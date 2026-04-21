# Historical Market Events (One-Time Bulk Seed)

## Why this exists

TwelveData's earnings calendar (our primary provider) **only returns
forward-looking data**. When replaying 2025-07 through 2025-12 we discovered
that most tickers had zero earnings coverage in D1 for that window, which
meant the Phase-H.4.0 earnings-proximity entry gate could not fire.

Concrete example — v10b backtest, 2025-07-21:

```
AGYS LONG @ $117.25 → exit @ $105.00 (HARD_LOSS_CAP, -10.45%)
entry was 5.5 h before AGYS Q1 FY26 earnings release (Jul 21 16:00 ET)
```

If the earnings-proximity gate had had the 2025-07-21 earnings row, it
would have rejected the entry with `reason=h4_earnings_proximity`.

## Source: Yahoo Finance (yfinance)

Yahoo returns up to ~20 historical earnings dates per ticker with exact
release timestamps (and reported vs. estimated EPS). We do a one-time bulk
pull, format to our `market_events` schema, and upsert via a dedicated
admin endpoint.

## How to run

```bash
# 1. Pull from yfinance (creates data/market-events/earnings-yfinance-full.json)
python3 scripts/pull-historical-earnings-yfinance.py \
    --tickers-file configs/backfill-universe-2026-04-18.txt \
    --start 2025-06-01 --end 2026-05-31 \
    --out data/market-events/earnings-yfinance-full.json \
    --limit-per-ticker 12 --sleep-sec 0.2

# 2. Upload to worker (batched, idempotent)
python3 scripts/upload-historical-earnings.py \
    --input data/market-events/earnings-yfinance-full.json \
    --url https://timed-trading-ingest.shashant.workers.dev \
    --key "$TIMED_API_KEY"

# 3. Verify coverage
curl -sS "https://.../timed/admin/market-events/coverage?key=...&tickers=AGYS,ORCL,AAPL&startDate=2025-06-01&endDate=2026-05-31" \
  | jq '.earnings.coverage'
```

## Idempotency

The worker endpoint (`POST /timed/admin/market-events/bulk-seed`) upserts
on `id = earn-<TICKER>-<YYYY-MM-DD>`, which matches the format used by
the existing TwelveData-driven seeder (`market-events-seed.js`). Rerunning
is safe and will merge cleanly with any forward-calendar rows added by
the automated seeder.

## Caveats

- **ETF tickers** (SPY, QQQ, IWM, GLD, IAU, GDX, KWEB, etc.) have no
  earnings and are skipped cleanly.
- **XYZ (Block Inc.)** trips yfinance's parser and was dropped. If
  needed, re-pull with a specific ticker.
- Yahoo's `scheduled_time_et` resolution is hour-level. We classify
  session (bmo/rth/amc) from the timestamp so the
  `eventIsDueForEntryBlock` / `hoursToEvent` logic still works.
