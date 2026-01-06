# Timed Trading

A TradingView Indicator system that scores tickers against signals across LTF and HTF, with a CloudFlare Worker backend and interactive Bubble Quadrant visualization.

## Project Structure

```
timedtrading/
├── react-app/index-react.html          # Main React Dashboard (Bubble Quadrant Chart)
├── worker/                             # CloudFlare Worker
│   ├── index.js                       # Worker code (KV storage, Discord alerts)
│   ├── wrangler.toml                  # Worker configuration
│   └── README.md                      # Worker setup instructions
└── tradingview/                        # TradingView Indicator
    ├── TimedTrading_ScoreEngine.pine  # Pine Script indicator (v1.1.0)
    └── README.md                       # Indicator documentation
```

## Components

### 1. TradingView Indicator
- Scores tickers against signals across LTF (Low Time Frame) and HTF (High Time Frame)
- Calculates state (Q1-Q4 quadrants)
- Fires alerts to a watchlist that trigger webhooks to the CloudFlare Worker

### 2. CloudFlare Worker
- Receives webhook data from TradingView alerts
- Stores data in CloudFlare KV
- Maintains historical trails for tickers
- Sends Discord alerts when trading opportunities are detected (corridor-only logic)
- Provides REST API endpoints for data retrieval

### 3. CloudFlare Pages
- Interactive Bubble Quadrant Chart visualization
- Displays tickers in Q1-Q4 quadrants based on HTF/LTF scores
- Shows trails, corridors, and various filters
- Real-time updates from the Worker API

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
2. Copy the contents of `tradingview/TimedTrading_ScoreEngine.pine`
3. Save and add to chart
4. Create an alert:
   - Condition: TimedTrading_ScoreEngine
   - Frequency: Once Per Bar Close
   - Webhook URL: `https://timed-trading-ingest.shashant.workers.dev/timed/ingest?key=YOUR_API_KEY`
   - Message: `{{message}}` (indicator auto-generates JSON)
5. Apply to watchlist for multiple tickers

See `tradingview/README.md` for detailed setup instructions.

## Features

- **Quadrant Visualization**: Tickers plotted in Q1-Q4 based on HTF/LTF scores
- **Corridor Detection**: Visual corridors for LONG (Q1→Q2) and SHORT (Q4→Q3) entries
- **Trails**: Historical movement tracking for selected tickers
- **Filtering**: Filter by quadrant, completion %, RR, rank
- **Discord Alerts**: Automatic notifications when corridor entries meet criteria
- **Real-time Updates**: Auto-refresh with configurable intervals

## API Endpoints

- `POST /timed/ingest?key=...` - Ingest data from TradingView
- `GET /timed/all` - Get all tickers
- `GET /timed/latest?ticker=XYZ` - Get latest data for a ticker
- `GET /timed/trail?ticker=XYZ` - Get historical trail
- `GET /timed/top?bucket=long|short|setup&n=10` - Get top tickers by rank
- `GET /timed/health` - Health check

## Alert Criteria

Discord alerts are sent when:
- Ticker is in entry corridor (LONG or SHORT)
- Corridor aligns with state (LONG corridor → Q2, SHORT corridor → Q3)
- Trigger condition met (entered aligned, EMA_CROSS, or squeeze release)
- Thresholds met: RR ≥ 1.5, Completion ≤ 40%, Phase ≤ 60%, Rank ≥ 70

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Comprehensive system architecture, data flow, and scoring logic documentation

## License

[Add your license here]

