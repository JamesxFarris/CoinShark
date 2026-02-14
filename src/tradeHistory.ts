import * as fs from "fs";
import * as path from "path";
import { TradeHistoryEntry, BotStats, Position } from "./types";
import { log } from "./logger";

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "trades.json");

/**
 * TradeHistory provides persistent trade logging and analytics.
 *
 * Features:
 * - Saves every trade to disk (JSON)
 * - Calculates win rate, total PnL, best/worst trades
 * - Tracks daily PnL for loss limiting
 * - Exportable trade log
 */
export class TradeHistory {
  private trades: TradeHistoryEntry[] = [];
  private dailyLoss: number = 0;
  private dailyReset: number = this.startOfDay();

  constructor() {
    this.ensureDataDir();
    this.load();
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        this.trades = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
        log.info(`Loaded ${this.trades.length} trade history entries`);
        this.recalculateDailyLoss();
      }
    } catch (err) {
      log.warn(`Failed to load trade history: ${err}`);
      this.trades = [];
    }
  }

  private save() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.trades, null, 2));
    } catch (err) {
      log.warn(`Failed to save trade history: ${err}`);
    }
  }

  private recalculateDailyLoss() {
    const today = this.startOfDay();
    if (this.dailyReset < today) {
      this.dailyLoss = 0;
      this.dailyReset = today;
    }

    // Sum losses from today's closed trades
    this.dailyLoss = this.trades
      .filter(t => t.timestamp >= today && t.action === "sell" && t.pnlSol !== undefined && t.pnlSol < 0)
      .reduce((sum, t) => sum + Math.abs(t.pnlSol!), 0);
  }

  /**
   * Record a buy trade
   */
  recordBuy(
    mint: string,
    symbol: string,
    solAmount: number,
    marketCapSol: number,
    signature?: string,
    signals?: string[]
  ) {
    const entry: TradeHistoryEntry = {
      id: `${Date.now()}-${mint.slice(0, 8)}`,
      timestamp: Date.now(),
      mint,
      symbol,
      action: "buy",
      solAmount,
      marketCapSol,
      signature,
      triggerSignals: signals,
    };
    this.trades.push(entry);
    this.save();
  }

  /**
   * Record a sell/close trade with PnL
   */
  recordSell(
    position: Position,
    exitMarketCapSol: number,
    exitReason: string,
    signature?: string
  ) {
    const pnlPercent = position.entryMarketCapSol > 0
      ? ((exitMarketCapSol - position.entryMarketCapSol) / position.entryMarketCapSol) * 100
      : 0;
    const pnlSol = position.solInvested * (pnlPercent / 100);

    const entry: TradeHistoryEntry = {
      id: `${Date.now()}-${position.mint.slice(0, 8)}`,
      timestamp: Date.now(),
      mint: position.mint,
      symbol: position.symbol,
      action: "sell",
      solAmount: position.solInvested,
      marketCapSol: exitMarketCapSol,
      signature,
      entryMarketCapSol: position.entryMarketCapSol,
      exitMarketCapSol,
      pnlPercent,
      pnlSol,
      holdDurationMs: Date.now() - position.entryTime,
      exitReason,
      triggerSignals: position.signals.map(s => s.type),
    };

    this.trades.push(entry);

    // Track daily losses
    if (pnlSol < 0) {
      const today = this.startOfDay();
      if (this.dailyReset < today) {
        this.dailyLoss = 0;
        this.dailyReset = today;
      }
      this.dailyLoss += Math.abs(pnlSol);
    }

    this.save();
    return { pnlPercent, pnlSol };
  }

  /**
   * Get current daily loss in SOL
   */
  getDailyLoss(): number {
    const today = this.startOfDay();
    if (this.dailyReset < today) {
      this.dailyLoss = 0;
      this.dailyReset = today;
    }
    return this.dailyLoss;
  }

  /**
   * Calculate overall bot statistics
   */
  getStats(): BotStats {
    const closedTrades = this.trades.filter(t => t.action === "sell" && t.pnlPercent !== undefined);
    const wins = closedTrades.filter(t => t.pnlPercent! > 0);
    const losses = closedTrades.filter(t => t.pnlPercent! <= 0);

    const totalPnlSol = closedTrades.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
    const bestTrade = closedTrades.reduce((best, t) => Math.max(best, t.pnlPercent ?? 0), 0);
    const worstTrade = closedTrades.reduce((worst, t) => Math.min(worst, t.pnlPercent ?? 0), 0);
    const avgHoldTime = closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + (t.holdDurationMs ?? 0), 0) / closedTrades.length
      : 0;

    return {
      totalTrades: closedTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
      totalPnlSol,
      bestTradePnl: bestTrade,
      worstTradePnl: worstTrade,
      avgHoldTimeMs: avgHoldTime,
      dailyPnlSol: this.getDailyPnl(),
    };
  }

  private getDailyPnl(): number {
    const today = this.startOfDay();
    return this.trades
      .filter(t => t.timestamp >= today && t.action === "sell" && t.pnlSol !== undefined)
      .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
  }

  /**
   * Get recent trades for display
   */
  getRecentTrades(count: number = 10): TradeHistoryEntry[] {
    return this.trades
      .filter(t => t.action === "sell")
      .slice(-count)
      .reverse();
  }

  /**
   * Format stats for display
   */
  formatStats(): string {
    const s = this.getStats();
    if (s.totalTrades === 0) return "No completed trades yet.";

    const avgHoldMin = (s.avgHoldTimeMs / 1000 / 60).toFixed(1);
    return [
      `Total Trades: ${s.totalTrades}`,
      `Win Rate: ${s.winRate.toFixed(1)}% (${s.wins}W / ${s.losses}L)`,
      `Total PnL: ${s.totalPnlSol >= 0 ? "+" : ""}${s.totalPnlSol.toFixed(4)} SOL`,
      `Today's PnL: ${s.dailyPnlSol >= 0 ? "+" : ""}${s.dailyPnlSol.toFixed(4)} SOL`,
      `Best Trade: +${s.bestTradePnl.toFixed(1)}%`,
      `Worst Trade: ${s.worstTradePnl.toFixed(1)}%`,
      `Avg Hold Time: ${avgHoldMin} min`,
    ].join("\n");
  }

  /**
   * Get PnL breakdown by signal type.
   * Shows which signals are making money and which are losing.
   */
  getSignalAnalytics(): Map<string, { trades: number; wins: number; totalPnlSol: number; avgPnlPercent: number }> {
    const closedTrades = this.trades.filter(t => t.action === "sell" && t.pnlPercent !== undefined && t.triggerSignals);
    const analytics = new Map<string, { trades: number; wins: number; totalPnlSol: number; totalPnlPercent: number }>();

    for (const trade of closedTrades) {
      for (const signal of trade.triggerSignals!) {
        const existing = analytics.get(signal) ?? { trades: 0, wins: 0, totalPnlSol: 0, totalPnlPercent: 0 };
        existing.trades++;
        if (trade.pnlPercent! > 0) existing.wins++;
        existing.totalPnlSol += trade.pnlSol ?? 0;
        existing.totalPnlPercent += trade.pnlPercent ?? 0;
        analytics.set(signal, existing);
      }
    }

    // Convert totalPnlPercent to avgPnlPercent
    const result = new Map<string, { trades: number; wins: number; totalPnlSol: number; avgPnlPercent: number }>();
    for (const [signal, data] of analytics) {
      result.set(signal, {
        trades: data.trades,
        wins: data.wins,
        totalPnlSol: data.totalPnlSol,
        avgPnlPercent: data.trades > 0 ? data.totalPnlPercent / data.trades : 0,
      });
    }

    return result;
  }

  /**
   * Format signal analytics for display (sorted by total PnL)
   */
  formatSignalAnalytics(): string {
    const analytics = this.getSignalAnalytics();
    if (analytics.size === 0) return "No signal data yet.";

    const sorted = Array.from(analytics.entries())
      .sort((a, b) => b[1].totalPnlSol - a[1].totalPnlSol);

    const lines = sorted.map(([signal, data]) => {
      const winRate = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
      const pnlSign = data.totalPnlSol >= 0 ? "+" : "";
      const avgSign = data.avgPnlPercent >= 0 ? "+" : "";
      return `${signal}: ${data.trades} trades | WR: ${winRate}% (${data.wins}W/${data.trades - data.wins}L) | PnL: ${pnlSign}${data.totalPnlSol.toFixed(4)} SOL | Avg: ${avgSign}${data.avgPnlPercent.toFixed(1)}%`;
    });

    return lines.join("\n");
  }

  /**
   * Format recent trades for display
   */
  formatRecentTrades(count: number = 5): string {
    const trades = this.getRecentTrades(count);
    if (trades.length === 0) return "No trades yet.";

    return trades.map(t => {
      const pnl = t.pnlPercent !== undefined ? `${t.pnlPercent >= 0 ? "+" : ""}${t.pnlPercent.toFixed(1)}%` : "?";
      const sol = t.pnlSol !== undefined ? `(${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol.toFixed(4)} SOL)` : "";
      const holdMin = t.holdDurationMs ? `${(t.holdDurationMs / 1000 / 60).toFixed(1)}m` : "?";
      const reason = t.exitReason ?? "?";
      return `${t.symbol} | ${pnl} ${sol} | ${holdMin} | ${reason}`;
    }).join("\n");
  }
}
