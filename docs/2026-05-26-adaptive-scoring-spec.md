# 2026-05-26 — Adaptive scoring — kickoff spec

> **Status:** kickoff / planning artifact. Defers to a follow-up session
> for implementation. This doc sets up the design so the next agent (or
> the next composer model) can pick up the work without rediscovery.

## Why now

The recap pending list (`docs/2026-05-23-progress-recap.md` §5) has
**"Adaptive scoring follow-up was deferred when we wrapped the CPU
optimizations (#234); pick this back up when the Markov framework is
producing."** That gate is now met:

- Markov P-matrix is populated daily (`timed:regime:matrix:global`,
  verified post-PR #279).
- HMM model + decode are populated (`timed:regime:hmm:model:v1` +
  `timed:regime:hmm:latest`, latest state = `BULL_TREND`).
- HMM→engine wiring is live as of PR #285 (latent_regime on the trade
  record, chop floor hardening, macro-flip DEFEND, sizing confidence
  guard).
- Observability is in place: SL guard counters (#290), provider
  fallback counters (#291), HMM labelling check (#295).

The system is now producing the data adaptive scoring needs as inputs.

## What "adaptive scoring" means in this codebase

Today the scoring weights inside `computeRank()` (worker/index.js
~line 12000-12500) are static constants — they don't react to regime
or to what the model has been getting right lately. The deferred work
is to make the weights respond to:

1. **Regime context** — when the HMM says `BULL_TREND`, lean harder
   on momentum signals (HTF/LTF score, EMA stack, ripster clouds);
   when `CHOP`, lean harder on mean-reversion signals (RSI extremes,
   stochastic, ATR fib levels).
2. **Recent direction accuracy** — when the model's HTF score has
   been a poor leading indicator for the last 30 trades, dampen its
   weight; when LTF score has been calling tops correctly, boost it.
3. **Per-ticker character** — the ticker_profile already classifies
   tickers as VOLATILE_RUNNER / RANGE_BOUND / etc. Scoring should
   weigh momentum more for runners, mean-reversion more for range.

Today some of this is approximated by the regime_class size haircut
(Phase 5 R3) and the cohort gates (Phase 4 G1/G2), but those are
*sizing / admission* knobs — they don't change the underlying rank.

## Design — three layers

The simplest layering keeps complexity bounded:

### Layer 1 — Static weights with regime multipliers

Keep the existing static weights in `computeRank()`. Introduce a
single multiplicative table keyed on `latent_regime.state`:

```js
const REGIME_WEIGHT_MULT = {
  BULL_TREND: { htf_score: 1.15, ltf_score: 1.10, mean_rev: 0.85, ... },
  CHOP:       { htf_score: 0.90, ltf_score: 0.95, mean_rev: 1.20, ... },
  BEAR_TREND: { htf_score: 1.15, ltf_score: 1.10, mean_rev: 0.85, ... },
};
```

`computeRank` reads `tickerData.latent_regime?.state` (already
populated by the scoring path post-#285) and applies the multipliers
when posterior confidence ≥ 0.6. When the HMM hasn't decoded yet or
confidence is low, multipliers default to 1.0 — pure pass-through.

**Risk:** trivially small. Default-off via a `gates.adaptive_scoring_v1`
flag; flip in production after observing 1 trading week.

### Layer 2 — Per-ticker character bias

Read `tickerData.execution_profile.personality` (already populated
by the ticker_profiles table) and apply a second set of multipliers:

```js
const PERSONALITY_WEIGHT_MULT = {
  VOLATILE_RUNNER: { htf_score: 1.10, ltf_score: 1.05, mean_rev: 0.90 },
  RANGE_BOUND:     { htf_score: 0.90, ltf_score: 0.95, mean_rev: 1.15 },
  // ... etc per existing personality set
};
```

Combines multiplicatively with Layer 1. Cap the combined multiplier
at ±20 % from baseline so adaptive scoring never produces an extreme
rank shift on its own. Default-off via `gates.adaptive_scoring_v2`.

### Layer 3 — Direction-accuracy feedback

Read the `direction_accuracy` D1 table (already populated — used by
the cohort-fail block) and compute per-signal hit rate over the last
30-50 trades. Down-weight signals that have been a poor leading
indicator; up-weight signals that have been right.

This is the most data-driven layer and also the riskiest — a single
streak of luck can move weights too far. Guard with:

- minimum sample size: ≥ 30 trades per signal before any adjustment.
- bounded adjustment: ±15 % from baseline.
- temporal decay: weights revert to baseline on a half-life of ~14
  days when not updated.

Default-off via `gates.adaptive_scoring_v3`.

## Implementation order

1. **Layer 1** — single PR, ~150 LoC. Add the multiplier table,
   wire into `computeRank`, log the applied multipliers in the
   admission log so post-trade attribution sees them.
2. **Layer 2** — second PR, ~100 LoC. Same shape, different input.
3. **Layer 3** — bigger PR, ~400 LoC. Needs a small precompute step
   that runs in the daily lifecycle to build the per-signal hit-rate
   table and persist it to KV. Reads from KV per-isolate.

Stack-merge order is `1 → 2 → 3`; each layer is independently
gateable so we can run Layer 1 in production while Layer 2 is being
tested.

## Observability that already exists

- `GET /timed/admin/sl-guard-stats` (PR #290) + `/daily` aggregator
  (PR #294) — see how often each guard catches edge cases.
- `GET /timed/admin/provider-fallback-stats` (PR #291) — TD/Alpaca
  health.
- `GET /timed/admin/phase6-prereq-status` (PR #295) — Phase 6 gate.
- `GET /timed/admin/hmm-labelling-check` (PR #295) — HMM sanity.

For adaptive scoring specifically, plan to add:

- `GET /timed/admin/adaptive-scoring-impact?lookback_days=7` — for
  every trade in the window, show baseline_rank vs adapted_rank vs
  outcome. Lets the operator see whether adaptive scoring is moving
  the needle in the right direction.

## What this PR ships

This PR ships **only** the spec doc — no code change. The next
agent (or composer session) picks up from here, lands Layer 1 first,
and iterates.

## Rollout plan (per layer)

1. PR opens with `gates.adaptive_scoring_v1 = false` (default-off).
2. Operator flips on for shadow mode: weights are computed and
   stamped on admission_cohort_log but scoring still uses baseline.
3. After 5 trading days in shadow, audit `adaptive-scoring-impact`
   endpoint. If adjusted ranks correlate better with outcome →
4. Operator flips on for live (single config update). No code change.
5. Monitor for 1 week; revert via config if anything regresses.

Same shape for Layers 2 + 3.

## Open questions to resolve before Layer 1 lands

- Should regime multipliers apply per-signal (htf_score, ltf_score,
  ema_stack, ripster_clouds, etc.) or just to the aggregate rank?
  Recommend per-signal — finer-grained, easier to tune.
- Should the multipliers be linear (current spec) or a softer
  sigmoid? Linear is simpler; revisit if we see clipping at the ±20%
  cap.
- Cohort interaction — when both adaptive scoring AND cohort-fail
  gate (Phase 4 G2) want to act, which wins? Recommend cohort first
  (it's hard-gated by data), adaptive second (it nudges).

## File index (for the next agent)

| File | Role |
|---|---|
| `worker/index.js` ~line 12000-12500 | `computeRank()` static weights |
| `worker/index.js` ~line 21215+ | `_p5ChopHaircutPlan` (Phase 5 R3 sizing) |
| `worker/index.js` ~line 21240+ | `_markovFavorPlan` (Phase B sizing) |
| `worker/lib/regime-markov-policy.js` | Pure policy fns (chop / favor / dwell) |
| `worker/lib/regime-hmm-compute.js` | `loadLatentRegime` |
| `worker/cio/cio-memory.js` | `buildCIOMemory` (already reads `latent_regime`) |
| D1 `direction_accuracy` | Per-signal hit-rate source (Layer 3) |
| D1 `ticker_profiles` | Per-ticker personality (Layer 2) |
| `docs/2026-05-23-progress-recap.md` §5 | Pending-items list |

## Definition of done — this kickoff PR

- [x] Spec doc landed at `docs/2026-05-26-adaptive-scoring-spec.md`.
- [x] Recap doc (`docs/2026-05-23-progress-recap.md` §5) marks
      adaptive scoring as "in progress (spec)" instead of "deferred".

Layer 1 implementation is the next focused PR.
