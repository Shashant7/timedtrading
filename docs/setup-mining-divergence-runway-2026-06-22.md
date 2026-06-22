# Divergence runway — findings (2026-06-22)

## Hypothesis

After TD9 / phase exhaustion, the market often **waits for RSI divergence** (MR ladder stage 4, `phase_left_zone`) before the confirmation stack and the actual move. Divergence is the runway that builds momentum.

## Where divergence lives in the system

| Layer | Signal |
|---|---|
| MR ladder | Stage 4 `phase_left_zone` — includes `rsi_divergence_confirmed` |
| Setup events | `rsi_divergence_confirmed` from `tf_tech.{TF}.rsiDiv` edge-detect |
| Indicators | `rsi_divergence`, `phase_divergence` on scored ticker bundles |
| Entry logic | `__entry_divergence_summary` (adverse div blocks fragile entries) |

Divergence is **not** in `trail_5m_facts` — backtest/missed enrichment that falls back to trail cannot see it.

## Lift pass (missed Tier A)

From `pattern-lift/missed-enriched.json` + combo presets:

| Combo | Miss Tier A rate |
|---|---:|
| RSI divergence confirmed | **73%** |
| Exhaustion confirmed + RSI div | 32% |
| TD9 + RSI div | 20% |
| TD9 + RSI div + momentum | 20% |
| TD9 + RSI div + phase left (stage 4) | 1% |

Backtest WIN/LOSS rates are **0%** for divergence — not because divergence is absent in markets, but because **production `setup_events` has no rows in the Jul–Dec 2025 backtest window** (table is forward-populated on preprod discovery anchors).

## Runway timing pass (Tier A, 120h lookback, preprod events)

Artifact: `data/setup-mining/divergence-runway/runway-2026-06-22T00-58-27.md`

| Metric | Tier A missed (n=74) |
|---|---:|
| Has direction-aligned RSI div | 39% |
| Exhaustion → div (before div fires) | 38% of div cases |
| Div → momentum (ST/squeeze/EMA21) | 28% of div cases |
| Full runway (exhaust → div → momentum) | 4% |
| Median div → move anchor | **49h** |
| Median div → momentum | 34h |
| Median TD9 → div (when TD9 present) | 66h |

### Event ordering (all missed with events)

- `exhaust_momentum_div`: 22 — momentum **before** divergence (contradicts strict runway story)
- `exhaust_div_momentum`: 11 — classic runway
- `incomplete`: 145 — missing one leg of the chain

### Move size

- Full runway (n=3): avg **19.3 ATR**
- Divergence only, partial runway (n=26): avg **12.9 ATR**

Larger Tier A moves skew toward complete exhaust→div→momentum, but sample is tiny (n=3).

## Verdict

1. **Divergence belongs in the MR story** — it is stage 4 by design and shows on **73% of Tier A misses** in the event-enriched cohort.
2. **Do not gate on divergence alone** — 73% miss rate without backtest win lift yet (parity gap).
3. **TD9 + divergence is rarer (20%)** than divergence alone — many div fires without `td9_complete` event in window (TD progress / phase exhaustion still present).
4. **Runway is partial** — only ~4% show full exhaust→div→momentum; often momentum prints before divergence in the replay window.
5. **Next objective step**: backfill `setup_events` (or trail divergence flags) for the canonical backtest window so WIN vs LOSS lift is measurable; then add `stack_td9+rsi_div+momentum` to gate simulation.

## Commands

```bash
node scripts/divergence-runway-pass.mjs \
  --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
  --tier-a-only

npm test -- worker/foundation/setup-replay-mining.test.js
```
