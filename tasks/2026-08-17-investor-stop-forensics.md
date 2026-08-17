# Investor (long-term) lane — entry + stop forensics

**Date:** 2026-08-17
**Scope:** `investor_positions` with `first_entry_ts >= 2026-05-01` — 63 positions,
47 closed, 16 open. All figures from remote `timed-trading-ledger`.
**Question asked:** are the long-term trades in need of refinement, especially
around entries and managing stops?

**Answer: yes, and it is overwhelmingly the exit side.**

---

## 1. The shape of the problem

| | |
|---|---|
| Closed positions | 47 (10 win / 37 loss, 21% WR) |
| Realized on closed | **-$11,132** |
| Open positions | 16 |
| Unrealized on open | **+$5,820** (plus +$1,734 already realized on the same names) |
| Median hold | 10 days — in a lane whose own config calls itself long-horizon |
| Closed within 1 day | 10 positions |

Terminal exit reason on the 47 closes:

| Reason | n | Sum P&L | Avg return | Avg hold |
|---|---|---|---|---|
| `PRIMARY_INVALIDATION_BREACH` | **44** | **-$10,847** | -4.91% | 15.3d |
| `FAILED_ENTRY_RECLAIM` | 2 | -$312 | -1.76% | 30.5d |
| `PRE_FOMC_RISK_REDUCTION` | 1 | +$5 | +1.92% | 1d |

Weighted by shares, the average closed position was liquidated **87.5% by its
terminal invalidation exit**. Management trims were 7.0%, macro event trims 5.1%.

**Every position the stop never touched is profitable.** WTS +16.1%, PLTR +36.6%,
GE +13.6%, PANW +13.0%, NVDA +10.9%, KO +8.9%. Only 5 of 16 are underwater and 4
of those were opened within three sessions of the data cutoff. There is
essentially no "still-open underwater" cohort to study, because anything that
goes 4-12% underwater gets stopped out before it can become one. **The absence
of that cohort is itself the finding.**

---

## 2. Entries — mediocre, but second-order

`decision_records` for `engine='investor'` only start 2026-06-29, so 38 of 63
positions have no entry record. Analysis is limited to 35 entries, of which 22
have both a record and a closed outcome. Thin.

What the snapshots show:

- `market_health` was 76-89 on **every** entry. Zero variance, zero discriminating power.
- `accum_zone.inZone` was false on 20 of 35, and it does not matter:
  inZone=false averaged -2.19%, inZone=true -2.17%. The zone flag, `action_tier`
  and `components.accumulationSignal` are collinear and all three are noise.
- Of the 15 in-zone entries, **14 had `zoneType: "momentum_runner_exhausted"`**
  and produced 1 winner. The label contains the word "exhausted."
- `components.trendDurability` was **0 on all 35** — see defect D2, the predicate
  is broken.
- `components.fourHourTiming` was 0 on 27 of 35. The 8 where it was positive
  averaged **+1.33%** over 21-day holds vs **-3.22%** over 11.5-day holds. Only
  entry feature with visible separation, n=8, hypothesis only.
- Score is *inverted* at the top: entries scoring >=75 averaged -4.38% (n=10, 1
  win); 70-74 averaged -0.65%; <65 averaged -2.37%.

Against the tape (closed positions, n=22):

| Entry location | n | Avg return | Wins |
|---|---|---|---|
| Below the daily EMA21 | 14 | -5.15% | 2 |
| Above the daily EMA21 | 8 | -1.79% | 1 |

Directionally consistent with the LTF gates shipped 2026-08-04/05, but **every
bucket is negative**. NBIS was bought 13.5% below its daily EMA21 after a -16.5%
20-day slide and stopped the next day at -12.2%; IESC was bought 8.8% *above* it
after a +22.8% run and stopped 4 days later. Both directions lose.

**The closed sample contains no entry feature that reliably separates a winner
from a loser.** Winners are distinguished by not having been stopped out —
23.8 days average hold vs 13.5 for losers. Entry refinement is second-order here.

---

## 3. The stop is a trailing stop wearing a thesis label

### It is a percentage band off live price, not a structure

