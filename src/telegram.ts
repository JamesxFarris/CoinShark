import TelegramBot from "node-telegram-bot-api";
import { BotConfig, Position } from "./types";
import { log } from "./logger";

/**
 * Callback interface so the Telegram bot can interact with the main bot
 * without circular dependencies.
 */
export interface TelegramBotCallbacks {
  getPositions: () => Position[];
  getBalance: () => Promise<number>;
  getWalletAddress: () => string;
  manualBuy: (mint: string) => Promise<{ success: boolean; error?: string }>;
  manualSell: (mint: string) => Promise<{ success: boolean; error?: string }>;
  addKol: (address: string, alias?: string) => void;
  removeKol: (address: string) => boolean;
  getKolList: () => string;
  getStats: () => string;
  getRecentTrades: () => string;
  isRunning: () => boolean;
  pauseTrading: () => void;
  resumeTrading: () => void;
  getConfig: () => BotConfig;
  updateConfig: (key: string, value: string) => boolean;
}

/**
 * TelegramUI provides a Telegram bot interface for controlling CoinShark.
 *
 * Commands:
 * /start     - Welcome message & help
 * /status    - Bot status, balance, uptime
 * /positions - Open positions with PnL
 * /buy       - Manual buy: /buy <mint>
 * /sell      - Manual sell: /sell <mint>
 * /kols      - List tracked KOL wallets
 * /addkol    - Add KOL: /addkol <wallet> [alias]
 * /removekol - Remove KOL: /removekol <wallet>
 * /stats     - Win rate, PnL, trade stats
 * /history   - Recent trade history
 * /pause     - Pause auto-trading
 * /resume    - Resume auto-trading
 * /config    - Show current config
 * /set       - Change setting: /set <key> <value>
 * /balance   - Wallet balance
 */
export class TelegramUI {
  private bot: TelegramBot;
  private chatId: string;
  private callbacks: TelegramBotCallbacks | null = null;
  private startTime = Date.now();

  constructor(token: string, chatId: string) {
    this.chatId = chatId;
    this.bot = new TelegramBot(token, { polling: true });
    this.registerCommandMenu();
    this.registerCommands();
    log.info("Telegram bot started");
  }

  setCallbacks(callbacks: TelegramBotCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Send a message to the configured chat
   */
  async send(text: string) {
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
    } catch (err: any) {
      log.warn(`Telegram send failed: ${err.message}`);
    }
  }

  /**
   * Send trade alert
   */
  async alertBuy(symbol: string, mint: string, solAmount: number, marketCapSol: number, signals: string[]) {
    const msg = [
      `<b>BUY ${symbol}</b>`,
      `Mint: <code>${mint.slice(0, 12)}...</code>`,
      `Amount: ${solAmount} SOL`,
      `MCap: ${marketCapSol.toFixed(2)} SOL`,
      `Signals: ${signals.join(", ")}`,
    ].join("\n");
    await this.send(msg);
  }

  /**
   * Send sell alert
   */
  async alertSell(symbol: string, pnlPercent: number, pnlSol: number, reason: string) {
    const emoji = pnlPercent >= 0 ? "+" : "";
    const msg = [
      `<b>SELL ${symbol}</b>`,
      `PnL: ${emoji}${pnlPercent.toFixed(1)}% (${emoji}${pnlSol.toFixed(4)} SOL)`,
      `Reason: ${reason}`,
    ].join("\n");
    await this.send(msg);
  }

  /**
   * Send a generic alert
   */
  async alert(text: string) {
    await this.send(text);
  }

  stop() {
    this.bot.stopPolling();
  }

  private registerCommandMenu() {
    this.bot.setMyCommands([
      { command: "start", description: "Welcome & command list" },
      { command: "status", description: "Bot status & balance" },
      { command: "positions", description: "Open positions with PnL" },
      { command: "buy", description: "Manual buy: /buy <mint>" },
      { command: "sell", description: "Manual sell: /sell <mint>" },
      { command: "kols", description: "List tracked KOL wallets" },
      { command: "addkol", description: "Add KOL: /addkol <wallet> [alias]" },
      { command: "removekol", description: "Remove KOL: /removekol <wallet>" },
      { command: "stats", description: "Win rate, PnL, trade stats" },
      { command: "history", description: "Recent trade history" },
      { command: "pause", description: "Pause auto-trading" },
      { command: "resume", description: "Resume auto-trading" },
      { command: "config", description: "Show current config" },
      { command: "set", description: "Change setting: /set <key> <value>" },
      { command: "balance", description: "Wallet SOL balance" },
    ]).catch(err => log.warn(`Failed to set Telegram command menu: ${err.message}`));
  }

