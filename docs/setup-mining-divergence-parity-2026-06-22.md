# Backtest divergence parity — results (2026-06-22)

## What changed

Backtest enrichment now derives `rsi_divergence_confirmed` (and TD9 on bootstrap) from **trail_5m + daily candles** when production `setup_events` is empty for Jul–Dec 2025.

| Module | Change |
|---|---|
| `setup-event-derivation.js` | `enrichTrailSnapshotsForDerivation()` — daily RSI div + daily TD stamp |
| `setup-replay-mining.js` | `diagnosticsForEntryWindow` calls enrichment before derive |
| `pattern-lift-pass.mjs` | Fetches `ticker_candles` (o/h/l/c) + trail; source `trail_derived` |
| `backfill-setup-events.mjs` | `--cohort backtest` for optional D1 persist |

## Canonical lift pass (362 backtest + 211 missed)

Artifact: `data/setup-mining/pattern-lift/lift-2026-06-22T01-47-35.json`

| Combo | BT WIN rate | BT LOSS rate | Win lift | Tier A miss rate | Capture gap |
|---|---:|---:|---:|---:|---:|
| **RSI divergence** | 60.9% | 67.1% | **-6.2%** | 73.0% | +12.1% |
| Exhaustion + RSI div | 2.4% | 2.6% | -0.2% | 32.4% | +30.0% |
| TD9 + RSI div | 0% | 0% | 0 | 20.3% | +20.3% |
| TD9 + div + momentum | 0% | 0% | 0 | 20.3% | +20.3% |
| **stack_full_confirm** | 61.4% | 55.9% | **+5.5%** | 68.9% | +7.5% |

Backtest rows with RSI divergence: **228 / 362 (63%)** — parity achieved vs 73% Tier A misses.

## Verdict

1. **Parity closed for RSI divergence** — backtest can now be scored objectively.
2. **Divergence alone is not a win filter** — slightly *anti*-edge on backtest (-6.2% lift). Ubiquitous on both wins and misses.
3. **Runway stack (TD9 + div + momentum) still blocked on backtest** — TD9 event emission from daily stamp needs bootstrap tuning (follow-up); combos show 0% backtest presence despite daily TD state.
4. **stack_full_confirm remains the only combo with positive win lift** (+5.5%). Divergence is contextual (MR stage 4 runway) not an entry gate.
5. **Promotion path**: shadow gate on `stack_full_confirm`; use divergence as *sequence context* (wait for div after exhaustion) not a hard block/allow.

## Commands

```bash
# Full lift with parity enrichment (~15 min)
node scripts/pattern-lift-pass.mjs \
  --run-id backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z \
  --backtest-limit 362 \
  --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
  --pre-entry-hours 120

# Optional: persist derived events to production D1
node scripts/backfill-setup-events.mjs \
  --cohort backtest --wrangler-d1 production --limit 362 \
  --pre-entry-hours 120
```
