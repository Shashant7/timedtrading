# Gate simulation — expanded runway gates (2026-06-22)

After TD9 daily transition fix + divergence parity enrichment.

Artifact: `data/setup-mining/gate-simulation/gate-sim-2026-06-22T02-59-35.{json,md}`

Lookback: 120h | Tier A: move_atr >= 8

## Gate comparison (shadow — would entry have been allowed?)

| Gate | Tier A enter % | BT WIN enter % | Win share if entered | Capture opp |
|---|---:|---:|---:|---:|
| stack_full_confirm | 68.0% | 61.4% | **59.9%** | +6.6% |
| gate_confirm+div (confirm + RSI div) | 54.7% | 39.1% | 58.7% | +15.6% |
| **gate_runway_full (TD9 + div + confirm)** | 17.3% | 3.4% | **70.0%** | +13.9% |
| stack_td9+div+momentum | 20.0% | 7.7% | 53.3% | +12.3% |
| stack_exhaust+rsi_div | 32.0% | 11.6% | 51.1% | +20.4% |

Baseline backtest win rate: **57.7%**

## Lift pass (362 backtest + 211 missed)

Artifact: `data/setup-mining/pattern-lift/lift-2026-06-22T02-43-11.json`

- TD9 in backtest window: **45 / 362 (12%)** — daily transition parity fixed
- RSI divergence: **228 / 362 (63%)**
- stack_td9+div+momentum win lift: measurable (7.7% WIN vs 9.2% LOSS on backtest)

## Verdict

1. **gate_runway_full** (TD9 + RSI div + stack_full_confirm) shows **70% win share** when it fires (n=10 backtest entries) vs 57.7% baseline — promising but **tiny sample** (7 WIN / 3 LOSS entries).
2. **stack_full_confirm alone** remains the highest-volume gate with modest win share edge (59.9%) and lowest capture opp (+6.6%).
3. Adding divergence to confirm stack (`gate_confirm+div`) raises capture opp (+15.6%) but **lowers** win share vs confirm alone — divergence is not a quality filter on backtest.
4. **Promotion**: shadow-stamp `gate_runway_full` on preprod alongside `stack_full_confirm`; do not live-size until forward shadow pass confirms 70% win share holds with n>30.

See also: `docs/setup-mining-gate-timing-shadow-2026-06-22.md` (timing pass + SETUP_GATE_SHADOW).

## Commands

```bash
node scripts/pattern-lift-pass.mjs \
  --run-id backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z \
  --backtest-limit 362 \
  --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
  --pre-entry-hours 120

node scripts/simulate-confirm-stack-gate.mjs \
  --build-backtest --rebuild-backtest \
  --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
  --backtest-cache data/setup-mining/pattern-lift/backtest-enriched.json \
  --pre-entry-hours 120
```
