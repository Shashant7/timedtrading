# Backtest Refinement Validation Plan

## Goal
Apply the highest-confidence refinements from the deep review, then prove whether they reduce churn, noisy exits, and same-day trade behavior without breaking the edge in `trader-only-no-cio-20250324`.

## Comparison Anchor
- Baseline run label: `trader-only-no-cio-20250324`
- Baseline run id: `backtest_2025-07-01_2026-03-23@2026-03-24T06:23:53.734Z`
- Baseline review memo: `data/backtest-artifacts/trader-only-no-cio-20250324-deep-review.md`

## Primary Refinements
### 1. `1H 72/89` structural-break hardening
- Add debounce to `ripster_72_89_1h_structural_break`
- Require confirmation from at least one stronger context signal before full exit:
  - `30m` weakness
  - `34/50` structural loss
  - repeated failure bar count
- If confirmation is missing, downgrade to `defend` or `trim`

### 2. Same-ticker re-entry reset
- Prevent immediate same-direction re-entry after noisy exits:
  - `doa_early_exit`
  - `SMART_RUNNER_SUPPORT_BREAK_CLOUD`
  - `ripster_34_50_lost_mtf`
  - fast `SOFT_FUSE_RSI_CONFIRMED` outcomes
- Reset options:
  - time cooldown
  - fresh `10m` re-trigger plus stronger `30m` / `1H` improvement
  - explicit structural reset condition

### 3. Anti-chase sponsorship tightening
- Keep `10m` as the timing trigger
- Require stronger `30m` / `1H` sponsorship before taking:
  - momentum continuation entries in mature bull structure
  - weak pullbacks in neutral / counter-trend structure

## Validation Scoreboard
### Headline
- realized pnl
- win rate
- trade count
- average pnl per trade

### Behavior
- same-day trade count
- same-ticker re-entry count within 1 trading day
- same-ticker re-entry expectancy within 1 trading day
- hold-duration mix:
  - same-day
  - 1-3 day
  - 3+ day

### Hold-profile intent
- define the acceptable behavioral target for the Active Trader swing product:
  - what same-day share is acceptable
  - what multi-day share should remain or improve
  - whether same-day trades are high-quality winners or noise-driven churn
- evaluate challenger runs against the baseline not only on headline PnL, but also on whether the hold profile is becoming cleaner and more intentional
- promotion rule: a challenger should not be considered better if it improves headline PnL only by increasing noisy same-day churn

### Exit quality
- count and expectancy for:
  - `ripster_72_89_1h_structural_break`
  - `SMART_RUNNER_SUPPORT_BREAK_CLOUD`
  - `ripster_34_50_lost_mtf`
  - `SOFT_FUSE_RSI_CONFIRMED`
  - `SMART_RUNNER_TD_EXHAUSTION_RUNNER`

### Targeted forensic names
- `FIX`
- `TJX`
- `ULTA`
- `MNST`
- `CELH`
- `APP`

## Execution Order
1. Freeze the baseline scoreboard for `trader-only-no-cio-20250324`
2. Implement `1H 72/89` exit hardening
3. Implement same-ticker re-entry reset / cooldown
4. Implement anti-chase sponsorship tightening using `30m` / `1H`
5. Run focused replay probes on the named forensic tickers
6. Run the next trader-only validation lane
7. Compare against the baseline scoreboard and decide whether to promote, iterate, or widen testing

## Success Criteria
- headline PnL remains competitive with the baseline
- same-day trade count declines materially
- same-ticker 1-day re-entry count declines materially
- `FIX`-style false structural-break exits disappear or become defend/trim cases
- `TJX`-style same-oscillation re-entry sequences become less frequent
- runner-quality exits remain healthy
- hold-profile quality is equal or better:
  - fewer noise-driven same-day round trips
  - healthy multi-day hold participation remains intact
  - any same-day concentration that remains has defensible expectancy

## Explicit Deferrals
- do not switch the primary trigger engine to `30m` yet
- do not retune broad SL/TP calibration globally yet
- do not reopen blacklist generation yet
- do not add investor-lane changes until the trader-only behavior improves cleanly

## Additional Areas To Watch
- `SL/TP fit audit`: treat as a diagnostic follow-up if exit hardening and anti-chase changes still leave too much drag
- short-side quality: the run had very little useful short participation, so either quality-gate shorts harder or leave this for a separate lane
- hold-profile quality: if the run stays highly profitable but still heavily same-day, decide explicitly whether that is acceptable behavior or drift from product intent