`pickPrimaryInvalidationPrice` filters every candidate level by distance **from
the current live price**, with `ACTIONABLE_MAX_DD_PCT = 12` and
`ACTIONABLE_MIN_DD_PCT = 4`. Every genuinely structural level for a multi-year
holder is discarded: IESC's own entry provenance records Monthly SuperTrend at
$375.22 (50% below) and Weekly EMA(200) at $373.56, both filtered out by the 12%
cap. Only tactical trailing levels survive.

The floor at entry is consequently arbitrary — FN -4.2%, CAT -4.6%, EXEL -8.7%,
IESC -11.6%, TWLO -21.9%, and **AMAT was born with a floor $3.70 ABOVE its
eventual cost basis**.

### And it ratchets

`resolveStickyPrimaryInvalidation` is monotonically non-decreasing while owned,
and the fresh value it ratchets toward is always 4-12% under the live mark. So
the floor trails the market up and detaches from the entry anchor entirely:

- **IESC**: $668.41 at entry -> $757.00 four calendar days later. Up 13.2%, and
  0.13% **above** its own $755.99 cost basis. Closed the position for +0.02%.
- **TWLO**: $160.84 -> $243.53, a 51% ratchet.

Label distribution across the 28 exits with a recorded breach: Weekly ATR
support 14, **Daily ATR support 9** (a day-trading level used as the invalidation
for a long-term investment), Weekly EMA(21) 4, 12% trailing fallback 1.
**Weekly SuperTrend 0. Monthly SuperTrend 0.**

### The exits are right over a month and terrible on the day

For each invalidation exit, the following 20 sessions of daily tape (23 exits
have >= 5 sessions of forward data):

- **18 of 23 saw price close back above the exit price**, median **1 session**.
- Average maximum recovery above the exit: **+7.30%**.
- Average return at the end of the 20-session window: **-5.75%**.
- The exit price sat at the **29th percentile** of the ±5-session range.

Read those together: **the decision is directionally defensible over a month,
but the execution is close to the worst available price.** The engine sells the
low of a swing, eats a +7.3% average bounce it does not participate in, and only
then is proven right.

Worst cases: ANET 7/16 exited at $166.81 on a **-0.62%** breach and reached
$210.50 (+26.2%) inside 20 sessions. CRDO 8/3 exited at $199.75 and reached
$268.16 (+34.3%) in nine sessions. NBIS 7/16 +32.0%. AVGO 7/17 +16.6%.

### Breach depth is the tell

Median penetration across all 28 exits: **-1.29%**. Extremes: SANM at **-0.01%**
(one cent through the floor, score 73) and IESC at **-0.11%**. Fifteen of 28
fired on a breach shallower than 1.5%. These were not crash days — on all 12
exit-cluster dates SPY moved between +1.65% and -0.99%, and SPY closed **above
its own 21 EMA on 11 of 12**.

And the sharpest single predictor in the data:

| Same-session daily close vs the floor | n | Avg 20-session max recovery | Avg return at +20 |
|---|---|---|---|
| Reclaimed back **above** the floor | 7 | +13.84% | **+1.52%** |
| Stayed **below** the floor | 16 | +4.44% | **-8.93%** |

Waiting for the session's own close costs **+0.02%** of execution on average
across all 28 exits — statistically identical to the tick the engine sold at.

---

## 4. What shipped (all default OFF)

`worker/investor-autopsy-gates.js` + `worker/investor-autopsy-gates.test.js` (22 tests).

### D2 — `deep_audit_investor_weekly_st_dir_fix`

A genuine bug with two independent failure modes. Producer, `worker/indicators.js`:

```js
const atrCross = (() => {
  if (!b.stFlip) return null;
  return { x: ..., xd: ..., xs: b.stDir < 0 ? -1 : 1 };
})();
```

1. `atr.xs` exists **only on a SuperTrend flip bar**, so on ~every live pass it
   is undefined.
2. It **mirrors the sign of stDir**, so `xs === 1` means `stDir >= 0`, which
   under the Pine convention used everywhere else in `investor.js`
   (`-1 = bull`) is **bearish**.

Both consumers read `xs === 1` as bullish: `criteria.weeklyST` in
`generateThesis` and `components.trendDurability` in `computeInvestorScore`.
Consequences, both confirmed on live data: `trendDurability` scored **0 on all
35** recorded entries, and because `criteria.weeklyST` is false
`pickPrimaryInvalidationPrice` **never adds Weekly SuperTrend as a floor
candidate** — the one structural level most likely to land in a sane band for a
long-horizon holder. Armed, it reads the persistent `stDir` with the weekly
bundle as fallback.

