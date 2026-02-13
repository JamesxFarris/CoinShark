import WebSocket from "ws";
import { EventEmitter } from "events";
import { PumpPortalNewToken, PumpPortalTrade } from "./types";
import { log } from "./logger";

const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";

/**
 * TokenScanner connects to PumpPortal's WebSocket to stream:
 * - New token creations on Pump.fun
 * - Trades on tokens we're watching
 * - Trades by KOL wallets we're tracking
 */
export class TokenScanner extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscribedTokens: Set<string> = new Set();
  private subscribedAccounts: Set<string> = new Set();
  private isConnected = false;

  connect() {
    log.info("Connecting to PumpPortal WebSocket...");
    this.ws = new WebSocket(PUMPPORTAL_WS_URL);

    this.ws.on("open", () => {
      log.info("Connected to PumpPortal WebSocket");
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Subscribe to new token creations
      this.send({ method: "subscribeNewToken" });

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

  private send(msg: object) {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: any) {
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
