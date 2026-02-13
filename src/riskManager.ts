import { Position, BotConfig, PumpPortalTrade, Signal } from "./types";
import { Trader } from "./trader";
import { TradeHistory } from "./tradeHistory";
import { log } from "./logger";

export type PositionCloseCallback = (
  position: Position,
  exitMarketCapSol: number,
  reason: string,
  signature?: string
) => void;

/**
 * RiskManager handles:
 * - Position tracking
 * - Position sizing (never risk more than configured max per trade)
 * - Take-profit execution (tiered: sell 50% at TP1, rest at TP2)
 * - Stop-loss execution
 * - Time-based exits (sell stale positions)
 * - Daily loss limits (stop trading after hitting limit)
 * - Max concurrent position enforcement
 */
export class RiskManager {
  private config: BotConfig;
  private trader: Trader;
  private tradeHistory: TradeHistory;
  private positions: Map<string, Position> = new Map();
  private dailyLossExceeded = false;
  onPositionClose: PositionCloseCallback | null = null;

  constructor(config: BotConfig, trader: Trader, tradeHistory: TradeHistory) {
    this.config = config;
    this.trader = trader;
    this.tradeHistory = tradeHistory;
  }

  /**
   * Check if we can open a new position
   */
  canOpenPosition(): boolean {
    if (this.dailyLossExceeded) return false;
    return this.positions.size < this.config.maxPositions;
  }

  /**
   * Check if daily loss limit has been hit
   */
  checkDailyLossLimit(): boolean {
    if (this.config.dailyLossLimitSol <= 0) return false;
    const dailyLoss = this.tradeHistory.getDailyLoss();
    if (dailyLoss >= this.config.dailyLossLimitSol) {
      if (!this.dailyLossExceeded) {
        this.dailyLossExceeded = true;
        log.warn(`DAILY LOSS LIMIT HIT: ${dailyLoss.toFixed(4)} SOL lost today (limit: ${this.config.dailyLossLimitSol})`);
        log.warn("Auto-trading paused until tomorrow. Manual trades still work.");
      }
      return true;
    }
    this.dailyLossExceeded = false;
    return false;
  }

