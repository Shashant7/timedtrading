# Short Parity Diagnostic

Generated: 2026-04-03

## Evidence Snapshot

- Golden Jul/Aug evidence: `24` LONG, `0` SHORT
- Safety-net candidate evidence: `33` LONG, `0` SHORT

## What This Means

1. The lack of shorts in the Jul/Aug golden window is not automatically a regression.
   - The golden anchor itself is all-long for that window.
   - We should not force shorts into a window where the benchmark did not require them.

2. The real risk is structural suppression outside the golden window.
   - The current codebase still has dedicated short entry paths:
     - `ema_regime_confirmed_short`
     - `ema_regime_early_short`
     - `gold_short`
     - `gold_short_pullback`
     - `pullback_short`
     - `momentum_score_short`
   - So shorts are not absent because the engine literally cannot form them.

3. The current stack does contain materially asymmetric short blockers.
   - `ctx_short_rank_low`
   - `ctx_short_daily_st_not_bear`
   - `ctx_short_4h_ema_shallow`
   - `shorts_blocked_in_chop`
   - `short_rvol_too_low`
   - `neutral_short_blocked`
   - `spy_bullish_short_blocked`
   - `tt_pdz_short_in_discount`
   - `da_htf_too_high_for_short`
   - `da_ltf_momentum_against_short`
   - `da_ltf_rsi_too_high_for_short`
   - `da_rvol_ceiling_short`

## Diagnosis

- Short capability exists in the entry engine.
- Short opportunity may still be structurally underfired because the global gating stack is stricter for SHORT than LONG.
- Jul/Aug parity does not justify loosening those gates blindly, because the benchmark window itself contains no short trades.

## Recovery Rule

Treat short parity as a separate checkpoint from Jul/Aug basket parity:

- Acceptable:
  - the golden Jul/Aug rerun remains all-long if the frozen market context still offers no valid shorts
- Not acceptable:
  - future windows with obvious bearish conditions still produce zero short candidates because the gate stack suppresses them before path selection

## Next Validation Step

The next non-Jul/Aug validation lane should explicitly record short-side blocker counts and candidate paths so we can distinguish:

- no bearish opportunities existed
- bearish opportunities existed but were rejected by short-only gates
- bearish opportunities existed and were routed into short paths successfully
