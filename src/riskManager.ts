import { Position, BotConfig, PumpPortalTrade, Signal } from "./types";
import { Trader } from "./trader";
import { log } from "./logger";

/**
 * RiskManager handles:
 * - Position tracking
 * - Position sizing (never risk more than configured max per trade)
 * - Take-profit execution (tiered: sell 50% at TP1, rest at TP2)
 * - Stop-loss execution
 * - Max concurrent position enforcement
 */
export class RiskManager {
  private config: BotConfig;
  private trader: Trader;
  private positions: Map<string, Position> = new Map();

  constructor(config: BotConfig, trader: Trader) {
    this.config = config;
    this.trader = trader;
  }

  /**
   * Check if we can open a new position
   */
  canOpenPosition(): boolean {
    return this.positions.size < this.config.maxPositions;
  }

  /**
   * Get the number of open positions
   */
  get positionCount(): number {
    return this.positions.size;
  }

  /**
   * Get all open positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Check if we already have a position in this token
   */
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
        `Cannot open position: at max (${this.positions.size}/${this.config.maxPositions})`
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
      entryPriceSol: 0, // Will be updated on next trade
      entryMarketCapSol: marketCapSol,
      tokenAmount: 0, // Will be updated by wallet check
      solInvested: amountSol,
      entryTime: Date.now(),
      currentMarketCapSol: marketCapSol,
      currentPnlPercent: 0,
      takeProfitHits: 0,
      signals,
    };

    this.positions.set(mint, position);
    log.trade(
      `Position opened: ${symbol} @ ${marketCapSol.toFixed(2)} SOL mcap | tx: ${result.signature}`
    );
    return true;
  }

  /**
   * Update position with latest trade data and check TP/SL
   */
  async onTradeUpdate(trade: PumpPortalTrade) {
    const pos = this.positions.get(trade.mint);
    if (!pos) return;

    pos.currentMarketCapSol = trade.marketCapSol;

    // Calculate PnL based on market cap change (simplified)
    if (pos.entryMarketCapSol > 0) {
      pos.currentPnlPercent =
        ((trade.marketCapSol - pos.entryMarketCapSol) / pos.entryMarketCapSol) * 100;
    }

    // === Stop Loss ===
    if (pos.currentPnlPercent <= -this.config.stopLossPercent) {
      log.trade(
        `STOP LOSS triggered for ${pos.symbol}: ${pos.currentPnlPercent.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "stop_loss");
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
