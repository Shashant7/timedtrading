# Track A — D1 cost relief + chain-scoring shadow (2026-06-15)

Operator approved Track A: D1 cost relief now, lock W/M = derived-from-daily,
then prepare the live score→chain cutover behind a reversible flag with a
shadow side-by-side to verify live≡chain BEFORE flipping. Nothing live flipped.

## 1. D1 rows-read bill — diagnosis + relief shipped

Bill: 20B rows read/month (D1 billing threshold). Diagnosis:
- PK is `(ticker, tf, ts)`, so per-ticker reads are efficient. The cost is
  **volume × frequency**: (a) the `*/5` scoring cron reads ~300 bars × 8 TFs ×
  ~200 tickers from D1 every 5 min (~4B/month), and (b) all-ticker scans like the
  `/timed/all` prev-close map (`WHERE tf='D' … GROUP BY ticker` reads every daily
  row across all tickers on each assembly of a hot endpoint).
- The full-table coverage scan (`d1FindTickersNeedingOnboard`) is admin-only, not
  a hot driver.

**Shipped (pre-prod):** cache the `/timed/all` prev-close daily map in KV keyed by
trading day (1h TTL). Cache hit = zero candle rows read. The map only changes at
the daily roll. Additive + reversible. **Needs a prod deploy (operator) to affect
the live bill.**

**Structural fix (the real lever):** moving the score path onto the candle-chain
DO hot-window removes driver (a) entirely — derivation reads the DO's own SQLite,
not D1 `ticker_candles`. That is the cutover below.

## 2. W/M derivation — LOCKED: derived-from-deep-daily

Decision (plan §9.4): the chain derives Weekly/Monthly from the deduped, deep
daily base (`resampleDailyToWeekly/Monthly`). Verified the resampled weekly OHLC
is byte-identical to the legacy stored weekly; deriving removes the legacy
00:00Z/04:00Z daily double-write and the separately-fetched W/M depth
inconsistency. No separate W/M fetch.

## 3. Chain-scoring shadow side-by-side — built + first results

New pre-prod endpoint `GET /timed/admin/chain-score-shadow?ticker=X` runs the
REAL `computeServerSideScores` twice — legacy `d1GetCandles` vs the chain-backed
`getCandles` (derive every TF from one 5m base + daily base) — and diffs the
score-composition fields. This is the verification gate before any cutover.

Three-way comparison (LIVE deep vs pre-prod-legacy vs chain), 2026-06-15:

| ticker | LIVE htf/ltf | preprod-legacy | chain |
|---|---|---|---|
| AAPL | 15.1 / -16.8 | 12.4 / -17.4 | 24.3 / -17.4 |
| GS | 32.9 / 18.5 | 26.9 / 20.2 | 30.4 / 20.2 |
| MU | 25.6 / 19.6 | 19.1 / 18.1 | 23.5 / 16.9 |
| NFLX | -28.6 / -22.4 | -29.2 / -22.7 | -13.7 / -22.6 |
| TSLA | -4.9 / 20.9 | -10.1 / 14.2 | 17.2 / 14.2 |

**Findings:**
- **LTF reproduces through the real pipeline** — chain ltf tracks LIVE/legacy
  within a couple points (the extended-hours per-TF policy is verified end-to-end).
- **HTF gap is dominated by the missing 240 (4H) component** — 30% of HTF weight.
  The chain can't build 240 from a shallow 5m base (needs ≈100 trading days of 5m
  for the 4H EMA200; the shadow tickers have ~10 days–6 weeks). GS/MU (where 240
  matters less) are already close to LIVE; AAPL/NFLX/TSLA diverge on the missing
  240. A ~6-week 5m backfill let 240 *build* but not deep enough to move htf.
- Secondary: pre-prod legacy W/M are shallow (monthly null at 44 bars) so the
  chain's deep clean W/M also separate it from pre-prod-legacy — but that is the
  chain being MORE complete; the LIVE comparison is the real target.

## 4. Next steps (to finish Track A)
1. **Deep 5m backfill (the htf blocker):** paginate the 5m backfill (the endpoint
   caps ~5000 bars/call) to ~6 months for the basket so 240 builds with EMA200
   depth. Then re-run the shadow → htf should converge to LIVE. Cost note: 5m is
   the finest series (storage↑ on write) but it REPLACES the per-TF intraday
   stores and slashes rows-READ once the DO serves derivation — net win on the
   metric that tripped the bill.
2. **Reversible cutover flag:** gate the live score path's candle source
   (`d1GetCandles` ↔ chain `getCandles`) on an env flag, default legacy (OFF).
   Flip only after the shadow shows htf/ltf/state parity vs LIVE on the basket.
3. **Prod deploy of the D1 prev-close cache** (operator) for immediate bill relief.

## Guardrails
No live behavior changed. New endpoints are admin-gated, additive. D1 cache +
shadow deployed to PRE-PROD only. The cutover flag will default OFF and is
reversible; it will not flip without operator confirmation of shadow parity.
