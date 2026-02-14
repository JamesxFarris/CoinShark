import { Position, BotConfig, PumpPortalTrade, Signal } from "./types";
import { Trader } from "./trader";
import { TradeHistory } from "./tradeHistory";
import { log } from "./logger";
import * as fs from "fs";
import * as path from "path";

export type PositionCloseCallback = (
  position: Position,
  exitMarketCapSol: number,
  reason: string,
  signature?: string
) => void;

/**
 * RiskManager handles:
 * - Position tracking
 * - Signal-based position sizing (scale bets by signal strength)
 * - Breakeven stop (never lose money after a big run-up)
 * - Trailing stop (lock in gains after TP1)
 * - Take-profit ladder: TP1 sell 50%, TP2 sell 50%, TP3 sell 50%, keep moonbag
 * - Stop-loss execution
 * - Time-based exits (sell stale positions)
 * - Daily loss limits (stop trading after hitting limit)
 * - Max concurrent position enforcement
 *
 * Exit strategy summary:
 *   Entry → if drops to -SL% → stop loss
 *   Entry → if rises to +breakeven% → move stop to +5% (covers fees)
 *   Entry → if rises to +TP1% → sell 50% (recover initial), activate trailing stop
 *   After TP1 → trailing stop at HWM - trailing% → sell remaining if triggered
 *   After TP1 → if rises to +TP2% → sell 50% of remaining
 *   After TP2 → if rises to +TP3% → sell 50% of remaining, rest is moonbag
 *   Moonbag → trailing stop at HWM - moonbagTrailing% → sell all if triggered
 */
export class RiskManager {
  private config: BotConfig;
  private trader: Trader;
  private tradeHistory: TradeHistory;
  private positions: Map<string, Position> = new Map();
  private pendingSells: Set<string> = new Set(); // prevents concurrent sell attempts
  private dailyLossExceeded = false;
  private positionsFile = path.join(process.cwd(), "data", "positions.json");
  onPositionClose: PositionCloseCallback | null = null;

  constructor(config: BotConfig, trader: Trader, tradeHistory: TradeHistory) {
    this.config = config;
    this.trader = trader;
    this.tradeHistory = tradeHistory;
    this.loadPositions();
  }

