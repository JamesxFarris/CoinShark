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
    // Start polling with error handling — suppress 409 conflicts during deployment overlap
    this.bot = new TelegramBot(token, {
      polling: { params: { timeout: 10 } },
    });
    this.bot.on("polling_error", (err: any) => {
      // 409 = another instance is polling, expected during redeployment
      if (err?.response?.statusCode === 409 || err?.message?.includes("409")) {
        log.debug("Telegram 409 conflict (deployment overlap) — will resolve shortly");
      } else {
        log.warn(`Telegram polling error: ${err.message}`);
      }
    });
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
      `\ud83d\udfe2 <b>BUY ${symbol}</b>`,
      `\ud83c\udfab Mint: <code>${mint.slice(0, 12)}...</code>`,
      `\ud83d\udcb5 Amount: ${solAmount} SOL`,
      `\ud83d\udcca MCap: ${marketCapSol.toFixed(2)} SOL`,
      `\u26a1 Signals: ${signals.join(", ")}`,
      ``,
      `\ud83d\udcc8 <a href="https://pump.fun/coin/${mint}">View Chart on Pump.fun</a>`,
    ].join("\n");
    try {
      await this.bot.sendMessage(this.chatId, msg, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "\ud83d\udcc8 Chart", url: `https://pump.fun/coin/${mint}` }],
            [
              { text: "\ud83d\udcb8 Sell Now", callback_data: `sell:${mint}` },
              { text: "\ud83d\udcc2 Positions", callback_data: "positions" },
            ],
          ],
        },
      });
    } catch (err: any) {
      log.warn(`Telegram send failed: ${err.message}`);
    }
  }

  /**
   * Send sell alert
   */
  async alertSell(symbol: string, mint: string, pnlPercent: number, pnlSol: number, reason: string) {
    const sign = pnlPercent >= 0 ? "+" : "";
    const pnlEmoji = pnlPercent >= 0 ? "\ud83d\udfe2" : "\ud83d\udd34";
    const msg = [
      `\ud83d\udcb8 <b>SELL ${symbol}</b>`,
      `${pnlEmoji} PnL: <b>${sign}${pnlPercent.toFixed(1)}%</b> (${sign}${pnlSol.toFixed(4)} SOL)`,
      `\ud83d\udccc Reason: ${reason}`,
    ].join("\n");
    try {
      await this.bot.sendMessage(this.chatId, msg, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: `\ud83d\udcc8 ${symbol} Chart`, url: `https://pump.fun/coin/${mint}` }],
            [
              { text: "\ud83d\udcc2 Positions", callback_data: "positions" },
              { text: "\ud83c\udfc6 Stats", callback_data: "stats" },
            ],
          ],
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
    const isRunning = this.callbacks?.isRunning() ?? false;
    const toggleBtn = isRunning
      ? { text: "\u23f8 Pause Bot", callback_data: "pause" }
      : { text: "\u25b6\ufe0f Resume Bot", callback_data: "resume" };

    return {
      inline_keyboard: [
        [
          { text: "\ud83d\udcca Status", callback_data: "status" },
          { text: "\ud83d\udcb0 Balance", callback_data: "balance" },
          { text: "\ud83d\udcc2 Positions", callback_data: "positions" },
        ],
        [
          { text: "\ud83c\udfc6 Stats", callback_data: "stats" },
          { text: "\ud83d\udcdc History", callback_data: "history" },
          { text: "\ud83d\udc51 KOLs", callback_data: "kols" },
        ],
        [
          { text: "\u2699\ufe0f Settings", callback_data: "config" },
          toggleBtn,
        ],
        [
          { text: "\ud83d\udd04 Refresh", callback_data: "refresh_menu" },
        ],
      ],
    };
  }

  private backToMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [[
        { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
        { text: "\ud83d\udd04 Refresh", callback_data: "refresh_menu" },
      ]],
    };
  }

  private positionsKeyboard(positions: Position[]): TelegramBot.InlineKeyboardMarkup {
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    for (const p of positions) {
      const emoji = p.currentPnlPercent >= 0 ? "\ud83d\udfe2" : "\ud83d\udd34";
      rows.push([
        { text: `\ud83d\udcc8 ${p.symbol} Chart`, url: `https://pump.fun/coin/${p.mint}` },
        { text: `${emoji} Sell ${p.symbol}`, callback_data: `sell:${p.mint}` },
      ]);
    }
    rows.push([
      { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
      { text: "\ud83d\udd04 Refresh", callback_data: "positions" },
    ]);
    return { inline_keyboard: rows };
  }

  private configKeyboard(c: BotConfig): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        // -- Trade Size --
        [{ text: `\ud83d\udcb5 Bet Size: ${c.maxBetSol} SOL`, callback_data: "noop" }],
        [
          { text: "\u2796 0.01", callback_data: "cfg:bet:-0.01" },
          { text: "\u2795 0.01", callback_data: "cfg:bet:+0.01" },
        ],
        // -- Take Profits --
        [{ text: `\ud83c\udfaf Take Profit 1: +${c.takeProfit1Percent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 25", callback_data: "cfg:tp1:-25" },
          { text: "\u2795 25", callback_data: "cfg:tp1:+25" },
        ],
        [{ text: `\ud83c\udfaf Take Profit 2: +${c.takeProfit2Percent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 50", callback_data: "cfg:tp2:-50" },
          { text: "\u2795 50", callback_data: "cfg:tp2:+50" },
        ],
        [{ text: `\ud83c\udfaf Take Profit 3: +${c.takeProfit3Percent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 100", callback_data: "cfg:tp3:-100" },
          { text: "\u2795 100", callback_data: "cfg:tp3:+100" },
        ],
        // -- Stop Loss --
        [{ text: `\ud83d\udee1 Stop Loss: -${c.stopLossPercent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 5", callback_data: "cfg:sl:-5" },
          { text: "\u2795 5", callback_data: "cfg:sl:+5" },
        ],
        // -- Breakeven --
        [{ text: `\u2696\ufe0f Breakeven At: +${c.breakevenActivationPercent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 10", callback_data: "cfg:breakeven:-10" },
          { text: "\u2795 10", callback_data: "cfg:breakeven:+10" },
        ],
        // -- Trailing Stop --
        [{ text: `\ud83d\udcc9 Trailing Stop: ${c.trailingStopPercent}%`, callback_data: "noop" }],
        [
          { text: "\u2796 5", callback_data: "cfg:trailing:-5" },
          { text: "\u2795 5", callback_data: "cfg:trailing:+5" },
        ],
        // -- Max Positions --
        [{ text: `\ud83d\udcca Max Positions: ${c.maxPositions}`, callback_data: "noop" }],
        [
          { text: "\u2796 1", callback_data: "cfg:maxpos:-1" },
          { text: "\u2795 1", callback_data: "cfg:maxpos:+1" },
        ],
        // -- Nav --
        [
          { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
          { text: "\ud83d\udd04 Refresh", callback_data: "config" },
        ],
      ],
    };
  }

  // ─── Response builders ─────────────────────────────────────────

  private buildStartMessage(): string {
    const isRunning = this.callbacks?.isRunning() ?? false;
    const statusLine = isRunning
      ? "\ud83d\udfe2 <b>Auto-Trading: ON</b>"
      : "\ud83d\udd34 <b>Auto-Trading: OFF</b>";

    return [
      "\ud83e\udd88 <b>CoinShark Trading Bot</b>",
      "",
      statusLine,
      "",
      "Use the buttons below to control the bot.",
      "You can also type commands:",
      "",
      "/buy &lt;mint&gt; \u2014 Manual buy",
      "/sell &lt;mint&gt; \u2014 Manual sell",
      "/addkol &lt;wallet&gt; [alias] \u2014 Add KOL",
      "/removekol &lt;wallet&gt; \u2014 Remove KOL",
      "/set &lt;key&gt; &lt;value&gt; \u2014 Update config",
    ].join("\n");
  }

  private async buildStatusMessage(): Promise<string> {
    if (!this.callbacks) return "Bot not ready.";
    const balance = await this.callbacks.getBalance();
    const positions = this.callbacks.getPositions();
    const running = this.callbacks.isRunning();
    const uptime = ((Date.now() - this.startTime) / 1000 / 60).toFixed(0);
    const statusEmoji = running ? "\ud83d\udfe2" : "\ud83d\udd34";
    const statusText = running ? "ACTIVE \u2014 auto-buying enabled" : "PAUSED \u2014 manual only";

    return [
      `\ud83e\udd88 <b>CoinShark Status</b>`,
      ``,
      `${statusEmoji} <b>${statusText}</b>`,
      ``,
      `\u23f1 Uptime: ${uptime} min`,
      `\ud83d\udcb0 Balance: <b>${balance.toFixed(4)} SOL</b>`,
      `\ud83d\udcc2 Open Positions: <b>${positions.length}</b>`,
      `\ud83d\udd11 Wallet: <code>${this.callbacks.getWalletAddress()}</code>`,
    ].join("\n");
  }

  private buildPositionsMessage(positions: Position[]): string {
    if (positions.length === 0) return "\ud83d\udcc2 No open positions.";
    return positions.map(p => {
      const pnlEmoji = p.currentPnlPercent >= 0 ? "\ud83d\udfe2" : "\ud83d\udd34";
      const pnl = `${p.currentPnlPercent >= 0 ? "+" : ""}${p.currentPnlPercent.toFixed(1)}%`;
      const age = ((Date.now() - p.entryTime) / 1000 / 60).toFixed(1);
      return [
        `${pnlEmoji} <b>${p.symbol}</b>  ${pnl}`,
        `   \ud83d\udcca MCap: ${p.currentMarketCapSol.toFixed(1)} SOL`,
        `   \ud83d\udcb5 Invested: ${p.solInvested} SOL`,
        `   \u23f1 Age: ${age}m  |  \ud83c\udfaf TP: ${p.takeProfitHits}/2`,
        `   \ud83d\udcc8 <a href="https://pump.fun/coin/${p.mint}">Chart</a>  |  <code>${p.mint}</code>`,
      ].join("\n");
    }).join("\n\n");
  }

  private buildConfigMessage(c: BotConfig): string {
    return [
      `<b>\u2699\ufe0f Bot Settings</b>`,
      ``,
      `<b>\ud83d\udcb5 Trade Size</b>`,
      `<b>${c.maxBetSol} SOL</b> per trade (auto-scales 0.5x\u20132x based on signal strength)`,
      `Up to <b>${c.maxPositions}</b> trades open at once`,
      ``,
      `<b>\ud83c\udfaf When to Take Profit</b>`,
      `<i>The bot sells in stages as price goes up:</i>`,
      `  1\ufe0f\u20e3  At <b>+${c.takeProfit1Percent}%</b> \u2014 sell half, get your money back`,
      `  2\ufe0f\u20e3  At <b>+${c.takeProfit2Percent}%</b> \u2014 sell half of what's left`,
      `  3\ufe0f\u20e3  At <b>+${c.takeProfit3Percent}%</b> \u2014 sell down to ${c.moonbagPercent}% moonbag`,
      ``,
      `<b>\ud83d\udee1 Protection</b>`,
      `<i>Automatic safety nets to limit losses:</i>`,
      `  \ud83d\udd34 <b>Stop Loss:</b> sell if price drops <b>-${c.stopLossPercent}%</b>`,
      `  \u2696\ufe0f <b>Breakeven:</b> once up <b>+${c.breakevenActivationPercent}%</b>, stop loss moves to your entry price`,
      `  \ud83d\udcc9 <b>Trailing:</b> after TP1, auto-sell if price drops <b>${c.trailingStopPercent}%</b> from peak`,
      `  \u23f0 <b>Max hold:</b> ${c.maxPositionAgeMinutes} min \u2022 Daily limit: ${c.dailyLossLimitSol} SOL loss`,
      ``,
      `<i>Tap \u2796/\u2795 below to adjust any setting:</i>`,
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
          // Try to get the token symbol from positions
          const positions = this.callbacks.getPositions();
          const pos = positions.find(p => p.mint === mint);
          const tokenName = pos?.symbol || mint.slice(0, 8);
          await this.bot.answerCallbackQuery(query.id, { text: `Selling ${tokenName}...` });
          const result = await this.callbacks.manualSell(mint);
          if (result.success) {
            await this.bot.sendMessage(chatId, `\u2705 <b>Sold ${tokenName}</b>\n<code>${mint.slice(0, 16)}...</code>`, {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "\ud83d\udcc2 Positions", callback_data: "positions" },
                  { text: "\ud83c\udfc6 Stats", callback_data: "stats" },
                ]],
              },
            });
          } else {
            await this.bot.sendMessage(chatId, `\u274c <b>Sell failed for ${tokenName}</b>\n${result.error ?? "Unknown error"}`, { parse_mode: "HTML" });
          }
          return;
        }

        // Stats
        if (data === "stats") {
          const stats = this.callbacks.getStats();
          await this.bot.editMessageText(`\ud83c\udfc6 <b>Trading Stats</b>\n\n${stats}`, {
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
          await this.bot.editMessageText(`\ud83d\udcdc <b>Recent Trades</b>\n\n<pre>${history}</pre>`, {
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
          await this.bot.editMessageText(`\ud83d\udc51 <b>Tracked KOLs</b>\n\n${list}`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "\ud83d\udd0d Discover from GMGN", callback_data: "gmgn_discover" }],
                [
                  { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
                  { text: "\ud83d\udd04 Refresh", callback_data: "kols" },
                ],
              ],
            },
          });
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // GMGN Discovery
        if (data === "gmgn_discover") {
          await this.bot.answerCallbackQuery(query.id, { text: "Scanning GMGN..." });
          await this.bot.editMessageText("\ud83d\udd0d <b>Scanning GMGN for top wallets...</b>\nThis may take a few seconds.", {
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
                  [{ text: "\ud83d\udc51 View KOLs", callback_data: "kols" }],
                  [{ text: "\u2b05\ufe0f Menu", callback_data: "menu" }],
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
                  [{ text: "\ud83d\udd04 Retry", callback_data: "gmgn_discover" }],
                  [{ text: "\u2b05\ufe0f Menu", callback_data: "menu" }],
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
            reply_markup: this.configKeyboard(c),
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
            reply_markup: this.configKeyboard(updated),
          });
          await this.bot.answerCallbackQuery(query.id, { text: `${key} = ${newValStr}` });
          return;
        }

        // Pause
        if (data === "pause") {
          this.callbacks.pauseTrading();
          await this.bot.answerCallbackQuery(query.id, { text: "\ud83d\udd34 Paused" });
          await this.bot.sendMessage(chatId, "\ud83d\udd34 <b>Auto-Trading: OFF</b>\n\nThe bot will NOT open new positions.\nManual /buy and /sell still work.", {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "\u25b6\ufe0f Resume Bot", callback_data: "resume" },
                { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
              ]],
            },
          });
          return;
        }

        // Resume
        if (data === "resume") {
          this.callbacks.resumeTrading();
          await this.bot.answerCallbackQuery(query.id, { text: "\ud83d\udfe2 Resumed" });
          await this.bot.sendMessage(chatId, "\ud83d\udfe2 <b>Auto-Trading: ON</b>\n\nThe bot is now scanning and buying automatically.", {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "\ud83d\udcca Status", callback_data: "status" },
                { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
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
      this.bot.sendMessage(msg.chat.id, `\u23f3 Buying <code>${mint.slice(0, 12)}...</code>`, { parse_mode: "HTML" });
      const result = await this.callbacks.manualBuy(mint);
      if (result.success) {
        this.bot.sendMessage(msg.chat.id, `\ud83d\udfe2 <b>Buy executed!</b>\n<code>${mint.slice(0, 16)}...</code>`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "\ud83d\udcc8 Chart", url: `https://pump.fun/coin/${mint}` }],
              [
                { text: "\ud83d\udcc2 Positions", callback_data: "positions" },
                { text: "\ud83d\udcb8 Sell", callback_data: `sell:${mint}` },
              ],
            ],
          },
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `\u274c Buy failed: ${result.error ?? "Unknown error"}`);
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
      const positions = this.callbacks.getPositions();
      const pos = positions.find(p => p.mint === mint);
      const tokenName = pos?.symbol || mint.slice(0, 8);
      this.bot.sendMessage(msg.chat.id, `Selling ${tokenName}...`);
      const result = await this.callbacks.manualSell(mint);
      if (result.success) {
        this.bot.sendMessage(msg.chat.id, `\u2705 <b>Sold ${tokenName}</b>`, {
          parse_mode: "HTML",
          reply_markup: this.backToMenuKeyboard(),
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `\u274c Sell failed for ${tokenName}: ${result.error ?? "Unknown error"}`);
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
            [{ text: "\ud83d\udd0d Discover from GMGN", callback_data: "gmgn_discover" }],
            [
              { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
              { text: "\ud83d\udd04 Refresh", callback_data: "kols" },
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
        "\ud83d\udd0d <b>Scanning GMGN for top wallets...</b>\nThis may take a few seconds.",
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
              [{ text: "\ud83d\udc51 View KOLs", callback_data: "kols" }],
              [{ text: "\u2b05\ufe0f Menu", callback_data: "menu" }],
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
              [{ text: "\ud83d\udd04 Retry", callback_data: "gmgn_discover" }],
              [{ text: "\u2b05\ufe0f Menu", callback_data: "menu" }],
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
            { text: "\ud83d\udc51 View KOLs", callback_data: "kols" },
            { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
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
            { text: "\ud83d\udc51 View KOLs", callback_data: "kols" },
            { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
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
      this.bot.sendMessage(msg.chat.id, "\ud83d\udd34 <b>Auto-Trading: OFF</b>\n\nThe bot will NOT open new positions.\nManual /buy and /sell still work.", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "\u25b6\ufe0f Resume Bot", callback_data: "resume" },
            { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
          ]],
        },
      });
    });

    // /resume
    this.bot.onText(/\/resume/, (msg) => {
      if (!this.isAuthorized(msg.chat.id) || !this.callbacks) return;
      this.callbacks.resumeTrading();
      this.bot.sendMessage(msg.chat.id, "\ud83d\udfe2 <b>Auto-Trading: ON</b>\n\nThe bot is now scanning and buying automatically.", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "\ud83d\udcca Status", callback_data: "status" },
            { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
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
        reply_markup: this.configKeyboard(c),
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
              { text: "\u2699\ufe0f Settings", callback_data: "config" },
              { text: "\u2b05\ufe0f Menu", callback_data: "menu" },
            ]],
          },
        });
      } else {
        this.bot.sendMessage(msg.chat.id, `Unknown setting: ${parts[0]}\nValid: bet, maxpos, tp1, tp2, tp3, sl, breakeven, trailing, moonbag, moonbagtrail, maxage, dailyloss`);
      }
    });
  }
}
