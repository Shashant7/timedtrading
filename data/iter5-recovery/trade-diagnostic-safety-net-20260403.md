# Trade Diagnostic Report

Generated: 2026-04-03T15:05:17.600Z

## Scope

- Golden anchor: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
- Candidate full run: `backtest_2025-07-01_2026-04-02@2026-04-03T13:50:12.590Z`
- Golden trade count: 24
- Candidate trade count: 33

## Golden Window Parity

- Basket parity: 33.33%
- Entry timing parity: 4.17%
- Lifecycle parity: 0.00%
- Stable overlap trades: 0
- Drifted overlap trades: 8
- Missing golden trades: 16
- Spurious Jul/Aug trades: 13

## Highest-Confidence Drift Trades

- FIX: golden `deferred_exit_st15_flip` vs candidate `BREAKEVEN_STOP`; giveback=1.3029 pct-points; recommendation=cut_loser_after_positive_excursion
- GRNY: golden `SMART_RUNNER_TD_EXHAUSTION_RUNNER` vs candidate `null`; giveback=-1.3708 pct-points; recommendation=entry_path_mismatch
- XLY: golden `SMART_RUNNER_SUPPORT_BREAK_CLOUD` vs candidate `SMART_RUNNER_SUPPORT_BREAK_CLOUD`; giveback=0.5513 pct-points; recommendation=track_but_no_change
- AU: golden `SMART_RUNNER_TD_EXHAUSTION_RUNNER` vs candidate `null`; giveback=-0.5775 pct-points; recommendation=entry_path_mismatch
- PH: golden `deferred_exit_st15_flip` vs candidate `sl_breached`; giveback=1.5159 pct-points; recommendation=entry_should_be_blocked_or_pretrimmed
- KWEB: golden `deferred_exit_st15_flip` vs candidate `null`; giveback=-6.1607 pct-points; recommendation=winner_extension_missing
- AYI: golden `SMART_RUNNER_TD_EXHAUSTION_RUNNER` vs candidate `below_trigger,trigger_breached_5pct,large_adverse_move`; giveback=0.1668 pct-points; recommendation=track_but_no_change
- DY: golden `deferred_exit_sl_breached` vs candidate `SMART_RUNNER_TD_EXHAUSTION_RUNNER`; giveback=0.2128 pct-points; recommendation=track_but_no_change

## Missing Golden Trades

- MTZ: restore missing trade path; nearest key=MTZ|LONG|1752068400000
- RIOT: restore missing trade path; nearest key=RIOT|LONG|1752077700000
- IESC: restore missing trade path; nearest key=IESC|LONG|1752162000000
- ON: restore missing trade path; nearest key=ON|LONG|1752516600000
- ETN: restore missing trade path; nearest key=ETN|LONG|1752692400000
- AGQ: restore missing trade path; nearest key=AGQ|LONG|1752762600000
- PANW: restore missing trade path; nearest key=PANW|LONG|1753363800000
- GDX: restore missing trade path; nearest key=GDX|LONG|1753373700000
- PH: restore missing trade path; nearest key=PH|LONG|1753380600000
- SWK: restore missing trade path; nearest key=SWK|LONG|1753461000000
- B: restore missing trade path; nearest key=B|LONG|1753810800000
- IREN: restore missing trade path; nearest key=IREN|LONG|1753897200000
- GRNY: restore missing trade path; nearest key=GRNY|LONG|1753898400000
- GDX: restore missing trade path; nearest key=GDX|LONG|1754060400000
- PLTR: restore missing trade path; nearest key=PLTR|LONG|1754063400000
- WDC: restore missing trade path; nearest key=WDC|LONG|1754660400000

## Spurious Jul/Aug Trades

- ULTA: candidate exit `SMART_RUNNER_TD_EXHAUSTION_RUNNER`; nearest golden=none; recommendation=entry_should_be_blocked
- BK: candidate exit `SMART_RUNNER_TD_EXHAUSTION_RUNNER`; nearest golden=none; recommendation=entry_should_be_blocked
- CDNS: candidate exit `hard_max_hold_168h`; nearest golden=none; recommendation=entry_should_be_blocked
- STRL: candidate exit `SMART_RUNNER_TD_EXHAUSTION_RUNNER`; nearest golden=none; recommendation=entry_should_be_blocked
- SLV: candidate exit `SOFT_FUSE_RSI_CONFIRMED`; nearest golden=none; recommendation=entry_should_be_blocked
- CLS: candidate exit `null`; nearest golden=none; recommendation=entry_should_be_blocked
- ORCL: candidate exit `null`; nearest golden=none; recommendation=entry_should_be_blocked
- FN: candidate exit `SMART_RUNNER_TD_EXHAUSTION_RUNNER`; nearest golden=none; recommendation=entry_should_be_blocked
- H: candidate exit `sl_breached`; nearest golden=none; recommendation=entry_should_be_blocked
- TWLO: candidate exit `null`; nearest golden=none; recommendation=entry_should_be_blocked
- AMGN: candidate exit `sl_breached`; nearest golden=none; recommendation=entry_should_be_blocked
- FN: candidate exit `SOFT_FUSE_RSI_CONFIRMED`; nearest golden=none; recommendation=entry_should_be_blocked
- GEV: candidate exit `null`; nearest golden=none; recommendation=entry_should_be_blocked

## Post-Window Losses

- None.

## Candidate Exit Families

- SOFT_FUSE_RSI_CONFIRMED: n=4, pnl=277.49
- SMART_RUNNER_TD_EXHAUSTION_RUNNER: n=12, pnl=1566.73
- PHASE_LEAVE_100: n=2, pnl=334.79
- STALL_FORCE_CLOSE: n=1, pnl=44.54
- below_trigger,trigger_breached_5pct,large_adverse_move: n=1, pnl=13.73
- hard_max_hold_168h: n=1, pnl=-70.35
- unknown: n=7, pnl=0.00
- sl_breached: n=3, pnl=-283.72
- BREAKEVEN_STOP: n=1, pnl=-15.43
- SMART_RUNNER_SUPPORT_BREAK_CLOUD: n=1, pnl=12.23

## Refinement Readout

- The golden Jul/Aug basket is still historically reproducible, so the main regressions are validity and harness drift first.
- Event-risk seeding must be present before replay or earnings-sensitive names will not get pre-event protection.
- Autopsy needs to stay clearly scoped to live replay KV or archived run data so July trades are observable and wall-clock contamination stays out.
- The next rerun should stay pinned to the frozen recovered config rather than merging live model state.
