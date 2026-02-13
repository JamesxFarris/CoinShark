import {
  Signal,
  SignalType,
  TokenMomentum,
  BotConfig,
  PumpPortalTrade,
  PumpPortalNewToken,
} from "./types";
import { log } from "./logger";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

interface TradeRecord {
  trader: string;
  action: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  marketCapSol: number;
  timestamp: number;
}

interface TokenState {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  trades: TradeRecord[];
  currentMarketCapSol: number;
  marketCapAtFirstSeen: number;
  kolBuys: Set<string>;
}

/**
 * SignalEngine evaluates whether a token has genuine momentum worth trading.
 *
 * Signal types:
 * - kol_buy: A tracked KOL wallet bought the token
 * - volume_spike: Trading volume exceeded threshold in a rolling window
 * - momentum: Buy/sell ratio and unique buyer count indicate organic growth
 * - trend: Market cap is growing steadily without sudden spikes (healthier)
 */
export class SignalEngine {
  private config: BotConfig;
  private kolWallets: Set<string>;
  private tokenStates: Map<string, TokenState> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
    this.kolWallets = new Set(config.kolWallets);
    if (this.kolWallets.size > 0) {
      log.kol(`Tracking ${this.kolWallets.size} KOL wallets`);
    }
  }

  /**
   * Register a new token we're observing
   */
  registerToken(token: PumpPortalNewToken) {
    this.tokenStates.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      createdAt: Date.now(),
      trades: [],
      currentMarketCapSol: token.marketCapSol,
      marketCapAtFirstSeen: token.marketCapSol,
      kolBuys: new Set(),
    });
  }

  /**
   * Record a trade and check if it generates any signals
   */
  processTrade(trade: PumpPortalTrade): Signal[] {
    let state = this.tokenStates.get(trade.mint);
    if (!state) {
      // Auto-register if we see a trade for a token we haven't seen yet
      state = {
        mint: trade.mint,
        symbol: "???",
        name: "Unknown",
        createdAt: Date.now(),
        trades: [],
        currentMarketCapSol: trade.marketCapSol,
        marketCapAtFirstSeen: trade.marketCapSol,
        kolBuys: new Set(),
      };
      this.tokenStates.set(trade.mint, state);
    }

    // Record the trade
    state.trades.push({
      trader: trade.traderPublicKey,
      action: trade.txType,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      marketCapSol: trade.marketCapSol,
      timestamp: Date.now(),
    });
    state.currentMarketCapSol = trade.marketCapSol;

    // Trim old trades to save memory (keep last 30 min)
    const cutoff = Date.now() - 30 * 60 * 1000;
    state.trades = state.trades.filter((t) => t.timestamp > cutoff);

    // Check for signals
    const signals: Signal[] = [];

    // KOL buy signal
    if (trade.txType === "buy" && this.kolWallets.has(trade.traderPublicKey)) {
      state.kolBuys.add(trade.traderPublicKey);
      const signal: Signal = {
        type: "kol_buy",
        mint: trade.mint,
        strength: Math.min(100, state.kolBuys.size * 40),
        details: `KOL ${trade.traderPublicKey.slice(0, 8)}... bought ${trade.solAmount.toFixed(2)} SOL worth`,
        timestamp: Date.now(),
      };
      signals.push(signal);
      log.kol(
        `${state.symbol}: KOL buy detected — ${trade.traderPublicKey.slice(0, 8)}... (${trade.solAmount.toFixed(2)} SOL)`
      );
    }

    return signals;
  }

  /**
   * Evaluate the overall momentum of a token
   */
  evaluateMomentum(mint: string): TokenMomentum | null {
    const state = this.tokenStates.get(mint);
    if (!state) return null;

    const now = Date.now();
    const recentTrades = state.trades.filter(
      (t) => now - t.timestamp < FIVE_MINUTES_MS
    );

    // Volume in last 5 minutes
    const volumeLast5m = recentTrades.reduce((sum, t) => sum + t.solAmount, 0);

    // Unique buyers/sellers in last 5 min
    const recentBuyers = new Set(
      recentTrades.filter((t) => t.action === "buy").map((t) => t.trader)
    );
    const recentSellers = new Set(
      recentTrades.filter((t) => t.action === "sell").map((t) => t.trader)
    );

    const buyVolume = recentTrades
      .filter((t) => t.action === "buy")
      .reduce((s, t) => s + t.solAmount, 0);
    const sellVolume = recentTrades
      .filter((t) => t.action === "sell")
      .reduce((s, t) => s + t.solAmount, 0);

    const buyToSellRatio = sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? 10 : 0;

    // Price change over 5 min window
    let priceChangePercent5m = 0;
    if (recentTrades.length >= 2) {
      const firstMcap = recentTrades[0].marketCapSol;
      const lastMcap = recentTrades[recentTrades.length - 1].marketCapSol;
      if (firstMcap > 0) {
        priceChangePercent5m = ((lastMcap - firstMcap) / firstMcap) * 100;
      }
    }

    // Generate signals
    const signals: Signal[] = [];

    // Volume spike signal
    if (volumeLast5m >= this.config.min5mVolumeSol) {
      signals.push({
        type: "volume_spike",
        mint,
        strength: Math.min(100, (volumeLast5m / this.config.min5mVolumeSol) * 50),
        details: `5m volume: ${volumeLast5m.toFixed(2)} SOL (threshold: ${this.config.min5mVolumeSol})`,
        timestamp: now,
      });
    }

    // Momentum signal — organic buyer growth with positive ratio
    if (
      recentBuyers.size >= this.config.min5mBuyers &&
      buyToSellRatio >= 1.5
    ) {
      const strength = Math.min(
        100,
        recentBuyers.size * 5 + buyToSellRatio * 10
      );
      signals.push({
        type: "momentum",
        mint,
        strength,
        details: `${recentBuyers.size} buyers, ${recentSellers.size} sellers, ratio ${buyToSellRatio.toFixed(1)}x`,
        timestamp: now,
      });
    }

    // Trend signal — steady growth (not a pump-and-dump spike)
    if (priceChangePercent5m > 10 && priceChangePercent5m < 200) {
      // Between 10% and 200% growth in 5 min is "trending"
      // Above 200% is suspicious pump territory
      const strength = Math.min(100, priceChangePercent5m);
      signals.push({
        type: "trend",
        mint,
        strength,
        details: `Market cap change: +${priceChangePercent5m.toFixed(1)}% in 5m`,
        timestamp: now,
      });
    }

    // KOL accumulation signal
    if (state.kolBuys.size >= this.config.minKolBuys) {
      signals.push({
        type: "kol_buy",
        mint,
        strength: Math.min(100, state.kolBuys.size * 40),
        details: `${state.kolBuys.size} tracked KOLs have bought`,
        timestamp: now,
      });
    }

    // Aggregate score
    let aggregateScore = 0;
    for (const signal of signals) {
      switch (signal.type) {
        case "kol_buy":
          aggregateScore += signal.strength * 0.35; // KOL buys weighted highest
          break;
        case "volume_spike":
          aggregateScore += signal.strength * 0.25;
          break;
        case "momentum":
          aggregateScore += signal.strength * 0.25;
          break;
        case "trend":
          aggregateScore += signal.strength * 0.15;
          break;
      }
    }
    aggregateScore = Math.min(100, aggregateScore);

    // Market cap bounds check
    if (
      state.currentMarketCapSol < this.config.minMarketCapSol ||
      state.currentMarketCapSol > this.config.maxMarketCapSol
    ) {
      aggregateScore = 0; // Outside our trading range
    }

    return {
      mint,
      volumeLast5m,
      uniqueBuyersLast5m: recentBuyers.size,
      uniqueSellersLast5m: recentSellers.size,
      buyToSellRatio,
      priceChangePercent5m,
      kolBuys: Array.from(state.kolBuys),
      signals,
      aggregateScore: Math.round(aggregateScore),
    };
  }

  /**
   * Check if a token meets minimum signal threshold for buying
   */
  shouldBuy(mint: string): { shouldBuy: boolean; momentum: TokenMomentum | null; reason: string } {
    const momentum = this.evaluateMomentum(mint);
    if (!momentum) {
      return { shouldBuy: false, momentum: null, reason: "No data available" };
    }

    // Must have at least one signal
    if (momentum.signals.length === 0) {
      return { shouldBuy: false, momentum, reason: "No signals detected" };
    }

    // Score threshold
    if (momentum.aggregateScore < 40) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Score too low: ${momentum.aggregateScore}/100 (need 40+)`,
      };
    }

    // Volume check
    if (momentum.volumeLast5m < this.config.min5mVolumeSol) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Volume too low: ${momentum.volumeLast5m.toFixed(2)} SOL`,
      };
    }

    // Buyer count check
    if (momentum.uniqueBuyersLast5m < this.config.min5mBuyers) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Not enough buyers: ${momentum.uniqueBuyersLast5m}`,
      };
    }

    return {
      shouldBuy: true,
      momentum,
      reason: `Score: ${momentum.aggregateScore}, signals: ${momentum.signals.map((s) => s.type).join(", ")}`,
    };
  }

  /**
   * Get all KOL wallet addresses being tracked
   */
  getKolWallets(): string[] {
    return Array.from(this.kolWallets);
  }

  /**
   * Add a KOL wallet to track
   */
  addKolWallet(address: string) {
    this.kolWallets.add(address);
    log.kol(`Added KOL wallet: ${address.slice(0, 8)}...`);
  }

  /**
   * Clean up old token states
   */
  cleanup(maxAgeMs: number = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [mint, state] of this.tokenStates) {
      if (now - state.createdAt > maxAgeMs) {
        this.tokenStates.delete(mint);
      }
    }
  }
}
