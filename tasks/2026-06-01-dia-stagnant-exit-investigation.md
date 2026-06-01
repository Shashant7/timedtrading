# DIA LONG 2026-06-01 — exit investigation

> Operator question: *"Was this a good entry / exit? It seems like it may still have room to go higher."*

## The trade as posted (Discord)

```
🏆 Winner: DIA LONG — Closed 100% — +0.28% @ $510.67 · 2:01 PM ET
Closed with +$22.31 profit (+0.28%). etf stagnant exit.

Trade Summary
  Entry: $509.25 | Exit: $510.67
  P&L:   +$22.31 (+0.28%)
  Qty:   15.7094  | Value: $8,022.31

Exit Reason: etf stagnant exit
Setup:      Atl Breakdown (sic — display bug, see below)
Grade:      Speculative
Risk:       0.50%
Price Move: +$1.42 (+0.28%)
```

## Verdict

| Aspect | Assessment |
|---|---|
| Entry | **Marginal but defensible.** Speculative grade + 0.50% risk = opportunistic, not high-conviction. Reasonable for an index ETF in an established uptrend. |
| Exit decision | **Mechanically correct per the rule** — `etf_fast_cut_zero_mfe` (4 h elapsed + MFE < 0.05% on a profile-managed ETF). |
| Exit timing | **Strategically premature.** The cut fired at the exact moment DIA was finishing a 4-hour coil-before-break inside an HTF-bullish setup. Current price $511.21 is ~+0.10% above our fill; the bullish multi-timeframe structure suggests more upside is in play. |
| Net outcome | **Small win → larger missed opportunity.** Realized +0.28% (lucky fill on the breakout edge) vs. potentially +0.40-0.80% if held into the afternoon trend. |

## Reconstruction (from rule + chart)

The `etf_fast_cut_zero_mfe` branch fires when:
- `age >= 4 h` AND
- `MFE < 0.05 %` (essentially zero high-water mark)

This branch fires **regardless of current P&L** — the rule treats near-zero MFE over 4+ hours as "wrong from bar 1, the price never moved." That's the right intuition in most stagnation cases.

For DIA this morning:

1. Entry $509.25 ~9:30-10 AM ET.
2. 4+ hours of chop between $508-$509.5. MFE stayed below 0.05 % the entire time.
3. ~2 PM ET: 4 h threshold met. Rule fires → exit decision made.
4. Order fills at $510.67 — the rally was just starting. +0.28 % realized (the gap between decision and fill).
5. Within minutes, DIA rallied to $511.21+.

The rule did exactly what it was designed for, but the underlying chart context was about to flip from stagnation to breakout — the rule had no way to see that.

## Why the rule missed the coil-before-break

Looking at the multi-timeframe chart the operator shared:
- **Monthly**: bullish trend, near recent highs
- **Weekly**: bullish, EMA cloud stack intact
- **Daily**: above 200 EMA, holding consolidation at highs
- **4H/1H**: tightening range with rising support
- **30m**: clear coil; tight range, low ATR — classic squeeze setup

That's **constructive consolidation**, not stagnation. The rule should distinguish between:
- *"Stuck in chop with no trend"* → cut fast (the original intent of this rule)
- *"Coiling at HTF highs in a bullish regime"* → defer; the next move is statistically up (the DIA case)

## Display bug (separate from the trade decision)

Discord showed `Setup: **Atl Breakdown**` for a LONG. The engine emits `tt_ath_breakout` for LONG and `tt_atl_breakdown` for SHORT (`worker/pipeline/tt-core-entry.js:3803`). Either:
- The trade record stored `setup_name` as `atl_breakdown` instead of `tt_ath_breakout` (engine bug), OR
- `prettySetupName()` title-cased an unmapped string and produced "Atl Breakdown" (display bug)

This is a separate issue worth investigating — flagged for follow-up but **does not affect the exit decision**.

## Fix shipped in this PR

Added an optional `htfContext` parameter to `checkEtfStagnantExit()` in `worker/etf-profile.js`. The `fast_cut_zero_mfe` branch now defers when:

| Trade direction | Required conditions to defer |
|---|---|
| LONG  | `monthly_bundle.supertrend_dir === -1` (Monthly bullish) AND `daily_structure.above_e200 === true` AND any of `tf_tech.{30,60,1H,4H}.sq` shows squeeze (`s===1` or `c===1`) |
| SHORT | `monthly_bundle.supertrend_dir === 1` (Monthly bearish) AND `daily_structure.above_e200 === false` AND squeeze active on any LTF |

All three conditions must hold (strict AND) — the rule still fires for the original target case ("downtrending ETF, stagnant, not in a coil"). The `dead_money` and `fast_cut` branches (which require `pnl <= 0`) are unchanged: a trade that's BOTH slow AND losing is genuine stagnation, not a coil.

Smoke-tested 8 scenarios:
- DIA case (4.5h, MFE~0, LONG, monthly bull + above D200 + squeeze) → **DEFERRED** ✓
- DIA but no squeeze → **fires** (expansion ≠ coil) ✓
- DIA but daily below 200 EMA → **fires** (counter-trend, no defer) ✓
- DIA + bear regime LONG → **fires** (trend against position) ✓
- SHORT in bearish HTF + squeeze → **DEFERRED** ✓
- No HTF context (backward compat) → **fires** (legacy behavior) ✓
- Dead-money (8 h, pnl<0) → **fires** (gate only applies to zero-MFE branch) ✓
- Winning stagnant (pnl > 0) → **skips** (original short-circuit unchanged) ✓

## Operator-visible behavior change

When the gate defers, the engine logs (operator-only, not paged):

```
[ETF_STAGNANT] DIA LONG — DEFERRED: etf_fast_cut_zero_mfe_DEFERRED_htf_coil:
   age=4.5h mfe~0 but long in HTF-aligned squeeze
   (monthly=true, d_ema200=true, squeeze=true)
```

The trade then continues to be managed by the next-line exit rules
(V13 hard-loss cap, doctrine force-exit, TP ladders, etc.). The deferred
position is NOT "permanently held" — it's just not killed by the
fast-cut. If the breakout fails and the trade keeps drifting, the
dead-money rule (8 h + MFE < 0.5 % + pnl <= 0) still fires.

## What the operator can act on now

For the DIA trade specifically: this was a small win on a Speculative-grade
opportunistic entry. **Not a strategic error to feel bad about** — the
position size (0.50 % risk) and grade (Speculative) tell us the model
was experimenting, not deploying conviction capital. The lesson is in
the management rule, not the entry.

For the rule going forward (after this PR ships): in the same DIA setup,
the engine would hold through the coil and let the breakout resolve. If
the breakout had failed and DIA drifted lower, the dead-money rule (8 h
threshold) would still catch the trade.

## Follow-up items

1. **Setup-name display bug** — investigate why `Atl Breakdown` rendered for a LONG. Either a trade-record write bug or a prettifier miss. Filed separately.
2. **Audit similar past trades** — back-test the new gate against all `etf_stagnant_exit` events in the last 30 days. Expectation: a handful of LONG ETF cuts during bullish-HTF coils would have been deferred and resolved into larger wins. The dead-money rule should still fire on the genuine losers.