Note the daily equivalent at `computeInvestorScore` (`dStDir === -1`) is already
correct, which is why `dailySuperTrendBonus` scores 5 on live rows while
`trendDurability` scores 0.

### D3 — `deep_audit_investor_require_session_close`

Restricts RTH firing to `session_close_mark`, deferring `sustained_hold_below`
and `prior_daily_close` until the session actually closes. Also gates the
**score path** (`classifyInvestorStage` -> `primary_invalidation_breach`), which
had no confirm discipline at all: it fires on a raw live tick, and because
`primary_invalidation_breach` is in `IMMEDIATE_INVESTOR_REDUCE_REASONS` it also
skips `reduce_trim_min_sessions`. The ANET movie never guarded that path.

### D4 — `deep_audit_investor_shallow_breach_score_hold`

Defers liquidation while the penetration is under
`deep_audit_investor_shallow_breach_pct` (default 2.0) **and** the engine's own
score is at or above `deep_audit_investor_breach_hold_score_min` (default 65).
Would have blocked SANM, CRDO 7/1, IESC 7/2, ANET 7/16, STRL 7/1 and MU.

D3 and D4 are **strictly widening** — each can only defer an exit that already
fires, never create one.

---

## 5. Deliberately NOT shipped — the floor ratchet clamp

The ratchet is real and is the root cause behind D4's symptoms, but two obvious
clamps both fail and they fail for opposite reasons:

- **Cap the floor at the entry anchor / cost-basis band.** Hands back most of
  the open gain on genuine winners. PLTR is +37% with a floor 2.2% under live;
  clamping to `cost_basis * 0.92` would drop its stop from $170 to $117.
- **Cap by peak giveback** (floor may lock in at most X% of the peak open gain).
  Does not catch IESC at all — its floor was only ~0.1% above cost basis, well
  inside any sane giveback band. IESC's pathology was ratchet *speed* (13.2% in
  four days), not ratchet *depth*.

Those are two different problems. Picking a giveback fraction, or a max ratchet
rate, needs a distribution this book does not yet contain. Revisit once D3/D4
have let enough positions survive to produce a real winner cohort.

---

## 6. Live risk right now (2026-08-17)

Cushion between the live mark and the ratcheted floor, from
`timed:investor:scores` + `timed:prices`. **Eight of 17 open positions sit inside
the 4% band the picker itself treats as the minimum actionable distance**, and
four are inside 3%:

| Ticker | Entry | Live | Floor | Cushion | Floor vs entry | Score |
|---|---|---|---|---|---|---|
| PANW | 340.07 | 384.27 | 376.17 | **2.15%** | +10.6% | 79 |
| PLTR | 127.44 | 174.04 | 170.32 | **2.18%** | +33.6% | 73 |
| CF | 115.90 | 118.30 | 115.49 | **2.43%** | -0.4% | 57 |
| TSM | 417.09 | 426.35 | 414.14 | **2.95%** | -0.7% | 47 |
| DE | 595.22 | 608.85 | 590.70 | 3.07% | -0.8% | 68 |
| GE | 324.18 | 368.38 | 354.84 | 3.82% | +9.5% | 65 |
| CAT | 864.41 | 856.57 | 824.71 | 3.86% | -4.6% | 43 |
| PWR | 686.86 | 685.78 | 659.92 | 3.92% | -3.9% | 63 |

PANW and PLTR are the two highest-conviction names in the book (scores 79 and
73) and are up 13% and 37%. **An ordinary 2.2% down day liquidates both.** With
D4 armed at its defaults, a 1% penetration holds PANW, PLTR and DE and releases
CF, TSM, CAT and PWR — which is the intended split, since the released names are
the low-score ones where an exit is defensible.

Seven of 17 positions currently carry a floor **above** cost basis (PLTR +33.6%,
PANW +10.6%, GE +9.5%, WTS +8.4%, NVDA +5.3%, KO +4.1%, IWM +0.8%) — the ratchet
in action on live money.

---

## 7. What NOT to change

