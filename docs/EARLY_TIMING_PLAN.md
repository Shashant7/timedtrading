# Early Timing Plan: 1m / 3m / 5m / 10m Triggers

**Goal:** Time big intraday moves early (e.g. AAPL 262→270 at 9:31 vs close) by factoring in LTF triggers: EMA crosses, squeeze release, and ST flip on 1m, 3m, 5m, and 10m timeframes.

## Why LTF Triggers

- **30m/1H** already drive Enter Now (squeeze release, EMA cross, corridor). They often fire after the move has started.
- **10m, 5m, 3m, 1m** fire earlier in the same move; stacking them with corridor + thesis can increase confidence and rank without waiting for 30m confirmation.
- We stay “corridor + trigger” but allow **LTF trigger contributions** to score and rank so early-but-valid setups surface in Enter Now.

## Trigger Naming (Worker + TV)

Same pattern as existing 30m/1H:

| Type        | Pattern (BULL/BEAR or LONG/SHORT where applicable) |
|------------|------------------------------------------------------|
| Squeeze    | `SQUEEZE_RELEASE_10M`, `_5M`, `_3M`, `_1M`           |
| EMA cross  | `EMA_CROSS_10M_13_48_BULL` / `_BEAR`, same for 5M, 3M, 1M |
| ST flip    | `ST_FLIP_10M`, `ST_FLIP_5M`, `ST_FLIP_3M`, `ST_FLIP_1M`   |

Existing `trigger_reason` acceptance already uses `includes("EMA_CROSS")` and `includes("SQUEEZE_RELEASE")`, so reasons like `EMA_CROSS_10M_13_48` or `SQUEEZE_RELEASE_10M` are accepted for entry logic.

## Worker: Score LTF Triggers (Done First)

- In `triggerSummaryAndScore()`, add score contributions when **triggers[]** (or flags) contain LTF trigger names.
- Weights (LTF lower than 30m/1H so they refine timing, not override):
  - **Squeeze:** 10m +3, 5m +2, 3m +1, 1m +1
  - **EMA cross (match side):** 10m +2, 5m +1, 3m +1, 1m +0.5
  - **ST flip:** 10m/5m/3m/1m +0.5 each
- Fallback **flags** (when `triggers[]` empty): e.g. `sq10_release`, `ema_cross_10m_13_48`, `st_flip_10m`, etc., with same relative weights.
- Cap remains `Math.max(-6, Math.min(18, score))` so LTF adds on top of existing 30m/1H.

## TradingView: Send LTF Triggers (Follow-up)

- **Enhanced** script currently sends only 30m and 1H in `triggers[]` and in flags. It already has **10m** in `tf_tech` (comp10, sq10, sqRel10, etc.).
- **Phase 1 (10m):** Add 10m squeeze release, 10m EMA 13/48 cross, 10m ST flip to `triggers[]` and to `flags` (e.g. `sq10_release`, `ema_cross_10m_13_48`, `st_flip_10m`). No new request.security if 10m is already the chart TF or already requested for tf_tech.
- **Phase 2 (5m, 3m, 1m):** If we add 5m/3m/1m to the script (e.g. request.security or companion), use the same naming and send in `triggers[]` / flags; worker will score them as above.

## Enter Now / Rank

- No change to **entry rules**: still corridor + (thesis/momentum/trigger) + score/rank/RR/completion gates.
- LTF triggers **increase trigger score** → higher composite rank → more likely to hit Enter Now and appear earlier in the list when a move is starting.

## Status

- [x] Doc: early timing plan (1m/3m/5m/10m)
- [x] Worker: score 1m/3m/5m/10m EMA, squeeze, ST flip in `triggerSummaryAndScore` (and flags fallback)
- [x] TV Enhanced: add 10m and 3m triggers to `triggers[]` and flags (5m/1m omitted — TradingView `request.*` limit 40)
