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
  uri: string; // metadata URI for social link verification
}

interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  [key: string]: unknown;
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
      uri: token.uri ?? "",
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
    // Default to UNSAFE — if we can't check, assume the worst
    let mintAuthorityEnabled = true;
    let freezeAuthorityEnabled = true;
    let authorityCheckSucceeded = false;
    let tokenTotalSupply = 0; // used later for holder concentration
    let tokenDecimals = 0;
    try {
      const mintPk = new PublicKey(mint);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPk);
      if (mintInfo.value) {
        const data = (mintInfo.value.data as any)?.parsed?.info;
        if (data) {
          mintAuthorityEnabled = data.mintAuthority !== null;
          freezeAuthorityEnabled = data.freezeAuthority !== null;
          authorityCheckSucceeded = true;
          // Extract total supply for holder concentration check
          tokenTotalSupply = parseFloat(data.supply ?? "0");
          tokenDecimals = data.decimals ?? 0;
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch mint info for ${mint} — assuming unsafe: ${err}`);
    }
    if (!authorityCheckSucceeded) {
      reasons.push("Could not verify mint/freeze authority (RPC failure)");
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
        // Use actual total supply from mint account (not sum of top-20 accounts,
        // which would make concentration always ~100%)
        const actualTotalSupplyUi = tokenDecimals > 0
          ? tokenTotalSupply / Math.pow(10, tokenDecimals)
          : tokenTotalSupply;
        // Fallback to sum of returned accounts if we couldn't get total supply
        const denominator = actualTotalSupplyUi > 0
          ? actualTotalSupplyUi
          : accounts.reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);

        if (denominator > 0) {
          const top5 = accounts
            .slice(0, 5)
            .reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
          topHolderConcentration = (top5 / denominator) * 100;
        }
      }
    } catch (err) {
      log.debug(`Failed to fetch holder data for ${mint}: ${err}`);
      topHolderConcentration = 100; // Assume worst case
    }

    // Use a relaxed concentration threshold for young tokens — pump.fun tokens
    // naturally start concentrated and spread out as they gain traction.
    // Under 1 min: allow up to 95% (brand new, only a few holders expected).
    // 1-3 min: allow up to 80%. After 3 min: use config value (default 50%).
    const tokenAgeSeconds = (Date.now() - history.createdAt) / 1000;
    const effectiveMaxHolder = tokenAgeSeconds < 60
      ? 95
      : tokenAgeSeconds < 180
        ? Math.max(this.config.maxTopHolderPercent, 80)
        : this.config.maxTopHolderPercent;

    if (topHolderConcentration > effectiveMaxHolder) {
      reasons.push(
        `Top 5 holders own ${topHolderConcentration.toFixed(1)}% (max: ${effectiveMaxHolder}%)`
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
    // On pump.fun, creators commonly buy 5-10% — only flag above 15%
    if (history.initialBuyPercent > 15) {
      reasons.push(`Creator grabbed ${history.initialBuyPercent.toFixed(1)}% of supply at launch`);
    }

    // === Check 10: Social media verification ===
    // Tokens with zero social presence (no twitter/telegram/website) are
    // much more likely to be throwaway rug pulls. Require at least 1 social link.
    let hasSocials = false;
    let socialCount = 0;
    const metadata = await this.fetchMetadata(history.uri);
    if (metadata) {
      if (metadata.twitter && metadata.twitter.trim().length > 5) socialCount++;
      if (metadata.telegram && metadata.telegram.trim().length > 5) socialCount++;
      if (metadata.website && metadata.website.trim().length > 5) socialCount++;
      hasSocials = socialCount > 0;
      if (!hasSocials) {
        reasons.push("No social links in metadata (no twitter/telegram/website)");
      }
    } else {
      // Couldn't fetch metadata — treat as no socials (penalty but not hard block)
      reasons.push("Could not fetch metadata URI — no social verification possible");
    }

    // === Scoring ===
    const holderDistScore = Math.max(0, 100 - topHolderConcentration);
    const volumeScore = suspectedWashTrading ? 20 : bundledLaunch ? 30 : microBuySwarming ? 40 : 80;
    const creatorScore = creatorIsSerial ? 10 : 70;

    // Social score: 0 socials = 0, 1 = 50, 2 = 80, 3 = 100
    const socialScore = socialCount === 0 ? 0 : socialCount === 1 ? 50 : socialCount === 2 ? 80 : 100;

    // Penalties
    let overallSafety =
      holderDistScore * 0.25 + volumeScore * 0.25 + creatorScore * 0.2 + socialScore * 0.15;
    if (mintAuthorityEnabled) overallSafety -= 30;
    if (freezeAuthorityEnabled) overallSafety -= 20;
    if (lowUniqueHolders) overallSafety -= 15;
    // No extra penalty — socialScore=0 already costs ~15 points from the weighted formula
    overallSafety = Math.max(0, Math.min(100, overallSafety));

    // Hard fail = truly disqualifying issues (authority abuse, serial deployers)
    // Soft flags (wash trading, micro-buys, holder concentration, no socials) just lower the score
    // but don't outright block — many legit pump.fun meme coins launch without socials.
    const hardFail =
      (mintAuthorityEnabled && this.config.requireMintRevoked) ||
      (freezeAuthorityEnabled && this.config.requireFreezeRevoked) ||
      creatorIsSerial;

    // Filter out soft reasons that should not hard-block on their own.
    // Active tokens naturally have two-sided trading, concentrated early holders,
    // and creators buying supply. Only truly disqualifying issues (authority, serial
    // deployers) should hard-block.
    const softPatterns = [
      "Suspected wash trading",
      "Micro-buy swarming",
      "Creator grabbed",
      "unique buyers",
      "No social links",
      "Could not fetch metadata",
    ];
    const hardReasons = reasons.filter(r => !softPatterns.some(p => r.includes(p)));
    const passed = !hardFail && hardReasons.length === 0;

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
   * Detect wash trading: same wallets appearing on both buy and sell sides.
   * Relaxed: on active tokens, some buy/sell overlap is NORMAL (profit-taking).
   * Only flag when there's overwhelming overlap from very few wallets.
   */
  private detectWashTrading(history: TokenTradeHistory): boolean {
    const buyerSet = history.uniqueBuyers;
    const sellerSet = history.uniqueSellers;

    // Need a meaningful sample — don't flag tiny token pools
    if (buyerSet.size < 8) return false;

    // Count wallets that both bought and sold
    let overlapCount = 0;
    for (const buyer of buyerSet) {
      if (sellerSet.has(buyer)) overlapCount++;
    }

    // If more than 60% of buyers are also sellers, suspicious
    // (30% was too aggressive — normal tokens have profit-takers)
    if (overlapCount / buyerSet.size > 0.6) {
      return true;
    }

    // Check for repeated small trades of identical amounts (volume bot pattern)
    // Require 15+ identical trades (10 was too sensitive for common amounts like 0.1 SOL)
    const recentTrades = history.trades.slice(-50);
    const amountCounts = new Map<string, number>();
    for (const trade of recentTrades) {
      // Only flag micro-amounts (<0.05 SOL) — normal traders can have similar amounts
      if (trade.solAmount < 0.05) {
        const key = trade.solAmount.toFixed(6);
        amountCounts.set(key, (amountCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [, count] of amountCounts) {
      if (count >= 15) {
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

    // Creator buying at launch is normal on pump.fun — only flag if creator
    // bought alongside many other wallets with suspiciously similar amounts
    const creatorBoughtAtLaunch = launchTrades.some(
      (t) => t.trader === history.creatorWallet
    );
    if (creatorBoughtAtLaunch && uniqueLaunchBuyers.size >= 6) {
      return true;
    }

    return false;
  }

  /**
   * Detect micro-buy swarming: many tiny buys (< 0.005 SOL) from different wallets
   * to simulate organic activity. Common bot pattern.
   * Relaxed from <0.01 to <0.005 — many real users buy tiny amounts on pump.fun.
   */
  private detectMicroBuySwarming(history: TokenTradeHistory): boolean {
    const recentBuys = history.trades.filter(t => t.action === "buy");
    if (recentBuys.length < 15) return false;

    const microBuys = recentBuys.filter(t => t.solAmount < 0.005);
    const microBuyWallets = new Set(microBuys.map(t => t.trader));

    // If >70% of buys are micro-buys from 12+ different wallets, it's suspicious
    if (microBuys.length > recentBuys.length * 0.7 && microBuyWallets.size >= 12) {
      return true;
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
    // On pump.fun, 5-15% is normal. Only instant-reject above 25%.
    if (token.initialBuy > 0 && token.marketCapSol > 0) {
      const creatorPercent = (token.initialBuy / token.vTokensInBondingCurve) * 100;
      if (creatorPercent > 25) {
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
   * Fetch and parse a token's metadata URI (pump.fun JSON with social links).
   * Returns null if fetch fails or JSON is invalid — caller handles the penalty.
   */
  private async fetchMetadata(uri: string): Promise<TokenMetadata | null> {
    if (!uri || uri.trim() === "") return null;

    try {
      // Convert IPFS URIs to HTTP gateway
      let fetchUrl = uri;
      if (uri.startsWith("ipfs://")) {
        fetchUrl = `https://ipfs.io/ipfs/${uri.slice(7)}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

      const response = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.debug(`Metadata fetch failed for ${uri.slice(0, 60)}: HTTP ${response.status}`);
        return null;
      }

      const json = await response.json() as TokenMetadata;
      return json;
    } catch (err: any) {
      log.debug(`Metadata fetch error for ${uri.slice(0, 60)}: ${err.message ?? err}`);
      return null;
    }
  }

  /**
   * Cleanup old token histories to free memory
   */
  cleanup(maxAgeMs: number = 30 * 60 * 1000, preserveMints?: Set<string>) {
    const now = Date.now();
    for (const [mint, history] of this.tokenHistories) {
      if (now - history.createdAt > maxAgeMs && !preserveMints?.has(mint)) {
        this.tokenHistories.delete(mint);
      }
    }
  }
}
