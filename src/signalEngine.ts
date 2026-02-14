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
const ONE_MINUTE_MS = 60 * 1000;
const TOTAL_BONDING_CURVE_TOKENS = 800_000_000;

interface TradeRecord {
  trader: string;
  action: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  marketCapSol: number;
  timestamp: number;
}

interface HolderSnapshot {
  timestamp: number;
  uniqueHolders: number;
}

interface TokenState {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  createdAt: number;
  trades: TradeRecord[];
  currentMarketCapSol: number;
  marketCapAtFirstSeen: number;
  kolBuys: Set<string>;
  bondingCurvePercent: number;
  previousBondingCurvePercent: number;
  bondingCurveSnapshotTime: number;
  vTokensInBondingCurve: number;
  graduated: boolean;
  creatorSold: boolean;
  holderSnapshots: HolderSnapshot[];
  allUniqueBuyers: Set<string>;
  lastCoordinatedSellTime: number;
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
 * - holder_velocity: Rate of new unique holders is accelerating
 * - coordinated_sell: Multiple wallets dumping simultaneously (exit signal)
 * - creator_sell: Creator wallet is selling (exit signal)
 * - graduation: Token graduated from bonding curve
 * - alpha_wallet: A wallet discovered via first-buyer tracking bought
 */
export class SignalEngine {
  private config: BotConfig;
  private kolDiscovery: KolDiscovery;
  private tokenStates: Map<string, TokenState> = new Map();

  /** Wallets auto-discovered as consistently early in winning tokens */
  private alphaWallets: Map<string, { hits: number; misses: number; lastSeen: number }> = new Map();

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
      creator: token.traderPublicKey,
      createdAt: Date.now(),
      trades: [],
      currentMarketCapSol: token.marketCapSol,
      marketCapAtFirstSeen: token.marketCapSol,
      kolBuys: new Set(),
      bondingCurvePercent,
      previousBondingCurvePercent: bondingCurvePercent,
      bondingCurveSnapshotTime: Date.now(),
      vTokensInBondingCurve: token.vTokensInBondingCurve,
      graduated: false,
      creatorSold: false,
      holderSnapshots: [{ timestamp: Date.now(), uniqueHolders: 0 }],
      allUniqueBuyers: new Set(),
      lastCoordinatedSellTime: 0,
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
   * Mark a token as graduated (called from bot.ts when migration event fires)
   */
  markGraduated(mint: string) {
    const state = this.tokenStates.get(mint);
    if (state) {
      state.graduated = true;
      state.bondingCurvePercent = 100;
    }
  }

  /**
   * Get the creator wallet for a token (for monitoring)
   */
  getCreator(mint: string): string | null {
    return this.tokenStates.get(mint)?.creator ?? null;
  }

  /**
   * Check if creator has sold
   */
  hasCreatorSold(mint: string): boolean {
    return this.tokenStates.get(mint)?.creatorSold ?? false;
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
        creator: "",
        createdAt: Date.now(),
        trades: [],
        currentMarketCapSol: trade.marketCapSol,
        marketCapAtFirstSeen: trade.marketCapSol,
        kolBuys: new Set(),
        bondingCurvePercent: this.calculateBondingCurvePercent(trade.vTokensInBondingCurve),
        previousBondingCurvePercent: 0,
        bondingCurveSnapshotTime: Date.now(),
        vTokensInBondingCurve: trade.vTokensInBondingCurve,
        graduated: false,
        creatorSold: false,
        holderSnapshots: [{ timestamp: Date.now(), uniqueHolders: 0 }],
        allUniqueBuyers: new Set(),
        lastCoordinatedSellTime: 0,
      };
      this.tokenStates.set(trade.mint, state);
    }

    // Snapshot bonding curve for velocity calculation (every 60s)
    const now = Date.now();
    if (now - state.bondingCurveSnapshotTime >= ONE_MINUTE_MS) {
      state.previousBondingCurvePercent = state.bondingCurvePercent;
      state.bondingCurveSnapshotTime = now;
    }

    // Update bonding curve progress
    state.vTokensInBondingCurve = trade.vTokensInBondingCurve;
    state.bondingCurvePercent = this.calculateBondingCurvePercent(trade.vTokensInBondingCurve);

