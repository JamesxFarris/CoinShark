import { BotConfig, PumpPortalNewToken, PumpPortalTrade } from "./types";
import { WalletManager } from "./wallet";
import { TokenScanner } from "./scanner";
import { ScamFilter } from "./scamFilter";
import { SignalEngine } from "./signalEngine";
import { Trader } from "./trader";
import { RiskManager } from "./riskManager";
import { log } from "./logger";

/**
 * CoinShark Bot — main orchestrator
 *
 * Pipeline: New Token → Scam Filter → Watch → Signal Engine → Trade Decision → Risk Management
 *
 * 1. Scanner detects new tokens on Pump.fun via WebSocket
 * 2. Scam filter does a quick reject on obvious scams
 * 3. Surviving tokens get watched for trading activity
 * 4. Signal engine evaluates momentum (KOL buys, volume, trends)
 * 5. If signals are strong enough, risk manager opens a position
 * 6. Risk manager monitors positions for TP/SL
 */
export class CoinSharkBot {
  private config: BotConfig;
  private wallet: WalletManager;
  private scanner: TokenScanner;
  private scamFilter: ScamFilter;
  private signalEngine: SignalEngine;
  private trader: Trader;
  private riskManager: RiskManager;

  private watchedTokens: Set<string> = new Set();
  private tokenSymbols: Map<string, string> = new Map();
  private isRunning = false;
  private stats = {
    tokensScanned: 0,
    tokensRejected: 0,
    tokensWatched: 0,
    tradesExecuted: 0,
    startTime: Date.now(),
  };

  constructor(config: BotConfig) {
    this.config = config;

    // Initialize components
    this.wallet = new WalletManager(config.solanaRpcUrl, config.privateKey);
    this.scanner = new TokenScanner();
    this.scamFilter = new ScamFilter(this.wallet.getConnection(), config);
    this.signalEngine = new SignalEngine(config);
    this.trader = new Trader(config, this.wallet);
    this.riskManager = new RiskManager(config, this.trader);
  }

  async start() {
    log.banner("CoinShark — Solana Pump.fun Trading Bot");

    // Print wallet info
    await this.wallet.printStatus();
    log.info(`Max bet: ${this.config.maxBetSol} SOL`);
    log.info(`Max positions: ${this.config.maxPositions}`);
    log.info(`TP1: +${this.config.takeProfit1Percent}% | TP2: +${this.config.takeProfit2Percent}% | SL: -${this.config.stopLossPercent}%`);

    if (this.config.kolWallets.length > 0) {
      log.kol(`Tracking ${this.config.kolWallets.length} KOL wallets`);
    } else {
      log.warn("No KOL wallets configured — KOL signal disabled");
    }

    // Wire up event handlers
    this.scanner.on("newToken", (token: PumpPortalNewToken) =>
      this.onNewToken(token)
    );
    this.scanner.on("trade", (trade: PumpPortalTrade) =>
      this.onTrade(trade)
    );
    this.scanner.on("fatal", (err: Error) => {
      log.error(`Fatal scanner error: ${err.message}`);
      this.stop();
    });

    // Subscribe to KOL wallet activity
    for (const kolWallet of this.signalEngine.getKolWallets()) {
      this.scanner.watchAccount(kolWallet);
    }

    // Connect to WebSocket
    this.scanner.connect();
    this.isRunning = true;

    // Periodic tasks
    this.startPeriodicTasks();

    log.info("Bot is running. Waiting for tokens...\n");
  }

  async stop() {
    log.warn("Shutting down...");
    this.isRunning = false;
    this.scanner.disconnect();

    // Close all positions on shutdown
    if (this.riskManager.positionCount > 0) {
      log.warn(`Closing ${this.riskManager.positionCount} open positions...`);
      await this.riskManager.closeAll("shutdown");
    }

    this.printStats();
    log.info("CoinShark stopped.");
  }

  /**
   * Handle a new token appearing on Pump.fun
   */
  private async onNewToken(token: PumpPortalNewToken) {
    this.stats.tokensScanned++;

    // Quick reject by scam filter
    const rejectReason = this.scamFilter.quickReject(token);
    if (rejectReason) {
      this.stats.tokensRejected++;
      log.scam(`REJECTED ${token.symbol} (${token.mint.slice(0, 8)}...): ${rejectReason}`);
      return;
    }

    // Register for tracking
    this.scamFilter.registerToken(token);
    this.signalEngine.registerToken(token);
    this.tokenSymbols.set(token.mint, token.symbol);

    // Watch this token's trades
    this.watchedTokens.add(token.mint);
    this.scanner.watchToken(token.mint);
    this.stats.tokensWatched++;

    log.info(
      `NEW: ${token.symbol} (${token.name}) | MCap: ${token.marketCapSol.toFixed(2)} SOL | ${token.mint.slice(0, 8)}...`
    );
  }

