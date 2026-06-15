# Phase 1 — Shadow Ingest + Zero-Gap Coverage Proof (2026-06-15)

The Phase 1 exit criterion (plan §7, §8): run the candle chain in SHADOW beside
the current per-TF store and prove **zero gaps using the chain's OWN coverage
report** (not an external guard). Done on isolated pre-prod; live untouched.

Tool: `scripts/candle-chain-shadow-ingest.js` (reads pre-prod D1 read-only,
feeds the dormant per-shard Candle Chain DO via the admin proxy, then queries
the chain's integrity/coverage). Report:
`data/parity/2026-06-chain-shadow-coverage.json`.

## Setup
- 10 tickers with stored 5m on pre-prod: AA, AAPL, CLS, FSLR, GS, MU, NFLX,
  SNDK, TSLA, XLE.
- Window: 2026-06-01 → 2026-06-12 (10 trading days).
- Fed the DO the stored 5m base + daily base; asked the chain for per-day RTH
  coverage and ran the base-fidelity shadow gate (reconcile + consensus).

## Result — COVERAGE (the Phase 1 success criterion)

**ZERO GAPS.** Across all 10 tickers × 10 days the chain's own coverage report
returns **7800 / 7800 expected RTH 5m buckets present, 100 / 100 complete
days**, every ticker `zero_gap=true`. The chain reconstructs a complete,
contiguous, calendar-anchored 5m base and derives every timeframe from it — the
structural fix for the "10/15/30 stale while D/60 fresh" divergence that caused
live ≠ backtest. Coverage is COMPUTED (present vs the calendar grid), not
asserted by a guard.

## Result — BASE-FIDELITY shadow gate (report-only, never blocks)
- 6 / 10 reconcile clean (AA, AAPL, CLS, GS, NFLX, XLE): the RTH 5m roll-up
  matches the official daily H/L within tolerance and volume is within the
  banded ratio.
- 4 / 10 correctly FLAG real discrepancies (the gate is doing its job, not
  ceremony):
  - **MU 2026-06-04 high 1079.57 vs daily 1036.37 (+4.2%)** — a genuine bad 5m
    tick in the stored per-TF data. Exactly what the fidelity gate exists to
    catch.
  - TSLA 06-01/06-02 high off 0.06–0.16%, SNDK 06-04 high off 0.31% — wick-level
    differences where the official daily high exceeds any RTH 5m bar's high (the
    daily captures a sub-5m print the 5m series rounds/misses). The same
    provider-hourly-vs-5m-aggregate class the shadow reconcile saw on 60/240.

These were surfaced AFTER two correctness fixes folded into `reconcileDailyRollup`
this session: (1) clip the roll-up to the RTH session (the stored 5m carries
extended-hours prints whose extreme ticks otherwise blow past the RTH daily),
and (2) a relative (5 bps) price tolerance so high-priced names ($1000+) aren't
flagged for a few-cent 2dp rounding gap. The MU bad tick still exceeds 5 bps and
is flagged — tolerance was made price-appropriate, NOT loosened to hide anomalies.

## Parity baseline re-run — status & the remaining delta

The Phase 0 baseline was **45/45 tickers diverge** (live `timed:latest` vs a
focused pre-prod candle-replay; `tasks/2026-06-14-phase0-parity-baseline-result.md`).
That doc identified the dominant confound as **#1 backfill daily-depth /
candle-gap** — the replay read a shallow, gappy series while live read a deep one.

Phase 1 (this session) **structurally removes confound #1 for the chain-backed
path**: the chain now serves a complete, zero-gap, calendar-anchored base
(proven above). But the live-vs-replay SCORE divergence only collapses once the
indicators + score actually READ from the chain via `getSeries` and refuse on
incomplete input — that is **Phase 2** (plan §7), explicitly the next phase.
Re-running `scripts/parity-baseline.js` against the existing score maps today
reproduces 45/45 because the score still reads the legacy per-TF store, not the
chain. The honest sequencing:

1. [x] Phase 1 — chain serves a complete zero-gap base in shadow (DONE here).
2. [ ] Phase 2 — cut indicators + score onto `getSeries` (complete-gated);
   re-run `parity-baseline.js`; the score/conviction divergence collapses toward
   0 and the residual is the real nondeterminism budget. Add the CI parity gate.

So the measured Phase 1 deliverable is the **zero-gap coverage proof**; the
parity-collapse number is produced in Phase 2 and must not be claimed before the
score reads the chain.

## Reproduce
```bash
TIMED_TRADING_API_KEY=... CLOUDFLARE_API_TOKEN=... \
node scripts/candle-chain-shadow-ingest.js \
  --tickers AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE \
  --start 2026-06-01 --end 2026-06-12
```

## Next (Phase 2 — for the next session)
- Implement a chain-backed `getSeries` reader for the replay + live score paths;
  point indicators at it; have the score return UNSCORABLE on `complete=false`.
- Re-run `scripts/parity-baseline.js`; confirm the 45/45 score/conviction
  divergence collapses; wire the parity gate into CI (non-zero exit on diff).
- Deepen the daily base for the full 45-ticker basket (Alpaca now available) to
  eliminate the EMA200-depth residual before the clean parity read.
