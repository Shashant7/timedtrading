# D1 billing investigation — 80M rows written threshold (2026-06-22)

**Status:** Documented. **No code change.** Re-assess if the threshold fires again next month.

Cloudflare notification: configured billing threshold reached for **80,000,000 rows written** on `timed-trading-ledger` (production D1).

---

## Dashboard read (screenshots, 2026-06-22)

### 24-hour view (Jun 21 → Jun 22)

| Metric | Value | Note |
|---|---:|---|
| Total queries | ~1M | +281% vs prior window |
| Rows read | ~1B | +270% |
| Rows written (24h card) | ~914k | +1174% — **not** the 80M monthly cumulative |
| Storage | 4.06 GB | 88 tables |

Activity pattern:

- Near-zero overnight Jun 21.
- Small spikes ~03:30–04:30 UTC (likely batch/cron).
- **Large RTH spike ~10:00 UTC Jun 22** (~225k queries, ~105k writes) — normal market-open load, not a runaway loop.

### 7-day view

- **Jun 18 ~08:00 EDT:** ~5M queries in one interval — aligns with setup-mining / replay work that week (Tier A+B replay, prod `historical_replay` setup_events backfill).
- **Jun 19–21:** relatively quiet between spikes.
- **Jun 22 RTH:** another open spike, smaller than Jun 18.

**Conclusion:** The 80M threshold is **monthly cumulative** steady-state crons + a **Jun 18 mining/replay burst**, not an ongoing runaway. Current day looks like normal RTH traffic.

---

## Production table snapshot (2026-06-22)

| Table | Rows | Notes |
|---|---:|---|
| `ticker_candles` | 9.4M | Chart bars + live quote patching |
| `trail_5m_facts` | 4.4M | 5m trail aggregates |
| `setup_events` | 196k | Shadow ledger (new Jun 2026) |
| `timed_trail` | 17k | Hot 48h window |
| `ticker_latest` | 289 | Latest scored payload |

`setup_events` by source:

| Source | Rows |
|---|---:|
| `historical_replay` | 189,125 |
| `scoring_cron` | 6,029 |
| `admin_backfill` | 383 |

Mining replay on **production** D1 (not preprod) explains the Jun 18–19 write spike. Tier replay should stay on preprod per `docs/weekend-readiness-juneteenth-2026.md`.

---

## Worker topology (verified)

| Worker | Flag | Value |
|---|---|---|
| Monolith (`timed-trading-ingest`) | `ENGINE_EXTERNAL` | `true` |
| tt-engine | `ENGINE_ENABLED` | `true` |

This is the **correct cutover pair** — monolith skips */5 scoring tail; tt-engine owns scoring. **No dual-scoring overlap** (which would corrupt kanban and double trail/setup_events writes).

Monolith still runs */5 **bar cron** (Alpaca candle fetch) when engine is external — by design (`worker/index.js` ~91127).

---

## Steady-state write drivers (for future reference)

Ranked by typical monthly volume. Existing D1-COST guards noted where present.

1. **`syncLivePricesToChartCandles`** — */1 price-feed during RTH, up to 280 tickers × 4 TFs (10/15/30/60). Upserts forming bars every minute. **~9–10M writes/month** estimated.
2. **Alpaca */5 bar cron** — half-universe lookback upserts into `ticker_candles`. Has skip-if-unchanged WHERE clause.
3. **Scoring */5 (tt-engine)** — `timed_trail` batch INSERT OR REPLACE; `ticker_latest` upsert (fingerprint-elided); `setup_events` when events fire.
4. **Data lifecycle** — `trail_5m_facts` light aggregation, retention purges.

---

## Live prices vs chart candles (do not conflate)

**Headline live prices** come from KV `timed:prices` (TwelveData feed, price-stream). They are **not** blocked by D1 candle sync cadence.

**`syncLivePricesToChartCandles`** only patches **D1 chart bars** (10/15/30/60) so right-rail charts and freshness grades stay aligned between */5 REST bar fetches. A **5-minute candle delay is acceptable** for charts; it does not affect card/header live price display.

If write volume becomes a problem again, prefer **cadence throttling** (e.g. run candle sync on */5 aligned with bar cron) over skip-if-unchanged on the same path — lower risk of subtle chart staleness bugs, zero impact on live price KV path.

**Deferred:** skip-if-unchanged optimization on live candle sync — operator concern about unintended side effects on price freshness (misplaced for KV, but valid caution for chart UX).

---

## Hygiene (optional, not urgent)

When mining parity work is complete:

```sql
DELETE FROM setup_events WHERE source = 'historical_replay';
```

Run via:

```bash
cd worker
../node_modules/.bin/wrangler d1 execute timed-trading-ledger --env production --remote \
  --command "DELETE FROM setup_events WHERE source = 'historical_replay';"
```

Does not reduce past billing; reduces table bloat and read amplification.

---

## Action plan

| Priority | Action |
|---|---|
| Now | None — monitor |
| Next month | If threshold fires again, compare 7-day D1 metrics for new burst vs steady RTH slope |
| If optimizing | Throttle `syncLivePricesToChartCandles` to */5 (not skip-if-unchanged first) |
| Mining | Keep replay/backfill on **preprod D1** only |

---

## Related docs

- `skills/d1-debugging.md` — query recipes
- `skills/worker-topology.md` — ENGINE_EXTERNAL / ENGINE_ENABLED cutover
- `docs/weekend-readiness-juneteenth-2026.md` — setup_events prod hygiene
