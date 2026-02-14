import * as fs from "fs";
import * as path from "path";
import { KolProfile, BotConfig } from "./types";
import { log } from "./logger";

const DATA_DIR = path.join(process.cwd(), "data");
const KOL_FILE = path.join(DATA_DIR, "kols.json");

/**
 * KolDiscovery manages KOL wallet tracking with performance scoring.
 *
 * Features:
 * - Persistent KOL storage (survives restarts)
 * - Performance tracking (win rate, PnL)
 * - Dynamic scoring based on historical performance
 * - Add/remove KOLs via Telegram commands
 */
export class KolDiscovery {
  private kols: Map<string, KolProfile> = new Map();

  constructor(initialWallets: string[]) {
    this.ensureDataDir();
    this.load();

    // Add any wallets from config that aren't already tracked
    for (const wallet of initialWallets) {
      if (!this.kols.has(wallet)) {
        this.addKol(wallet, wallet.slice(0, 6));
      }
    }
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private load() {
    try {
      if (fs.existsSync(KOL_FILE)) {
        const data = JSON.parse(fs.readFileSync(KOL_FILE, "utf-8"));
        for (const kol of data) {
          // Backwards compat: add scamBuys field if missing from old data
          if (kol.scamBuys === undefined) kol.scamBuys = 0;
          this.kols.set(kol.address, kol);
        }
        log.info(`Loaded ${this.kols.size} KOL profiles from disk`);
      }
    } catch (err) {
      log.warn(`Failed to load KOL data: ${err}`);
    }
  }

  save() {
    try {
      this.ensureDataDir();
      const data = Array.from(this.kols.values());
      fs.writeFileSync(KOL_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn(`Failed to save KOL data: ${err}`);
    }
  }

  addKol(address: string, alias: string = ""): KolProfile {
    if (this.kols.has(address)) {
      return this.kols.get(address)!;
    }
    const profile: KolProfile = {
      address,
      alias: alias || address.slice(0, 8),
      addedAt: Date.now(),
      totalSignals: 0,
      profitableSignals: 0,
      totalPnlPercent: 0,
      winRate: 50, // neutral starting point
      score: 50,
      lastActive: 0,
      scamBuys: 0,
    };
    this.kols.set(address, profile);
    this.save();
    log.kol(`Added KOL: ${profile.alias} (${address.slice(0, 8)}...)`);
    return profile;
  }

  removeKol(address: string): boolean {
    const existed = this.kols.delete(address);
    if (existed) {
      this.save();
      log.kol(`Removed KOL: ${address.slice(0, 8)}...`);
    }
    return existed;
  }

  getKol(address: string): KolProfile | undefined {
    return this.kols.get(address);
  }

  getAllKols(): KolProfile[] {
    return Array.from(this.kols.values()).sort((a, b) => b.score - a.score);
  }

  getKolAddresses(): string[] {
    return Array.from(this.kols.keys());
  }

  isKol(address: string): boolean {
    return this.kols.has(address);
  }

  /**
   * Get a KOL's score weight (0.5-2.0x multiplier based on their performance)
   */
  getKolWeight(address: string): number {
    const kol = this.kols.get(address);
    if (!kol) return 1.0;

    // New KOLs (< 5 signals) get neutral weight
    if (kol.totalSignals < 5) return 1.0;

    // Score 0-100 maps to 0.5-2.0x weight
    return 0.5 + (kol.score / 100) * 1.5;
  }

  /**
   * Record a signal outcome for a KOL
   */
  recordSignalOutcome(address: string, pnlPercent: number) {
    const kol = this.kols.get(address);
    if (!kol) return;

    kol.totalSignals++;
    kol.totalPnlPercent += pnlPercent;
    kol.lastActive = Date.now();

    if (pnlPercent > 0) {
      kol.profitableSignals++;
    }

    // Update win rate
    kol.winRate = kol.totalSignals > 0
      ? (kol.profitableSignals / kol.totalSignals) * 100
      : 50;

    // Recalculate score: weighted blend of win rate, average PnL, and recency
    this.recalculateScore(kol);
    this.save();
  }

  /**
   * Record that a KOL bought into a scam token. Auto-blacklist after 2+ scam buys.
   */
  recordScamBuy(address: string, tokenSymbol: string): boolean {
    const kol = this.kols.get(address);
    if (!kol) return false;

    kol.scamBuys = (kol.scamBuys ?? 0) + 1;

    if (kol.scamBuys >= 2) {
      log.kol(`AUTO-BLACKLIST: ${kol.alias} (${address.slice(0, 8)}...) — ${kol.scamBuys} scam buys (latest: ${tokenSymbol})`);
      this.kols.delete(address);
      this.save();
      return true; // was blacklisted
    }

    log.kol(`SCAM WARNING: ${kol.alias} (${address.slice(0, 8)}...) bought scam token ${tokenSymbol} (${kol.scamBuys}/2 strikes)`);
    this.save();
    return false;
  }

  private recalculateScore(kol: KolProfile) {
    // Win rate component (0-40 points)
    const winRateScore = (kol.winRate / 100) * 40;

    // Average PnL component (0-40 points, capped)
    const avgPnl = kol.totalSignals > 0
      ? kol.totalPnlPercent / kol.totalSignals
      : 0;
    const pnlScore = Math.min(40, Math.max(0, avgPnl / 2));

    // Activity recency component (0-20 points)
    const daysSinceActive = kol.lastActive > 0
      ? (Date.now() - kol.lastActive) / (24 * 60 * 60 * 1000)
      : 30;
    const recencyScore = Math.max(0, 20 - daysSinceActive * 2);

    kol.score = Math.round(Math.min(100, Math.max(0, winRateScore + pnlScore + recencyScore)));
  }

  /**
   * Format KOL list for display
   */
  formatKolList(): string {
    const kols = this.getAllKols();
    if (kols.length === 0) return "No KOL wallets tracked.";

    const lines = kols.map((k, i) => {
      const winLoss = `${k.profitableSignals}W/${k.totalSignals - k.profitableSignals}L`;
      const avgPnl = k.totalSignals > 0
        ? (k.totalPnlPercent / k.totalSignals).toFixed(1)
        : "0.0";
      return `${i + 1}. ${k.alias} (${k.address.slice(0, 6)}...${k.address.slice(-4)})\n` +
        `   Score: ${k.score}/100 | WR: ${k.winRate.toFixed(0)}% | ${winLoss} | Avg: ${avgPnl}%`;
    });

    return lines.join("\n\n");
  }
}
