# Timed Trading

A TradingView Indicator system that scores tickers against signals across LTF and HTF, with a CloudFlare Worker backend, D1 ledger, and interactive Bubble Quadrant visualization.

## Project Structure

```
timedtrading/
├── react-app/
│   ├── index-react.html               # Main Dashboard (Bubble Chart, Kanban, Viewport)
│   └── simulation-dashboard.html      # Simulated Account (holdings, trade history)
├── worker/                            # CloudFlare Worker
│   ├── index.js                       # Main handler (routes, ingest, trades)
│   ├── storage.js, ingest.js, trading.js, api.js, alerts.js  # Modules
│   ├── wrangler.toml                  # KV, D1, cron triggers
│   └── README.md
├── tradingview/
│   ├── TimedTrading_Unified.pine      # Primary indicator (ScoreEngine + Heartbeat)
│   └── README.md
└── docs/                              # Documentation index in docs/README.md
```

## Components

### 1. TradingView Indicator
- Scores tickers against signals across LTF (Low Time Frame) and HTF (High Time Frame)
- Calculates state (Q1-Q4 quadrants)
- Fires alerts to a watchlist that trigger webhooks to the CloudFlare Worker

### 2. CloudFlare Worker
- Receives webhook data from TradingView alerts
- Stores data in KV and D1 (ledger, positions, trail)
- Paper-trade simulation (Kanban-driven entries/trims/exits)
- Discord alerts when opportunities meet criteria
- REST API for tickers, portfolio, ledger, sectors

### 3. React UI
- **index-react.html**: Bubble Chart, Kanban lanes, Viewport, Opportunities, Time Travel
- **simulation-dashboard.html**: Simulated Account (holdings LONG/SHORT, trade history by day/ticker)
- Embedded in Worker and served at `/` and `/dashboard`

## Setup

### CloudFlare Worker

See [worker/README.md](worker/README.md) for detailed setup instructions.

Quick start:
```bash
cd worker
wrangler login
wrangler kv:namespace create "KV_TIMED"
# Update wrangler.toml with KV namespace ID
wrangler secret put TIMED_API_KEY
wrangler deploy
```

### CloudFlare Pages

1. Connect your GitHub repository to CloudFlare Pages
2. Set build command: (none needed, static HTML)
3. Set output directory: `/` (root)
4. Deploy

### TradingView Indicator

1. Open TradingView Pine Editor
2. Copy the contents of `tradingview/TimedTrading_Unified.pine` (or `TimedTrading_ScoreEngine.pine`)
3. Save and add to chart (5m timeframe recommended)
4. Create an alert:
   - Condition: TimedTrading_Unified
   - Frequency: Once Per Bar Close
   - Webhook URL: `https://timed-trading-ingest.shashant.workers.dev/timed/ingest?key=YOUR_API_KEY`
   - Message: `{{message}}`
5. Apply to watchlist for multiple tickers

See `tradingview/README.md` for detailed setup.

## Features

- **Quadrant Visualization**: Tickers plotted in Q1-Q4 based on HTF/LTF scores
- **Corridor Detection**: Visual corridors for LONG (Q1→Q2) and SHORT (Q4→Q3) entries
- **Trails**: Historical movement tracking for selected tickers
- **Filtering**: Filter by quadrant, completion %, RR, rank
- **Discord Alerts**: Automatic notifications when corridor entries meet criteria
- **Real-time Updates**: Auto-refresh with configurable intervals

## API Endpoints

- `POST /timed/ingest?key=...` - Ingest from TradingView
- `GET /timed/all` - All tickers
- `GET /timed/latest?ticker=XYZ` - Latest for a ticker
- `GET /timed/trail?ticker=XYZ` - Historical trail
- `GET /timed/portfolio` - Paper portfolio (open positions, executions)
- `GET /timed/ledger/trades` - Trade history (D1)
- `GET /timed/health` - Health check

## Alert Criteria

Discord alerts are sent when:
- Ticker is in entry corridor (LONG or SHORT)
- Corridor aligns with state (LONG corridor → Q2, SHORT corridor → Q3)
- Trigger condition met (entered aligned, EMA_CROSS, or squeeze release)
- Thresholds met: RR ≥ 1.5, Completion ≤ 40%, Phase ≤ 60%, Rank ≥ 70

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture, data flow, scoring
- [docs/README.md](docs/README.md) - Documentation index
- [docs/REPLAY_AND_BACKTEST.md](docs/REPLAY_AND_BACKTEST.md) - Full backtest replay and Replay Control UI (`npm run replay-ui`)
- [tasks/WORKFLOW_ORCHESTRATION.md](tasks/WORKFLOW_ORCHESTRATION.md) - Dev workflow
- [SECRETS_MANAGEMENT.md](SECRETS_MANAGEMENT.md) - Secrets (API keys, webhooks)

## License

[Add your license here]

