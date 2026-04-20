# Phase F — Short-side activation & cohort rules

**Date**: 2026-04-20
**Trigger**: 10-month v5 rerun showed **0 SHORT trades** across Jul 2025 – Apr 2026 despite Mar 2026 being a structurally-perfect short month (SPY −8 %, broke D200 on Mar 6, bear-stacked by Mar 26).

## Evidence from Mar 2026 v5 block-chain (41,712 blocked bars, 9,887 short-related)

| Blocking reason | Fires | Why it's wrong for shorts |
|---|---:|---|
| `tt_d_ema_short_overextended` | **4,194** | Rejects shorts when price > 7 % BELOW D48. That's the PAYZONE for shorts, not the rejection zone. |
| `tt_short_pullback_not_deep_enough` | 2,552 | Requires 2 of 3 LTF ST bullish (so the short enters on a bounce). Even my Phase-E.2 relaxation to 1-of-3 when SPY bearish wasn't enough — smooth down-moves leave LTFs lagging. |
| `ctx_short_daily_st_not_bear` | 2,031 | Ticker's own daily ST hasn't flipped yet. TSLA Mar 10: bear-stack=True, below D200, D48 slope −1.41 %, price −3.4 % below D48 — still blocked because ticker daily ST flag was still 0. |
| `tt_d_ema_short_flat_structure` | 855 | Mirror of long flat-structure gate. Flat-DOWN D48 slope is actually fine for shorts building up a bear trend. |

**32 near-fire short bars** (score ≥ 85 at setup/in_review stage) were blocked in March alone. Top candidates:
- SWK: 10 bars blocked by `tt_d_ema_short_overextended`
- RIOT, TSLA, ON: 20 bars blocked by `ctx_short_daily_st_not_bear`

## Fix design (3 targeted changes)

### F8 — Invert `tt_d_ema_short_overextended` semantics

Current rule rejects shorts when `pct_above_e48 < −7 %` (i.e. more than 7 % below D48). That's backwards.

New rule: reject shorts only when they're chasing a **too-deep capitulation bounce** — when price is `< −15 %` below D48 **AND** D21 slope is already turning up (5-day > +0.5 %). That's the "covering short too late" signature.

Also invert the flat-structure rule: reject shorts when D48 slope is **rising** (> +0.25 %), which means the structural trend is still bullish.

```
deep_audit_d_ema_short_max_below_e48_pct:    7   → 15  (reject at capitulation)
deep_audit_d_ema_short_max_e48_slope_pct:    -0.25 → +0.25 (reject when D48 rising)
```

### F9 — SPY-regime-aware `tt_d_ema_short_flat_structure` bypass

When SPY is bear-stacked (my existing `spyDailyStructure`), a declining/flat ticker D48 is consistent with sector rotation and is NOT a fakeout signal for shorts — it's confirmation the structure is rolling over. Add a bypass:

```
if (spyBearish && side === "SHORT") skip tt_d_ema_short_flat_structure
```

### F10 — Ticker-level `ctx_short_daily_st_not_bear` — accept daily-structure bear as substitute

Currently requires `stDirD === -1`. TSLA Mar 10 had stDirD=0 but bear_stack=True + below D200 + D48 slope −1.41 % — clearly bearish structurally. Accept either signal:

```js
const dailyBearish = (stDirD === -1) ||
  (dailyStructure.bear_stack === true && dailyStructure.above_e200 === false);
```

### F11 — SHORT cohort overlay (mirror of Phase-E.3 LONG rules)

Per the Phase-E.3 pattern-mining model, add SHORT-side cohort thresholds:

| Cohort | slope_max (decline req) | extension_min | RSI_min (for shorts) |
|---|---:|---:|---:|
| Index ETF (SPY/QQQ/IWM) | −0.5 % (steeper decline) | −1 % | 25 |
| Mega-Cap Tech | −0.3 % | −1 % | 30 (oversold is GREEN for shorts) |
| Industrial | −0.7 % | −1 % | 30 |
| Speculative | −0.3 % | −1 % | 25 |

For shorts:
- "slope_max (more negative) → stronger decline confirmation"
- "extension_min → require price at least 1 % below D48 to avoid shorting pullbacks"
- "RSI_min → don't short into oversold < 25; those bounce"

Implemented as the SHORT branch of the existing cohort-overlay block in `tt-core-entry.js`.

### F12 — Relax `tt_short_pullback_not_deep_enough` further when SPY bear-stacked

Phase-E.2 already relaxes to `1-of-3` when SPY is bearish. For Phase-F, allow entry with **0-of-3** LTF ST flips when:
- SPY is bear-stacked (not just below-D48)
- Ticker itself is bear-stacked on the daily
- Reclaim trigger fired (clean re-engagement of shorts from a bounce)

This captures "clean bounce-shortable" setups where LTFs have already flipped bullish during the bounce but the daily structure is clearly bear.

## Expected impact (from Mar 2026 v5 block-chain)

**If F8 alone fires correctly**: 4,194 short-overextended blocks disappear. Some fraction (~10-20 %, based on v4 LONG conversion rate) become trades.
**If F10 fires correctly**: ~2,000 ctx-short blocks unblocked → TSLA/RIOT/ON candidate shorts become viable.
**If F11+F12 fire correctly**: Mar 2026 likely produces 3-8 SHORT trades (vs 0 currently).

Target metrics for v6 vs v5:
- ≥ 1 SHORT trade in Feb 2026 AND Mar 2026
- v6 Mar 2026 PnL: target > 0 % (vs v5 0 trades = 0 %, vs v2 −3.95 %)
- v6 Apr 2026 PnL: target ≥ 0 % (mostly still bearish regime)
- Overall training PnL: preserve or exceed v5 +226.91 %

## Non-goals for Phase-F

- Do NOT add new LONG gates (cohort overlay is already tight)
- Do NOT change management-side (F1–F4 exit rules work well)
- Do NOT add new DA keys that don't directly map to the block reasons we observed

## Holdout discipline

Mar 2026 is a holdout month in the Phase-D plan. Using it for Phase-F evidence **uses up the holdout**. After v6 runs, the Mar+Apr picture becomes the new baseline; any future tuning needs fresh holdout months.
