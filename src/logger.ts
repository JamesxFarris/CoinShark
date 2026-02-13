import chalk from "chalk";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  TRADE = 4,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  debug(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.DEBUG) {
      console.log(chalk.gray(`[${timestamp()}] [DBG] ${msg}`), ...args);
    }
  },

  info(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.INFO) {
      console.log(chalk.white(`[${timestamp()}] [INF] ${msg}`), ...args);
    }
  },

  warn(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.WARN) {
      console.log(chalk.yellow(`[${timestamp()}] [WRN] ${msg}`), ...args);
    }
  },

  error(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.ERROR) {
      console.log(chalk.red(`[${timestamp()}] [ERR] ${msg}`), ...args);
    }
  },

  trade(msg: string, ...args: unknown[]) {
    console.log(chalk.green(`[${timestamp()}] [TRD] ${msg}`), ...args);
  },

  scam(msg: string, ...args: unknown[]) {
    console.log(chalk.redBright(`[${timestamp()}] [SCM] ${msg}`), ...args);
  },

  signal(msg: string, ...args: unknown[]) {
    console.log(chalk.cyan(`[${timestamp()}] [SIG] ${msg}`), ...args);
  },

  kol(msg: string, ...args: unknown[]) {
    console.log(chalk.magenta(`[${timestamp()}] [KOL] ${msg}`), ...args);
  },

  banner(msg: string) {
    console.log(chalk.bold.blueBright(`\n${"=".repeat(60)}`));
    console.log(chalk.bold.blueBright(`  ${msg}`));
    console.log(chalk.bold.blueBright(`${"=".repeat(60)}\n`));
  },
};
