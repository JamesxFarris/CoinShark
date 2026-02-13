import {
  Signal,
  SignalType,
  TokenMomentum,
  BotConfig,
  PumpPortalTrade,
  PumpPortalNewToken,
} from "./types";
import { KolDiscovery } from "./kolDiscovery";
import { log } from "./logger";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TOTAL_BONDING_CURVE_TOKENS = 800_000_000;

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
  bondingCurvePercent: number;
  vTokensInBondingCurve: number;
}

/**
 * SignalEngine evaluates whether a token has genuine momentum worth trading.
 *
 * Signal types:
 * - kol_buy: A tracked KOL wallet bought the token (weighted by KOL score)
 * - volume_spike: Trading volume exceeded threshold in a rolling window
 * - momentum: Buy/sell ratio and unique buyer count indicate organic growth
 * - trend: Market cap is growing steadily without sudden spikes (healthier)
 * - bonding_curve: Token is approaching graduation (high demand)
 */
export class SignalEngine {
  private config: BotConfig;
  private kolDiscovery: KolDiscovery;
  private tokenStates: Map<string, TokenState> = new Map();

  constructor(config: BotConfig, kolDiscovery: KolDiscovery) {
    this.config = config;
    this.kolDiscovery = kolDiscovery;
  }

  /**
   * Register a new token we're observing
   */
  registerToken(token: PumpPortalNewToken) {
    const bondingCurvePercent = this.calculateBondingCurvePercent(token.vTokensInBondingCurve);
    this.tokenStates.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      createdAt: Date.now(),
      trades: [],
      currentMarketCapSol: token.marketCapSol,
      marketCapAtFirstSeen: token.marketCapSol,
      kolBuys: new Set(),
      bondingCurvePercent,
      vTokensInBondingCurve: token.vTokensInBondingCurve,
    });
  }

  /**
   * Calculate bonding curve completion percentage.
   * 800M tokens on the curve; as tokens are bought, vTokens decreases.
   */
  private calculateBondingCurvePercent(vTokensInCurve: number): number {
    if (vTokensInCurve <= 0) return 100;
    const bought = TOTAL_BONDING_CURVE_TOKENS - vTokensInCurve;
    return Math.max(0, Math.min(100, (bought / TOTAL_BONDING_CURVE_TOKENS) * 100));
  }

  /**
   * Record a trade and check if it generates any signals
   */
  processTrade(trade: PumpPortalTrade): Signal[] {
    let state = this.tokenStates.get(trade.mint);
    if (!state) {
      state = {
        mint: trade.mint,
        symbol: "???",
        name: "Unknown",
        createdAt: Date.now(),
        trades: [],
        currentMarketCapSol: trade.marketCapSol,
        marketCapAtFirstSeen: trade.marketCapSol,
        kolBuys: new Set(),
        bondingCurvePercent: this.calculateBondingCurvePercent(trade.vTokensInBondingCurve),
        vTokensInBondingCurve: trade.vTokensInBondingCurve,
      };
      this.tokenStates.set(trade.mint, state);
    }

    // Update bonding curve progress
    state.vTokensInBondingCurve = trade.vTokensInBondingCurve;
    state.bondingCurvePercent = this.calculateBondingCurvePercent(trade.vTokensInBondingCurve);

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

    // KOL buy signal (with performance-weighted strength)
    if (trade.txType === "buy" && this.kolDiscovery.isKol(trade.traderPublicKey)) {
      state.kolBuys.add(trade.traderPublicKey);
      const kolWeight = this.kolDiscovery.getKolWeight(trade.traderPublicKey);
      const kol = this.kolDiscovery.getKol(trade.traderPublicKey);
      const baseStrength = Math.min(100, state.kolBuys.size * 40);
      const signal: Signal = {
        type: "kol_buy",
        mint: trade.mint,
        strength: Math.min(100, Math.round(baseStrength * kolWeight)),
        details: `KOL ${kol?.alias ?? trade.traderPublicKey.slice(0, 8)}... bought ${trade.solAmount.toFixed(2)} SOL (score: ${kol?.score ?? "??"})`,
        timestamp: Date.now(),
      };
      signals.push(signal);
      this.kolDiscovery.getKol(trade.traderPublicKey)!.lastActive = Date.now();
      this.kolDiscovery.save();
      log.kol(
        `${state.symbol}: KOL buy — ${kol?.alias ?? trade.traderPublicKey.slice(0, 8)}... (${trade.solAmount.toFixed(2)} SOL, weight: ${kolWeight.toFixed(1)}x)`
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
      const strength = Math.min(100, priceChangePercent5m);
      signals.push({
        type: "trend",
        mint,
        strength,
        details: `Market cap change: +${priceChangePercent5m.toFixed(1)}% in 5m`,
        timestamp: now,
      });
    }

    // KOL accumulation signal (weighted by KOL scores)
    if (state.kolBuys.size >= this.config.minKolBuys) {
      let totalWeight = 0;
      for (const kolAddr of state.kolBuys) {
        totalWeight += this.kolDiscovery.getKolWeight(kolAddr);
      }
      const weightedStrength = Math.min(100, Math.round(totalWeight * 35));
      signals.push({
        type: "kol_buy",
        mint,
        strength: weightedStrength,
        details: `${state.kolBuys.size} KOLs bought (weighted strength: ${weightedStrength})`,
        timestamp: now,
      });
    }

    // Bonding curve signal — tokens with good progress are in demand
    if (
      state.bondingCurvePercent >= this.config.minBondingCurvePercent &&
      state.bondingCurvePercent <= this.config.maxBondingCurvePercent
    ) {
      // Tokens at 40-70% are the sweet spot (strong demand, not yet graduated)
      const distFromOptimal = Math.abs(state.bondingCurvePercent - 55);
      const strength = Math.min(100, Math.max(20, 80 - distFromOptimal));
      signals.push({
        type: "bonding_curve",
        mint,
        strength,
        details: `Bonding curve: ${state.bondingCurvePercent.toFixed(1)}% complete`,
        timestamp: now,
      });
    }

    // Aggregate score
    let aggregateScore = 0;
    for (const signal of signals) {
      switch (signal.type) {
        case "kol_buy":
          aggregateScore += signal.strength * 0.30;
          break;
        case "volume_spike":
          aggregateScore += signal.strength * 0.20;
          break;
        case "momentum":
          aggregateScore += signal.strength * 0.20;
          break;
        case "trend":
          aggregateScore += signal.strength * 0.15;
          break;
        case "bonding_curve":
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
      aggregateScore = 0;
    }

    // Bonding curve bounds check
    if (
      state.bondingCurvePercent < this.config.minBondingCurvePercent ||
      state.bondingCurvePercent > this.config.maxBondingCurvePercent
    ) {
      aggregateScore = 0;
    }

    return {
      mint,
      volumeLast5m,
      uniqueBuyersLast5m: recentBuyers.size,
      uniqueSellersLast5m: recentSellers.size,
      buyToSellRatio,
      priceChangePercent5m,
      bondingCurvePercent: state.bondingCurvePercent,
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

    if (momentum.signals.length === 0) {
      return { shouldBuy: false, momentum, reason: "No signals detected" };
    }

    if (momentum.aggregateScore < 40) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Score too low: ${momentum.aggregateScore}/100 (need 40+)`,
      };
    }

    if (momentum.volumeLast5m < this.config.min5mVolumeSol) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Volume too low: ${momentum.volumeLast5m.toFixed(2)} SOL`,
      };
    }

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
   * Get the bonding curve percent for a token
   */
  getBondingCurvePercent(mint: string): number {
    return this.tokenStates.get(mint)?.bondingCurvePercent ?? 0;
  }

  /**
   * Get all KOL wallet addresses being tracked
   */
  getKolWallets(): string[] {
    return this.kolDiscovery.getKolAddresses();
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