  private savePositions(): void {
    try {
      const dir = path.dirname(this.positionsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = JSON.stringify(Array.from(this.positions.entries()), null, 2);
      fs.writeFileSync(this.positionsFile, data);
    } catch (e: any) {
      log.error(`Failed to save positions: ${e.message}`);
    }
  }

  private loadPositions(): void {
    try {
      if (!fs.existsSync(this.positionsFile)) return;
      const data = JSON.parse(fs.readFileSync(this.positionsFile, "utf-8"));
      for (const [mint, pos] of data) {
        this.positions.set(mint, pos);
      }
      if (this.positions.size > 0) {
        log.info(`Restored ${this.positions.size} position(s) from disk`);
      }
    } catch (e: any) {
      log.error(`Failed to load positions: ${e.message}`);
    }
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

  getPosition(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  /**
   * Position size — always use the configured bet amount.
   * No more scaling down (was causing penny bets that waste gas).
   */
  calculatePositionSize(_signalScore: number): number {
    return this.config.maxBetSol;
  }

  /**
   * Open a new position with signal-based sizing
   */
  async openPosition(
    mint: string,
    symbol: string,
    marketCapSol: number,
    signals: Signal[],
    signalScore: number = 50
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

    const amountSol = this.calculatePositionSize(signalScore);
    log.trade(`Opening position: ${symbol} (${mint.slice(0, 8)}...) — ${amountSol} SOL (score: ${signalScore}, base: ${this.config.maxBetSol})`);

    const result = await this.trader.buy(mint, amountSol);
    if (!result.success) {
      log.error(`Failed to open position in ${symbol}: ${result.error}`);
      return false;
    }

    // Re-check after async buy — another concurrent call might have opened a position
    if (this.hasPosition(mint)) {
      log.warn(`Position already opened for ${symbol} while buy was in flight — ignoring duplicate`);
      return false;
    }

    const position: Position = {
      mint,
      symbol,
      entryPriceSol: 0,
      entryMarketCapSol: marketCapSol,
      tokenAmount: 0,
      solInvested: amountSol,
      solRecovered: 0,
      entryTime: Date.now(),
      currentMarketCapSol: marketCapSol,
      currentPnlPercent: 0,
      highWaterMarkPnl: 0,
      takeProfitHits: 0,
      breakevenStopActive: false,
      trailingStopActive: false,
      isMoonbag: false,
      signals,
      signalScore,
    };

    this.positions.set(mint, position);
    this.savePositions();

    // Record buy in trade history
    this.tradeHistory.recordBuy(
      mint, symbol, amountSol, marketCapSol,
      result.signature,
      signals.map(s => s.type)
    );

    log.trade(
      `Position opened: ${symbol} @ ${marketCapSol.toFixed(2)} SOL mcap | ${amountSol} SOL | tx: ${result.signature}`
    );
    return true;
  }

  /**
   * Update position with latest trade data and check all exit conditions.
   *
   * Exit priority (checked in order):
   * 1. Moonbag trailing stop (if isMoonbag)
   * 2. Trailing stop (if trailingStopActive, after TP1)
   * 3. Breakeven stop (if breakevenStopActive, PnL dropped to ~0%)
   * 4. Hard stop loss
   * 5. Time exit (stale positions not in profit)
   * 6. Take profit levels (TP1 → TP2 → TP3)
   * 7. Activate breakeven/trailing flags on the way up
   */
  async onTradeUpdate(trade: PumpPortalTrade) {
    const pos = this.positions.get(trade.mint);
    if (!pos) return;

    // If a sell is already in progress for this token, skip entirely.
    // This prevents TP/stop-loss/trailing-stop from firing 9+ concurrent
    // sell requests when multiple trade updates arrive in rapid succession.
    if (this.pendingSells.has(trade.mint)) return;

    // Update current state
    pos.currentMarketCapSol = trade.marketCapSol;

    // If entryMarketCapSol is 0 (manual buy with unknown market cap), latch
    // the first observed trade's market cap as the entry baseline so PnL,
    // stop-loss, and take-profit calculations can function.
    if (pos.entryMarketCapSol === 0 && trade.marketCapSol > 0) {
      pos.entryMarketCapSol = trade.marketCapSol;
      log.info(`Latched entry market cap for ${pos.symbol}: ${trade.marketCapSol.toFixed(2)} SOL`);
    }

    if (pos.entryMarketCapSol > 0) {
      pos.currentPnlPercent =
        ((trade.marketCapSol - pos.entryMarketCapSol) / pos.entryMarketCapSol) * 100;
    }

    // Track high water mark
    if (pos.currentPnlPercent > pos.highWaterMarkPnl) {
      pos.highWaterMarkPnl = pos.currentPnlPercent;
    }

    // === 1. Moonbag trailing stop ===
    if (pos.isMoonbag) {
      // Calculate actual price drop percentage from HWM (not PnL point difference)
      const hwmMultiplier = 1 + pos.highWaterMarkPnl / 100;
      const currentMultiplier = 1 + pos.currentPnlPercent / 100;
      const dropFromHwm = (1 - currentMultiplier / hwmMultiplier) * 100;
      if (dropFromHwm >= this.config.moonbagTrailingStopPercent) {
        log.trade(
          `MOONBAG TRAILING STOP for ${pos.symbol}: price dropped ${dropFromHwm.toFixed(1)}% from peak (HWM: +${pos.highWaterMarkPnl.toFixed(1)}%, now: +${pos.currentPnlPercent.toFixed(1)}%)`
        );
        await this.closePosition(pos.mint, 100, "moonbag_trailing_stop");
        return;
      }
      // Moonbags don't check other exits — they ride or die with trailing stop
      return;
    }

    // === 2. Trailing stop (after TP1) ===
    if (pos.trailingStopActive) {
      // Calculate actual price drop percentage from HWM (not PnL point difference)
      const hwmMultiplier = 1 + pos.highWaterMarkPnl / 100;
      const currentMultiplier = 1 + pos.currentPnlPercent / 100;
      const dropFromHwm = (1 - currentMultiplier / hwmMultiplier) * 100;
      if (dropFromHwm >= this.config.trailingStopPercent) {
        log.trade(
          `TRAILING STOP for ${pos.symbol}: price dropped ${dropFromHwm.toFixed(1)}% from peak (HWM: +${pos.highWaterMarkPnl.toFixed(1)}%, now: +${pos.currentPnlPercent.toFixed(1)}%)`
        );
        await this.closePosition(pos.mint, 100, "trailing_stop");
        return;
      }
    }

    // === 3. Breakeven stop (activated once PnL crossed threshold, sells if PnL drops to ~0%) ===
    if (pos.breakevenStopActive && !pos.trailingStopActive && pos.currentPnlPercent <= 5) {
      log.trade(
        `BREAKEVEN STOP for ${pos.symbol}: PnL dropped to +${pos.currentPnlPercent.toFixed(1)}% after reaching +${pos.highWaterMarkPnl.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "breakeven_stop");
      return;
    }

    // === 4a. Early rug detection — fast crash exit for fresh positions ===
    // If market cap drops >50% within the first 2 minutes, it's likely a rug pull.
    // Don't wait for the normal stop loss — get out immediately.
    const posAgeSeconds = (Date.now() - pos.entryTime) / 1000;
    if (posAgeSeconds < 120 && pos.currentPnlPercent <= -50) {
      log.trade(
        `RUG DETECTED for ${pos.symbol}: ${pos.currentPnlPercent.toFixed(1)}% in ${posAgeSeconds.toFixed(0)}s — emergency sell`
      );
      await this.closePosition(pos.mint, 100, "rug_detected");
      return;
    }

    // === 4b. Hard stop loss — ALWAYS fires as a backstop regardless of other flags ===
    if (pos.currentPnlPercent <= -this.config.stopLossPercent) {
      log.trade(
        `STOP LOSS for ${pos.symbol}: ${pos.currentPnlPercent.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "stop_loss");
      return;
    }

    // === 5. Time-based exit (only if not significantly profitable and no TPs hit) ===
    const ageMinutes = (Date.now() - pos.entryTime) / 1000 / 60;
    if (
      this.config.maxPositionAgeMinutes > 0 &&
      ageMinutes >= this.config.maxPositionAgeMinutes &&
      pos.takeProfitHits === 0 &&
      pos.currentPnlPercent < 20
    ) {
      log.trade(
        `TIME EXIT for ${pos.symbol}: ${ageMinutes.toFixed(0)}m old, PnL: ${pos.currentPnlPercent.toFixed(1)}%`
      );
      await this.closePosition(pos.mint, 100, "time_exit");
      return;
    }

    // === 6. Take Profit Ladder ===

    // TP1: sell 50% at 2x → recover full initial, remaining 50% rides as house money
    if (
      pos.takeProfitHits === 0 &&
      pos.currentPnlPercent >= this.config.takeProfit1Percent
    ) {
      log.trade(
        `TAKE PROFIT 1 for ${pos.symbol}: +${pos.currentPnlPercent.toFixed(1)}% — selling 50% (initial recovered, rest is house money)`
      );
      this.pendingSells.add(pos.mint);
      try {
        const result = await this.trader.sell(pos.mint, 50);
        if (result.success) {
          pos.takeProfitHits = 1;
          pos.trailingStopActive = true;
          pos.solRecovered += pos.solInvested * 0.5;
          pos.solInvested = pos.solInvested * 0.5;
          log.trade(`Trailing stop activated for ${pos.symbol} at ${this.config.trailingStopPercent}% below HWM`);
        }
      } finally {
        this.pendingSells.delete(pos.mint);
      }
      return;
    }

    // TP2: sell 25% of remaining
    if (
      pos.takeProfitHits === 1 &&
      pos.currentPnlPercent >= this.config.takeProfit2Percent
    ) {
      log.trade(
        `TAKE PROFIT 2 for ${pos.symbol}: +${pos.currentPnlPercent.toFixed(1)}% — selling 25% of remaining`
      );
      this.pendingSells.add(pos.mint);
      try {
        const result = await this.trader.sell(pos.mint, 25);
        if (result.success) {
          pos.takeProfitHits = 2;
          pos.solRecovered += pos.solInvested * 0.25;
          pos.solInvested = pos.solInvested * 0.75;
        }
      } finally {
        this.pendingSells.delete(pos.mint);
      }
      return;
    }

    // TP3: sell 50% of remaining, rest becomes moonbag
    if (
      pos.takeProfitHits === 2 &&
      pos.currentPnlPercent >= this.config.takeProfit3Percent
    ) {
      const moonbag = this.config.moonbagPercent;
      // Sell down to moonbag percentage of what's left
      const sellPercent = 100 - moonbag;
      log.trade(
        `TAKE PROFIT 3 for ${pos.symbol}: +${pos.currentPnlPercent.toFixed(1)}% — selling ${sellPercent}%, keeping ${moonbag}% moonbag`
      );
      this.pendingSells.add(pos.mint);
      try {
        const result = await this.trader.sell(pos.mint, sellPercent);
        if (result.success) {
          pos.takeProfitHits = 3;
          pos.isMoonbag = true;
          // Record partial close
          this.tradeHistory.recordSell(pos, pos.currentMarketCapSol, "take_profit_3_moonbag", result.signature);
          if (this.onPositionClose) {
            this.onPositionClose(pos, pos.currentMarketCapSol, "take_profit_3_moonbag", result.signature);
          }
          pos.solRecovered += pos.solInvested * (sellPercent / 100);
          pos.solInvested = pos.solInvested * (moonbag / 100);
          log.trade(`${pos.symbol} is now a moonbag (${moonbag}% remaining). Moonbag trailing stop: ${this.config.moonbagTrailingStopPercent}%`);
        }
      } finally {
        this.pendingSells.delete(pos.mint);
      }
      return;
    }

    // === 7. Activate breakeven stop on the way up ===
    if (
      !pos.breakevenStopActive &&
      pos.takeProfitHits === 0 &&
      pos.currentPnlPercent >= this.config.breakevenActivationPercent
    ) {
      pos.breakevenStopActive = true;
      log.trade(
        `BREAKEVEN STOP activated for ${pos.symbol}: PnL hit +${pos.currentPnlPercent.toFixed(1)}% — stop moved to +5%`
      );
    }
  }

  /**
   * Check all positions for time-based exits (called periodically)
   */
  async checkTimeExits() {
    if (this.config.maxPositionAgeMinutes <= 0) return;

    // Snapshot keys to avoid mutation during iteration
    const mints = Array.from(this.positions.keys());
    for (const mint of mints) {
      const pos = this.positions.get(mint);
      if (!pos || pos.isMoonbag) continue; // moonbags don't time-exit
      const ageMinutes = (Date.now() - pos.entryTime) / 1000 / 60;
      if (
        ageMinutes >= this.config.maxPositionAgeMinutes &&
        pos.takeProfitHits === 0 &&
        pos.currentPnlPercent < 20
      ) {
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

    // Prevent concurrent sell attempts on the same position — the old code
    // would fire 30+ sell requests simultaneously, causing 429 rate limiting
    if (this.pendingSells.has(mint)) {
      log.debug(`Sell already in progress for ${pos.symbol}, skipping`);
      return false;
    }
    this.pendingSells.add(mint);

    try {
      const result = await this.trader.sell(mint, percent);
      if (result.success) {
        log.trade(
          `Position closed (${reason}): ${pos.symbol} | PnL: ${pos.currentPnlPercent.toFixed(1)}% | Recovered: ${pos.solRecovered.toFixed(4)} SOL | tx: ${result.signature}`
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
          this.savePositions();
        }
        return true;
      } else {
        log.error(`Failed to close ${pos.symbol}: ${result.error}`);
        return false;
      }
    } finally {
      this.pendingSells.delete(mint);
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
      const flags = [];
      if (pos.isMoonbag) flags.push("MOONBAG");
      if (pos.trailingStopActive) flags.push("TRAILING");
      if (pos.breakevenStopActive) flags.push("BE-STOP");
      const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
      log.info(
        `  ${pos.symbol} | ${pnlColor}${pos.currentPnlPercent.toFixed(1)}% | ` +
        `MCap: ${pos.currentMarketCapSol.toFixed(1)} SOL | ` +
        `Invested: ${pos.solInvested.toFixed(4)} SOL | Recovered: ${pos.solRecovered.toFixed(4)} SOL | ` +
        `Age: ${age}m | TP: ${pos.takeProfitHits}/3 | HWM: +${pos.highWaterMarkPnl.toFixed(1)}%${flagStr}`
      );
    }
  }
}