    // Track unique buyers for holder velocity
    if (trade.txType === "buy") {
      state.allUniqueBuyers.add(trade.traderPublicKey);
      // Take holder snapshots every minute
      const lastSnapshot = state.holderSnapshots[state.holderSnapshots.length - 1];
      if (now - lastSnapshot.timestamp >= ONE_MINUTE_MS) {
        state.holderSnapshots.push({ timestamp: now, uniqueHolders: state.allUniqueBuyers.size });
        // Keep only last 15 minutes of snapshots
        if (state.holderSnapshots.length > 15) {
          state.holderSnapshots.shift();
        }
      }
    }

    // Record the trade
    state.trades.push({
      trader: trade.traderPublicKey,
      action: trade.txType,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      marketCapSol: trade.marketCapSol,
      timestamp: now,
    });
    state.currentMarketCapSol = trade.marketCapSol;

    // Trim old trades to save memory (keep last 30 min)
    const cutoff = now - 30 * 60 * 1000;
    state.trades = state.trades.filter((t) => t.timestamp > cutoff);

    // Check for signals
    const signals: Signal[] = [];

    // === Creator sell detection ===
    if (trade.txType === "sell" && trade.traderPublicKey === state.creator && !state.creatorSold) {
      state.creatorSold = true;
      signals.push({
        type: "creator_sell",
        mint: trade.mint,
        strength: 90,
        details: `Creator ${state.creator.slice(0, 8)}... sold ${trade.solAmount.toFixed(2)} SOL`,
        timestamp: now,
      });
      log.scam(`${state.symbol}: CREATOR SELLING — ${trade.solAmount.toFixed(2)} SOL`);
    }

    // === KOL buy signal (with performance-weighted strength) ===
    if (trade.txType === "buy" && this.kolDiscovery.isKol(trade.traderPublicKey)) {
      state.kolBuys.add(trade.traderPublicKey);
      const kolWeight = this.kolDiscovery.getKolWeight(trade.traderPublicKey);
      const kol = this.kolDiscovery.getKol(trade.traderPublicKey);
      const baseStrength = Math.min(100, state.kolBuys.size * 60);
      signals.push({
        type: "kol_buy",
        mint: trade.mint,
        strength: Math.min(100, Math.round(baseStrength * kolWeight)),
        details: `KOL ${kol?.alias ?? trade.traderPublicKey.slice(0, 8)}... bought ${trade.solAmount.toFixed(2)} SOL (score: ${kol?.score ?? "??"})`,
        timestamp: now,
      });
      this.kolDiscovery.getKol(trade.traderPublicKey)!.lastActive = now;
      this.kolDiscovery.save();
      log.kol(
        `${state.symbol}: KOL buy — ${kol?.alias ?? trade.traderPublicKey.slice(0, 8)}... (${trade.solAmount.toFixed(2)} SOL, weight: ${kolWeight.toFixed(1)}x)`
      );
    }

    // === Alpha wallet signal (auto-discovered wallets) ===
    if (trade.txType === "buy") {
      const alpha = this.alphaWallets.get(trade.traderPublicKey);
      if (alpha && alpha.hits >= 3) {
        const hitRate = alpha.hits / (alpha.hits + alpha.misses);
        if (hitRate >= 0.3) {
          signals.push({
            type: "alpha_wallet",
            mint: trade.mint,
            strength: Math.min(100, Math.round(hitRate * 80)),
            details: `Auto-discovered alpha wallet (${alpha.hits} hits, ${(hitRate * 100).toFixed(0)}% rate)`,
            timestamp: now,
          });
          log.signal(`${state.symbol}: Alpha wallet buy — ${trade.traderPublicKey.slice(0, 8)}... (${alpha.hits} hits)`);
        }
      }
    }

