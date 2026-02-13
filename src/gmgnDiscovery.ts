import https from "https";
import { KolDiscovery } from "./kolDiscovery";
import { log } from "./logger";

const BASE_URL = "https://gmgn.ai";

// Browser-like headers to avoid Cloudflare blocks
const HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "DNT": "1",
  "Referer": "https://gmgn.ai/?chain=sol",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

type WalletTag = "pump_smart" | "smart_degen" | "reowned" | "snipe_bot";
type Timeframe = "1d" | "7d" | "30d";

interface GmgnWalletRank {
  wallet_address?: string;
  address?: string;
  realized_profit?: number;
  realized_profit_7d?: number;
  realized_profit_30d?: number;
  unrealized_profit?: number;
  pnl_7d?: number;
  pnl_30d?: number;
  winrate?: number;
  buy_7d?: number;
  sell_7d?: number;
  buy_30d?: number;
  sell_30d?: number;
  token_num?: number;
  name?: string;
  tags?: string[];
}

interface GmgnWalletStats {
  wallet?: string;
  realized_profit?: number;
  realized_profit_7d?: number;
  pnl_7d?: number;
  winrate?: number;
  buy_7d?: number;
  sell_7d?: number;
  token_num?: number;
  profit_num?: number;
  tags?: string[];
  name?: string;
}

interface DiscoveryResult {
  added: number;
  skipped: number;
  failed: number;
  wallets: Array<{ address: string; alias: string; winRate: number; pnl7d: number }>;
}

/**
 * GmgnDiscovery fetches top-performing wallets from GMGN.ai's internal API
 * and adds qualifying ones to the KOL tracking list.
 *
 * Endpoints used (undocumented, subject to change):
 * - /api/v1/rank/sol/wallets/{timeframe} — ranked wallet list
 * - /api/v1/smartmoney/sol/walletNew/{address} — individual wallet stats
 */
export class GmgnDiscovery {
  private kolDiscovery: KolDiscovery;
  private lastRun: number = 0;
  private cooldownMs = 6 * 60 * 60 * 1000; // 6 hours between auto-runs

  // Minimum requirements for auto-adding a wallet as KOL
  private minWinRate = 0.45; // 45%+
  private minTrades7d = 10; // at least 10 trades in 7 days
  private minProfitSol = 5; // at least 5 SOL realized profit 7d

  constructor(kolDiscovery: KolDiscovery) {
    this.kolDiscovery = kolDiscovery;
  }

