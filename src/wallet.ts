import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger";

export class WalletManager {
  private connection: Connection;
  private keypair: Keypair;

  constructor(rpcUrl: string, privateKeyBase58: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    try {
      const decoded = bs58.decode(privateKeyBase58);
      this.keypair = Keypair.fromSecretKey(decoded);
    } catch {
      throw new Error(
        "Invalid private key. Must be base58-encoded Solana private key."
      );
    }
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  getConnection(): Connection {
    return this.connection;
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  async getBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async signAndSendTransaction(
    serializedTx: Uint8Array
  ): Promise<string> {
    const tx = VersionedTransaction.deserialize(serializedTx);
    tx.sign([this.keypair]);

    // Send via Jito for MEV protection + better landing rate.
    // Falls back to standard RPC if Jito fails.
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");
    let signature: string | null = null;

    try {
      const jitoResp = await fetch(
        "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [txBase64, { encoding: "base64" }],
          }),
        }
      );
      const jitoResult = await jitoResp.json() as any;
      if (jitoResult.result) {
        signature = jitoResult.result;
        log.debug(`Transaction sent via Jito: ${signature}`);
      } else {
        log.debug(`Jito send failed: ${JSON.stringify(jitoResult.error ?? jitoResult)}, falling back to RPC`);
      }
    } catch (e: any) {
      log.debug(`Jito endpoint error: ${e.message}, falling back to RPC`);
    }

    // Fallback to standard RPC
    if (!signature) {
      signature = await this.connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 3,
      });
      log.debug(`Transaction sent via RPC: ${signature}`);
    }

    return signature;
  }

  async confirmTransaction(signature: string, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.connection.getSignatureStatus(signature);
      if (status.value?.confirmationStatus === "confirmed" ||
          status.value?.confirmationStatus === "finalized") {
        // CRITICAL: A transaction can be "confirmed" (included in a block) but still
        // have an execution error (e.g. program reverted, insufficient funds).
        // We MUST check err even for confirmed transactions.
        if (status.value.err) {
          log.error(`Transaction confirmed but FAILED on-chain: ${signature}`, status.value.err);
          return false;
        }
        return true;
      }
      if (status.value?.err) {
        log.error(`Transaction failed: ${signature}`, status.value.err);
        return false;
      }
      await sleep(2000);
    }
    log.warn(`Transaction confirmation timed out: ${signature}`);
    return false;
  }

  async getTokenBalance(mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint }
      );
      if (accounts.value.length === 0) return 0;
      return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    } catch {
      return 0;
    }
  }

  async printStatus() {
    const balance = await this.getBalance();
    log.info(`Wallet: ${this.address}`);
    log.info(`Balance: ${balance.toFixed(4)} SOL`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
