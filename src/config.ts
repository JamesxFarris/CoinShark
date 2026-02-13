import dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

function envStr(key: string, fallback: string = ""): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === "true";
}

export function loadConfig(): BotConfig {
  return {
    solanaRpcUrl: envStr("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    privateKey: envStr("SOLANA_PRIVATE_KEY"),
    pumpPortalApiKey: envStr("PUMPPORTAL_API_KEY"),

    maxBetSol: envNum("MAX_BET_SOL", 0.05),
    maxPositions: envNum("MAX_POSITIONS", 3),
    slippagePercent: envNum("SLIPPAGE_PERCENT", 25),
    priorityFeeSol: envNum("PRIORITY_FEE_SOL", 0.001),

    takeProfit1Percent: envNum("TAKE_PROFIT_1_PERCENT", 50),
    takeProfit2Percent: envNum("TAKE_PROFIT_2_PERCENT", 100),
    stopLossPercent: envNum("STOP_LOSS_PERCENT", 30),
    moonbagPercent: envNum("MOONBAG_PERCENT", 10),

    maxTopHolderPercent: envNum("MAX_TOP_HOLDER_PERCENT", 50),
    minUniqueHolders: envNum("MIN_UNIQUE_HOLDERS", 10),
    requireMintRevoked: envBool("REQUIRE_MINT_REVOKED", true),
    requireFreezeRevoked: envBool("REQUIRE_FREEZE_REVOKED", true),
    minTokenAgeSeconds: envNum("MIN_TOKEN_AGE_SECONDS", 30),

    kolWallets: envStr("KOL_WALLETS")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean),
    minKolBuys: envNum("MIN_KOL_BUYS", 1),

    min5mVolumeSol: envNum("MIN_5M_VOLUME_SOL", 5),
    min5mBuyers: envNum("MIN_5M_BUYERS", 10),
    minMarketCapSol: envNum("MIN_MARKET_CAP_SOL", 10),
    maxMarketCapSol: envNum("MAX_MARKET_CAP_SOL", 500),

    // Bonding Curve
    minBondingCurvePercent: envNum("MIN_BONDING_CURVE_PERCENT", 5),
    maxBondingCurvePercent: envNum("MAX_BONDING_CURVE_PERCENT", 85),

    // Risk Management
    maxPositionAgeMinutes: envNum("MAX_POSITION_AGE_MINUTES", 30),
    dailyLossLimitSol: envNum("DAILY_LOSS_LIMIT_SOL", 0.5),

    // Telegram
    telegramBotToken: envStr("TELEGRAM_BOT_TOKEN"),
    telegramChatId: envStr("TELEGRAM_CHAT_ID"),
  };
}
