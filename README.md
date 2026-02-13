# CoinShark

Solana trading bot for Pump.fun with scam detection, KOL tracking, and momentum-based trading.

## How It Works

```
New Token on Pump.fun
  → Quick Scam Reject (serial deployers, creator supply grab)
  → Watch token trades via WebSocket
  → Signal Engine evaluates momentum:
      - KOL wallet buys (highest weight)
      - Volume spikes
      - Buy/sell ratio & unique buyer count
      - Market cap trend
  → Full Scam Analysis before buying:
      - Mint/freeze authority check
      - Holder concentration (top 5 wallets)
      - Wash trading detection
      - Bundle detection at launch
      - Serial deployer tracking
  → Risk Manager executes trade:
      - Position sizing (configurable max per trade)
      - Take Profit 1: sell 50% at +X%
      - Take Profit 2: sell remaining at +Y%
      - Stop Loss: sell all at -Z%
```

## Scam Detection

98.6% of Pump.fun tokens are scams. CoinShark filters for:

- **Mint/Freeze Authority** — tokens where the creator can mint unlimited supply or freeze trading
- **Holder Concentration** — tokens where top wallets hold a disproportionate share
- **Wash Trading** — same wallets buying and selling to fake volume
- **Bundle Detection** — coordinated buys from multiple wallets at launch
- **Serial Deployers** — creators who launch token after token (pump and dump pattern)
- **Microbuys** — many tiny identical trades faking organic interest

## Setup

```bash
# Install dependencies
npm install

# Copy config template
cp .env.example .env

# Get a free Helius RPC key at https://helius.dev (1M credits/month, 10 RPS)
# Then edit .env with your settings:
# - SOLANA_PRIVATE_KEY (required)
# - SOLANA_RPC_URL → https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
# - KOL_WALLETS (comma-separated wallet addresses to track)
# - Trading parameters (bet size, TP/SL levels, etc.)

# Build
npm run build

# Run
npm start

# Run with debug logging
npm start -- --debug
```

## Configuration

All settings are in `.env`. Key ones:

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_BET_SOL` | 0.05 | Max SOL per trade |
| `MAX_POSITIONS` | 3 | Max concurrent positions |
| `TAKE_PROFIT_1_PERCENT` | 50 | Sell 50% at this gain |
| `TAKE_PROFIT_2_PERCENT` | 100 | Sell rest at this gain |
| `STOP_LOSS_PERCENT` | 30 | Exit at this loss |
| `KOL_WALLETS` | | Comma-separated KOL wallet addresses |
| `MIN_5M_VOLUME_SOL` | 5 | Min 5-minute volume to trigger interest |
| `MIN_5M_BUYERS` | 10 | Min unique buyers in 5 min |
| `MAX_TOP_HOLDER_PERCENT` | 50 | Max % held by top 5 wallets |

## Architecture

```
src/
├── index.ts          # Entry point and CLI
├── config.ts         # Environment config loader
├── types.ts          # TypeScript interfaces
├── logger.ts         # Colored terminal logging
├── wallet.ts         # Solana wallet management
├── scanner.ts        # PumpPortal WebSocket token/trade scanner
├── scamFilter.ts     # On-chain scam detection
├── signalEngine.ts   # KOL tracking, volume, momentum scoring
├── trader.ts         # PumpPortal API trade execution
├── riskManager.ts    # Position management, TP/SL
└── bot.ts            # Main orchestrator
```

## Trading via PumpPortal

Trades are executed through the [PumpPortal](https://pumpportal.fun/) local transaction API. Your private key never leaves your machine — transactions are signed locally and sent to Solana.

## Disclaimer

This software is for educational and research purposes. Cryptocurrency trading involves substantial risk of loss. 98.6% of Pump.fun tokens are documented scams. Never trade with money you cannot afford to lose. This bot does not guarantee profits. Do your own research.
