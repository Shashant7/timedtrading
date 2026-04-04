# Accounting And Autopsy Normalization Notes

Generated: 2026-04-03

## Why This Needs A Code Change

The Trade Autopsy UI is still preferring inferred `effective_*` prices over stored raw execution prices in the modal header and chart inputs.

That directly conflicts with the benchmark intent:

- raw entry/trim/exit prices must be primary
- inferred/effective values should only be secondary diagnostics
- shares and risk should be exposed as lifecycle facts, not reconstructed mentally

## Files To Patch

### `react-app/trade-autopsy.html`

#### Current problem

- `displayEntry` currently prefers `effective_entry_price` over `entry_price`
- `displayExit` currently prefers `effective_exit_price` over `exit_price`
- chart receives those effective values
- trim is not surfaced as a first-class lifecycle pill beside entry and exit
- shares pill shows coarse derived values, but not explicit lifecycle wording

#### Intended changes

1. Prefer raw prices first:
   - `raw_entry_price -> entry_price -> entryPrice`
   - `raw_exit_price -> exit_price -> exitPrice`
   - `raw_trim_price -> trim_price -> trimPrice`
2. Only fall back to `effective_*` when the raw field is absent.
3. If raw and effective differ, label the secondary one as `inferred`, not `raw`.
4. Add a trim lifecycle pill:
   - trim timestamp
   - trim raw price
   - trim shares
5. Add explicit lifecycle quantities:
   - entry shares
   - trim shares
   - exit shares
   - risk amount
6. Feed the chart raw prices, not effective prices.

### `worker/index.js`

#### Current problem

The autopsy endpoint already derives:

- `effective_entry_price`
- `effective_exit_price`
- `effective_exit_basis`
- `raw_entry_price`
- `raw_exit_price`

But it does not yet expose a fully normalized lifecycle object for the UI to consume directly.

#### Intended changes

For both the live-merge branch and the archive/fallback branch of:

- `GET /timed/admin/trade-autopsy/trades`

extend the derived payload to include:

- `raw_trim_price`
- `lifecycle_entry_price`
- `lifecycle_trim_price`
- `lifecycle_exit_price`
- `lifecycle_entry_shares`
- `lifecycle_trim_shares`
- `lifecycle_exit_shares`
- `lifecycle_runner_shares`
- `lifecycle_risk_amount`
- `lifecycle_realized_pnl`

Suggested derivation rules:

- `entry shares`: `shares`
- `trim shares`: `shares * trimmed_pct`
- `exit shares`: `shares * (1 - trimmed_pct)`
- `risk amount`:
  - if `risk_budget < 1`, use `notional * risk_budget`
  - otherwise treat `risk_budget` as a dollar value
- `realized pnl`:
  - prefer `realizedPnl`
  - then `realized_pnl`
  - then `pnl` as last resort for closed trades

## Validation Cases After Patch

- `ANET`
  - header and chart should show raw entry/trim/exit prices first
- `SLV`
  - realized-PnL presentation should not imply a flat trade when trims realized gains
- `LRN`
  - lifecycle fields should remain internally coherent when reviewing anomalous trade behavior

## Follow-Up Once Code Edits Are Unblocked

1. patch `worker/index.js`
2. patch `react-app/trade-autopsy.html`
3. run lints for the edited files
4. verify the modal against one trimmed winner and one anomalous loser