    // === Coordinated sell detection (ratio-aware with cooldown) ===
    // Only fire if sell pressure actually dominates buy pressure, not just because
    // an active token has normal two-sided volume. 30s cooldown prevents log spam.
    if (now - state.lastCoordinatedSellTime >= 30_000) {
      const recentSells = state.trades.filter(
        (t) => t.action === "sell" && now - t.timestamp < 10_000
      );
      const uniqueRecentSellers = new Set(recentSells.map((t) => t.trader));
      const recentSellVolume = recentSells.reduce((s, t) => s + t.solAmount, 0);

      const recentBuys = state.trades.filter(
        (t) => t.action === "buy" && now - t.timestamp < 10_000
      );
      const uniqueRecentBuyers = new Set(recentBuys.map((t) => t.trader));
      const recentBuyVolume = recentBuys.reduce((s, t) => s + t.solAmount, 0);

      // Require: 8+ unique sellers, sell volume > 2x buy volume,
      // AND sellers clearly outnumber buyers by 3+.
      // Previous thresholds (5 sellers, 1.5x) were too sensitive for active tokens.
      if (
        uniqueRecentSellers.size >= 8 &&
        recentSellVolume > recentBuyVolume * 2 &&
        uniqueRecentSellers.size >= uniqueRecentBuyers.size + 3
      ) {
        const sellDominance = recentBuyVolume > 0 ? recentSellVolume / recentBuyVolume : 10;
        const strength = Math.min(100, Math.round(sellDominance * 20 + uniqueRecentSellers.size * 5));
        signals.push({
          type: "coordinated_sell",
          mint: trade.mint,
          strength,
          details: `${uniqueRecentSellers.size} sellers vs ${uniqueRecentBuyers.size} buyers, sell/buy ratio ${sellDominance.toFixed(1)}x in 10s`,
          timestamp: now,
        });
        log.signal(`${state.symbol}: COORDINATED SELL — ${uniqueRecentSellers.size} sellers (${recentSellVolume.toFixed(2)} SOL) vs ${uniqueRecentBuyers.size} buyers (${recentBuyVolume.toFixed(2)} SOL)`);
        state.lastCoordinatedSellTime = now;
      }
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
    // Ratio >= 1.2 is healthy; active tokens always have sell-side volume
    if (
      recentBuyers.size >= this.config.min5mBuyers &&
      buyToSellRatio >= 1.2
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

    // Bonding curve signal — weight tokens approaching graduation more heavily
    if (
      state.bondingCurvePercent >= this.config.minBondingCurvePercent &&
      state.bondingCurvePercent <= this.config.maxBondingCurvePercent
    ) {
      // Sweet spot shifted to 50-80% (approaching graduation = strong demand)
      let strength: number;
      if (state.bondingCurvePercent >= 50 && state.bondingCurvePercent <= 80) {
        strength = 70 + (state.bondingCurvePercent - 50); // 70-100
      } else {
        const distFromOptimal = Math.min(
          Math.abs(state.bondingCurvePercent - 50),
          Math.abs(state.bondingCurvePercent - 80)
        );
        strength = Math.max(20, 70 - distFromOptimal * 2);
      }
      signals.push({
        type: "bonding_curve",
        mint,
        strength: Math.min(100, strength),
        details: `Bonding curve: ${state.bondingCurvePercent.toFixed(1)}% complete`,
        timestamp: now,
      });
    }

    // === Bonding curve velocity signal (separate type to avoid double-weighting) ===
    if (state.bondingCurveSnapshotTime > state.createdAt) {
      const bcVelocity = state.bondingCurvePercent - state.previousBondingCurvePercent;
      if (bcVelocity > 5) {
        // Curve filled 5%+ in the last minute = high demand
        const strength = Math.min(100, bcVelocity * 10);
        signals.push({
          type: "bonding_curve_velocity",
          mint,
          strength,
          details: `Curve velocity: +${bcVelocity.toFixed(1)}%/min (rapid filling)`,
          timestamp: now,
        });
      }
    }

    // === Holder velocity signal ===
    if (state.holderSnapshots.length >= 2) {
      const latest = state.holderSnapshots[state.holderSnapshots.length - 1];
      // Compare to 3 minutes ago (or earliest available)
      const compareIdx = Math.max(0, state.holderSnapshots.length - 4);
      const earlier = state.holderSnapshots[compareIdx];
      const timeDiffMin = (latest.timestamp - earlier.timestamp) / ONE_MINUTE_MS;

      if (timeDiffMin > 0) {
        const newHoldersPerMin = (latest.uniqueHolders - earlier.uniqueHolders) / timeDiffMin;

        if (newHoldersPerMin >= 3) {
          // 3+ new holders per minute = strong organic growth
          const strength = Math.min(100, newHoldersPerMin * 10);
          signals.push({
            type: "holder_velocity",
            mint,
            strength,
            details: `${newHoldersPerMin.toFixed(1)} new holders/min (${latest.uniqueHolders} total)`,
            timestamp: now,
          });
        }
      }
    }

    // Aggregate score with updated weights
    let aggregateScore = 0;
    for (const signal of signals) {
      switch (signal.type) {
        case "kol_buy":
          aggregateScore += signal.strength * 0.25; // strong indicator — smart money edge
          break;
        case "volume_spike":
          aggregateScore += signal.strength * 0.15;
          break;
        case "momentum":
          aggregateScore += signal.strength * 0.15;
          break;
        case "trend":
          aggregateScore += signal.strength * 0.10;
          break;
        case "bonding_curve":
          aggregateScore += signal.strength * 0.08;
          break;
        case "bonding_curve_velocity":
          aggregateScore += signal.strength * 0.02;
          break;
        case "holder_velocity":
          aggregateScore += signal.strength * 0.13;
          break;
        case "alpha_wallet":
          aggregateScore += signal.strength * 0.12; // auto-discovered smart money
          break;
        // Negative signals reduce score (moderate penalty — active tokens have sells)
        case "coordinated_sell":
          aggregateScore -= signal.strength * 0.15;
          break;
        case "creator_sell":
          aggregateScore -= signal.strength * 0.20;
          break;
        default:
          break;
      }
    }
    aggregateScore = Math.max(0, Math.min(100, aggregateScore));

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

    // Creator sold = significant penalty, but NOT a hard zero.
    // "No dev" tokens (where creator sold early) can still run if momentum is strong.
    // The creator_sell signal already subtracts via the weighted scoring above.

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

    if (momentum.aggregateScore < 50) {
      return {
        shouldBuy: false,
        momentum,
        reason: `Score too low: ${momentum.aggregateScore}/100 (need 50+)`,
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
   * Record trade outcome for first-buyer tracking (auto wallet discovery).
   * Called when a position closes to record which early buyers were in winning tokens.
   */
  recordOutcome(mint: string, profitable: boolean) {
    const state = this.tokenStates.get(mint);
    if (!state) return;

    // Get the first 20 buyers of this token
    const earlyBuyers = new Set<string>();
    for (const trade of state.trades) {
      if (trade.action === "buy") {
        earlyBuyers.add(trade.trader);
        if (earlyBuyers.size >= 20) break;
      }
    }

    // Update alpha wallet scores
    for (const wallet of earlyBuyers) {
      // Skip known KOLs (they're already tracked)
      if (this.kolDiscovery.isKol(wallet)) continue;
      // Skip the creator
      if (wallet === state.creator) continue;

      let profile = this.alphaWallets.get(wallet);
      if (!profile) {
        profile = { hits: 0, misses: 0, lastSeen: Date.now() };
        this.alphaWallets.set(wallet, profile);
      }

      if (profitable) {
        profile.hits++;
      } else {
        profile.misses++;
      }
      profile.lastSeen = Date.now();
    }

    // Prune alpha wallets that haven't been seen in 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [addr, profile] of this.alphaWallets) {
      if (profile.lastSeen < weekAgo) {
        this.alphaWallets.delete(addr);
      }
    }
  }

  /**
   * Get count of auto-discovered alpha wallets
   */
  getAlphaWalletCount(): number {
    let count = 0;
    for (const [, profile] of this.alphaWallets) {
      if (profile.hits >= 3 && profile.hits / (profile.hits + profile.misses) >= 0.3) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the bonding curve percent for a token
   */
  getBondingCurvePercent(mint: string): number {
    return this.tokenStates.get(mint)?.bondingCurvePercent ?? 0;
  }

  /**
   * Check if KOLs have bought this token recently (within lastSeconds)
   */
  hasRecentKolBuys(mint: string, lastSeconds: number = 300, minSolAmount: number = 0.5): boolean {
    const state = this.tokenStates.get(mint);
    if (!state) return false;
    const cutoff = Date.now() - lastSeconds * 1000;
    // Check trades for recent KOL buys — filter dust buys (bait signals)
    return state.trades.some(
      (t) => t.timestamp >= cutoff && t.action === "buy" && t.solAmount >= minSolAmount && this.kolDiscovery.isKol(t.trader)
    );
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
  cleanup(maxAgeMs: number = 30 * 60 * 1000, preserveMints?: Set<string>) {
    const now = Date.now();
    for (const [mint, state] of this.tokenStates) {
      if (now - state.createdAt > maxAgeMs && !preserveMints?.has(mint)) {
        this.tokenStates.delete(mint);
      }
    }
  }
}
