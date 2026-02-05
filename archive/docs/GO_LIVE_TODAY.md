# Go Live Today (Clean Slate + Replay)

Use this when you want to **clear all trade ledgers** and **replay a single day as if it were your first day live** — no old data, only trades generated from that day’s replay.

**“Today” / first day** means the **trading day starting at 9:30 AM ET** on the date you choose. For example, “go live today” = **February 2, 2026, 9:30 AM EST** as the first bar of the first day — no prior positions or trades; everything starts from that open.

## One-command flow

```bash
TIMED_API_KEY=your_key node scripts/reset-and-replay-today.js
```

Optional:

- **DATE=YYYY-MM-DD** — Replay this **trading day** (default: today UTC). Use **2026-02-02** for “first day = Feb 2, 9:30 AM ET”.
- **TICKERS=AAPL,AMD,...** — Replay these tickers (default: AAPL,AMD,AMZN,BE,GOLD).

Example (Feb 2, 9:30 AM ET as first day):

```bash
TIMED_API_KEY=AwesomeSauce DATE=2026-02-02 TICKERS=AAPL,AMD,AMZN,BE,GOLD node scripts/reset-and-replay-today.js
```

## What the script does

1. **Reset** — Calls `POST /timed/admin/reset?key=...&resetLedger=1`:
   - Clears KV: `timed:trades:all`, paper portfolio, activity feed.
   - Clears D1: all rows in `trades`, `alerts`, `trade_events`.
   - Resets per-ticker state (entry_ts, entry_price, Kanban stamps) so lanes recompute from scratch.

2. **Replay** — For each ticker, calls `POST /timed/admin/replay-ticker-d1` with **date** and **cleanSlate=1**:
   - Reads that day’s rows from D1 `timed_trail` (payload_json).
   - Processes bars in order; creates/updates trades and `timed:latest` as the engine would on live ingest.
   - Writes KV only at the end (no 429 issues).

Result: only trades from that day’s replay exist; UI shows “first day” behavior. The replay uses D1 `timed_trail` for that calendar day; the worker treats the first bar at or after 9:30 AM ET as the start of the trading day (with optional pre-market lookback for context).

## Broker-style UI (Trade Tracker / simulation dashboard)

After reset + replay, use the **simulation dashboard** (Trade Tracker) for a Robinhood-style view:

| What you want           | Where it is |
|-------------------------|-------------|
| **What you have open**  | **Portfolio** section: “Positions” and list of open positions (ticker, qty, entry, mark, open P&L). |
| **Overall account value** | **Portfolio snapshot**: “Equity” = cash + positions (mark-to-market). “Cash” and “Positions” are shown too. |
| **Trades by day**       | **Proof Center** tab: expand a day to see entries/trims/exits and P&L for that day. **Trades** tab: list of trades (filter by ticker); **By Day Activity** groups activity by date. |
| **P&L by ticker**       | **P&L by ticker** section: each ticker with total P&L (realized + unrealized), bar and $ amount. |

- **Portfolio snapshot** + **Overall (closed + open)** = account value and closed vs open P&L.
- **Proof Center** = daily execution summary (paper tape); **Trades** = D1-backed trade list; **Alerts** = D1 alerts. Same time window applies to all.

## Multi-day replay (reset + replay a date range)

To **clear all trades** and **replay from a specific date through today** (e.g. Monday Feb 2 through today), use `reset-and-replay-from-start.js` with **FROM=YYYY-MM-DD**:

```bash
FROM=2026-02-02 TIMED_API_KEY=AwesomeSauce node scripts/reset-and-replay-from-start.js
```

- **FROM=YYYY-MM-DD** — Replay starts on this date and runs through today (trading days only). Omit to auto-detect the first date with data.
- The script: (1) resets KV + D1, (2) replays each day in order via the worker’s replay-day API, (3) force-syncs to D1.

## Manual reset only (no replay)

To clear everything but **not** run a replay:

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/reset?key=YOUR_API_KEY&resetLedger=1"
```

After that, new trades appear only when new ingest/replay runs.
