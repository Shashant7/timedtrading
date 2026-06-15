# Phase 0 — Parity Baseline Result (2026-06-14)

The final Phase 0 deliverable (tasks/2026-06-14-foundation-rebuild-plan.md):
measure & record today's **live-vs-replay score divergence**, the number the
rebuild drives to zero. Run on the isolated **pre-prod** worker (no live state
touched). Artifacts in `data/parity/`.

## Setup

- **Golden day:** 2026-06-12 (last full session in the 60-day review window).
- **Basket:** 45 tickers actually traded 2026-04-13 → 06-12 (from live ledger).
- **Live side:** live's current `timed:latest` scores (market closed since the
  Fri close, so these ARE the 2026-06-12 close scores) — `data/parity/2026-06-12-live.json`.
- **Replay side:** pre-prod candle-replay of 2026-06-12 after a focused
  TwelveData backfill of the basket — `data/parity/2026-06-12-replay.json`.
- **Compared fields:** `state, htf_score, ltf_score, score, completion,
  phase_pct, conviction`. Tolerance 0.5 (so float rounding ≠ divergence).
- **Tool:** `scripts/parity-baseline.js` (pure diff core: `worker/foundation/parity.js`).

## Result — the baseline number

**45 / 45 tickers diverge. 177 field-level diffs.** This is the number we drive
to zero.

| field | # diverging / 45 | avg \|Δ\| | max \|Δ\| |
|---|---:|---:|---:|
| `completion` | **0** | 0.00 | 0.00 |
| `phase_pct` | **0** | 0.00 | 0.00 |
| `state` | 7 | — | (regime label flip) |
| `htf_score` | 44 | 4.63 | 15.70 |
| `ltf_score` | 42 | 5.19 | 16.20 |
| `score` (composite) | 40 | **14.62** | **48.00** |
| `conviction` | 44 | **15.14** | **50.00** |

`state` flips (would change setup admission): **APD, INFL, NXT, OKE, TLN, TT, XYZ**.
Worst single case — **APD**: live `HTF_BEAR_LTF_BEAR` / score 76 vs replay
`HTF_BEAR_LTF_PULLBACK` / score 28. **AAPL**: score 52 vs 41, conviction 42 vs 65.

## What this proves (and what it doesn't)

**Proves, decisively:** you cannot reproduce live scores from a replay today.
The divergence is **not** in the replay machinery — the pure price-derived
fields (`completion`, `phase_pct`) are **identical on every ticker**. It is
concentrated in the **score-composition layer** (`score`, `conviction`, and the
EMA-stack `htf/ltf` scores) — exactly the layer the rebuild's deterministic
score contract governs, and exactly the numbers that drive entries. This is the
quantified form of "backtest looked great, live never matched."

**Confounds (why the clean number is still owed):** this compares live-current
vs a focused replay, so part of the 177 is measurement noise, not the
candle-gap effect alone:
1. **Backfill daily-depth.** The focused backfill gave pre-prod ~150 daily bars
   (from 2025-11); live has continuous multi-year daily history. Components that
   lean on deep daily EMAs (EMA200) will diverge from depth alone. The
   pure-price fields matching tells us this is the main suspect for the residual
   `htf`/`conviction` drift, not the replay path.
2. **Known nondeterminism in the current engine** (documented in CONTEXT.md):
   market-internals / VIX read at wall-clock during replay; reference-execution
   differences. The rebuild removes these by construction.

So **177 / 45-of-45 is an upper bound** on live-vs-replay drift today. The
*clean* parity number (identical input contract, same history) is what the
Phase 2 controlled harness produces and the CI gate enforces at 0. The
qualitative verdict is unambiguous now: today's score is not reproducible, and
the irreproducibility lives precisely in the score-composition layer.

## How to reproduce

```bash
# pre-prod already synced (code + 479 model_config keys + TWELVEDATA secret)
# 1. focused backfill of the basket (in batches of <=15 for candle-replay)
# 2. candle-replay 2026-06-12 for the basket on pre-prod
# 3. build the two score maps (live timed:latest vs pre-prod timed:latest)
# 4. diff:
node scripts/parity-baseline.js \
  --live   data/parity/2026-06-12-live.json \
  --replay data/parity/2026-06-12-replay.json \
  --date   2026-06-12 \
  --fields "state,htf_score,ltf_score,score,completion,phase_pct,conviction" \
  --tolerance 0.5
```

## Next (Phase 1)

Build the candle chain (5m base + deterministic resample, contiguity invariant,
per-ticker DO, bounded retention) so the replay reads a *complete, deep*,
calendar-anchored series identical to live — removing confound #1 — and the
score contract refuses on incomplete input in both paths. Then re-run this
baseline; the score/conviction divergence should collapse toward 0, and the
residual is the real candle-gap + nondeterminism budget to eliminate in Phase 2.