  get positionCount(): number {
    return this.positions.size;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  hasPosition(mint: string): boolean {
    return this.positions.has(mint);
  }

  /**
   * Open a new position
   */
  async openPosition(
    mint: string,
    symbol: string,
    marketCapSol: number,
    signals: Signal[]
  ): Promise<boolean> {
    if (!this.canOpenPosition()) {
      log.warn(
        `Cannot open position: ${this.dailyLossExceeded ? "daily loss limit" : "at max"} (${this.positions.size}/${this.config.maxPositions})`
      );
      return false;
    }

    if (this.hasPosition(mint)) {
      log.warn(`Already have a position in ${symbol}`);
      return false;
    }

    const amountSol = this.config.maxBetSol;
    log.trade(`Opening position: ${symbol} (${mint.slice(0, 8)}...) — ${amountSol} SOL`);

    const result = await this.trader.buy(mint, amountSol);
    if (!result.success) {
      log.error(`Failed to open position in ${symbol}: ${result.error}`);
      return false;
    }

    const position: Position = {
      mint,
      symbol,
      entryPriceSol: 0,
      entryMarketCapSol: marketCapSol,
      tokenAmount: 0,
      solInvested: amountSol,
      entryTime: Date.now(),
      currentMarketCapSol: marketCapSol,
      currentPnlPercent: 0,
      highWaterMarkPnl: 0,
      takeProfitHits: 0,
      signals,
    };

    this.positions.set(mint, position);

    // Record buy in trade history
    this.tradeHistory.recordBuy(
      mint, symbol, amountSol, marketCapSol,
      result.signature,
      signals.map(s => s.type)
    );

    log.trade(
      `Position opened: ${symbol} @ ${marketCapSol.toFixed(2)} SOL mcap | tx: ${result.signature}`
    );
    return true;
  }

  /**
   * Update position with latest trade data and check TP/SL/time exits
   */
  async onTradeUpdate(trade: PumpPortalTrade) {
    const pos = this.positions.get(trade.mint);
    if (!pos) return;

    pos.currentMarketCapSol = trade.marketCapSol;

    if (pos.entryMarketCapSol > 0) {
      pos.currentPnlPercent =
        ((trade.marketCapSol - pos.entryMarketCapSol) / pos.entryMarketCapSol) * 100;
    }

    // Track high water mark for future trailing stop
    if (pos.currentPnlPercent > pos.highWaterMarkPnl) {
      pos.highWaterMarkPnl = pos.currentPnlPercent;
    }

    // === Stop Loss ===
    if (pos.currentPnlPercent <= -this.config.stopLossPercent) {
      log.trade(
        `STOP LOSS triggered for ${pos.symbol}: ${pos.currentPnlPercent.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "stop_loss");
      return;
    }

    // === Time-based exit ===
    const ageMinutes = (Date.now() - pos.entryTime) / 1000 / 60;
    if (
      this.config.maxPositionAgeMinutes > 0 &&
      ageMinutes >= this.config.maxPositionAgeMinutes &&
      pos.currentPnlPercent < 10 // Only time-exit if not significantly profitable
    ) {
      log.trade(
        `TIME EXIT for ${pos.symbol}: ${ageMinutes.toFixed(0)}m old, PnL: ${pos.currentPnlPercent.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "time_exit");
      return;
    }

    // === Take Profit 1 (sell 50%) ===
    if (
      pos.takeProfitHits === 0 &&
      pos.currentPnlPercent >= this.config.takeProfit1Percent
    ) {
      log.trade(
        `TAKE PROFIT 1 for ${pos.symbol}: +${pos.currentPnlPercent.toFixed(1)}% — selling 50%`
      );
      const result = await this.trader.sell(pos.mint, 50);
      if (result.success) {
        pos.takeProfitHits = 1;
      }
      return;
    }

    // === Take Profit 2 (sell remaining) ===
    if (
      pos.takeProfitHits === 1 &&
      pos.currentPnlPercent >= this.config.takeProfit2Percent
    ) {
      log.trade(
        `TAKE PROFIT 2 for ${pos.symbol}: +${pos.currentPnlPercent.toFixed(1)}% — closing position`
      );
      await this.closePosition(pos.mint, 100, "take_profit_2");
      return;
    }
  }

  /**
   * Check all positions for time-based exits (called periodically)
   */
  async checkTimeExits() {
    if (this.config.maxPositionAgeMinutes <= 0) return;

    for (const pos of this.positions.values()) {
      const ageMinutes = (Date.now() - pos.entryTime) / 1000 / 60;
      if (ageMinutes >= this.config.maxPositionAgeMinutes && pos.currentPnlPercent < 10) {
        log.trade(
          `TIME EXIT for ${pos.symbol}: ${ageMinutes.toFixed(0)}m old, PnL: ${pos.currentPnlPercent.toFixed(1)}%`
        );
        await this.closePosition(pos.mint, 100, "time_exit");
      }
    }
  }

  /**
   * Close a position
   */
  async closePosition(
    mint: string,
    percent: number = 100,
    reason: string = "manual"
  ): Promise<boolean> {
    const pos = this.positions.get(mint);
    if (!pos) {
      log.warn(`No position found for ${mint}`);
      return false;
    }

    const result = await this.trader.sell(mint, percent);
    if (result.success) {
      log.trade(
        `Position closed (${reason}): ${pos.symbol} | PnL: ${pos.currentPnlPercent.toFixed(1)}% | tx: ${result.signature}`
      );

      if (percent >= 100) {
        // Record sell in trade history
        this.tradeHistory.recordSell(pos, pos.currentMarketCapSol, reason, result.signature);

        // Notify callback (for Telegram alerts, KOL scoring)
        if (this.onPositionClose) {
          this.onPositionClose(pos, pos.currentMarketCapSol, reason, result.signature);
        }

        // Check daily loss limit
        this.checkDailyLossLimit();

        this.positions.delete(mint);
      }
      return true;
    } else {
      log.error(`Failed to close ${pos.symbol}: ${result.error}`);
      return false;
    }
  }

  /**
   * Emergency: close all positions
   */
  async closeAll(reason: string = "emergency"): Promise<void> {
    log.warn(`Closing ALL positions (${reason})`);
    const mints = Array.from(this.positions.keys());
    for (const mint of mints) {
      await this.closePosition(mint, 100, reason);
    }
  }

  /**
   * Print position summary
   */
  printPositions() {
    if (this.positions.size === 0) {
      log.info("No open positions");
      return;
    }
    log.info(`--- Open Positions (${this.positions.size}/${this.config.maxPositions}) ---`);
    for (const pos of this.positions.values()) {
      const pnlColor = pos.currentPnlPercent >= 0 ? "+" : "";
      const age = ((Date.now() - pos.entryTime) / 1000 / 60).toFixed(1);
      log.info(
        `  ${pos.symbol} | ${pnlColor}${pos.currentPnlPercent.toFixed(1)}% | ` +
        `MCap: ${pos.currentMarketCapSol.toFixed(1)} SOL | ` +
        `Invested: ${pos.solInvested} SOL | Age: ${age}m | TP: ${pos.takeProfitHits}/2`
      );
    }
  }
}
