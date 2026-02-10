# Entry Logic & Data Fixes — 2026-02-02

## 1. UI Stale / Outdated Data

**Root cause**: The replay overwrites KV with "last-seen-per-bucket" data. With 50 rows per bucket and 160 tickers, many tickers were last updated in early buckets (e.g. AAPL at 11am, not 4pm).

**Fix**:
- Added `POST /timed/admin/refresh-latest-from-ingest` — fetches the actual latest row per ticker from `ingest_receipts` and updates KV.
- Replay script now calls refresh-latest automatically after replay completes.
- Manual run: `TIMED_API_KEY=... node scripts/refresh-latest-from-ingest.js`

## 2. No Trades (AAPL, AMD, AMZN Examples)

**Root causes** (from alert-debug):

| Ticker | Blocker(s) | Fix |
|--------|------------|-----|
| AAPL | rrOk=false (RR 0), compOk=false (completion 1) | RR/TP near price = valid block. Completion: use computeCompletionToTpMax when available. |
| AMD | trigOk=false — trigger "EMA_CROSS_30M_13_48" not accepted | Accept trigger reasons that include "EMA_CROSS" or "SQUEEZE_RELEASE". |
| AMZN | compOk=false (completion 1) | Use computeCompletionToTpMax; prefer completion-to-max-TP over raw payload. |

**Code changes**:
- **trigOk**: Accept `EMA_CROSS_30M_13_48`, `EMA_CROSS_1H_13_48` — `trigReason.includes("EMA_CROSS")` or `includes("SQUEEZE_RELEASE")`.
- **freshPullbackOk**: Same trigger expansion for EMA_CROSS / SQUEEZE_RELEASE.
- **completion**: In `shouldTriggerTradeSimulation`, use `computeCompletionToTpMax` when available; fallback to `completionForSize`.
- **rank**: Fallback to `rank_position` or `position` when `rank` is missing.

## 3. Replay Script

- After replay, automatically runs refresh-latest-from-ingest.
- Ensures UI shows true latest data post-replay.