  private isAuthorized(chatId: number): boolean {
    return String(chatId) === this.chatId;
  }

  private registerCommands() {
    this.bot.onText(/\/start/, (msg) => {
      if (!this.isAuthorized(msg.chat.id)) return;
      this.bot.sendMessage(msg.chat.id, [
        "<b>CoinShark Trading Bot</b>",
        "",
        "/status - Bot status & balance",
        "/positions - Open positions",
        "/buy &lt;mint&gt; - Manual buy",
        "/sell &lt;mint&gt; - Manual sell",
        "/kols - KOL wallet list",
        "/addkol &lt;wallet&gt; [alias] - Add KOL",
        "/removekol &lt;wallet&gt; - Remove KOL",
        "/stats - Trading statistics",
        "/history - Recent trades",
        "/pause - Pause auto-trading",
        "/resume - Resume auto-trading",
        "/config - Show config",
        "/set &lt;key&gt; &lt;value&gt; - Update config",
        "/balance - Wallet balance",
      ].join("\n"), { parse_mode: "HTML" });
    });

    this.bot.onText(/\/status/, async (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const balance = await this.callbacks.getBalance();
      const positions = this.callbacks.getPositions();
      const running = this.callbacks.isRunning();
      const uptime = ((Date.now() - this.startTime) / 1000 / 60).toFixed(0);

      this.bot.sendMessage(msg.chat.id, [
        `<b>CoinShark Status</b>`,
        `State: ${running ? "Running" : "Paused"}`,
        `Uptime: ${uptime} min`,
        `Balance: ${balance.toFixed(4)} SOL`,
        `Open Positions: ${positions.length}`,
        `Wallet: <code>${this.callbacks.getWalletAddress()}</code>`,
      ].join("\n"), { parse_mode: "HTML" });
    });

    this.bot.onText(/\/positions/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const positions = this.callbacks.getPositions();
      if (positions.length === 0) {
        this.bot.sendMessage(msg.chat.id, "No open positions.");
        return;
      }

      const lines = positions.map(p => {
        const pnl = `${p.currentPnlPercent >= 0 ? "+" : ""}${p.currentPnlPercent.toFixed(1)}%`;
        const age = ((Date.now() - p.entryTime) / 1000 / 60).toFixed(1);
        return [
          `<b>${p.symbol}</b> | ${pnl}`,
          `  MCap: ${p.currentMarketCapSol.toFixed(1)} SOL`,
          `  Invested: ${p.solInvested} SOL | Age: ${age}m`,
          `  TP: ${p.takeProfitHits}/2`,
          `  <code>${p.mint}</code>`,
        ].join("\n");
      });

      this.bot.sendMessage(msg.chat.id, lines.join("\n\n"), { parse_mode: "HTML" });
    });

    this.bot.onText(/\/buy (.+)/, async (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const mint = match[1].trim();
      if (mint.length < 32) {
        this.bot.sendMessage(msg.chat.id, "Invalid mint address.");
        return;
      }
      this.bot.sendMessage(msg.chat.id, `Buying ${mint.slice(0, 12)}...`);
      const result = await this.callbacks.manualBuy(mint);
      if (result.success) {
        this.bot.sendMessage(msg.chat.id, "Buy executed successfully.");
      } else {
        this.bot.sendMessage(msg.chat.id, `Buy failed: ${result.error}`);
      }
    });

    this.bot.onText(/\/sell (.+)/, async (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const mint = match[1].trim();
      if (mint.length < 32) {
        this.bot.sendMessage(msg.chat.id, "Invalid mint address.");
        return;
      }
      this.bot.sendMessage(msg.chat.id, `Selling ${mint.slice(0, 12)}...`);
      const result = await this.callbacks.manualSell(mint);
      if (result.success) {
        this.bot.sendMessage(msg.chat.id, "Sell executed successfully.");
      } else {
        this.bot.sendMessage(msg.chat.id, `Sell failed: ${result.error}`);
      }
    });