  /**
   * Handle a trade event on a watched token or KOL wallet
   */
  private async onTrade(trade: PumpPortalTrade) {
    // Feed the trade to scam filter and signal engine
    this.scamFilter.recordTrade(trade);
    const newSignals = this.signalEngine.processTrade(trade);

    // Log significant signals
    for (const signal of newSignals) {
      log.signal(
        `${this.tokenSymbols.get(trade.mint) ?? trade.mint.slice(0, 8)}: ` +
        `[${signal.type}] strength=${signal.strength} — ${signal.details}`
      );
    }

    // If we already have a position, update risk management
    if (this.riskManager.hasPosition(trade.mint)) {
      await this.riskManager.onTradeUpdate(trade);
      return;
    }

    // Check if we should open a new position
    if (!this.riskManager.canOpenPosition()) return;

    const { shouldBuy, momentum, reason } = this.signalEngine.shouldBuy(trade.mint);
    if (!shouldBuy || !momentum) return;

    // Run full scam analysis before committing real money
    log.info(`Evaluating ${this.tokenSymbols.get(trade.mint)} for purchase...`);
    const scamResult = await this.scamFilter.analyze(trade.mint);

    if (!scamResult.passed) {
      log.scam(
        `BLOCKED ${this.tokenSymbols.get(trade.mint)}: ${scamResult.reasons.join("; ")}`
      );
      // Stop watching this scam token
      this.unwatchToken(trade.mint);
      return;
    }

    log.signal(
      `BUY SIGNAL for ${this.tokenSymbols.get(trade.mint)}: ${reason} | Safety: ${scamResult.scores.overallSafety}/100`
    );

    // Execute the trade
    const symbol = this.tokenSymbols.get(trade.mint) ?? "???";
    const opened = await this.riskManager.openPosition(
      trade.mint,
      symbol,
      trade.marketCapSol,
      momentum.signals
    );

    if (opened) {
      this.stats.tradesExecuted++;
    }
  }

  /**
   * Stop watching a token (scam or graduated)
   */
  private unwatchToken(mint: string) {
    this.watchedTokens.delete(mint);
    this.scanner.unwatchToken(mint);
    this.tokenSymbols.delete(mint);
  }

  /**
   * Periodic cleanup and status logging
   */
  private startPeriodicTasks() {
    // Print positions every 2 minutes
    setInterval(() => {
      if (!this.isRunning) return;
      this.riskManager.printPositions();
    }, 2 * 60 * 1000);

    // Cleanup old data every 5 minutes
    setInterval(() => {
      if (!this.isRunning) return;
      this.scamFilter.cleanup();
      this.signalEngine.cleanup();

      // Unwatch tokens we've been watching for too long without buying
      const MAX_WATCH_TIME = 15 * 60 * 1000; // 15 min
      // We don't have timestamps for watch start, so just limit total count
      if (this.watchedTokens.size > 200) {
        log.info(`Pruning watched tokens (${this.watchedTokens.size} → keeping recent)`);
        // Just clear old ones — the important ones (with positions) are tracked separately
        const toRemove = Array.from(this.watchedTokens).slice(
          0,
          this.watchedTokens.size - 100
        );
        for (const mint of toRemove) {
          if (!this.riskManager.hasPosition(mint)) {
            this.unwatchToken(mint);
          }
        }
      }
    }, 5 * 60 * 1000);

    // Print stats every 10 minutes
    setInterval(() => {
      if (!this.isRunning) return;
      this.printStats();
    }, 10 * 60 * 1000);
  }

  printStats() {
    const uptime = ((Date.now() - this.stats.startTime) / 1000 / 60).toFixed(1);
    log.info("--- CoinShark Stats ---");
    log.info(`  Uptime: ${uptime} min`);
    log.info(`  Tokens scanned: ${this.stats.tokensScanned}`);
    log.info(`  Tokens rejected (scam): ${this.stats.tokensRejected}`);
    log.info(`  Tokens watched: ${this.stats.tokensWatched}`);
    log.info(`  Trades executed: ${this.stats.tradesExecuted}`);
    log.info(`  Open positions: ${this.riskManager.positionCount}/${this.config.maxPositions}`);
  }
}
