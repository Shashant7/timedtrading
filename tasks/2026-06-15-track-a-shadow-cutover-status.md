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

## 3b. Parity proof + a storage-driven architecture correction (2026-06-15)

Deep-5m backfilled AAPL/NFLX/TSLA to ~8.5 months (~32k 5m bars each, paginated
around the 5000-bar/call cap) and re-ran the shadow (same-asOf, chain vs legacy):

| ticker | d_ltf | d_completion/phase | d_htf | state |
|---|---|---|---|---|
| AAPL | 0 | 0 | +9.5 | equal |
| NFLX | 0 | 0 | +4.8 | equal |
| TSLA | 0 | 0 | +17.7 | **flips** BEAR→BULL |

- **LTF + completion + phase: EXACT parity** (the drift source the rebuild
  targets is fully reproduced). ✓
- **HTF: chain runs systematically HIGHER** than both legacy and LIVE (+5–18).
  Root cause isolated by comparing the 240 (4H) bundle directly:
  - AAPL 240 chain≈legacy (depth 3/3, px/rsi identical) — converges.
  - **TSLA 240 chain depth 7 vs legacy depth 9** — legacy 240 has **1,148 bars
    (multi-year)**; the chain derived only **350** from 8.5 months of 5m.

### The storage finding (answers the operator's cost question)
To derive a 240 EMA-stack as deep as the legacy stored 240, the chain needs
~2.7 YEARS of 5m: ~1,148 4H bars × 48 = **~55k+ RTH 5m bars/ticker (~110k with
extended hours)** vs **1,148 rows stored directly** — **~50–100× more storage**
for the HTF timeframes, per ticker, ×258 tickers. Deriving *deep HTF* from one
5m base is storage-prohibitive (and re-creates the read cost on the metric that
tripped the bill). My earlier "one-base storage is comparable" held only for the
shallow LTF window — NOT for deep HTF.

### Corrected architecture (recommended)
**Hybrid base, not a single 5m base:**
- **5m base → LTF (10/15/30/60)** derived. This is cheap (months of 5m) and is
  exactly where the live≠backtest *drift* lived. ✓ proven byte-exact.
- **Daily base → D/W/M** derived (deduped, deep). ✓ proven byte-exact OHLC.
- **240 (4H): keep as its own maintained series** (stored ~1,148 rows), NOT
  derived from multi-year 5m. (Optionally derive a *recent* 240 from 5m for
  same-day freshness, reconciled to the stored deep 240 at session end.)

This keeps consistency where it matters (LTF) without the multi-year-5m storage
blow-up, and HTF stays on its cheap deep series. It also means the live cutover
should swap only the LTF candle source to the chain initially.

### Decision → do NOT full-universe-backfill 5m
Proceeding to a full ~258-ticker deep-5m backfill is the wrong move: huge write +
storage, and it still can't match the legacy deep-240 EMA stack. Instead adopt
the hybrid above. The cutover then flips LTF (10/15/30/60) to the chain (fresh +
exact parity) while HTF stays on the existing deep series — fresh scores, no
storage blow-up, and the D1 read relief comes from the LTF derivation moving into
the DO hot-window.

## 3c. Hybrid implemented + parity VALIDATED (2026-06-15, operator approved)

Shipped (pre-prod): `makeHybridGetCandles` (route LTF 10/15/30/60 → chain;
240/D/W/M → legacy deep stores) + `resolveScoreGetCandles(env)` reversible switch
(`SCORE_CANDLE_SOURCE`: legacy [default] | hybrid_chain | full_chain; fails safe
to legacy). `chain-score-shadow?mode=hybrid` previews the LTF-only cutover.

Hybrid-mode shadow on the sample (chain LTF + legacy HTF, same asOf):

| ticker | d_htf | d_ltf | d_completion | state |
|---|---|---|---|---|
| AAPL | 0 | 0 | 0 | equal |
| NFLX | 0 | 0 | 0 | equal |
| TSLA | 0 | 0 | 0 | equal |
| GS | 0 | 0 | 0 | equal |
| MU | 0 | -1.2 | 0 | equal |

**Clean parity: htf identical, ltf ≈0, state 5/5 equal.** The cutover reproduces
legacy scores when healthy; the win is the LTF can no longer drift stale
mid-session (one 5m base instead of 4 independently-fetched series). Tests:
454 green incl. the router + resolver.

## 4. Remaining to finish Track A (operator-gated — the LIVE cutover)
The foundation is done + parity-validated. What's left flips LIVE behavior and is
gated by the guardrail "don't wire the DO into live ingestion without approval":
1. **Enable the DO 5m ingest lane** (calendar-driven, every 5 min) feeding the
   per-shard candle-chain DO so the LTF chain source is the DO HOT-WINDOW (not
   D1) — this is what makes the cutover REDUCE D1 reads. (Tool exists:
   `scripts/candle-chain-shadow-ingest.js` / the DO `/ingest`.) Needs operator OK.
2. **Wire `resolveScoreGetCandles(env, {legacy, chain})`** at the scoring cron's
   `computeServerSideScores(...)` call, with `chain` = a DO-backed getCandles.
   Defaults to legacy (no-op) until the flag is set.
3. **Flip `SCORE_CANDLE_SOURCE=hybrid_chain`** on a canary, watch the shadow diff
   stay ~0 live, then ramp. Reversible (set back to `legacy`).
4. **Prod deploy of the D1 prev-close cache** for immediate bill relief.

LTF-only first; 240/D/W/M stay on their deep stores. Optional later: same-day 240
freshness via a recent-5m derive reconciled to the stored deep 240 at close.

## Guardrails
No live behavior changed. New endpoints are admin-gated, additive. D1 cache +
shadow deployed to PRE-PROD only. The cutover flag will default OFF and is
reversible; it will not flip without operator confirmation of shadow parity.
