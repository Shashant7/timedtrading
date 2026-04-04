# Trade Diagnostic Report

Generated: 2026-04-03T13:16:51.886Z

## Scope

- Golden anchor: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
- Candidate full run: `backtest_2025-07-01_2026-03-31@2026-03-31T21:26:48.269Z`
- Golden trade count: 24
- Candidate trade count: 218

## Golden Window Parity

- Basket parity: 100.00%
- Entry timing parity: 100.00%
- Lifecycle parity: 91.67%
- Stable overlap trades: 22
- Drifted overlap trades: 2
- Missing golden trades: 0
- Spurious Jul/Aug trades: 13

## Highest-Confidence Drift Trades

- GRNY: golden `replay_end_close` vs candidate `SMART_RUNNER_SUPPORT_BREAK_CLOUD`; giveback=1.677 pct-points; recommendation=winner_gave_back_too_much
- GDX: golden `replay_end_close` vs candidate `ST_FLIP_4H_CLOSE`; giveback=4.9557 pct-points; recommendation=winner_gave_back_too_much

## Missing Golden Trades

- None.

## Spurious Jul/Aug Trades

- ASTS: candidate exit `PROFIT_GIVEBACK`; nearest golden=none; recommendation=entry_should_be_blocked
- ORCL: candidate exit `HARD_LOSS_CAP`; nearest golden=none; recommendation=entry_should_be_blocked
- CDNS: candidate exit `HARD_LOSS_CAP`; nearest golden=none; recommendation=entry_should_be_blocked
- ORCL: candidate exit `PROFIT_GIVEBACK`; nearest golden=none; recommendation=entry_should_be_blocked
- CDNS: candidate exit `HARD_LOSS_CAP`; nearest golden=none; recommendation=entry_should_be_blocked
- ITT: candidate exit `TP_FULL`; nearest golden=none; recommendation=entry_should_be_blocked
- ITT: candidate exit `TP_FULL`; nearest golden=none; recommendation=entry_should_be_blocked
- CSX: candidate exit `deferred_exit_st15_flip`; nearest golden=none; recommendation=entry_should_be_blocked
- CSX: candidate exit `deferred_exit_st15_flip`; nearest golden=none; recommendation=entry_should_be_blocked
- ITT: candidate exit `replay_end_close`; nearest golden=none; recommendation=entry_should_be_blocked
- ITT: candidate exit `replay_end_close`; nearest golden=none; recommendation=entry_should_be_blocked
- CDNS: candidate exit `replay_end_close`; nearest golden=none; recommendation=entry_should_be_blocked
- CDNS: candidate exit `replay_end_close`; nearest golden=none; recommendation=entry_should_be_blocked

## Post-Window Losses

- TT 2026-02-17: exit `replay_end_close`, pnl_pct=-10.23084178114327, mfe=0, mae=0, recommendation=track_but_no_change
- UNP 2026-02-18: exit `replay_end_close`, pnl_pct=-9.785975564772572, mfe=0, mae=0, recommendation=track_but_no_change
- MNST 2026-02-06: exit `replay_end_close`, pnl_pct=-9.603936338233506, mfe=0, mae=0, recommendation=track_but_no_change
- XLV 2026-02-18: exit `replay_end_close`, pnl_pct=-7.547468855992647, mfe=0, mae=0, recommendation=track_but_no_change
- AWI 2026-01-14: exit `HARD_LOSS_CAP`, pnl_pct=-7.403962338270234, mfe=0, mae=-8.1435, recommendation=entry_should_be_blocked_or_pretrimmed
- AGQ 2025-11-03: exit `max_loss`, pnl_pct=-6.0256167581550955, mfe=0, mae=-6.0256, recommendation=entry_should_be_blocked_or_pretrimmed
- APP 2025-08-18: exit `HARD_LOSS_CAP`, pnl_pct=-5.753870195201515, mfe=0.3875, mae=-5.7539, recommendation=entry_should_be_blocked_or_pretrimmed
- AA 2026-02-11: exit `HARD_LOSS_CAP`, pnl_pct=-5.513092710544944, mfe=0, mae=-6.1257, recommendation=entry_should_be_blocked_or_pretrimmed
- CW 2026-03-04: exit `HARD_LOSS_CAP`, pnl_pct=-4.81278643512749, mfe=0, mae=0, recommendation=entry_should_be_blocked_or_pretrimmed
- ISRG 2026-01-09: exit `HARD_LOSS_CAP`, pnl_pct=-4.757993850497797, mfe=0.0425, mae=-5.2863, recommendation=entry_should_be_blocked_or_pretrimmed

## Candidate Exit Families

- deferred_exit_st15_flip: n=44, pnl=12980.60
- ripster_34_50_lost_mtf: n=32, pnl=-3658.24
- SMART_RUNNER_TD_EXHAUSTION_RUNNER: n=23, pnl=3062.12
- deferred_exit_sl_breached: n=11, pnl=1964.98
- SMART_RUNNER_SUPPORT_BREAK_CLOUD: n=20, pnl=-1423.87
- PRE_EARNINGS_RUNNER_CLOSE: n=5, pnl=1249.46
- PROFIT_GIVEBACK: n=25, pnl=-773.07
- HARD_LOSS_CAP: n=16, pnl=-14023.13
- TP_FULL: n=2, pnl=813.31
- replay_end_close: n=12, pnl=-6659.89
- ST_FLIP_4H_CLOSE: n=3, pnl=1075.83
- max_loss: n=6, pnl=-2112.02

## Refinement Readout

- The golden Jul/Aug basket is still historically reproducible, so the main regressions are validity and harness drift first.
- Event-risk seeding must be present before replay or earnings-sensitive names will not get pre-event protection.
- Autopsy needs to stay clearly scoped to live replay KV or archived run data so July trades are observable and wall-clock contamination stays out.
- The next rerun should stay pinned to the frozen recovered config rather than merging live model state.
