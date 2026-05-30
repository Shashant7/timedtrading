# CSX Forensic Iteration-1 (2026-03-22)

## Objective

Establish a data-backed parity loop before launching a long backtest, using the reference trade:

- `CSX-1751377500000-0bkrj96aq`
- Entry: `2025-07-01 09:45 ET`
- Exit: `2025-07-18 09:30 ET`
- Path: `ripster_momentum`
- Exit: `TP_FULL`
- PnL: `+374.49` (`+4.6811%`)

## Evidence Base

- Reference artifact: `data/backtest-artifacts/option-a-rank-overhaul--20260309-202532/trade-autopsy-trades.json`
- Cross-run overlap report: `data/ticker-window-forensics-latest.json`
- CSX Jul 1 week aggregation (all artifact trades, deduped by `source+trade_id`)

## Forensic Findings

### 1) CSX has strong edge, but path/management choice changes lifecycle

Within the CSX overlap window (`ref entry -> ref exit`), deduped:

- `ripster_momentum`: `n=59`, `WR=81.4%`, `avg_pnl=149.48`, `TP_FULL=16`
- `ema_regime_confirmed_long`: `n=29`, `WR=58.6%`, `avg_pnl=50.17`, `TP_FULL=0`

Interpretation:
- The reference behavior is consistent with a momentum-led lifecycle.
- EMA-confirmed path in this window tends to resolve as shorter/management exits rather than full trend completion.

### 2) Current parity lane still routes CSX to EMA path too early

Interval replay (Jul 1, interval 0, `ENTRY_ENGINE=legacy`, `MANAGEMENT_ENGINE=legacy`) shows:

- Trade created immediately
- `entryPath = ema_regime_confirmed_long`

This diverges from the reference contract (`ripster_momentum`).

### 3) Forcing ripster_core directly currently blocks CSX at open

Interval replay probe (`ENTRY_ENGINE=ripster_core`) for first intervals shows:

- No trade created
- Block reason: `ripster_bias_not_aligned`

So the current ripster_core gate is stricter than what the reference trade implies for that timestamp.

## Iteration-1 Change Applied

Code change (feature-flagged):

- `worker/pipeline/legacy-entry.js`
  - Added optional precedence switch:
  - `deep_audit_legacy_momentum_precedence=true`
  - When enabled, legacy momentum path is checked before EMA regime paths.

Config hydration:

- Added `deep_audit_legacy_momentum_precedence` to deep-audit key loading lists in `worker/index.js` (all replay/live load paths).

Model config applied:

- `deep_audit_confirmed_min_rank=65`
- `deep_audit_parity_defer_confirmed_opening_minutes=0`
- `deep_audit_legacy_momentum_precedence=true`

## Iteration-1 Result (Pass/Fail)

- **FAIL for CSX parity** (entry path criterion)
- CSX still entered at interval 0 as `ema_regime_confirmed_long`.

Implication:
- Momentum precedence alone was insufficient.
- Additional diagnostics were needed at entry-time feature level.

## Iteration-2 (Entry Forensics + Surgical Fix)

### Added diagnostics

- `/timed/admin/interval-replay` now returns `entryDiagnostics` per ticker (reason/path/engine + metadata), allowing direct forensic inspection of path selection.
- Legacy entry metadata instrumentation added for momentum-precedence decisions.

### Evidence discovered (CSX @ 2025-07-01 09:45 ET bar)

- `state=HTF_BULL_LTF_BULL`
- `score=71`
- `rr=1.678`
- `hasStFlipBull=false`, `hasEmaCrossBull=false`, `hasSqRelease=false`

So momentum precedence did not fire because:
- strict `rr >= 2.0` threshold
- strict trigger requirement unmet

### Surgical config-gated fix

Added two legacy forensic controls:

- `deep_audit_legacy_momentum_min_rr` (default `2.0`)
- `deep_audit_legacy_momentum_relax_trigger` (default `false`)

Applied parity-lane settings:

- `deep_audit_legacy_momentum_precedence=true`
- `deep_audit_legacy_momentum_min_rr=1.6`
- `deep_audit_legacy_momentum_relax_trigger=true`

### Iteration-2 result

- **PASS for CSX entry-path parity** (entry gate)
- Interval replay now reports:
  - `path=momentum_score` (mapped to TT Momentum)
  - `reason=momentum_with_signal_precedence`

## Current status gate (before full backtest)

Entry-path parity for CSX is now aligned. Remaining parity gates:

1. **Hold lifecycle parity**: avoid intraday premature exits for CSX-like winners.
2. **Exit-class parity**: target `TP_FULL`/runner-completion behavior in the reference window.
3. **Cross-ticker safety**: validate no major regression on `CDNS/ORCL/ITT` in same Jul1 cohort.

Only after these gates pass should we run a clean full backtest.
