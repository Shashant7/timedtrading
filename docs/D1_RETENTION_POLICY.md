# D1 Storage & Data Maintenance Policy

_Last updated: 2026-05-22 (PR responding to Cloudflare 80M rows-written billing alert)._

## Why this exists

Cloudflare D1 bills on **rows written**, not bytes or query count. We hit our
80 M rows-written threshold in May 2026. This document is the single source of
truth for:

1. What we write to D1 and how often.
2. How long we keep each table.
3. Which write paths have cost-elision in place.
4. The handful of tables that intentionally have no retention and why.

## Cost model — the only knob that matters

| Operation             | D1 billed | Notes                                            |
|-----------------------|-----------|--------------------------------------------------|
| `INSERT`              | 1 row     | Per row inserted                                 |
| `UPDATE … WHERE`      | N rows    | Per row touched                                  |
| `INSERT … ON CONFLICT DO UPDATE` | 1 row     | Counts whether INSERT or UPDATE path fires |
| `DELETE … LIMIT N`    | N rows    | Per row removed                                  |
| `db.batch([...])`     | sum       | Each statement bills its own rows                |
| `SELECT`              | **free**  | We can pre-read to avoid unnecessary writes      |

The cheapest write is the one we don't make. All optimizations below are
"elide the write when the row content didn't change."

## Top write paths (audit 2026-05-22)

Profile measured on the live worker:

| Rank | Path                                                          | Est. share | Mitigation                                                              |
|------|---------------------------------------------------------------|------------|-------------------------------------------------------------------------|
| 1    | `ticker_candles` `*/5` REST bar cron + 06:00 ET backfill      | 45–60%     | Tiered retention; PriceStream gating skips intraday REST when DO healthy |
| 2    | TV ingest → `ticker_latest` + `ticker_index`                  | 15–25%     | **2026-05-22 — fingerprint elision** (`d1UpsertTickerLatest`) + **1h staleness gate** (`d1UpsertTickerIndex`) |
| 3    | TV ingest → `timed_trail` + `ingest_receipts`                 | 10–15%     | 48h `timed_trail` purge; 7d `ingest_receipts` purge                     |
| 4    | Scoring `*/5` `ticker_latest` batch sync (~76710)             | 5–8%       | **2026-05-22 — fingerprint elision** (mirrors call-site cache)          |
| 5    | `d1SyncLatestBatchFromKV` safety-net catch-up                 | 3–5%       | **2026-05-22 — cadence cut from every 5 min → every 15 min**            |

## Retention windows (`runDataLifecycle`, daily 4:00 UTC)

| Table                       | Window           | Trigger                                          |
|-----------------------------|------------------|--------------------------------------------------|
| `timed_trail`               | 48 hours         | Aggregate → `trail_5m_facts` then DELETE         |
| `ingest_receipts`           | 7 days           | DELETE                                           |
| `alerts`                    | 90 days          | DELETE                                           |
| `model_predictions`         | 180 days (resolved) | DELETE WHERE resolved=1                       |
| `model_outcomes`            | 180 days         | DELETE                                           |
| `ml_v1_queue`               | 30 days          | DELETE                                           |
| `user_notifications`        | 60 days (read)   | DELETE WHERE read_at IS NOT NULL                 |
| `queued_actions`            | 7 days resolved / 24h pending | DELETE                              |
| `admission_cohort_log`      | **365 days**     | DELETE (added 2026-05-22)                        |
| `trail_5m_facts`            | **365 days**     | DELETE (added 2026-05-22 — was indefinite)       |
| `data_audit_log`            | **180 days**     | DELETE (added 2026-05-22)                        |
| `sessions`                  | **180 days**     | DELETE (added 2026-05-22)                        |
| `ticker_candles` `10m`/`30m`| 90 days          | Tiered DELETE                                    |
| `ticker_candles` `1h` (60m) | 180 days         | Tiered DELETE                                    |
| `ticker_candles` `4h` (240m)| 365 days         | Tiered DELETE                                    |
| `ticker_candles` `D`/`W`/`M`| **forever**      | Tax-archive — never purged                       |
| `ticker_candles` `1m`/`3m`  | All rows         | One-time dead-TF purge (legacy TFs)              |
| All tables                  | All rows         | Removed-ticker block-list purge                  |

## Tables with no scheduled retention (by design)

These are small and bounded by external factors:

- `users`, `terms_acceptance` — bounded by signup volume; legal retention requirement
- `vip_codes` — operator-managed
- `trades`, `positions`, `lots`, `execution_actions`, `trade_events`, `account_ledger` — full trade history needed for performance attribution
- `investor_positions`, `investor_lots` — same
- `ai_cio_decisions`, `model_changelog` — model audit trail
- `etf_rebalance_history`, `etf_core_ideas` — ETF history (low volume)
- `backtest_*` — bounded by user-initiated runs
- `daily_briefs`, `daily_market_snapshots`, `market_events` — daily granularity, small
- `direction_accuracy`, `path_performance`, `pattern_library`, `model_config` — bounded by trade count / config keys

If any of these ever grow into a billed-write concern, add them to the
`retentionPurges` array in `worker/index.js` (`runDataLifecycle`, ~26977).

## Write-elision caches (per-isolate)

Added 2026-05-22 to address Tier #2 and #4 above:

### `_d1IndexLastSeenCache: Map<sym, last_seen_ts>`

`d1UpsertTickerIndex` skips the write when the cached `last_seen_ts` is
within 1 hour of `nowTs`. The `last_seen_ts` column is only used for ordering
"recently active" tickers, so hour-granularity is fine. Cuts TV-ingest index
writes by ~95%.

### `_d1LatestFingerprintCache: Map<sym, fingerprint>` (max 500 entries)

`d1UpsertTickerLatest` and the scoring `*/5` batch sync (~76710) both
compute `${stage}|${len}|${payload_json}` as a fingerprint and skip the
write when the fingerprint matches the last write for that ticker in this
isolate. Volatile fields (`ts`, `updated_at`) are excluded — they tick on
every call by design and have no observable effect on UI/scoring.

Cuts the TV-ingest `ticker_latest` writes by ~70–80% (consecutive bars
within a `*/5` window all carry the same compacted payload). For the
scoring path, cuts ~20–40% (compaction often produces identical output
when only volatile / dropped fields changed).

Caches evict on isolate respawn (~hourly), guaranteeing a fresh write
after a deploy or eviction.

## Operator runbook

- **Monitor:** `wrangler d1 insights` (when available) or the Cloudflare
  dashboard → D1 → Metrics → Rows written. Anything trending above ~2.5 M
  rows/day deserves a look.
- **Probe a single write path:**
  ```
  GET /timed/admin/d1-write-stats?key=ADMIN_KEY   # TODO if not yet shipped
  ```
- **One-off purge:** the `runDataLifecycle` function can be invoked
  manually via `POST /timed/admin/run-data-lifecycle?key=ADMIN_KEY`.
- **Adding a new high-volume table:** include a `retentionPurges` entry
  in the same PR, or document here under "no scheduled retention" with
  justification.
