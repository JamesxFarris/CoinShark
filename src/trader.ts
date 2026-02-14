import { TradeRequest, TradeResult, BotConfig } from "./types";
import { WalletManager } from "./wallet";
import { log } from "./logger";

const PUMPPORTAL_LOCAL_API = "https://pumpportal.fun/api/trade-local";

/**
 * Trader handles executing buy/sell orders via PumpPortal's local transaction API.
 * Uses local signing (your private key never leaves your machine).
 *
 * Supports dry-run mode: logs simulated trades without touching the chain.
 */
export class Trader {
  private config: BotConfig;
  private wallet: WalletManager;

  constructor(config: BotConfig, wallet: WalletManager) {
    this.config = config;
    this.wallet = wallet;
  }

  /**
   * Get the wallet manager (for balance checks after trades)
   */
  getWallet(): WalletManager {
    return this.wallet;
  }

  /**
   * Execute a buy order
   */
  async buy(mint: string, amountSol: number): Promise<TradeResult> {
    log.trade(`BUY ${amountSol.toFixed(4)} SOL of ${mint.slice(0, 8)}...`);

    if (this.config.dryRun) {
      return this.simulateTrade("buy", mint, amountSol);
    }

    return this.executeTrade({
      action: "buy",
      mint,
      amountSol,
      slippage: this.config.slippagePercent,
      priorityFee: this.config.priorityFeeSol,
    });
  }

  /**
   * Execute a sell order (by percentage of holdings)
   */
  async sell(mint: string, percent: number = 100): Promise<TradeResult> {
    log.trade(`SELL ${percent}% of ${mint.slice(0, 8)}...`);

    if (this.config.dryRun) {
      return this.simulateTrade("sell", mint, undefined, percent);
    }

    return this.executeTrade({
      action: "sell",
      mint,
      amountPercent: `${percent}%`,
      slippage: this.config.slippagePercent,
      priorityFee: this.config.priorityFeeSol,
    });
  }

  /**
   * Simulate a trade for dry-run mode. Logs the action but doesn't touch the chain.
   */
  private simulateTrade(
    action: "buy" | "sell",
    mint: string,
    amountSol?: number,
    sellPercent?: number
  ): TradeResult {
    const simSig = `DRY_RUN_${Date.now()}_${mint.slice(0, 8)}`;
    if (action === "buy") {
      log.trade(`[DRY RUN] BUY simulated: ${amountSol?.toFixed(4)} SOL → ${mint.slice(0, 8)}... | sig: ${simSig}`);
    } else {
      log.trade(`[DRY RUN] SELL simulated: ${sellPercent}% of ${mint.slice(0, 8)}... | sig: ${simSig}`);
    }
    return {
      success: true,
      signature: simSig,
      amountSol,
    };
  }

  /**
   * Execute a trade via PumpPortal local transaction API.
   * Flow: request serialized tx → sign locally → send to Solana
   */
  private async executeTrade(request: TradeRequest): Promise<TradeResult> {
    try {
      // Step 1: Get the serialized transaction from PumpPortal
      const body: Record<string, string> = {
        publicKey: this.wallet.address,
        action: request.action,
        mint: request.mint,
        denominatedInSol: request.action === "buy" ? "true" : "false",
        slippage: String(request.slippage),
        priorityFee: String(request.priorityFee),
        pool: "auto",
      };

      if (request.action === "buy" && request.amountSol !== undefined) {
        body.amount = String(request.amountSol);
        body.denominatedInSol = "true";
      } else if (request.action === "sell" && request.amountPercent) {
        body.amount = request.amountPercent;
        body.denominatedInSol = "false";
      }

      log.debug(`Trade request: ${JSON.stringify(body)}`);

      const response = await fetch(PUMPPORTAL_LOCAL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          error: `PumpPortal API error (${response.status}): ${errText}`,
        };
      }

      // Step 2: Sign and send the transaction locally
      const txBuffer = await response.arrayBuffer();
      const txBytes = new Uint8Array(txBuffer);

      const signature = await this.wallet.signAndSendTransaction(txBytes);

      // Step 3: Confirm the transaction
      const confirmed = await this.wallet.confirmTransaction(signature);

      if (confirmed) {
        log.trade(
          `${request.action.toUpperCase()} confirmed: ${signature}`
        );
        return {
          success: true,
          signature,
          amountSol: request.amountSol,
        };
      } else {
        return {
          success: false,
          signature,
          error: "Transaction sent but confirmation timed out",
        };
      }
    } catch (err: any) {
      log.error(`Trade failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }
}
