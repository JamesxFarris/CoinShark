import { BotConfig, PumpPortalNewToken, PumpPortalTrade, PumpPortalMigration, Position, Signal } from "./types";
import { WalletManager } from "./wallet";
import { TokenScanner } from "./scanner";
import { ScamFilter } from "./scamFilter";
import { SignalEngine } from "./signalEngine";
import { Trader } from "./trader";
import { RiskManager } from "./riskManager";
import { KolDiscovery } from "./kolDiscovery";
import { TradeHistory } from "./tradeHistory";
import { TelegramUI, TelegramBotCallbacks } from "./telegram";
import { GmgnDiscovery } from "./gmgnDiscovery";
import { log } from "./logger";


/**
 * CoinShark Bot — main orchestrator
 *
 * Pipeline: New Token → Scam Filter → Watch → Signal Engine → Trade Decision → Risk Management
 *
 * Features:
 * - Telegram UI for control & alerts
 * - KOL discovery with performance scoring
 * - Trade history with analytics
 * - Bonding curve tracking
 * - Time-based exits & daily loss limits
 */
export class CoinSharkBot {
  private config: BotConfig;
  private wallet: WalletManager;
  private scanner: TokenScanner;
  private scamFilter: ScamFilter;
  private signalEngine: SignalEngine;
  private trader: Trader;
  private riskManager: RiskManager;
  private kolDiscovery: KolDiscovery;
  private tradeHistory: TradeHistory;
  private gmgnDiscovery: GmgnDiscovery;
  private telegram: TelegramUI | null = null;

  private watchedTokens: Set<string> = new Set();
  private tokenSymbols: Map<string, string> = new Map();
  private pendingBuys: Set<string> = new Set(); // prevents concurrent buy evaluations
  private boughtTokens: Set<string> = new Set(); // never buy the same token twice per session
  private skipLogTimes: Map<string, number> = new Map(); // throttle SKIP logs per token
  private isRunning = false;
  private autoTradingEnabled = false; // starts OFF — user must enable via Telegram
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
    this.kolDiscovery = new KolDiscovery(config.kolWallets);
    this.tradeHistory = new TradeHistory();
    this.signalEngine = new SignalEngine(config, this.kolDiscovery);
    this.trader = new Trader(config, this.wallet);
    this.riskManager = new RiskManager(config, this.trader, this.tradeHistory);
    this.gmgnDiscovery = new GmgnDiscovery(this.kolDiscovery);

    // Wire up position close callback for Telegram alerts & KOL scoring
    this.riskManager.onPositionClose = (pos, exitMcap, reason, sig) =>
      this.onPositionClosed(pos, exitMcap, reason, sig);