  /**
   * Fetch JSON from a GMGN endpoint with browser-like headers
   */
  private fetch(urlPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, BASE_URL);
      const req = https.get(
        url.toString(),
        { headers: HEADERS, timeout: 15000 },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              if (json.msg === "success" || json.code === 0 || json.data) {
                resolve(json);
              } else {
                reject(new Error(`GMGN API error: ${json.msg ?? JSON.stringify(json).slice(0, 200)}`));
              }
            } catch {
              // Cloudflare block returns HTML
              if (data.includes("challenge-platform") || data.includes("cloudflare")) {
                reject(new Error("Cloudflare blocked the request — try again later or use a proxy"));
              } else {
                reject(new Error(`Failed to parse GMGN response: ${data.slice(0, 200)}`));
              }
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("GMGN request timed out"));
      });
    });
  }

  /**
   * Fetch ranked wallets from GMGN
   */
  async fetchTopWallets(
    timeframe: Timeframe = "7d",
    tag: WalletTag = "pump_smart"
  ): Promise<GmgnWalletRank[]> {
    const path = `/api/v1/rank/sol/wallets/${timeframe}?tag=${tag}&orderby=pnl_${timeframe}&direction=desc`;
    const result = await this.fetch(path);
    const wallets = result?.data?.rank ?? result?.data ?? [];
    return Array.isArray(wallets) ? wallets : [];
  }

  /**
   * Fetch detailed stats for a single wallet
   */
  async fetchWalletStats(address: string): Promise<GmgnWalletStats | null> {
    try {
      const path = `/api/v1/smartmoney/sol/walletNew/${address}?period=7d`;
      const result = await this.fetch(path);
      return result?.data ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Discover and add top wallets from GMGN.
   * Fetches from multiple tags and filters by performance.
   */
  async discover(tags?: WalletTag[]): Promise<DiscoveryResult> {
    const tagsToScan: WalletTag[] = tags ?? ["pump_smart", "smart_degen"];
    const result: DiscoveryResult = { added: 0, skipped: 0, failed: 0, wallets: [] };
    const seen = new Set<string>();

    for (const tag of tagsToScan) {
      log.info(`GMGN: Fetching ${tag} wallets...`);

      let wallets: GmgnWalletRank[];
      try {
        wallets = await this.fetchTopWallets("7d", tag);
      } catch (err: any) {
        log.warn(`GMGN: Failed to fetch ${tag}: ${err.message}`);
        result.failed++;
        continue;
      }

      log.info(`GMGN: Got ${wallets.length} ${tag} wallets`);

      for (const w of wallets) {
        const address = w.wallet_address ?? w.address;
        if (!address || seen.has(address)) continue;
        seen.add(address);

        // Skip if already tracked as KOL
        if (this.kolDiscovery.isKol(address)) {
          result.skipped++;
          continue;
        }

        // Check minimum thresholds from the ranking data
        const winRate = w.winrate ?? 0;
        const trades = (w.buy_7d ?? 0) + (w.sell_7d ?? 0);
        const profit7d = w.realized_profit_7d ?? 0;

        if (winRate < this.minWinRate) {
          result.skipped++;
          continue;
        }
        if (trades < this.minTrades7d) {
          result.skipped++;
          continue;
        }
        if (profit7d < this.minProfitSol) {
          result.skipped++;
          continue;
        }

        // Build alias
        const nameTag = w.name ? w.name.slice(0, 15) : "";
        const wrPercent = (winRate * 100).toFixed(0);
        const alias = nameTag
          ? `GMGN-${nameTag}`
          : `GMGN-${tag.slice(0, 6)}-${wrPercent}%WR`;

        // Add to KOL list with a starting score based on GMGN data
        const startingScore = Math.min(
          70,
          Math.round(winRate * 50 + Math.min(20, profit7d / 10))
        );
        const profile = this.kolDiscovery.addKol(address, alias);
        profile.score = startingScore;
        profile.winRate = winRate * 100;
        this.kolDiscovery.save();

        result.added++;
        result.wallets.push({
          address,
          alias,
          winRate: winRate * 100,
          pnl7d: profit7d,
        });

        log.kol(
          `GMGN: Added ${alias} (${address.slice(0, 8)}...) — ` +
          `WR: ${wrPercent}% | 7d PnL: ${profit7d.toFixed(1)} SOL | Score: ${startingScore}`
        );
      }

      // Rate limit between tag fetches
      await this.sleep(2000);
    }

    this.lastRun = Date.now();
    return result;
  }

  /**
   * Auto-discover if enough time has passed since last run.
   * Called periodically from bot.ts.
   */
  async autoDiscover(): Promise<DiscoveryResult | null> {
    if (Date.now() - this.lastRun < this.cooldownMs) {
      return null;
    }
    log.info("GMGN: Running auto-discovery...");
    try {
      return await this.discover();
    } catch (err: any) {
      log.warn(`GMGN auto-discovery failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Format discovery results for Telegram
   */
  static formatResult(result: DiscoveryResult): string {
    const lines = [
      `<b>GMGN Discovery Results</b>`,
      ``,
      `Added: ${result.added} | Skipped: ${result.skipped} | Failed: ${result.failed}`,
    ];

    if (result.wallets.length > 0) {
      lines.push(``);
      for (const w of result.wallets.slice(0, 10)) {
        lines.push(
          `<code>${w.address.slice(0, 6)}...${w.address.slice(-4)}</code> ${w.alias}` +
          `\n  WR: ${w.winRate.toFixed(0)}% | 7d PnL: ${w.pnl7d.toFixed(1)} SOL`
        );
      }
      if (result.wallets.length > 10) {
        lines.push(`...and ${result.wallets.length - 10} more`);
      }
    }

    return lines.join("\n");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