- **Macro event-risk trims.** Most numerous sell reason (`PRE_FOMC` 64 +
  `PRE_CPI` 38 of 223 SELL lots) and alarming in a histogram, but they are 8%
  slices — only **5.1%** of the average closed position by shares. And they are
  P&L-neutral: across 84 macro trims with forward tape, price 5 sessions later
  averaged **-0.01%** vs the trim price. Leave them.
- **DCA / averaging down.** Five positions DCA'd and were later
  invalidation-exited; they netted **+$1,424** and include the two largest
  realized winners (TWLO +$2,319 across four DCAs, CRS +$950). DCA is working.
- **Intraday-vs-close slippage as a framing.** The difference between the tick
  the engine sold at and that session's close is **+0.02%**. D3 is worth doing
  because of *which* exits it filters, not because of execution price. Anyone
  who measures it as a slippage fix will conclude the change failed.
- **The accumulation-zone detector.** Uninformative here (-2.19% vs -2.17%) but
  not doing damage, and n=35 does not suggest a fix. Fixing the exit side first
  changes which positions survive long enough for zone quality to matter.
- **Reading the 2026-08 cohort as evidence.** Six positions, five still open,
  and the last three opened on the final session in the candle data. They also
  differ structurally from June/July (all in-zone, all `act_now`, all
  `compounder_dip_override_exhaustion`). Judging the 2026-08-04/05 LTF gates
  needs ~25-30 closed positions entered under them.
- **Blaming the June 1 lump.** Eleven positions opened 2026-06-01 and
  -$8,507 of the -$11,132 is June-cohort, which invites that story. But those
  eleven closed 6/19-6/26 by the *same* mechanism as everything else, and the
  mechanism kept producing -$2,612 in July on tranched entries. The lump made
  the loss bigger; it did not cause it.

---

## 8. Open — repeat-entry churn

30 of 63 positions are repeat entries on 14 tickers, net **-$2,538**. NBIS twice
(both one-day round trips, -11.0% and -12.2%), AMD twice, CRDO three times, IESC
three times. `loss_reentry_cooldown_days` is 5.

This is a symptom of the stop mechanism, not an independent defect — fixing D3
and D4 removes most of the stop-outs that create the cooldown in the first
place. If a direct gate is wanted later,
`deep_audit_investor_reentry_requires_reclaim` (block re-open until price closes
back above the prior position's breach floor) is cheap and uses a number already
persisted in `notes._inv_movie_fired.breach.price`.

## 9. Open — fair-value premium at entry

Only 7 positions have a readable `fair_value` block at entry and **all 7 were
classed `premium`**: CAT 48.3%, PWR 29.4%, TWLO 29.7%, AMAT 25.0%, IESC 22.6%,
ANET 14.3%, FN 12.9%. Five August entries carry
`stage_reason: "compounder_dip_override_exhaustion"` with 2-3
`exhaustionWarnings` each (e.g. `monthly_rsi_86`,
`markov_dwell_exhausted_3.6sigma`, `fsd_macro_risk_off`).

Buying a 25-48% premium and then placing a 4-12% stop under it is a structural
mismatch. But n=7 with no closed outcomes — do not gate on this yet. What would
settle it: `entry_provenance_json` on >= 40 closed positions, or a replay that
backfills the provenance blob for the 38 positions that lack it.

---

## 10. Arming

None of these are armed. To turn them on in `model_config`:

```
deep_audit_investor_weekly_st_dir_fix         = true
deep_audit_investor_require_session_close     = true
deep_audit_investor_shallow_breach_score_hold = true
deep_audit_investor_shallow_breach_pct        = 2
deep_audit_investor_breach_hold_score_min     = 65
```

All five are in `REPLAY_DA_KEYS` (`worker/replay-runtime-setup.js`), which is
what makes them visible to the investor scoring cron and the auto-rebalance
invalidation loop — see the plumbing trap in `CONTEXT.md`.

**Suggested order.** D4 first and alone: it is the smallest predicate, it
directly addresses the live hair-trigger table in §6, and its effect is legible
in the logs (`invalidation HELD — breach X% ... score Y`). D3 next, once D4 has
shown it defers the right names. D2 last and separately — it is the only one
that moves entry scores, so it needs its own before/after on entry counts rather
than being confounded with two exit changes.

Rollback is a config flip in `model_config`; no redeploy.
