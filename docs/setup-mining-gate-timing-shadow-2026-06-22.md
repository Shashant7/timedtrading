# Gate simulation + timing + shadow stamp (2026-06-22)

Follow-up to TD9 daily transition fix and expanded gate sim.

Artifacts:
- Gate sim + timing: `data/setup-mining/gate-simulation/gate-sim-2026-06-22T14-59-22.{json,md}`
- Prior (no timing): `gate-sim-2026-06-22T02-59-35.{json,md}`

Lookback: 120h | Tier A: move_atr >= 8 | Timing source: preprod `setup_events`

## Gate comparison (unchanged from prior run)

| Gate | Tier A enter % | BT WIN enter % | Win share if entered | Capture opp |
|---|---:|---:|---:|---:|
| stack_full_confirm | 68.0% | 61.4% | 59.9% | +6.6% |
| gate_confirm+div | 54.7% | 39.1% | 58.7% | +15.6% |
| **gate_runway_full** | 17.3% | 3.4% | **70.0%** | +13.9% |
| stack_td9+div+momentum | 20.0% | 7.7% | 53.3% | +12.3% |

Baseline backtest WR: **57.7%**

## Tier A timing comparison (new)

Lead time from first gate fire to move anchor on Tier A missed cohort (preprod events):

| Gate | Tier A fires | Avg h before anchor | Median h before anchor |
|---|---:|---:|---:|
| stack_full_confirm | 51 | 78.8h | **94.0h** |
| **gate_runway_full** | 13 | 57.3h | **48.9h** |

**Read:** `gate_runway_full` fires on a **shorter runway** (~2 days median vs ~4 days for confirm alone) while maintaining higher win share when it fires. The TD9 + divergence requirement selects moves where exhaustion/confirm stack completes closer to the anchor — consistent with MR runway stage 4–5 timing from divergence analysis.

## Shadow stamp (shipped)

`SETUP_GATE_SHADOW=1` on **preprod** + **tt-engine** (not monolith production).

Payload fields (read-only, no entry gate):
- `setup_gates.stack_full_confirm.fires`
- `setup_gates.gate_runway_full.fires`
- `setup_gate_lookback_hours` (120)
- `setup_gate_as_of_ts`

Module: `worker/foundation/setup-gate-shadow.js` — merged into `loadSetupShadowFields()` when gate shadow enabled.

## Verdict

1. **Proceed with forward shadow** on tt-engine — gate fields on every scored payload for admin/Today diagnostics.
2. **Do not live-size** on `gate_runway_full` until n>30 forward observations confirm 70% win share.
3. **Timing pass supports runway thesis** — runway gate fires ~45h earlier (median) than confirm-only on Tier A misses.

## Commands

```bash
# Gate sim with side-by-side timing
node scripts/simulate-confirm-stack-gate.mjs \
  --with-timing \
  --timing-gates stack_full_confirm,gate_runway_full \
  --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
  --backtest-cache data/setup-mining/pattern-lift/backtest-enriched.json \
  --pre-entry-hours 120

# Deploy gate shadow (after merge)
# preprod: SETUP_GATE_SHADOW=1 in wrangler preprod vars
# tt-engine: SETUP_GATE_SHADOW=1 in worker-engine/wrangler.toml
```
