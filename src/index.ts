import { loadConfig } from "./config";
import { CoinSharkBot } from "./bot";
import { log, setLogLevel, LogLevel } from "./logger";

async function main() {
  log.banner("CoinShark v1.0.0");
  log.info("Loading configuration...");

  const config = loadConfig();

  // Validate required config
  if (!config.privateKey) {
    log.error("SOLANA_PRIVATE_KEY is required. Set it in your .env file.");
    log.info("Copy .env.example to .env and fill in your private key.");
    process.exit(1);
  }

  // Enable debug logging if requested
  if (process.argv.includes("--debug")) {
    setLogLevel(LogLevel.DEBUG);
    log.debug("Debug logging enabled");
  }

  // Dry run mode (no actual trades)
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    log.warn("DRY RUN MODE — no real trades will be executed");
  }

  // Create and start the bot
  const bot = new CoinSharkBot(config);

  // Graceful shutdown
  const shutdown = async () => {
    log.info("\nReceived shutdown signal...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await bot.start();
  } catch (err: any) {
    log.error(`Fatal error: ${err.message}`);
    await bot.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
