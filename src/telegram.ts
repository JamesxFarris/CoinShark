import TelegramBot from "node-telegram-bot-api";
import { BotConfig, Position } from "./types";
import { GmgnDiscovery } from "./gmgnDiscovery";
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
  discoverGmgnKols: () => Promise<{ added: number; skipped: number; failed: number; wallets: Array<{ address: string; alias: string; winRate: number; pnl7d: number }> }>;
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
 * Supports both slash commands and inline keyboard buttons.
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
    this.registerCallbackQueries();
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
   * Send trade alert with quick-sell button
   */
  async alertBuy(symbol: string, mint: string, solAmount: number, marketCapSol: number, signals: string[]) {
    const msg = [
      `<b>BUY ${symbol}</b>`,
      `Mint: <code>${mint.slice(0, 12)}...</code>`,
      `Amount: ${solAmount} SOL`,
      `MCap: ${marketCapSol.toFixed(2)} SOL`,
      `Signals: ${signals.join(", ")}`,
    ].join("\n");
    try {
      await this.bot.sendMessage(this.chatId, msg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Sell Now", callback_data: `sell:${mint}` },
            { text: "Positions", callback_data: "positions" },
          ]],
        },
      });
    } catch (err: any) {
      log.warn(`Telegram send failed: ${err.message}`);
    }
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
    try {
      await this.bot.sendMessage(this.chatId, msg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Positions", callback_data: "positions" },
            { text: "Stats", callback_data: "stats" },
          ]],
        },
      });
    } catch (err: any) {
      log.warn(`Telegram send failed: ${err.message}`);
    }
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

  // ─── Inline keyboard builders ──────────────────────────────────

  private mainMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: "Status", callback_data: "status" },
          { text: "Balance", callback_data: "balance" },
          { text: "Positions", callback_data: "positions" },
        ],
        [
          { text: "Stats", callback_data: "stats" },
          { text: "History", callback_data: "history" },
          { text: "KOLs", callback_data: "kols" },
        ],
        [
          { text: "Config", callback_data: "config" },
          { text: "Pause", callback_data: "pause" },
          { text: "Resume", callback_data: "resume" },
        ],
        [
          { text: "Refresh", callback_data: "refresh_menu" },
        ],
      ],
    };
  }

  private backToMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [[
        { text: "<< Menu", callback_data: "menu" },
        { text: "Refresh", callback_data: "refresh_menu" },
      ]],
    };
  }

  private positionsKeyboard(positions: Position[]): TelegramBot.InlineKeyboardMarkup {
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    for (const p of positions) {
      rows.push([
        { text: `Sell ${p.symbol}`, callback_data: `sell:${p.mint}` },
      ]);
    }
    rows.push([
      { text: "<< Menu", callback_data: "menu" },
      { text: "Refresh", callback_data: "positions" },
    ]);
    return { inline_keyboard: rows };
  }

  private configKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: "Bet -0.01", callback_data: "cfg:bet:-0.01" },
          { text: "Bet Size", callback_data: "noop" },
          { text: "Bet +0.01", callback_data: "cfg:bet:+0.01" },
        ],
        [
          { text: "TP1 -25", callback_data: "cfg:tp1:-25" },
          { text: "TP1 (2x)", callback_data: "noop" },
          { text: "TP1 +25", callback_data: "cfg:tp1:+25" },
        ],
        [
          { text: "TP2 -50", callback_data: "cfg:tp2:-50" },
          { text: "TP2 (4x)", callback_data: "noop" },
          { text: "TP2 +50", callback_data: "cfg:tp2:+50" },
        ],
        [
          { text: "TP3 -100", callback_data: "cfg:tp3:-100" },
          { text: "TP3 (10x)", callback_data: "noop" },
          { text: "TP3 +100", callback_data: "cfg:tp3:+100" },
        ],
        [
          { text: "SL -5", callback_data: "cfg:sl:-5" },
          { text: "Stop Loss", callback_data: "noop" },
          { text: "SL +5", callback_data: "cfg:sl:+5" },
        ],
        [
          { text: "BE -10", callback_data: "cfg:breakeven:-10" },
          { text: "Breakeven", callback_data: "noop" },
          { text: "BE +10", callback_data: "cfg:breakeven:+10" },
        ],
        [
          { text: "Trail -5", callback_data: "cfg:trailing:-5" },
          { text: "Trail Stop", callback_data: "noop" },
          { text: "Trail +5", callback_data: "cfg:trailing:+5" },
        ],
        [
          { text: "MaxPos -1", callback_data: "cfg:maxpos:-1" },
          { text: "Max Positions", callback_data: "noop" },
          { text: "MaxPos +1", callback_data: "cfg:maxpos:+1" },
        ],
        [
          { text: "<< Menu", callback_data: "menu" },
          { text: "Refresh", callback_data: "config" },
        ],
      ],
    };
  }

  // ─── Response builders ─────────────────────────────────────────

  private buildStartMessage(): string {
    return [
      "<b>CoinShark Trading Bot</b>",
      "",
      "Use the buttons below or type commands:",
      "",
      "/buy &lt;mint&gt; - Manual buy",
      "/sell &lt;mint&gt; - Manual sell",
      "/addkol &lt;wallet&gt; [alias] - Add KOL",
      "/removekol &lt;wallet&gt; - Remove KOL",
      "/set &lt;key&gt; &lt;value&gt; - Update config",
    ].join("\n");
  }

  private async buildStatusMessage(): Promise<string> {
    if (!this.callbacks) return "Bot not ready.";
    const balance = await this.callbacks.getBalance();
    const positions = this.callbacks.getPositions();
    const running = this.callbacks.isRunning();
    const uptime = ((Date.now() - this.startTime) / 1000 / 60).toFixed(0);

    return [
      `<b>CoinShark Status</b>`,
      `State: ${running ? "Running" : "Paused"}`,
      `Uptime: ${uptime} min`,
      `Balance: ${balance.toFixed(4)} SOL`,
      `Open Positions: ${positions.length}`,
      `Wallet: <code>${this.callbacks.getWalletAddress()}</code>`,
    ].join("\n");
  }

  private buildPositionsMessage(positions: Position[]): string {
    if (positions.length === 0) return "No open positions.";
    return positions.map(p => {
      const pnl = `${p.currentPnlPercent >= 0 ? "+" : ""}${p.currentPnlPercent.toFixed(1)}%`;
      const age = ((Date.now() - p.entryTime) / 1000 / 60).toFixed(1);
      return [
        `<b>${p.symbol}</b> | ${pnl}`,
        `  MCap: ${p.currentMarketCapSol.toFixed(1)} SOL`,
        `  Invested: ${p.solInvested} SOL | Age: ${age}m`,
        `  TP: ${p.takeProfitHits}/2`,
        `  <code>${p.mint}</code>`,
      ].join("\n");
    }).join("\n\n");
  }

  private buildConfigMessage(c: BotConfig): string {
    return [
      `<b>Bot Config</b>`,
      ``,
      `Bet Size: ${c.maxBetSol} SOL (0.5x-2x by signal)`,
      `Max Positions: ${c.maxPositions}`,
      `Slippage: ${c.slippagePercent}%`,
      `Priority Fee: ${c.priorityFeeSol} SOL`,
      ``,
      `<b>Exit Strategy:</b>`,
      `TP1: +${c.takeProfit1Percent}% (sell 50%, recover initial)`,
      `TP2: +${c.takeProfit2Percent}% (sell 50% of remaining)`,
      `TP3: +${c.takeProfit3Percent}% (sell to ${c.moonbagPercent}% moonbag)`,
      `SL: -${c.stopLossPercent}%`,
      `Breakeven: activates at +${c.breakevenActivationPercent}%`,
      `Trailing Stop: ${c.trailingStopPercent}% below HWM (after TP1)`,
      `Moonbag Trail: ${c.moonbagTrailingStopPercent}% below HWM`,
      ``,
      `Max Position Age: ${c.maxPositionAgeMinutes} min`,
      `Daily Loss Limit: ${c.dailyLossLimitSol} SOL`,
      ``,
      `MCap Range: ${c.minMarketCapSol}-${c.maxMarketCapSol} SOL`,
      `Bonding Curve: ${c.minBondingCurvePercent}-${c.maxBondingCurvePercent}%`,
      `Min 5m Volume: ${c.min5mVolumeSol} SOL`,
      `Min 5m Buyers: ${c.min5mBuyers}`,
      ``,
      `Tap buttons below to adjust:`,
    ].join("\n");
  }

  // ─── Callback query handler ────────────────────────────────────

  private registerCallbackQueries() {
    this.bot.on("callback_query", async (query) => {
      if (!query.message || !this.isAuthorized(query.message.chat.id)) return;
      if (!this.callbacks) {
        await this.bot.answerCallbackQuery(query.id, { text: "Bot not ready" });
        return;
      }

      const data = query.data || "";
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;

      try {
        // Menu / start
        if (data === "menu" || data === "refresh_menu") {
          await this.bot.editMessageText(this.buildStartMessage(), {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.mainMenuKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // Status
        if (data === "status") {
          const text = await this.buildStatusMessage();
          await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.backToMenuKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // Balance
        if (data === "balance") {
          const balance = await this.callbacks.getBalance();
          await this.bot.editMessageText(`Balance: <b>${balance.toFixed(4)} SOL</b>`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.backToMenuKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // Positions
        if (data === "positions") {
          const positions = this.callbacks.getPositions();
          const text = this.buildPositionsMessage(positions);
          await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.positionsKeyboard(positions),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // Sell from button
        if (data.startsWith("sell:")) {
          const mint = data.slice(5);
          await this.bot.answerCallbackQuery(query.id, { text: `Selling ${mint.slice(0, 8)}...` });
          const result = await this.callbacks.manualSell(mint);
          if (result.success) {
            await this.bot.sendMessage(chatId, `Sell executed for <code>${mint.slice(0, 12)}...</code>`, { parse_mode: "HTML" });
          } else {
            await this.bot.sendMessage(chatId, `Sell failed: ${result.error}`);
          }
          return;
        }

        // Stats
        if (data === "stats") {
          const stats = this.callbacks.getStats();
          await this.bot.editMessageText(`<b>Trading Stats</b>\n\n${stats}`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.backToMenuKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // History
        if (data === "history") {
          const history = this.callbacks.getRecentTrades();
          await this.bot.editMessageText(`<b>Recent Trades</b>\n\n<pre>${history}</pre>`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.backToMenuKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // KOLs
        if (data === "kols") {
          const list = this.callbacks.getKolList();
          await this.bot.editMessageText(`<b>Tracked KOLs</b>\n\n${list}`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Discover from GMGN", callback_data: "gmgn_discover" }],
                [
                  { text: "<< Menu", callback_data: "menu" },
                  { text: "Refresh", callback_data: "kols" },
                ],
              ],
            },
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // GMGN Discovery
        if (data === "gmgn_discover") {
          await this.bot.answerCallbackQuery(query.id, { text: "Scanning GMGN for top wallets..." });
          await this.bot.editMessageText("<b>Scanning GMGN for top wallets...</b>\nThis may take a few seconds.", {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
          });
          try {
            const result = await this.callbacks.discoverGmgnKols();
            const text = GmgnDiscovery.formatResult(result);
            await this.bot.editMessageText(text, {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "View KOLs", callback_data: "kols" }],
                  [{ text: "<< Menu", callback_data: "menu" }],
                ],
              },
            });
          } catch (err: any) {
            await this.bot.editMessageText(`<b>GMGN Discovery Failed</b>\n\n${err.message}`, {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Retry", callback_data: "gmgn_discover" }],
                  [{ text: "<< Menu", callback_data: "menu" }],
                ],
              },
            });
          }
          return;
        }

        // Config
        if (data === "config") {
          const c = this.callbacks.getConfig();
          await this.bot.editMessageText(this.buildConfigMessage(c), {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.configKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // Config adjustments: cfg:<key>:<delta>
        if (data.startsWith("cfg:")) {
          const [, key, deltaStr] = data.split(":");
          const delta = parseFloat(deltaStr);
          const c = this.callbacks.getConfig();
          let current = 0;
          if (key === "bet") current = c.maxBetSol;
          else if (key === "tp1") current = c.takeProfit1Percent;
          else if (key === "tp2") current = c.takeProfit2Percent;
          else if (key === "tp3") current = c.takeProfit3Percent;
          else if (key === "sl") current = c.stopLossPercent;
          else if (key === "breakeven") current = c.breakevenActivationPercent;
          else if (key === "trailing") current = c.trailingStopPercent;
          else if (key === "maxpos") current = c.maxPositions;

          const newVal = Math.max(0, current + delta);
          const newValStr = key === "bet" ? newVal.toFixed(2) : String(Math.round(newVal));
          this.callbacks.updateConfig(key, newValStr);

          const updated = this.callbacks.getConfig();
          await this.bot.editMessageText(this.buildConfigMessage(updated), {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: this.configKeyboard(),
          });
          await this.bot.answerCallbackQuery(query.id, { text: `${key} = ${newValStr}` });
          return;
        }

        // Pause
        if (data === "pause") {
          this.callbacks.pauseTrading();
          await this.bot.answerCallbackQuery(query.id, { text: "Auto-trading PAUSED" });
          await this.bot.sendMessage(chatId, "Auto-trading <b>PAUSED</b>. Manual trades still work.", {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "Resume", callback_data: "resume" },
                { text: "<< Menu", callback_data: "menu" },
              ]],
            },
          });
          return;
        }

        // Resume
        if (data === "resume") {
          this.callbacks.resumeTrading();
          await this.bot.answerCallbackQuery(query.id, { text: "Auto-trading RESUMED" });
          await this.bot.sendMessage(chatId, "Auto-trading <b>RESUMED</b>.", {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "Status", callback_data: "status" },
                { text: "<< Menu", callback_data: "menu" },
              ]],
            },
          });
          return;
        }

        // No-op buttons (labels in config grid)
        if (data === "noop") {
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        await this.bot.answerCallbackQuery(query.id, { text: "Unknown action" });
      } catch (err: any) {
        log.warn(`Callback query error: ${err.message}`);
        await this.bot.answerCallbackQuery(query.id, { text: "Error occurred" }).catch(() => {});
      }
    });
  }

  // ─── Slash command registration ────────────────────────────────

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
      { command: "discover", description: "Discover KOLs from GMGN smart money" },
    ]).catch(err => log.warn(`Failed to set Telegram command menu: ${err.message}`));
  }

  private isAuthorized(chatId: number): boolean {
    return String(chatId) === this.chatId;
  }

  private registerCommands() {
    // /start - show main menu with inline buttons
    this.bot.onText(/\/start/, (msg) => {
      if (!this.isAuthorized(msg.chat.id)) return;
      this.bot.sendMessage(msg.chat.id, this.buildStartMessage(), {
        parse_mode: "HTML",
        reply_markup: this.mainMenuKeyboard(),
      });
    });

    // /status
    this.bot.onText(/\/status/, async (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const text = await this.buildStatusMessage();
      this.bot.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: this.backToMenuKeyboard(),
      });
    });

    // /positions - with sell buttons per position
    this.bot.onText(/\/positions/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const positions = this.callbacks.getPositions();
      const text = this.buildPositionsMessage(positions);
      this.bot.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: this.positionsKeyboard(positions),
      });
    });

    // /buy <mint>
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
        this.bot.sendMessage(msg.chat.id, "Buy executed successfully.", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Positions", callback_data: "positions" },
              { text: "Sell", callback_data: `sell:${mint}` },
            ]],
          },
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `Buy failed: ${result.error}`);
      }
    });

    // /sell <mint>
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
        this.bot.sendMessage(msg.chat.id, "Sell executed successfully.", {
          reply_markup: this.backToMenuKeyboard(),
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `Sell failed: ${result.error}`);
      }
    });

    // /kols
    this.bot.onText(/\/kols/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const list = this.callbacks.getKolList();
      this.bot.sendMessage(msg.chat.id, `<b>Tracked KOLs</b>\n\n${list}`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Discover from GMGN", callback_data: "gmgn_discover" }],
            [
              { text: "<< Menu", callback_data: "menu" },
              { text: "Refresh", callback_data: "kols" },
            ],
          ],
        },
      });
    });

    // /discover - fetch top wallets from GMGN
    this.bot.onText(/\/discover/, async (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const pendingMsg = await this.bot.sendMessage(
        msg.chat.id,
        "<b>Scanning GMGN for top wallets...</b>\nThis may take a few seconds.",
        { parse_mode: "HTML" }
      );
      try {
        const result = await this.callbacks.discoverGmgnKols();
        const text = GmgnDiscovery.formatResult(result);
        await this.bot.editMessageText(text, {
          chat_id: msg.chat.id,
          message_id: pendingMsg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "View KOLs", callback_data: "kols" }],
              [{ text: "<< Menu", callback_data: "menu" }],
            ],
          },
        });
      } catch (err: any) {
        await this.bot.editMessageText(`<b>GMGN Discovery Failed</b>\n\n${err.message}`, {
          chat_id: msg.chat.id,
          message_id: pendingMsg.message_id,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Retry", callback_data: "gmgn_discover" }],
              [{ text: "<< Menu", callback_data: "menu" }],
            ],
          },
        });
      }
    });

    // /addkol <wallet> [alias]
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
      this.bot.sendMessage(msg.chat.id, `Added KOL: ${alias || address.slice(0, 8)}... (<code>${address.slice(0, 12)}...</code>)`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "View KOLs", callback_data: "kols" },
            { text: "<< Menu", callback_data: "menu" },
          ]],
        },
      });
    });

    // /removekol <wallet>
    this.bot.onText(/\/removekol (.+)/, (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const address = match[1].trim();
      const removed = this.callbacks.removeKol(address);
      this.bot.sendMessage(msg.chat.id, removed ? `Removed KOL: ${address.slice(0, 12)}...` : "KOL not found.", {
        reply_markup: {
          inline_keyboard: [[
            { text: "View KOLs", callback_data: "kols" },
            { text: "<< Menu", callback_data: "menu" },
          ]],
        },
      });
    });

    // /stats
    this.bot.onText(/\/stats/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const stats = this.callbacks.getStats();
      this.bot.sendMessage(msg.chat.id, `<b>Trading Stats</b>\n\n${stats}`, {
        parse_mode: "HTML",
        reply_markup: this.backToMenuKeyboard(),
      });
    });

    // /history
    this.bot.onText(/\/history/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const history = this.callbacks.getRecentTrades();
      this.bot.sendMessage(msg.chat.id, `<b>Recent Trades</b>\n\n<pre>${history}</pre>`, {
        parse_mode: "HTML",
        reply_markup: this.backToMenuKeyboard(),
      });
    });

    // /pause
    this.bot.onText(/\/pause/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      this.callbacks.pauseTrading();
      this.bot.sendMessage(msg.chat.id, "Auto-trading <b>PAUSED</b>. Manual trades still work.", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Resume", callback_data: "resume" },
            { text: "<< Menu", callback_data: "menu" },
          ]],
        },
      });
    });

    // /resume
    this.bot.onText(/\/resume/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      this.callbacks.resumeTrading();
      this.bot.sendMessage(msg.chat.id, "Auto-trading <b>RESUMED</b>.", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Status", callback_data: "status" },
            { text: "<< Menu", callback_data: "menu" },
          ]],
        },
      });
    });

    // /balance
    this.bot.onText(/\/balance/, async (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const balance = await this.callbacks.getBalance();
      this.bot.sendMessage(msg.chat.id, `Balance: <b>${balance.toFixed(4)} SOL</b>`, {
        parse_mode: "HTML",
        reply_markup: this.backToMenuKeyboard(),
      });
    });

    // /config - with adjustment buttons
    this.bot.onText(/\/config/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      const c = this.callbacks.getConfig();
      this.bot.sendMessage(msg.chat.id, this.buildConfigMessage(c), {
        parse_mode: "HTML",
        reply_markup: this.configKeyboard(),
      });
    });

    // /set <key> <value>
    this.bot.onText(/\/set (.+)/, (msg, match) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks || !match) return;
      const parts = match[1].trim().split(/\s+/);
      if (parts.length < 2) {
        this.bot.sendMessage(msg.chat.id, "Usage: /set <key> <value>\nKeys: bet, maxpos, tp1, tp2, tp3, sl, breakeven, trailing, moonbag, moonbagtrail, maxage, dailyloss");
        return;
      }
      const updated = this.callbacks.updateConfig(parts[0], parts[1]);
      if (updated) {
        this.bot.sendMessage(msg.chat.id, `Updated ${parts[0]} = ${parts[1]}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: "View Config", callback_data: "config" },
              { text: "<< Menu", callback_data: "menu" },
            ]],
          },
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `Unknown setting: ${parts[0]}\nValid: bet, maxpos, tp1, tp2, tp3, sl, breakeven, trailing, moonbag, moonbagtrail, maxage, dailyloss`);
      }
    });
  }
}
