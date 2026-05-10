# Timed Trading — System Overview

> Snapshot date: **May 2026**
> Doc owner: shipping team
> Status: live, paying customers, ~10 months of paper-trading proof
>
> This is the canonical answer to "where is the system today, how is it built,
> how do we run it, and what's next." It supersedes ad-hoc README sections.
> For workflow rules and lessons, see [CONTEXT.md](CONTEXT.md). For the older
> conceptual architecture that pre-dates the TwelveData migration, see
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. What it does (in one paragraph)

Timed Trading is a real-time scoring + decision engine for U.S. equities and
two crypto pairs. The same engine produces signals for **two modes**:

- **Active Trader** — multi-timeframe entries with explicit stop / take-profit
  / trim management. ~3 trades per day per ticker universe. Multi-day holds.
- **Investor (Trend-Hold)** — once-per-day decisions per ticker that flow
  through a 5-stage pipeline (Watch → Accumulate → Core Hold → Reduce → Exit).
  Built for accumulation without daily screen time.

Every recommendation carries an explanation, every trade is logged, and every
decision is auditable. The product surface is a single React app with three
tabs (Analysis · Trader · Invest) plus a Trades page for performance review.

## 2. How it has performed (live as of this doc)

Paper-trading record from the production engine, **Jul 2025 → May 2026
(203 trading days)**, $100,000 starting account:

| Metric            | Active Trader | Investor (Trend-Hold) |
|-------------------|--------------:|----------------------:|
| Total return      | **+40.0%**    | +8.4%                 |
| Sharpe (annual.)  | **4.62**      | 1.01                  |
| Max drawdown      | **−2.7%**     | −2.4%                 |
| Win rate          | 52.2%         | n/a (one-decision/day)|
| Closed trades     | 588           | varies by ticker      |
| Avg trades / day  | ~3            | <1                    |

Disclaimer: simulated. Past performance does not guarantee future results. The
Sharpe figure assumes continuous compounding and the standard 252-trading-day
annualization; we publish the raw daily P&L series so anyone can recompute.

## 3. Architecture (today, post-TwelveData migration)

```
                    ┌──────────────────────────┐
                    │    TwelveData REST       │  primary price + quote
                    │  /quote ?prepost=true    │  (RTH + ext-hours)
                    │  /time_series (candles)  │
                    └───────────┬──────────────┘
                                │
   ┌────────────────────────────┴────────────────────────────┐
   │                                                         │
   │            Cloudflare Worker (worker/index.js)          │
   │  ┌─────────────────────────────────────────────────┐    │
   │  │ Cron jobs (*/1, */5, hourly, :00 + :30)        │    │
   │  │  • price feed (TwelveData)                     │    │
   │  │  • scoring engine (HTF/LTF/composite)          │    │
   │  │  • Kanban classifier (Setup→Exit lanes)        │    │
   │  │  • paper-trader (Active Trader + Investor)     │    │
   │  │  • Discord + push alerts on action thresholds  │    │
   │  │  • daily AI brief (pre-market + evening)       │    │
   │  └─────────────────────────────────────────────────┘    │
   │  ┌─────────────────────────────────────────────────┐    │
   │  │ Persistence                                     │    │
   │  │  • D1 (SQLite)   trades · positions · ledger   │    │
   │  │                  ticker_candles · execution_*  │    │
   │  │  • KV            timed:prices · timed:latest   │    │
   │  │                  timed:all:snapshot · audit log │    │
   │  └─────────────────────────────────────────────────┘    │
   │  ┌─────────────────────────────────────────────────┐    │
   │  │ Public API (subset)                            │    │
   │  │   GET  /timed/all                               │    │
   │  │   GET  /timed/prices · /timed/latest            │    │
   │  │   GET  /timed/account-summary                   │    │
   │  │   GET  /timed/portfolio/equity-curve            │    │
   │  │   GET  /timed/ledger/trades                     │    │
   │  │   POST /timed/admin/*  (audited mutators)      │    │
   │  └─────────────────────────────────────────────────┘    │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │       Cloudflare Pages — react-app-dist (built UI)      │
   │  • splash.html / faq.html   (marketing + onboarding)   │
   │  • index-react.html         (Analysis dashboard)       │
   │  • investor-dashboard.html  (Investor view)            │
   │  • simulation-dashboard.html (Trades / performance)    │
   │  • daily-brief.html         (AI brief reader)          │
   │  • shared: tt-tokens.css (design system v2 — gold)     │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │          Edge clients — browser, Discord webhook,       │
   │          web-push (PWA), email (SendGrid)               │
   └─────────────────────────────────────────────────────────┘
```

### Key data flow rules

- **TwelveData is the source of truth** for live price + previous close
  (`DATA_PROVIDER=twelvedata`). Alpaca is execution + fallback.