    this.bot.onText(/\/kols/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const list = this.callbacks.getKolList();
      this.bot.sendMessage(msg.chat.id, `<b>Tracked KOLs</b>\n\n${list}`, { parse_mode: "HTML" });
    });

    this.bot.onText(/\/addkol (.+)/, (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const parts = match[1].trim().split(/\s+/);
      const address = parts[0];
      const alias = parts[1] || "";
      if (address.length < 32) {
        this.bot.sendMessage(msg.chat.id, "Invalid wallet address.");
        return;
      }
      this.callbacks.addKol(address, alias);
      this.bot.sendMessage(msg.chat.id, `Added KOL: ${alias || address.slice(0, 8)}... (${address.slice(0, 12)}...)`);
    });

    this.bot.onText(/\/removekol (.+)/, (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const address = match[1].trim();
      const removed = this.callbacks.removeKol(address);
      this.bot.sendMessage(msg.chat.id, removed ? `Removed KOL: ${address.slice(0, 12)}...` : "KOL not found.");
    });

    this.bot.onText(/\/stats/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const stats = this.callbacks.getStats();
      this.bot.sendMessage(msg.chat.id, `<b>Trading Stats</b>\n\n${stats}`, { parse_mode: "HTML" });
    });

    this.bot.onText(/\/history/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const history = this.callbacks.getRecentTrades();
      this.bot.sendMessage(msg.chat.id, `<b>Recent Trades</b>\n\n<pre>${history}</pre>`, { parse_mode: "HTML" });
    });

    this.bot.onText(/\/pause/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      this.callbacks.pauseTrading();
      this.bot.sendMessage(msg.chat.id, "Auto-trading PAUSED. Manual trades still work.\n/resume to restart.");
    });

    this.bot.onText(/\/resume/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      this.callbacks.resumeTrading();
      this.bot.sendMessage(msg.chat.id, "Auto-trading RESUMED.");
    });

    this.bot.onText(/\/balance/, async (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const balance = await this.callbacks.getBalance();
      this.bot.sendMessage(msg.chat.id, `Balance: ${balance.toFixed(4)} SOL`);
    });

    this.bot.onText(/\/config/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const c = this.callbacks.getConfig();
      this.bot.sendMessage(msg.chat.id, [
        `<b>Bot Config</b>`,
        ``,
        `Bet Size: ${c.maxBetSol} SOL`,
        `Max Positions: ${c.maxPositions}`,
        `Slippage: ${c.slippagePercent}%`,
        `Priority Fee: ${c.priorityFeeSol} SOL`,
        ``,
        `TP1: +${c.takeProfit1Percent}% (sell 50%)`,
        `TP2: +${c.takeProfit2Percent}% (sell ${100 - c.moonbagPercent}%, keep ${c.moonbagPercent}% moonbag)`,
        `SL: -${c.stopLossPercent}%`,
        `Moonbag: ${c.moonbagPercent}%`,
        ``,
        `Max Position Age: ${c.maxPositionAgeMinutes} min`,
        `Daily Loss Limit: ${c.dailyLossLimitSol} SOL`,
        ``,
        `MCap Range: ${c.minMarketCapSol}-${c.maxMarketCapSol} SOL`,
        `Bonding Curve: ${c.minBondingCurvePercent}-${c.maxBondingCurvePercent}%`,
        `Min 5m Volume: ${c.min5mVolumeSol} SOL`,
        `Min 5m Buyers: ${c.min5mBuyers}`,
        ``,
        `<b>Adjustable with /set:</b>`,
        `bet, maxpos, tp1, tp2, sl, moonbag, maxage, dailyloss`,
      ].join("\n"), { parse_mode: "HTML" });
    });

    this.bot.onText(/\/set (.+)/, (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const parts = match[1].trim().split(/\s+/);
      if (parts.length < 2) {
        this.bot.sendMessage(msg.chat.id, "Usage: /set <key> <value>\nKeys: bet, maxpos, tp1, tp2, sl, maxage, dailyloss");
        return;
      }
      const updated = this.callbacks.updateConfig(parts[0], parts[1]);
      if (updated) {
        this.bot.sendMessage(msg.chat.id, `Updated ${parts[0]} = ${parts[1]}`);
      } else {
        this.bot.sendMessage(msg.chat.id, `Unknown setting: ${parts[0]}\nValid: bet, maxpos, tp1, tp2, sl, maxage, dailyloss`);
      }
    });
  }
}
