# RIOT Drift Audit - 2026-04-12 - AGQ Challenger

## Purpose

Classify the `RIOT` drift seen when comparing:

- frozen cumulative savepoint:
  `data/backtest-artifacts/focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805`
- AGQ-exception challenger:
  `data/backtest-artifacts/focused-julsep-mainline-agq-exception-v2-20260412--20260411-225718`

This audit is only about whether the `RIOT` differences are a promotion blocker for the narrow `AGQ` exception.

## Headline Result

Classification:

- `acceptable challenger drift`
- `not clean enough to call zero-drift promotion`

Reason:

- one `RIOT` difference is the same early-July timestamp substitution already known from prior deterministic parity work
- the larger September PnL giveback is not a semantic entry/exit mutation; it is the same trade id with the same prices, timestamps, status, and move percentage, which points to downstream sizing/path drift rather than a new `RIOT` rule regression

## Finding 1 - Early July substitution is not new

Frozen savepoint contains:

- `RIOT-1751900400000`
  - entry `2025-07-07 14:20 UTC`
  - `WIN`
  - `+985.53`

Challenger contains:

- `RIOT-1751902200000`
  - entry `2025-07-07 14:50 UTC`
  - `WIN`
  - `+857.63`

Interpretation:

- this is a nearby same-day branch substitution, not a collapse of the `RIOT` thesis
- the project record already documented this exact family as the remaining trade-id mismatch in the earlier deterministic parity lane, so it should not be attributed uniquely to the `AGQ` exception challenger

## Finding 2 - September drift is sizing/path drift, not semantic lifecycle drift

Both runs contain the exact same trade id:

- `RIOT-1757003400000`

Shared fields across both runs:

- status: `WIN`
- exit reason: `HARD_FUSE_RSI_EXTREME`
- entry ts: `1757003400000`
- trim ts: `1757342400000`
- exit ts: `1757511000000`
- entry price: `13.335`
- trim price: `13.44`
- exit price: `15.995`
- pnl pct: `10.454818147731523`
- effective move pct: `10.454818147731531`

Changed field:

- frozen savepoint PnL: `+586.23`
- challenger PnL: `+294.98`
- delta: `-291.25`

Interpretation:

- the behavior of the trade is unchanged
- the realized dollars changed while the trade identity and percentage move stayed fixed
- that strongly suggests a downstream account/sizing/path effect rather than a new `RIOT` entry or lifecycle bug

## What This Means For Promotion

This drift is not strong evidence that the `AGQ` exception itself broke `RIOT` decision logic.

It is, however, enough drift to keep the challenger from replacing the frozen savepoint without an explicit policy decision.

Use this rule:

- if the bar for promotion is "August recovered with no meaningful unrelated drift," do not promote yet
- if the bar is "narrow candidate materially improves the pressure month and unrelated drift is explainable/non-semantic," keep this as the active challenger

## Recommended Follow-Up

If we want to push this challenger toward promotion, the next focused check should be on the sizing/capital path around the September `RIOT-1757003400000` entry rather than on `RIOT` entry logic itself.