- `/timed/prices` is the canonical live feed (KV, refreshed every minute by
  the price feed cron). Both `/timed/all` and `/timed/latest` overlay this
  KV at request time so the frontend never sees stale snapshot data.
- The scoring snapshot (`timed:all:snapshot`) is rebuilt every 5 minutes by
  the scoring cron and serves `/timed/all` on the fast path. After-hours TTL
  is 24h, but live-price overlays still apply on top.
- `account_ledger` (D1) is the canonical equity-history record. Equity curves
  are walked from this ledger, not stamped from any cache. The
  `rebuild-snapshots-from-ledger` admin endpoint can rebuild
  `portfolio_snapshots` from the ledger after any incident.

## 4. The scoring engine (one screen)

Every ticker gets a composite score `0–100` blending multi-timeframe technical
signals into a Kanban stage. Inputs:

- **HTF (Higher Timeframe) score** — daily / 4H / 1H trend agreement, EMA
  stack, SuperTrend, volume profile, premium-stack confirmation.
- **LTF (Lower Timeframe) score** — 30m / 10m EMA cross, RSI / Stoch, squeeze
  release, momentum-vs-σ. Sign matches the active direction.
- **Risk/Reward** — projected reward / stop distance; multiplied by
  `(1 − completion)` so late-stage moves shrink and fresh setups grow.

The output is **one of seven Kanban stages**:

```
Setup  →  In Review  →  Position Initiated  →  Hold  →  Defend  →  Trim  →  Exit
```

Active Trader executes on stage transitions. Investor uses a parallel
5-stage pipeline (Watch / Accumulate / Core Hold / Reduce / Exit).

## 5. Operational runbook

### Deploy

```bash
# Build the React app (Babel + Tailwind into react-app-dist)
node scripts/build-frontend.js

# Build the worker dashboard bundle
node scripts/embed-dashboard.js

# Deploy the worker
cd worker && wrangler deploy

# Pages auto-deploy on git push to main (Cloudflare Pages → react-app-dist)
```

### Scheduled jobs (worker/wrangler.toml)

| Cron        | Job                                            |
|-------------|------------------------------------------------|
| `*/1 * * * *` | Price feed (TwelveData → `timed:prices`)     |
| `*/5 * * * *` | Scoring + Kanban + paper-trade + snapshot    |
| `0 * * * *`   | Hourly housekeeping (stage drift, audit)     |
| `30 * * * *`  | AI brief generation, candle backfill checks  |

### Safety controls (live since the May 2026 incidents)

- **`cron-mute`** — admin endpoint, with TTL (default 6h, auto-clears).
  Prevents live cron from interfering with backtests.
- **`replay-lock`** — held by the active backtest run. `/timed/admin/replay-lock`
  inspects + releases.
- **`cleanSlate=1`** hard guard — destructive replays require
  `confirm_clean_slate=YES_DESTROY` AND inactive cron-mute.
- **Integrity guard** — auto-mutes cron when `trades` or `account_ledger`
  row count drops by >50% in one cycle. Logged as `INTEGRITY_WIPE_DETECTED`
  in the audit log.
- **Audit log (`data_audit_log` table)** — every destructive admin op
  records `op`, `scope`, `caller`, `rowsAffected`, `meta`. Inspect via
  `/timed/admin/data-audit-log?limit=50&key=…`.
- **Stale-tick guard** — TRIM and soft-EXIT actions defer execution if the
  price feed is stalled or if `price == prev_close` at RTH open. Logs
  `STALE_TICK_BLOCKED` and re-queues via `d1QueueAction`.

### Recovery toolkit (admin endpoints)

| Endpoint                                       | Purpose                                  |
|------------------------------------------------|------------------------------------------|
| `POST /timed/admin/cron-mute`                  | Mute / unmute cron (TTL parameter)       |
| `POST /timed/admin/replay-lock`                | Inspect / release replay lock            |
| `POST /timed/admin/restore-trade-from-da`      | Restore a wiped trade from `direction_accuracy` |
| `POST /timed/admin/patch-trade-fields`         | Generic field patch on `trades` row      |
| `POST /timed/admin/patch-trade-event-price`    | Fix a wrong fill price + recalc PnL      |
| `POST /timed/admin/recover-event-price-from-candle` | Derive correct price from `ticker_candles` |
| `POST /timed/admin/sync-trade-to-ledger`       | Backfill missing ENTRY/TRIM/EXIT events  |
| `POST /timed/admin/rebuild-snapshots-from-ledger` | Walk ledger → rebuild equity snapshots |
| `POST /timed/admin/rollback-to-date`           | Surgical date-bounded data cleanup       |
| `GET  /timed/admin/data-audit-log`             | Forensic trail of all mutations          |
| `GET  /timed/admin/ledger-inspect`             | Per-trade ledger event inspection        |

## 6. What we maintain (cadence)

