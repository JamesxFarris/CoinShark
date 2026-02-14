import WebSocket from "ws";
import { EventEmitter } from "events";
import { PumpPortalNewToken, PumpPortalTrade, PumpPortalMigration } from "./types";
import { log } from "./logger";

const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";

/**
 * TokenScanner connects to PumpPortal's WebSocket to stream:
 * - New token creations on Pump.fun
 * - Trades on tokens we're watching
 * - Trades by KOL wallets we're tracking
 * - Token migrations (bonding curve graduation to PumpSwap/Raydium)
 *
 * Events emitted:
 * - "newToken" (PumpPortalNewToken)
 * - "trade" (PumpPortalTrade)
 * - "migration" (PumpPortalMigration)
 * - "fatal" (Error)
 */
export class TokenScanner extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscribedTokens: Set<string> = new Set();
  private subscribedAccounts: Set<string> = new Set();
  private isConnected = false;
  private recentSignatures: Set<string> = new Set(); // dedup overlapping subscriptions

  connect() {
    log.info("Connecting to PumpPortal WebSocket...");
    this.ws = new WebSocket(PUMPPORTAL_WS_URL);

    this.ws.on("open", () => {
      log.info("Connected to PumpPortal WebSocket");
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Subscribe to new token creations and migrations
      this.send({ method: "subscribeNewToken" });
      this.send({ method: "subscribeMigration" });

      // Re-subscribe to any tokens/accounts from before reconnect
      for (const mint of this.subscribedTokens) {
        this.send({ method: "subscribeTokenTrade", keys: [mint] });
      }
      for (const account of this.subscribedAccounts) {
        this.send({ method: "subscribeAccountTrade", keys: [account] });
      }
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.debug(`Failed to parse WS message: ${data.toString().slice(0, 200)}`);
      }
    });

    this.ws.on("close", () => {
      log.warn("PumpPortal WebSocket disconnected");
      this.isConnected = false;
      this.attemptReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`WebSocket error: ${err.message}`);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Subscribe to trades on a specific token mint
   */
  watchToken(mint: string) {
    this.subscribedTokens.add(mint);
    if (this.isConnected) {
      this.send({ method: "subscribeTokenTrade", keys: [mint] });
      log.debug(`Watching token: ${mint.slice(0, 8)}...`);
    }
  }

  /**
   * Unsubscribe from a token
   */
  unwatchToken(mint: string) {
    this.subscribedTokens.delete(mint);
    if (this.isConnected) {
      this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
    }
  }

  /**
   * Subscribe to trades by a specific wallet (e.g. KOL wallet)
   */
  watchAccount(account: string) {
    this.subscribedAccounts.add(account);
    if (this.isConnected) {
      this.send({ method: "subscribeAccountTrade", keys: [account] });
      log.debug(`Watching account: ${account.slice(0, 8)}...`);
    }
  }

  /**
   * Unsubscribe from an account
   */
  unwatchAccount(account: string) {
    this.subscribedAccounts.delete(account);
    if (this.isConnected) {
      this.send({ method: "unsubscribeAccountTrade", keys: [account] });
    }
  }

  private send(msg: object) {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: any) {
    // Deduplicate: when a KOL buys a watched token, PumpPortal sends the
    // trade on BOTH the token and account channels. Skip duplicates by signature.
    if (msg.signature && this.recentSignatures.has(msg.signature)) return;
    if (msg.signature) {
      this.recentSignatures.add(msg.signature);
      // Cap the set size to prevent memory leak
      if (this.recentSignatures.size > 5000) {
        const iter = this.recentSignatures.values();
        for (let i = 0; i < 2500; i++) iter.next();
        // Keep only the last ~2500 entries
        const keep = new Set<string>();
        for (const sig of iter) keep.add(sig);
        this.recentSignatures = keep;
      }
    }

    // New token creation event
    if (msg.mint && msg.initialBuy !== undefined && msg.name) {
      const token: PumpPortalNewToken = {
        signature: msg.signature ?? "",
        mint: msg.mint,
        traderPublicKey: msg.traderPublicKey ?? "",
        initialBuy: msg.initialBuy ?? 0,
        bondingCurveKey: msg.bondingCurveKey ?? "",
        vTokensInBondingCurve: msg.vTokensInBondingCurve ?? 0,
        vSolInBondingCurve: msg.vSolInBondingCurve ?? 0,
        marketCapSol: msg.marketCapSol ?? 0,
        name: msg.name ?? "",
        symbol: msg.symbol ?? "",
        uri: msg.uri ?? "",
      };
      this.emit("newToken", token);
      return;
    }

    // Migration event (bonding curve graduation)
    if (msg.mint && msg.pool && !msg.txType) {
      const migration: PumpPortalMigration = {
        signature: msg.signature ?? "",
        mint: msg.mint,
        bondingCurveKey: msg.bondingCurveKey ?? "",
        pool: msg.pool ?? "",
        marketCapSol: msg.marketCapSol ?? 0,
      };
      this.emit("migration", migration);
      return;
    }

    // Trade event (buy or sell on a watched token/account)
    if (msg.txType && msg.mint) {
      const trade: PumpPortalTrade = {
        signature: msg.signature ?? "",
        mint: msg.mint,
        traderPublicKey: msg.traderPublicKey ?? "",
        txType: msg.txType,
        tokenAmount: msg.tokenAmount ?? 0,
        solAmount: msg.solAmount ?? 0,
        newTokenBalance: msg.newTokenBalance ?? 0,
        bondingCurveKey: msg.bondingCurveKey ?? "",
        vTokensInBondingCurve: msg.vTokensInBondingCurve ?? 0,
        vSolInBondingCurve: msg.vSolInBondingCurve ?? 0,
        marketCapSol: msg.marketCapSol ?? 0,
      };
      this.emit("trade", trade);
      return;
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error("Max reconnect attempts reached. Giving up.");
      this.emit("fatal", new Error("WebSocket reconnection failed"));
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    log.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this.connect(), delay);
  }
}
