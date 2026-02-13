import { PublicKey } from "@solana/web3.js";

// === Token Data ===

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  createdAt: number;
  bondingCurveProgress: number; // 0-100, 100 = graduated to Raydium
  marketCapSol: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface TokenTrade {
  signature: string;
  mint: string;
  traderPublicKey: string;
  action: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  timestamp: number;
  newMarketCapSol: number;
}

// === Scam Detection ===

export interface ScamAnalysis {
  mint: string;
  passed: boolean;
  reasons: string[];
  scores: {
    holderDistribution: number; // 0-100
    volumeAuthenticity: number; // 0-100
    creatorTrust: number; // 0-100
    overallSafety: number; // 0-100
  };
  flags: {
    mintAuthorityEnabled: boolean;
    freezeAuthorityEnabled: boolean;
    topHolderConcentration: number;
    suspectedWashTrading: boolean;
    bundledLaunch: boolean;
    creatorIsSerial: boolean;
    lowUniqueHolders: boolean;
  };
}

export interface HolderInfo {
  address: string;
  balance: number;
  percentage: number;
}

// === Signal Engine ===

export type SignalType =
  | "kol_buy"
  | "volume_spike"
  | "momentum"
  | "trend"
  | "bonding_curve"
  | "holder_velocity"
  | "coordinated_sell"
  | "creator_sell"
  | "graduation"
  | "alpha_wallet";

export interface PumpPortalMigration {
  signature: string;
  mint: string;
  bondingCurveKey: string;
  pool: string; // PumpSwap/Raydium pool address
  marketCapSol: number;
}

export interface Signal {
  type: SignalType;
  mint: string;
  strength: number; // 0-100
  details: string;
  timestamp: number;
}

export interface TokenMomentum {
  mint: string;
  volumeLast5m: number;
  uniqueBuyersLast5m: number;
  uniqueSellersLast5m: number;
  buyToSellRatio: number;
  priceChangePercent5m: number;
  bondingCurvePercent: number;
  kolBuys: string[]; // KOL wallet addresses that bought
  signals: Signal[];
  aggregateScore: number; // 0-100
}

// === Trading ===

export type TradeAction = "buy" | "sell";

export interface TradeRequest {
  action: TradeAction;
  mint: string;
  amountSol?: number;
  amountPercent?: string; // e.g. "100%" for sell-all
  slippage: number;
  priorityFee: number;
}

export interface TradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  amountSol?: number;
  amountTokens?: number;
}

export interface Position {
  mint: string;
  symbol: string;
  entryPriceSol: number; // price per token in SOL at entry
  entryMarketCapSol: number;
  tokenAmount: number;
  solInvested: number;
  solRecovered: number; // SOL recovered from partial sells
  entryTime: number;
  currentMarketCapSol: number;
  currentPnlPercent: number;
  highWaterMarkPnl: number; // highest PnL seen (for trailing stop)
  takeProfitHits: number; // how many TP levels hit (0-3)
  breakevenStopActive: boolean; // true once PnL crossed breakeven threshold
  trailingStopActive: boolean; // true after TP1 hit
  isMoonbag: boolean; // true after TP3 (only moonbag left)
  signals: Signal[]; // signals that triggered the buy
  signalScore: number; // aggregate signal score at entry (for sizing)
}

// === KOL Discovery & Scoring ===

export interface KolProfile {
  address: string;
  alias: string;
  addedAt: number;
  totalSignals: number;
  profitableSignals: number;
  totalPnlPercent: number;
  winRate: number; // 0-100
  score: number; // 0-100
  lastActive: number;
}

// === Trade History ===

export interface TradeHistoryEntry {
  id: string;
  timestamp: number;
  mint: string;
  symbol: string;
  action: "buy" | "sell";
  solAmount: number;
  marketCapSol: number;
  signature?: string;
  entryMarketCapSol?: number;
  exitMarketCapSol?: number;
  pnlPercent?: number;
  pnlSol?: number;
  holdDurationMs?: number;
  exitReason?: string;
  triggerSignals?: string[];
}

export interface BotStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlSol: number;
  bestTradePnl: number;
  worstTradePnl: number;
  avgHoldTimeMs: number;
  dailyPnlSol: number;
}

// === Config ===

export interface BotConfig {
  // Wallet
  solanaRpcUrl: string;
  privateKey: string;
  pumpPortalApiKey: string;

  // Trading
  maxBetSol: number;
  maxPositions: number;
  slippagePercent: number;
  priorityFeeSol: number;

  // Take Profit / Stop Loss
  takeProfit1Percent: number;
  takeProfit2Percent: number;
  takeProfit3Percent: number;
  stopLossPercent: number;
  moonbagPercent: number; // % of position to keep as moonbag after TP3
  breakevenActivationPercent: number; // move SL to breakeven once PnL hits this
  trailingStopPercent: number; // after TP1, sell if price drops this % from HWM
  moonbagTrailingStopPercent: number; // trailing stop for moonbag positions

  // Scam Filters
  maxTopHolderPercent: number;
  minUniqueHolders: number;
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  minTokenAgeSeconds: number;

  // KOL
  kolWallets: string[];
  minKolBuys: number;

  // Volume / Momentum
  min5mVolumeSol: number;
  min5mBuyers: number;
  minMarketCapSol: number;
  maxMarketCapSol: number;

  // Bonding Curve
  minBondingCurvePercent: number;
  maxBondingCurvePercent: number;

  // Risk Management
  maxPositionAgeMinutes: number;
  dailyLossLimitSol: number;

  // Telegram
  telegramBotToken: string;
  telegramChatId: string;
}

// === WebSocket Messages ===

export interface PumpPortalNewToken {
  signature: string;
  mint: string;
  traderPublicKey: string;
  initialBuy: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
}

export interface PumpPortalTrade {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}