| Asset                 | Cadence       | Notes                                          |
|-----------------------|---------------|------------------------------------------------|
| Backtest re-run       | Monthly       | Validate engine against new month's data       |
| Calibration tuning    | After backtest| Adjust admission / exit doctrine, sized by evidence |
| Frontend deploy       | On merge      | Auto via Cloudflare Pages from `main`          |
| Worker deploy         | On merge      | `wrangler deploy` from CI or hand               |
| Dependency bump       | Quarterly     | npm audit + targeted updates                   |
| Documentation refresh | After major   | This file + FAQ + splash proof tiles            |

## 7. Scale strategy (what it takes to add the next 100 / 1k / 10k users)

**Today (1–10 users):**
Single-tenant Workers + D1 + KV. Read amplification is the limit (every
`/timed/all` request reads the snapshot KV blob). Fine.

**Next 100 users:**
- KV reads will dominate. Mitigation: bump the snapshot fast-path TTL
  (already 6 min during RTH, 24h off-hours) and confirm cache-hit ratio
  via Cloudflare analytics.
- Discord webhook fan-out is currently 1:1. For 100 users with
  per-ticker preferences, we'll need a small fan-out worker with a
  KV-backed subscription map.
- D1 row count: ~100k trades/year/user × 100 users = 10M rows. D1's
  per-database limit is 10 GB. We're fine for >5 years at current rate
  but should add an auto-archive job that ships closed trades >12 months
  old to R2 as parquet.

**Next 1,000 users:**
- Move per-user state into a **Durable Object** namespace keyed on
  user id, so price feed + scoring crons remain shared but per-user
  trade simulation runs in isolated DOs (no D1 contention).
- Push notifications via web-push at 1k subscribers becomes a real cron
  workload. Move from synchronous `fetch()` per subscriber to a queue
  (`Cloudflare Queues`) with a worker consumer.
- AI brief cost: each daily brief is ~$0.02 in OpenAI + Claude calls.
  At 1k users, that's $20/day or $7,300/year if every user gets a
  personalized brief. Fix: keep one global brief + per-user
  highlight injection (cheaper per-user prompt).

**Next 10,000 users:**
- TwelveData rate limits — need an enterprise contract (or a
  websocket-based feed like Polygon) and a price-feed worker per
  region (US-East / US-West / EU-West). Cache cross-region via R2.
- Database: D1 is no longer the right substrate. Migration target is
  PostgreSQL on Hyperdrive (Cloudflare's connection-pooler), with a
  partition-by-user-id strategy.
- The signal engine itself remains a single global compute (it doesn't
  shard well — it reasons about the whole universe), but the
  per-user simulator can run as one DO per user and only touch global
  state via the public scoring API.

**Engineering principles to preserve:**
- Every mutation has an audit row.
- Every destructive op requires explicit confirmation strings.
- The price-feed source of truth (`timed:prices`) is single-writer.
- The ledger is replayable (rebuild-snapshots-from-ledger always works).
- Discord webhooks and other secrets live in Cloudflare secrets, never
  in the repo.

## 8. Tech stack reference

- **Runtime:** Cloudflare Workers (V8 isolates, no Node API)
- **Storage:** Cloudflare D1 (SQLite), Cloudflare KV
- **Pages:** Cloudflare Pages (static + Pages Functions proxy)
- **Frontend:** React 18 (loaded via CDN with Babel-in-browser for
  source HTML, then Babel-pre-compiled to `react-app-dist`),
  htm template literal helper, LightweightCharts
- **Styling:** Tailwind (precompiled) + custom design tokens in
  `react-app/tt-tokens.css` (`--ds-*` variables, gold accent
  `#F5C25C`)
- **Auth:** Cloudflare Access (Zero Trust) + custom JWT for API
- **Payments:** Stripe (via `/timed/stripe/create-checkout`)
- **Notifications:** Discord webhooks, web-push (PWA),
  SendGrid (email)
- **Data:** TwelveData (primary), Alpaca (execution + fallback)
- **AI:** OpenAI (Daily Brief, AI CIO) + Anthropic Claude (analysis)

## 9. Where to look when something breaks

| Symptom                              | First place to check                            |
|--------------------------------------|--------------------------------------------------|
| Stale prices in UI                   | `/timed/prices` vs `/timed/all` vs `/timed/latest` — confirm overlay is running |
| Trades disappeared / account reset   | `/timed/admin/data-audit-log` — look for `WIPE_DETECTED` |
| Equity curve flat for X days         | `POST /timed/admin/rebuild-snapshots-from-ledger` |
| New live trade not in ledger         | `POST /timed/admin/sync-trade-to-ledger`        |
| Cron not running / muted             | `GET /timed/admin/cron-mute` (check TTL)         |
| Replay lock stuck                    | `POST /timed/admin/replay-lock` (release)        |
| Discord alerts not firing            | Check `DISCORD_WEBHOOK_URL` secret on CF Dashboard |
| Worker logs                          | `wrangler tail` or Cloudflare Dashboard → Logs   |