    // Initialize Telegram if configured
    if (config.telegramBotToken && config.telegramChatId) {
      this.telegram = new TelegramUI(config.telegramBotToken, config.telegramChatId);
      this.telegram.setCallbacks(this.createTelegramCallbacks());
    }
  }

  async start() {
    log.banner("CoinShark v2.0 — Solana Pump.fun Trading Bot");

    // Print wallet info
    await this.wallet.printStatus();
    log.info(`Max bet: ${this.config.maxBetSol} SOL`);
    log.info(`Max positions: ${this.config.maxPositions}`);
    log.info(`Market cap range: ${this.config.minMarketCapSol}-${this.config.maxMarketCapSol} SOL`);
    log.info(`Signal score threshold: 50 | Safety score threshold: 50`);
    log.info(`TP1: +${this.config.takeProfit1Percent}% | TP2: +${this.config.takeProfit2Percent}% | TP3: +${this.config.takeProfit3Percent}% | SL: -${this.config.stopLossPercent}%`);
    log.info(`Moonbag: ${this.config.moonbagPercent}% | Breakeven at: +${this.config.breakevenActivationPercent}% | Trailing: ${this.config.trailingStopPercent}%`);
    log.info(`Max position age: ${this.config.maxPositionAgeMinutes} min`);
    log.info(`Daily loss limit: ${this.config.dailyLossLimitSol} SOL`);
    log.info(`Bonding curve range: ${this.config.minBondingCurvePercent}-${this.config.maxBondingCurvePercent}%`);

    const kolCount = this.kolDiscovery.getAllKols().length;
    if (kolCount > 0) {
      log.kol(`Tracking ${kolCount} KOL wallets`);
    } else {
      log.warn("No KOL wallets configured — KOL signal disabled");
    }

    if (this.telegram) {
      log.info("Telegram bot connected");
    } else {
      log.warn("Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
    }

    // Wire up event handlers
    this.scanner.on("newToken", (token: PumpPortalNewToken) =>
      this.onNewToken(token)
    );
    this.scanner.on("trade", (trade: PumpPortalTrade) =>
      this.onTrade(trade)
    );
    this.scanner.on("migration", (migration: PumpPortalMigration) =>
      this.onMigration(migration)
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

    if (this.telegram) {
      const balance = await this.wallet.getBalance();
      await this.telegram.send(
        `<b>CoinShark started</b>\nBalance: ${balance.toFixed(4)} SOL\nKOLs: ${kolCount}\nMax bet: ${this.config.maxBetSol} SOL`
      );
    }
  }

  async stop() {
    log.warn("Shutting down...");
    this.isRunning = false;

    // Stop Telegram polling FIRST to prevent 409 conflict with new deployment
    if (this.telegram) {
      this.telegram.stop();
      log.info("Telegram polling stopped");
    }

    this.scanner.disconnect();

    // Do NOT close positions on shutdown — redeployments would panic-sell everything.
    // Tokens stay in the wallet. User can sell manually via Telegram /sell.
    if (this.riskManager.positionCount > 0) {
      log.warn(`${this.riskManager.positionCount} open position(s) will remain in wallet (not panic-selling on shutdown).`);
      this.riskManager.printPositions();
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

    // Watch the creator's wallet so we detect if they sell
    if (token.traderPublicKey) {
      this.scanner.watchAccount(token.traderPublicKey);
    }

    log.info(
      `NEW: ${token.symbol} (${token.name}) | MCap: ${token.marketCapSol.toFixed(2)} SOL | ${token.mint.slice(0, 8)}...`
    );
  }

  /**
   * Handle a token migration (bonding curve graduation to PumpSwap/Raydium)
   */
  private onMigration(migration: PumpPortalMigration) {
    this.signalEngine.markGraduated(migration.mint);
    const symbol = this.tokenSymbols.get(migration.mint) ?? migration.mint.slice(0, 8);
    log.info(
      `GRADUATED: ${symbol} → Pool: ${migration.pool.slice(0, 8)}... | MCap: ${migration.marketCapSol.toFixed(2)} SOL`
    );

    // If we have a position, this is good news (token survived to graduation)
    if (this.riskManager.hasPosition(migration.mint)) {
      log.signal(`${symbol}: Token graduated while we hold a position — bullish!`);
      if (this.telegram) {
        this.telegram.send(
          `<b>🎓 ${symbol} graduated!</b>\nMCap: ${migration.marketCapSol.toFixed(2)} SOL\nPool: <code>${migration.pool.slice(0, 16)}...</code>`
        );
      }
    }

    // Unwatch tokens we don't hold positions in after graduation (saves bandwidth)
    if (!this.riskManager.hasPosition(migration.mint)) {
      this.unwatchToken(migration.mint);
    }
  }

  /**
   * Handle a trade event on a watched token or KOL wallet
   */
  private async onTrade(trade: PumpPortalTrade) {
    // Feed the trade to scam filter and signal engine
    this.scamFilter.recordTrade(trade);
    const newSignals = this.signalEngine.processTrade(trade);

    // Resolve symbol — use || (not ??) so empty strings also fall back
    const symbol = this.tokenSymbols.get(trade.mint) || trade.mint.slice(0, 8);

    // Log significant signals
    for (const signal of newSignals) {
      log.signal(
        `${symbol}: [${signal.type}] strength=${signal.strength} — ${signal.details}`
      );
    }

    // ALWAYS update existing positions — stop-loss, trailing stop, rug detection
    // all work regardless of whether auto-trading is on or off.
    if (this.riskManager.hasPosition(trade.mint)) {
      // Check if creator sold or coordinated dump while we hold — emergency exit
      for (const signal of newSignals) {
        if (signal.type === "creator_sell") {
          log.trade(`EMERGENCY: ${symbol} — creator_sell detected while holding position!`);
          await this.riskManager.closePosition(trade.mint, 100, signal.type);
          return;
        }
        // Coordinated sell: emergency exit if we're at a loss.
        // Trust KOL dip-buying UNLESS the creator is also dumping — that's a rug signal.
        if (signal.type === "coordinated_sell" && signal.strength >= 95) {
          const pos = this.riskManager.getPosition(trade.mint);
          const recentKolBuys = this.signalEngine.hasRecentKolBuys(trade.mint, 300, 0.5);
          const creatorSold = this.signalEngine.hasCreatorSold(trade.mint);
          if (pos && pos.currentPnlPercent <= 0 && creatorSold) {
            // Creator dump + coordinated sell = rug. Exit regardless of KOL buys.
            log.trade(`EMERGENCY: ${symbol} — coordinated sell + creator dump at ${pos.currentPnlPercent.toFixed(1)}% PnL — exiting!`);
            await this.riskManager.closePosition(trade.mint, 100, "coordinated_sell_rug");
            return;
          } else if (pos && pos.currentPnlPercent <= 0 && !recentKolBuys) {
            log.trade(`EMERGENCY: ${symbol} — ${signal.type} detected at ${pos.currentPnlPercent.toFixed(1)}% PnL — selling!`);
            await this.riskManager.closePosition(trade.mint, 100, signal.type);
            return;
          } else if (recentKolBuys && !creatorSold) {
            log.trade(`HOLD: ${symbol} — ${signal.type} detected but KOLs bought recently (no creator dump) — trusting smart money`);
          } else {
            log.trade(`WARNING: ${symbol} — ${signal.type} detected but in profit (+${pos?.currentPnlPercent.toFixed(1)}%) — trailing stop will protect`);
          }
        }
      }
      await this.riskManager.onTradeUpdate(trade);
      return;
    }

    // Skip NEW trade evaluation if auto-trading is disabled
    if (!this.autoTradingEnabled) return;

    // Check if we should open a new position
    if (!this.riskManager.canOpenPosition()) return;

    // Never buy the same token twice in a session
    if (this.boughtTokens.has(trade.mint)) return;

    // Prevent concurrent buy evaluations for the same token (race condition guard)
    if (this.pendingBuys.has(trade.mint)) return;
    if (this.riskManager.hasPosition(trade.mint)) return;

    // === KOL instant follow: high-conviction KOLs (score 80+, buy >= 1 SOL) ===
    // Skip the 5-minute momentum wait — buy within seconds of the KOL.
    const instantFollow = this.signalEngine.checkInstantKolFollow(trade);
    if (instantFollow) {
      this.pendingBuys.add(trade.mint);
      try {
        log.kol(`INSTANT FOLLOW: ${symbol} — ${instantFollow.kolAlias} (score ${instantFollow.kolScore}) bought ${instantFollow.solAmount.toFixed(2)} SOL`);
        const scamResult = await this.scamFilter.analyze(trade.mint);
        if (!scamResult.passed) {
          log.scam(`BLOCKED instant follow ${symbol}: ${scamResult.reasons.join("; ")}`);
          const kolBuyers = this.signalEngine.getKolBuyers(trade.mint);
          for (const kolAddr of kolBuyers) {
            const blacklisted = this.kolDiscovery.recordScamBuy(kolAddr, symbol);
            if (blacklisted) this.scanner.unwatchAccount(kolAddr);
          }
          this.unwatchToken(trade.mint);
          return;
        }
        if (scamResult.scores.overallSafety < 50) {
          log.scam(`BLOCKED instant follow ${symbol}: safety ${scamResult.scores.overallSafety}/100`);
          this.unwatchToken(trade.mint);
          return;
        }
        this.boughtTokens.add(trade.mint);
        const signals: Signal[] = [{
          type: "kol_buy",
          mint: trade.mint,
          strength: 90,
          details: `Instant follow: ${instantFollow.kolAlias} (score ${instantFollow.kolScore})`,
          timestamp: Date.now(),
        }];
        const opened = await this.riskManager.openPosition(
          trade.mint, symbol, trade.marketCapSol, signals, 80
        );
        if (opened) {
          this.stats.tradesExecuted++;
          if (this.telegram) {
            await this.telegram.alertBuy(symbol, trade.mint, this.config.maxBetSol, trade.marketCapSol, ["kol_instant_follow"]);
          }
        }
      } finally {
        this.pendingBuys.delete(trade.mint);
      }
      return;
    }

    const { shouldBuy: buy, momentum, reason } = this.signalEngine.shouldBuy(trade.mint);
    if (!buy || !momentum) {
      // Log rejections for tokens with some signal activity (score 30+) — throttled to once per 60s per token
      if (momentum && momentum.aggregateScore >= 30) {
        const now = Date.now();
        const lastLog = this.skipLogTimes.get(trade.mint) ?? 0;
        if (now - lastLog >= 60_000) {
          this.skipLogTimes.set(trade.mint, now);
          log.signal(`SKIP ${symbol}: ${reason} (score: ${momentum.aggregateScore}/100, mcap: ${trade.marketCapSol.toFixed(0)} SOL, signals: ${momentum.signals.map(s => s.type).join(", ")})`);
        }
      }
      return;
    }

    // Lock this mint to prevent concurrent evaluations
    this.pendingBuys.add(trade.mint);
    try {
      // Run full scam analysis before committing real money
      log.info(`Evaluating ${symbol} for purchase...`);
      const scamResult = await this.scamFilter.analyze(trade.mint);

      if (!scamResult.passed) {
        log.scam(
          `BLOCKED ${symbol}: ${scamResult.reasons.join("; ")}`
        );
        // Record scam buy for any KOLs that bought this token — auto-blacklist repeat offenders
        const kolBuyers = this.signalEngine.getKolBuyers(trade.mint);
        for (const kolAddr of kolBuyers) {
          const blacklisted = this.kolDiscovery.recordScamBuy(kolAddr, symbol);
          if (blacklisted) this.scanner.unwatchAccount(kolAddr);
        }
        this.unwatchToken(trade.mint);
        return;
      }

      // Require minimum safety score — low safety (27-48) correlated with losses in audit
      if (scamResult.scores.overallSafety < 50) {
        log.scam(
          `BLOCKED ${symbol}: safety score too low (${scamResult.scores.overallSafety}/100, need 50+)`
        );
        const kolBuyers = this.signalEngine.getKolBuyers(trade.mint);
        for (const kolAddr of kolBuyers) {
          const blacklisted = this.kolDiscovery.recordScamBuy(kolAddr, symbol);
          if (blacklisted) this.scanner.unwatchAccount(kolAddr);
        }
        this.unwatchToken(trade.mint);
        return;
      }

      log.signal(
        `BUY SIGNAL for ${symbol}: ${reason} | Safety: ${scamResult.scores.overallSafety}/100 | MCap: ${trade.marketCapSol.toFixed(0)} SOL`
      );

      // Mark as bought BEFORE attempting — a timed-out buy may still land on-chain
      // (skipPreflight=true means tx is sent regardless). Better to miss a retry
      // than to send 6 duplicate buy transactions.
      this.boughtTokens.add(trade.mint);

      // Execute the trade (pass signal score for position sizing)
      const opened = await this.riskManager.openPosition(
        trade.mint,
        symbol,
        trade.marketCapSol,
        momentum.signals,
        momentum.aggregateScore
      );

      if (opened) {
        this.stats.tradesExecuted++;
        // Send Telegram alert
        if (this.telegram) {
          await this.telegram.alertBuy(
            symbol, trade.mint, this.config.maxBetSol,
            trade.marketCapSol,
            momentum.signals.map(s => s.type)
          );
        }
      }
    } finally {
      this.pendingBuys.delete(trade.mint);
    }
  }

  /**
   * Called when a position is closed (for alerts & KOL scoring)
   */
  private async onPositionClosed(
    position: Position,
    exitMarketCapSol: number,
    reason: string,
    signature?: string
  ) {
    const pnlPercent = position.entryMarketCapSol > 0
      ? ((exitMarketCapSol - position.entryMarketCapSol) / position.entryMarketCapSol) * 100
      : 0;
    const pnlSol = position.solInvested * (pnlPercent / 100);

    // Record outcome for alpha wallet discovery (first-buyer tracking)
    this.signalEngine.recordOutcome(position.mint, pnlPercent > 0);

    // Update KOL scores based on trade outcome
    for (const signal of position.signals) {
      if (signal.type === "kol_buy") {
        // Extract KOL addresses from the signal details
        for (const kolAddr of this.kolDiscovery.getKolAddresses()) {
          // If this KOL contributed to the signal
          const kol = this.kolDiscovery.getKol(kolAddr);
          if (kol && kol.lastActive >= position.entryTime - 60000) {
            this.kolDiscovery.recordSignalOutcome(kolAddr, pnlPercent);
          }
        }
      }
    }

    // Telegram sell alert
    if (this.telegram) {
      await this.telegram.alertSell(position.symbol, position.mint, pnlPercent, pnlSol, reason);
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

    // Check time-based exits every minute
    setInterval(async () => {
      if (!this.isRunning) return;
      try { await this.riskManager.checkTimeExits(); } catch (e: any) { log.error(`checkTimeExits error: ${e.message}`); }
    }, 60 * 1000);

    // Check daily loss limit every minute
    setInterval(() => {
      if (!this.isRunning) return;
      try { this.riskManager.checkDailyLossLimit(); } catch (e: any) { log.error(`checkDailyLossLimit error: ${e.message}`); }
    }, 60 * 1000);

    // Print stats every 5 minutes
    setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const balance = await this.wallet.getBalance();
        const alphaCount = this.signalEngine.getAlphaWalletCount();
        log.info(`--- Stats: Balance: ${balance.toFixed(4)} SOL | Watching: ${this.watchedTokens.size} tokens | Bought: ${this.boughtTokens.size} session | Alpha wallets: ${alphaCount} ---`);
      } catch (e: any) { log.error(`Stats error: ${e.message}`); }
    }, 5 * 60 * 1000);

    // Cleanup old data every 5 minutes (preserve state for tokens we hold positions in)
    setInterval(() => {
      if (!this.isRunning) return;
      const heldMints = new Set(this.riskManager.getPositions().map(p => p.mint));
      this.scamFilter.cleanup(30 * 60 * 1000, heldMints);
      this.signalEngine.cleanup(30 * 60 * 1000, heldMints);

      // Clean old skip log throttle entries
      const skipCutoff = Date.now() - 5 * 60 * 1000;
      for (const [mint, time] of this.skipLogTimes) {
        if (time < skipCutoff) this.skipLogTimes.delete(mint);
      }

      if (this.watchedTokens.size > 200) {
        log.info(`Pruning watched tokens (${this.watchedTokens.size} → keeping recent)`);
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

    // GMGN auto-discovery every 6 hours
    setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const result = await this.gmgnDiscovery.autoDiscover();
        if (result && result.added > 0) {
          log.kol(`GMGN auto-discovery: added ${result.added} new wallets`);
          // Subscribe to new KOL wallets
          for (const w of result.wallets) {
            this.scanner.watchAccount(w.address);
          }
          if (this.telegram) {
            await this.telegram.send(GmgnDiscovery.formatResult(result));
          }
        }
      } catch (e: any) {
        log.error(`GMGN auto-discovery error: ${e.message}`);
      }
    }, 6 * 60 * 60 * 1000);

    // Run initial GMGN discovery 30s after startup
    setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        const result = await this.gmgnDiscovery.autoDiscover();
        if (result && result.added > 0) {
          for (const w of result.wallets) {
            this.scanner.watchAccount(w.address);
          }
          if (this.telegram) {
            await this.telegram.send(GmgnDiscovery.formatResult(result));
          }
        }
      } catch (e: any) {
        log.error(`GMGN initial discovery error: ${e.message}`);
      }
    }, 30_000);
  }

  /**
   * Create callbacks for the Telegram bot to interact with the main bot
   */
  private createTelegramCallbacks(): TelegramBotCallbacks {
    return {
      getPositions: () => this.riskManager.getPositions(),
      getBalance: () => this.wallet.getBalance(),
      getWalletAddress: () => this.wallet.address,

      manualBuy: async (mint: string) => {
        const result = await this.trader.buy(mint, this.config.maxBetSol);
        if (result.success) {
          this.stats.tradesExecuted++;
        }
        return result;
      },

      manualSell: async (mint: string) => {
        if (this.riskManager.hasPosition(mint)) {
          const success = await this.riskManager.closePosition(mint, 100, "manual_telegram");
          return { success, error: success ? undefined : "Sell transaction failed — check logs for details" };
        }
        // Direct sell if no tracked position
        const result = await this.trader.sell(mint, 100);
        return result;
      },

      addKol: (address: string, alias?: string) => {
        this.kolDiscovery.addKol(address, alias);
        this.scanner.watchAccount(address);
      },

      removeKol: (address: string) => {
        return this.kolDiscovery.removeKol(address);
      },

      getKolList: () => this.kolDiscovery.formatKolList(),

      discoverGmgnKols: async () => {
        const result = await this.gmgnDiscovery.discover();
        // Subscribe to newly discovered wallets
        for (const w of result.wallets) {
          this.scanner.watchAccount(w.address);
        }
        return result;
      },
      getStats: () => this.tradeHistory.formatStats(),
      getRecentTrades: () => this.tradeHistory.formatRecentTrades(),
      isRunning: () => this.autoTradingEnabled,

      pauseTrading: () => {
        this.autoTradingEnabled = false;
        log.warn("Auto-trading PAUSED via Telegram");
      },

      resumeTrading: () => {
        this.autoTradingEnabled = true;
        log.info("Auto-trading RESUMED via Telegram");
      },

      getConfig: () => this.config,

      updateConfig: (key: string, value: string) => {
        const num = parseFloat(value);
        if (isNaN(num)) return false;

        switch (key) {
          case "bet": this.config.maxBetSol = num; break;
          case "maxpos": this.config.maxPositions = num; break;
          case "tp1": this.config.takeProfit1Percent = num; break;
          case "tp2": this.config.takeProfit2Percent = num; break;
          case "tp3": this.config.takeProfit3Percent = num; break;
          case "sl": this.config.stopLossPercent = num; break;
          case "moonbag": this.config.moonbagPercent = Math.max(0, Math.min(50, num)); break;
          case "breakeven": this.config.breakevenActivationPercent = num; break;
          case "trailing": this.config.trailingStopPercent = num; break;
          case "moonbagtrail": this.config.moonbagTrailingStopPercent = num; break;
          case "maxage": this.config.maxPositionAgeMinutes = num; break;
          case "dailyloss": this.config.dailyLossLimitSol = num; break;
          default: return false;
        }
        log.info(`Config updated via Telegram: ${key} = ${value}`);
        return true;
      },
    };
  }

  printStats() {
    const uptime = ((Date.now() - this.stats.startTime) / 1000 / 60).toFixed(1);
    const historyStats = this.tradeHistory.getStats();
    log.info("--- CoinShark Stats ---");
    log.info(`  Uptime: ${uptime} min`);
    log.info(`  Tokens scanned: ${this.stats.tokensScanned}`);
    log.info(`  Tokens rejected (scam): ${this.stats.tokensRejected}`);
    log.info(`  Tokens watched: ${this.stats.tokensWatched}`);
    log.info(`  Trades executed: ${this.stats.tradesExecuted}`);
    log.info(`  Open positions: ${this.riskManager.positionCount}/${this.config.maxPositions}`);
    if (historyStats.totalTrades > 0) {
      log.info(`  Win rate: ${historyStats.winRate.toFixed(1)}% (${historyStats.wins}W/${historyStats.losses}L)`);
      log.info(`  Total PnL: ${historyStats.totalPnlSol >= 0 ? "+" : ""}${historyStats.totalPnlSol.toFixed(4)} SOL`);
      log.info(`  Today PnL: ${historyStats.dailyPnlSol >= 0 ? "+" : ""}${historyStats.dailyPnlSol.toFixed(4)} SOL`);
    }
    const alphaCount = this.signalEngine.getAlphaWalletCount();
    if (alphaCount > 0) {
      log.info(`  Alpha wallets discovered: ${alphaCount}`);
    }
    log.info(`  Auto-trading: ${this.autoTradingEnabled ? "ON" : "PAUSED"}`);
  }
}
