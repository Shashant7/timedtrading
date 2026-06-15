# Phase 2 — Indicator/Score Parity from the Chain (2026-06-15)

Phase 2 of `tasks/2026-06-14-foundation-rebuild-plan.md` §7: cut indicators +
score onto the chain (read ONLY via `getSeries`, complete-gated; UNSCORABLE on
incomplete) and re-run parity. This is the **first measured cut** — the seam +
a controlled bundle/score comparison on the shadow tickers. Read-only; no live
change; the DO stays dormant.

## What shipped
1. **The seam** — `worker/foundation/chain-series-adapter.js`:
   `makeChainGetCandles(getSeries)` returns a `getCandles(env,ticker,tf,limit)`
   that is **drop-in compatible with `computeServerSideScores`** (the live
   scorer's only candle dependency). It serves intraday TFs derived from the 5m
   base and D/W/M from the daily base, and carries the chain's `complete` +
   `coverage` up so the score layer can **refuse on incomplete input**.
2. **UNSCORABLE gate proven end-to-end** (test): a gappy 5m base → `complete=false`
   → `evaluateScore` returns `UNSCORABLE` (value `null`), never a silent number.
3. **Parity harness** — `scripts/chain-indicator-parity.js`: runs the REAL pure
   scorers (`computeTfBundle` → `computeWeightedHTFScore`/`computeWeightedLTFScore`
   → `classifyState`, replicating `assembleTickerData`'s anchor/leadingLtf glue)
   over LEGACY-store bundles vs CHAIN-derived bundles for the 10 shadow tickers.
   Report: `data/parity/2026-06-chain-indicator-parity.json`.

## Result (10 shadow tickers, 2026-06-01→06-12, isRTH fixed both sides)

| layer | parity vs legacy |
|---|---|
| **state** | **10/10 match** (Phase 0 baseline flipped 7/45) |
| **htf_score** | within ~1 pt; **4/10 exact** (AA, SNDK, TSLA, XLE) |
| `D` bundle | **exact 10/10** (px, emaDepth, ST, RSI, ATR identical) |
| `60` / `W` bundle | exact / near-exact |
| **ltf_score** | diverges (see below) |
| `10`/`15`/`30` bundles | differ — root cause below |

vs the Phase 0 baseline (45/45 diverge, 7 state flips, htf avg|Δ| 4.63 / max
15.7): the chain-backed HTF/state layer **collapses to a near-match**.

## Root cause of the ltf residual — a real rebuild win, not a chain bug

The harness surfaced **the exact legacy inconsistency the rebuild exists to
kill**: the legacy per-TF intraday store is **source-inconsistent and
extended-hours-contaminated**.

- Legacy `10m` GS = **631 bars / 10 days** (≈63/day = RTH 39 + pre/post-market) —
  Alpaca-sourced, **includes extended hours** (per the price-pipeline rule "10m
  is Alpaca-sourced in production").
- Legacy `60m` GS = **70 bars / 10 days** = exactly RTH (7/day) — a different
  source/aggregation, **RTH-only**.
- So within ONE ticker the legacy 10m and 60m disagree on whether extended hours
  count. Worse, the legacy 10m bundle's "current price" was an **after-hours
  print 1064.40**, while the RTH/daily close was **1062.75** — the engine scored
  LTF off an extended-hours tick (against the project's own headline-price
  doctrine: outside RTH use the RTH close, never a stale extended print).

The chain derives **every** timeframe from ONE **RTH-clipped 5m base**, so it is
internally consistent: D/W/60 (already RTH-consistent in legacy) match, while
10m/30m differ because the chain dropped the extended-hours prints legacy fed
in. The chain's intraday is the correct, consistent series; the legacy's was the
contaminated one. This is precisely "different inputs → different outputs → live
≠ backtest," now located and quantified.

## CORRECTION (operator-flagged 2026-06-15): the backtest USES extended hours

The first draft of this result recommended RTH-only and called extended hours
"contamination." **That was wrong.** The operator flagged that the proven
performance results are computed off extended-hours data, and the code confirms
it:
- `worker/replay-candle-batches.js` does **no** session filtering — the backtest
  scores over the full stored candles.
- `computeTfBundle` computes EMA/SuperTrend/RSI over **all** bars (the only
  RTH-specific code is the ORB sub-feature + the `isRTHNow()` LTF weight blend).
- The stored intraday is **source-dependent**: 5/10/15/30m are Alpaca-sourced
  and **extended-hours-inclusive** (10m spans 04:00–19:50 ET, ~63 bars/day vs 39
  RTH); 60/240m are **RTH-only** (≈7 / 2 bars/day).

Deriving the sub-hourly TFs from the extended-hours 5m base **without** clipping
reproduces the legacy bundles **byte-for-byte** (GS 10m: emaDepth 15, RSI 55.3,
px 1064.40, n=631 — identical), whereas RTH-clip is far off.

**Fix shipped** — `candle-chain.defaultSessionClip` encodes the canonical policy
that MATCHES the backtest basis: `5/10/15/30 = extended-hours`, `60/240 = RTH`
(overridable via `opts.sessionClip`). The daily-rollup reconcile keeps its RTH
clip (it compares to the official RTH daily — a separate, correct use).

### Re-run with the corrected policy
| layer | parity vs legacy |
|---|---|
| **ltf_score** | **10/10 exact** (was 0/10 under the wrong RTH-clip) |
| **state** | **10/10** |
| per-TF bundle fields | **10/10 on 10m, 15m, 30m, 60m, D** |
| htf_score | 4/10 exact; residual is `W` only (chain resamples weekly from daily vs legacy's separately-fetched W) + depth-limited 240/M |

The chain now **preserves the validated performance basis** and reproduces the
legacy indicator inputs essentially exactly. The remaining htf residual is the
weekly-derivation choice (resample-from-daily vs separate fetch — open decision
§9.4) and intraday depth for 240/M (needs the deep-base backfill).

### Remaining decision (narrowed)
Whether to keep weekly **derived from the daily base** (resample) or **fetch W
separately and reconcile** — affects htf by <1 pt today. Everything else
reproduces the backtest. The TRUE parity target remains **chain-live ≡
chain-replay** (0 by construction once both read the chain with this policy).

## "Fix weekly?" — diagnosed 2026-06-15: weekly is NOT broken; it's DEPTH

Operator asked if weekly is the next fix. Investigated:
- The chain's **resampled weekly OHLC is byte-identical to the legacy stored
  weekly** week-for-week (GS last 6 weeks O/H/L/C match to the penny). The only
  difference is a cosmetic timestamp on holiday-shortened weeks (chain anchors
  the bar at the first *trading* day, e.g. Tue 05-26 after Memorial Day; legacy
  at the ISO Monday 05-25) — self-consistent for the chain. **No resample bug.**
- The htf residual is **history depth + the W/M storage model**, not weekly
  logic. Pre-prod's stored series for GS:
  - daily = 908 rows / **490 unique days** (rest are the 2025 00:00Z/04:00Z
    double-write the chain correctly dedups), only **2024-07 → 2026-06 (~2yr)**.
  - **M = 44 bars (< 50 scoring threshold → legacy MONTHLY bundle is NULL)**.
  - W = 191 rows but ~104 unique weeks (also double-write-inflated, ~2yr).
  So the pre-prod-legacy HTF was computed on a **shallow, double-write-
  contaminated** history with **no monthly and no weekly EMA200**.
- Deepening the chain's daily base to 2020 (≈1620 bars) made the chain derive
  **clean, deep** W/M — which then DIVERGED MORE from the shallow pre-prod
  legacy (htf 4/10 → 1/10 exact). That is the chain being **more correct**, not
  a regression: the pre-prod legacy is the confounded side (Phase 0 confound #1).

### Conclusion + corrected next step
- **Do not "fix weekly"** — the resample is correct.
- The pre-prod legacy is the WRONG parity baseline (shallow + double-write). The
  right target is **chain vs LIVE deep scores**, and ultimately **chain-replay ≡
  chain-live** (0 by construction).
- Next, in order:
  1. **W/M derivation decision (§9.4)**: keep W/M **derived from a deep, deduped
     daily base** (recommended — already byte-exact on OHLC and removes the
     double-write) vs fetch-separately. This is strategy-affecting → operator call.
  2. **Deepen the chain base across the basket** to match live depth: daily to
     ~5yr (done for the 10-ticker sample) for W/M EMA200; **5m to several months
     for 240** (the last depth gap — 240 still can't build on a 10-day window).
  3. Run parity **chain-deep vs LIVE deep** (or chain≡chain) and wire the CI gate.

## Remaining for the full 45/45 re-run (deep-base requirement)
- The shadow chain holds only a 10-day 5m base, so HTF `240` (and deep `M`) can't
  be exercised from 5m yet. Deepen the chain 5m base (Alpaca/TD; months) + the
  daily base for the full 45-ticker basket, then run `computeServerSideScores`
  through `makeChainGetCandles` for both the chain-replay and a chain-live path
  and assert the divergence is ~0 (chain≡chain). Wire that as the CI parity gate
  (`scripts/parity-baseline.js` exits non-zero on diff).
- Resolve the extended-hours policy above before the gate is meaningful.

## Reproduce
```bash
CLOUDFLARE_API_TOKEN=... node scripts/chain-indicator-parity.js \
  --tickers AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE \
  --start 2026-06-01 --end 2026-06-12
```
