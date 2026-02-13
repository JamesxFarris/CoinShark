import { Connection, PublicKey } from "@solana/web3.js";
import { ScamAnalysis, BotConfig, PumpPortalNewToken, PumpPortalTrade } from "./types";
import { log } from "./logger";

/**
 * Tracks per-token trade history for wash trading / bundle detection
 */
interface TokenTradeHistory {
  trades: Array<{
    trader: string;
    action: "buy" | "sell";
    solAmount: number;
    timestamp: number;
  }>;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  creatorWallet: string;
  createdAt: number;
  initialBuyPercent: number;
}

/**
 * ScamFilter performs on-chain analysis to detect scam tokens.
 *
 * Detection methods:
 * 1. Mint/Freeze authority checks — if creator retains these, they can rug
 * 2. Holder concentration — if top wallets hold >X%, likely coordinated
 * 3. Wash trading detection — same wallets buying/selling repeatedly
 * 4. Bundle detection — many buys from fresh wallets at launch
 * 5. Creator history — serial deployers who launch and dump repeatedly
 * 6. Microbuys — many tiny buys from different wallets to fake organic activity
 * 7. Token age — extremely new tokens are highest risk
 */
export class ScamFilter {
  private connection: Connection;
  private config: BotConfig;
  private tokenHistories: Map<string, TokenTradeHistory> = new Map();
  private knownScamCreators: Set<string> = new Set();
  private creatorTokenCount: Map<string, number> = new Map();

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection;
    this.config = config;
  }

  /**
   * Register a new token for tracking
   */
  registerToken(token: PumpPortalNewToken) {
    const initialBuyPercent = token.vTokensInBondingCurve > 0
      ? (token.initialBuy / token.vTokensInBondingCurve) * 100
      : 0;
    this.tokenHistories.set(token.mint, {
      trades: [],
      uniqueBuyers: new Set(),
      uniqueSellers: new Set(),
      creatorWallet: token.traderPublicKey,
      createdAt: Date.now(),
      initialBuyPercent,
    });

    // Track how many tokens this creator has launched
    const count = (this.creatorTokenCount.get(token.traderPublicKey) ?? 0) + 1;
    this.creatorTokenCount.set(token.traderPublicKey, count);

    if (count >= 5) {
      this.knownScamCreators.add(token.traderPublicKey);
      log.scam(
        `Serial deployer detected: ${token.traderPublicKey.slice(0, 8)}... (${count} tokens)`
      );
    }
  }

  /**
   * Record a trade for pattern analysis
   */
  recordTrade(trade: PumpPortalTrade) {
    const history = this.tokenHistories.get(trade.mint);
    if (!history) return;

    history.trades.push({
      trader: trade.traderPublicKey,
      action: trade.txType,
      solAmount: trade.solAmount,
      timestamp: Date.now(),
    });

    if (trade.txType === "buy") {
      history.uniqueBuyers.add(trade.traderPublicKey);
    } else {
      history.uniqueSellers.add(trade.traderPublicKey);
    }
  }

  /**
   * Run full scam analysis on a token. Returns pass/fail with detailed scoring.
   */
  async analyze(mint: string): Promise<ScamAnalysis> {
    const reasons: string[] = [];
    const history = this.tokenHistories.get(mint);

    // Default result for unknown tokens
    if (!history) {
      return {
        mint,
        passed: false,
        reasons: ["No trade history available — token not tracked"],
        scores: {
          holderDistribution: 0,
          volumeAuthenticity: 0,
          creatorTrust: 0,
          overallSafety: 0,
        },
        flags: {
          mintAuthorityEnabled: false,
          freezeAuthorityEnabled: false,
          topHolderConcentration: 100,
          suspectedWashTrading: false,
          bundledLaunch: false,
          creatorIsSerial: false,
          lowUniqueHolders: true,
        },
      };
    }

    // === Check 1: Token age ===
    const ageSeconds = (Date.now() - history.createdAt) / 1000;
    if (ageSeconds < this.config.minTokenAgeSeconds) {
      reasons.push(`Token too new (${ageSeconds.toFixed(0)}s < ${this.config.minTokenAgeSeconds}s minimum)`);
    }

    // === Check 2: Mint/Freeze authority ===
    let mintAuthorityEnabled = false;
    let freezeAuthorityEnabled = false;
    try {
      const mintPk = new PublicKey(mint);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPk);
      if (mintInfo.value) {
        const data = (mintInfo.value.data as any)?.parsed?.info;
        if (data) {
          mintAuthorityEnabled = data.mintAuthority !== null;
          freezeAuthorityEnabled = data.freezeAuthority !== null;
        }
      }
    } catch (err) {
      log.debug(`Failed to fetch mint info for ${mint}: ${err}`);
    }

    if (mintAuthorityEnabled && this.config.requireMintRevoked) {
      reasons.push("Mint authority NOT revoked — creator can mint unlimited tokens");
    }
    if (freezeAuthorityEnabled && this.config.requireFreezeRevoked) {
      reasons.push("Freeze authority NOT revoked — creator can freeze trading");
    }

    // === Check 3: Serial deployer ===
    const creatorIsSerial = this.knownScamCreators.has(history.creatorWallet);
    if (creatorIsSerial) {
      const count = this.creatorTokenCount.get(history.creatorWallet) ?? 0;
      reasons.push(`Creator has launched ${count} tokens (serial deployer pattern)`);
    }

    // === Check 4: Holder concentration ===
    let topHolderConcentration = 0;
    try {
      const mintPk = new PublicKey(mint);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPk);
      const accounts = largestAccounts.value;

      if (accounts.length > 0) {
        // Sum of top 5 holders as percentage
        const totalSupply = accounts.reduce(
          (sum, a) => sum + (a.uiAmount ?? 0),
          0
        );
        if (totalSupply > 0) {
          const top5 = accounts
            .slice(0, 5)
            .reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
          topHolderConcentration = (top5 / totalSupply) * 100;
        }
      }
    } catch (err) {
      log.debug(`Failed to fetch holder data for ${mint}: ${err}`);
      topHolderConcentration = 100; // Assume worst case
    }

    if (topHolderConcentration > this.config.maxTopHolderPercent) {
      reasons.push(
        `Top 5 holders own ${topHolderConcentration.toFixed(1)}% (max: ${this.config.maxTopHolderPercent}%)`
      );
    }

    // === Check 5: Unique holders ===
    const lowUniqueHolders = history.uniqueBuyers.size < this.config.minUniqueHolders;
    if (lowUniqueHolders) {
      reasons.push(
        `Only ${history.uniqueBuyers.size} unique buyers (min: ${this.config.minUniqueHolders})`
      );
    }

    // === Check 6: Wash trading detection ===
    const suspectedWashTrading = this.detectWashTrading(history);
    if (suspectedWashTrading) {
      reasons.push("Suspected wash trading detected (same wallets buying and selling)");
    }

    // === Check 7: Bundle detection ===
    const bundledLaunch = this.detectBundledLaunch(history);
    if (bundledLaunch) {
      reasons.push("Bundled launch detected (many buys from fresh wallets at creation)");
    }

    // === Check 8: Micro-buy swarming (fake activity from tiny buys) ===
    const microBuySwarming = this.detectMicroBuySwarming(history);
    if (microBuySwarming) {
      reasons.push("Micro-buy swarming detected (many tiny buys to fake activity)");
    }

    // === Check 9: Creator initial supply grab ===
    if (history.initialBuyPercent > 5) {
      reasons.push(`Creator grabbed ${history.initialBuyPercent.toFixed(1)}% of supply at launch`);
    }

    // === Scoring ===
    const holderDistScore = Math.max(0, 100 - topHolderConcentration);
    const volumeScore = suspectedWashTrading ? 20 : bundledLaunch ? 30 : microBuySwarming ? 40 : 80;
    const creatorScore = creatorIsSerial ? 10 : 70;

    // Penalties
    let overallSafety =
      holderDistScore * 0.3 + volumeScore * 0.3 + creatorScore * 0.2;
    if (mintAuthorityEnabled) overallSafety -= 30;
    if (freezeAuthorityEnabled) overallSafety -= 20;
    if (lowUniqueHolders) overallSafety -= 15;
    overallSafety = Math.max(0, Math.min(100, overallSafety));

    // A token with any of the authority flags still on is an auto-fail
    const hardFail =
      (mintAuthorityEnabled && this.config.requireMintRevoked) ||
      (freezeAuthorityEnabled && this.config.requireFreezeRevoked) ||
      creatorIsSerial;

    const passed = !hardFail && reasons.length === 0;

    return {
      mint,
      passed,
      reasons,
      scores: {
        holderDistribution: Math.round(holderDistScore),
        volumeAuthenticity: volumeScore,
        creatorTrust: creatorScore,
        overallSafety: Math.round(overallSafety),
      },
      flags: {
        mintAuthorityEnabled,
        freezeAuthorityEnabled,
        topHolderConcentration,
        suspectedWashTrading,
        bundledLaunch,
        creatorIsSerial,
        lowUniqueHolders,
      },
    };
  }

  /**
   * Detect wash trading: same wallets appearing on both buy and sell sides
   */
  private detectWashTrading(history: TokenTradeHistory): boolean {
    const buyerSet = history.uniqueBuyers;
    const sellerSet = history.uniqueSellers;

    // Count wallets that both bought and sold
    let overlapCount = 0;
    for (const buyer of buyerSet) {
      if (sellerSet.has(buyer)) overlapCount++;
    }

    // If more than 30% of buyers are also sellers, suspicious
    if (buyerSet.size > 3 && overlapCount / buyerSet.size > 0.3) {
      return true;
    }

    // Check for repeated small trades of identical amounts (volume bot pattern)
    const recentTrades = history.trades.slice(-50);
    const amountCounts = new Map<string, number>();
    for (const trade of recentTrades) {
      const key = trade.solAmount.toFixed(6);
      amountCounts.set(key, (amountCounts.get(key) ?? 0) + 1);
    }
    for (const [amount, count] of amountCounts) {
      if (count >= 10) {
        // 10+ trades of the exact same amount = likely bot
        return true;
      }
    }

    return false;
  }

  /**
   * Detect bundled launches: many buys in the first few seconds from different wallets.
   * This is a signature move of scammers who use multiple wallets to grab supply.
   */
  private detectBundledLaunch(history: TokenTradeHistory): boolean {
    const LAUNCH_WINDOW_MS = 5000; // first 5 seconds
    const launchTrades = history.trades.filter(
      (t) =>
        t.action === "buy" &&
        t.timestamp - history.createdAt < LAUNCH_WINDOW_MS
    );

    const uniqueLaunchBuyers = new Set(launchTrades.map((t) => t.trader));

    // 5+ different wallets buying in the first 5 seconds is suspicious
    if (uniqueLaunchBuyers.size >= 5) {
      // Check if the buy amounts are very similar (coordinated)
      if (launchTrades.length >= 5) {
        const amounts = launchTrades.map((t) => t.solAmount);
        const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
        const variance =
          amounts.reduce((s, a) => s + Math.pow(a - avg, 2), 0) /
          amounts.length;
        const stddev = Math.sqrt(variance);

        // Low variance in buy amounts = coordinated
        if (avg > 0 && stddev / avg < 0.3) {
          return true;
        }
      }
    }

    // Also flag if creator wallet bought alongside other wallets
    const creatorBoughtAtLaunch = launchTrades.some(
      (t) => t.trader === history.creatorWallet
    );
    if (creatorBoughtAtLaunch && uniqueLaunchBuyers.size >= 3) {
      return true;
    }

    return false;
  }

  /**
   * Detect micro-buy swarming: many tiny buys (< 0.01 SOL) from different wallets
   * to simulate organic activity. Common bot pattern.
   */
  private detectMicroBuySwarming(history: TokenTradeHistory): boolean {
    const recentBuys = history.trades.filter(t => t.action === "buy");
    if (recentBuys.length < 10) return false;

    const microBuys = recentBuys.filter(t => t.solAmount < 0.01);
    const microBuyWallets = new Set(microBuys.map(t => t.trader));

    // If >50% of buys are micro-buys from many different wallets, it's suspicious
    if (microBuys.length > recentBuys.length * 0.5 && microBuyWallets.size >= 8) {
      return true;
    }

    // Also check for rapid-fire buys (>20 buys in 30 seconds from different wallets)
    if (recentBuys.length >= 20) {
      const sorted = [...recentBuys].sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i <= sorted.length - 20; i++) {
        const window = sorted.slice(i, i + 20);
        const timeSpan = window[window.length - 1].timestamp - window[0].timestamp;
        const uniqueTraders = new Set(window.map(t => t.trader)).size;
        if (timeSpan < 30_000 && uniqueTraders >= 15) {
          return true;
        }
      }
    }

    return false;
  }

  // Common scam keywords in token names/symbols
  private static readonly SCAM_KEYWORDS = [
    "airdrop", "free", "claim", "presale", "whitelist",
    "guaranteed", "1000x", "moonshot", "safu", "based dev",
    "renounced", "locked", "anti-rug", "stealth launch",
    "doxxed", "audit", "certik",
  ];

  // Tokens that impersonate major assets
  private static readonly IMPERSONATION_NAMES = [
    "solana", "bitcoin", "ethereum", "bnb", "tether", "usdc", "usdt",
    "cardano", "dogecoin", "shiba", "pepe", "bonk", "wif",
    "jupiter", "raydium", "marinade", "jito", "pyth", "tensor",
  ];

  private static readonly IMPERSONATION_SYMBOLS = [
    "SOL", "BTC", "ETH", "BNB", "USDC", "USDT", "ADA",
    "DOGE", "SHIB", "PEPE", "BONK", "WIF", "JUP", "RAY", "JTO",
  ];

  /**
   * Quick pre-check before full analysis (fast rejection)
   */
  quickReject(token: PumpPortalNewToken): string | null {
    // Known scam creator
    if (this.knownScamCreators.has(token.traderPublicKey)) {
      return `Serial deployer: ${token.traderPublicKey.slice(0, 8)}...`;
    }

    // Suspiciously large initial buy (creator grabbing supply)
    if (token.initialBuy > 0 && token.marketCapSol > 0) {
      const creatorPercent = (token.initialBuy / token.vTokensInBondingCurve) * 100;
      if (creatorPercent > 10) {
        return `Creator grabbed ${creatorPercent.toFixed(1)}% of supply at launch`;
      }
    }

    // === Metadata red flags ===

    // Missing metadata URI (no image/description = likely throwaway scam)
    if (!token.uri || token.uri.trim() === "") {
      return "No metadata URI — likely throwaway token";
    }

    const nameLower = token.name.toLowerCase().trim();
    const symbolUpper = token.symbol.toUpperCase().trim();

    // Scam keywords in token name
    for (const keyword of ScamFilter.SCAM_KEYWORDS) {
      if (nameLower.includes(keyword)) {
        return `Scam keyword in name: "${keyword}"`;
      }
    }

    // Impersonation detection — exact symbol match with major tokens
    if (ScamFilter.IMPERSONATION_SYMBOLS.includes(symbolUpper)) {
      return `Impersonates ${symbolUpper} — exact symbol match`;
    }

    // Impersonation detection — name contains major project name
    for (const name of ScamFilter.IMPERSONATION_NAMES) {
      if (nameLower === name || nameLower.startsWith(name + " ") || nameLower.endsWith(" " + name)) {
        return `Impersonates ${name} — name match`;
      }
    }

    // Empty or single-char names are suspicious
    if (token.name.trim().length <= 1 || token.symbol.trim().length === 0) {
      return "Empty or single-char token name/symbol";
    }

    return null;
  }

  /**
   * Cleanup old token histories to free memory
   */
  cleanup(maxAgeMs: number = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [mint, history] of this.tokenHistories) {
      if (now - history.createdAt > maxAgeMs) {
        this.tokenHistories.delete(mint);
      }
    }
  }
}
