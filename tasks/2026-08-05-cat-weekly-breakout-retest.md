# CAT Weekly Breakout Retest — why the model sat out

Operator note (2026-08-01): "Breakout retest Catepillar Play" after Weekly
EMA(21) + Weekly SuperTrend held near ~$800 following the premium drawdown
from ~$1,080. Chart reclaim to ~$876.54 on the open weekly candle.

## What the model did

| When | Action | Detail |
|---|---|---|
| 2026-06-24 | Investor **BUY** | `inv-CAT-auto-1782309789719` @ **$987.85**, score 83 accumulate |
| 2026-07-07 | Investor **SELL** | Full exit `PRIMARY_INVALIDATION_BREACH` @ **$917.31** (~−7%) |
| Jul 12 | Cooldown ends | 5-day loss re-entry cooldown expired — **not** the Aug blocker |
| ~Jul 27 week | Structure | Weekly candle low **$776**, close $814.81 |
| ~Aug 3 week | Bounce | Weekly low **$804.57**, reclaim to **$876.54** (operator chart) |
| After Jul 7 | No re-entry | Zero investor lots / decision_records after the invalidation exit |

Trader lane last CAT print was much earlier (Feb 2026 ATH breakout, pre-earnings
force exit) — not relevant to this weekly investor setup.

## Why it missed the Weekly Breakout Retest

1. **Already flat.** Position was cut on Jul 7 invalidation; nothing open into
   the late-July / early-August support test.
2. **No named admit path.** Accum zone had live `near_weekly_supertrend` (price
   within 3% of Weekly ST) and a soft `weekly_ema_reclaim` (EMA structure/
   momentum), but **no week-low Weekly EMA(21) test** and **no EMA21+ST
   confluence** signal. By mid-reclaim (~$876 vs ~$808–810 anchors) live
   proximity alone is already outside the 3% band — the test lived in the
   **week low**, not the bounce print.
3. **Momentum-runner branch looks the other way.** It wants price *already
   above* Weekly 21 + healthy Weekly RSI (≥50). A deep retest from premium
   fails that profile on purpose.
4. **Compounder `near_weekly_ema21` was live-only.** Required
   `priceAboveEma21` and 0–6% distance on the current print — same miss once
   the candle had already bounced. CAT also may not clear growth_elite/strong
   compounder eligibility, so that lane would not promote alone.
5. **Franchise / fundamentals do not reopen.** History and growth thesis are
   not an auto-init trigger after structural exit; auto-init still needs
   `stage=accumulate` and score ≥ floor (~65).

## Engine response

1. `detectWeeklyBreakoutRetest` — week-low test of Weekly EMA(21) and/or Weekly
   ST; confluence + reclaim → `weekly_breakout_retest`.
2. Wire into `detectAccumulationZone` (oversold/confluence branch); prefer
   `zoneType=weekly_breakout_retest` when confluence fires.
3. `INVESTOR_STRUCTURAL_ANCHORS.CAT` — weekly EMA21 / ST / breakout-retest memory.
4. Growth-compounder `near_weekly_ema21` also accepts week-low test + reclaim.

Same family as ANET Daily 21 memory: **movie > frame** — honor the structural
test that held, then act on reclaim, not only on the live distance band.
