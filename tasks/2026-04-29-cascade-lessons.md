# Cascade Lessons + Path Forward

**Date:** 2026-04-29  
**Session focus:** Push WR ≥ 70% on the v16-fix4 baseline using newly-captured TD/PDZ/Divergence signals.

## TL;DR

**Three different entry-side filters were tried and all failed in execution despite passing counterfactual analysis:**

| Fix | Counterfactual prediction | Live result | Cause of failure |
|---|---|---|---|
| FIX 9 — Progressive partial trim | +12pp PnL | -106pp PnL | Heavy trimming pushed runners into "near-fully-trimmed" downstream paths that closed residuals early |
| FIX 12 V3 — Quality block (F1+F2+F3) | +7pp PnL | -37pp PnL | F2 (RSI MTF middling) caused 47-trade slot reshuffle |
| FIX 12 V4 — Drop F2, add F4 (severe div) | +19pp PnL | -300pp PnL | Slot-fill cascade: removed F4 trades got replaced by lower-quality alternatives that weren't in baseline |

**Root cause: slot-fill cascade.** Today's engine enters trades greedily as it iterates through tickers. When a high-quality candidate gets blocked by a post-hoc filter, the freed slot fills with a lower-quality alternative (the next ticker in iteration order that passes the gate). The counterfactual analysis assumes "remove these trades, keep all others identical" — that assumption is wrong in a slot-constrained system.

## What this means

**Post-hoc entry filters cannot improve a slot-constrained system.**  
You cannot reduce a system's loss rate by knocking out individual trades because the slots get refilled by alternatives. The "alternatives" are by definition trades the system would have entered anyway — they were waiting for capacity, and capacity becomes available when a higher-conviction trade gets gated out.

**The only structural fix is to change WHAT FILLS THE SLOT.** That requires entry-time selection: rank all eligible candidates by quality, take only the top N up to capacity, reject the rest. This is Phase C.

## What was actually achieved this session (the keepers)

### Lifecycle correctness wins
- **D1 reconciliation fix (P0.7.13/14)** — orphan trades caused by KV vs lock-string mismatch are now properly reconciled
- **Live cron isolation (P0.7.16)** — `d1LoadTradesForSimulation` filters backtest trades; live cron no longer force-closes them at wall-clock time
- **30m live management cadence (P0.7.17)** — `LIVE_MANAGE_INTERVAL_MIN=30` env. Live mode gates signal-based exits to 30-min intervals
- **Auto-curl-killer tightening** — 240s→150s threshold, 30s→15s poll. Significantly reduces backtest stall wall-time
- **Orphan position cleanup endpoint** — `POST /timed/admin/cleanup-orphan-trades`. Found and closed 14 stuck OPEN positions from prior backtests that the live cron was force-closing every minute

### Validated entry/exit fixes (kept on live system)
- **FIX 4 — Late-day entry block** (P0.7.20) — block 3:30-4:00 PM ET. +151pp PnL, +10pp WR on July smoke
- **FIX 6 — TP1 floor** (P0.7.18) — `pTrim >= max(1.5×ATR, 1.5%×price)`. +1.37pp PnL, no regression

### Forensic infrastructure
- **TD Sequential per TF** captured in setup_snapshot (10m/30m/60m/240m/D/W with prep counts, leadup, td9/td13 flags)
- **PDZ zones per TF** (D/4h/1h)
- **Adverse RSI + adverse phase divergence summaries** with strongest TF and count
- **100% coverage** on all trades from the v16-baseline-ctx run forward
- **`scripts/full-trade-autopsy.py`** + **`scripts/autopsy-join-context.py`** for repeatable post-backtest analysis

### Statistical insights from the new fields (use for design, not as filters)

| Cohort | N | WR | Notes |
|---|---|---|---|
| Adverse Phase Div = NONE | 51 | 76% | Cleanest setup state |
| BOTH adv RSI + adv phase div active | 7 | 29% | "F4 severe divergence" — strong loser signal |
| PDZ_Daily=premium (LONG) | 27 | 78% | Counterintuitive — momentum continuation |
| PDZ D+4h both premium (LONG) | 14 | 93% | Premium-stack wins |
| TD bear_prep 4h 1-3 | 31 | 81% | Early HTF strength |

These are **excellent signals for exit-side modulation and entry-time scoring** — but NOT for binary entry blocks (cascade kills the benefit).

## The "real" v16-fix4 baseline (after orphan cleanup)

The savepoint shows different numbers depending on whether orphan-related noise was present:

| | Pre-cleanup (artifact) | Post-cleanup (true) |
|---|---|---|
| N | 107 | 101 |
| WR | 62.6% | **67.3%** |
| PnL | +430.63% | +427.12% |
| PF | 5.33 | **8.14** |
| Best WIN | +111% (LITE) | +49.63% (AVGO/LITE) |

The +4.7pp WR and +2.8 PF improvement came purely from removing 14 orphan positions polluting the run. **This is the real baseline going forward.**

## Why exit-side fixes work and entry-side fixes don't

- **Exit-side modifications change behavior of trades that already entered.** No slot reshuffle happens because we're not changing which tickers got the slots. FIX 4 (late-day entry block) is technically entry-side but it's a TIME filter, not a quality filter — it doesn't free a slot for a different ticker because the time-of-day applies to all simultaneously.
- **Entry quality filters move slots between tickers.** Whatever you remove gets replaced by something else. If your engine's iteration order isn't quality-sorted, the replacement will be lower quality than what you removed.

## What changes next

### Phase 0 (today): Lock down + savepoint
- Document this learning (this file)
- Commit + merge PR #47 to main with full lifecycle fixes
- Tag main as `v16-fix4-savepoint-2026-04-29`
- New branch for Phase C

### Phase C (next): Restructure entry to rank-all-take-top-N
The fundamental fix. Eliminates cascade by making slot allocation explicit.

**Behavior change:**
- Per-bar candidate buffer instead of greedy in-line entry
- Score every eligible candidate with rank + conviction + new TD/PDZ/Div quality contributors
- At end-of-bar batch decision, take top N by composite quality score (up to remaining capacity)
- Reject the rest; they get re-evaluated next bar

**Validation:**
- July go/no-go smoke at v16-fix4 + Phase C
- Pass = WR ≥ 67% with no top-15 winner regression and PnL within ±10%
- Critical test: re-enable F4 (severe divergence) as a quality SCORE PENALTY (not a binary block) and confirm cohort-level WR boost without cascade

### Phase 1 (after Phase C validated): Per-ticker personality runner protection
Once entry quality is selective, each trade matters more. Use captured `ticker_personality` to modulate exit logic:
- "Explosive" personalities (LITE/AVGO/PLTR class): later trim, wider trail, longer min-hold for runners
- "Mean-reverting" personalities: faster trim, tighter trail, earlier exit on stalls
- "Balanced" (default): current behavior

### Phase 2 (after Phase 1): Timestamped GRNY/GRNJ rebalance history
- Append-only D1 table for ETF holdings snapshots
- Separate `etf_core_ideas` table for Apr 2026 Top/Bottom 5 deck data
- Lookup contracts: `getETFHoldingsAsOf(etf, date)`, `getCoreIdeasAsOf(date)`
- Backfill from grannyshots.com archives + investor decks

### Phase 3+ (UI/UX): see project plan

## Key references

- `tasks/refinement-tracker-2026-04-29.md` — full fix-by-fix decision log
- `tasks/winner-loser-forensic-2026-04-29.md` — original forensic that proposed FIX 12 (rejected)
- `worker/etf-holdings.js` — existing ETF auto-sync (will be extended in Phase 2)
- `data/trade-analysis/v16-fix4-jul-30m-1777446799/` — pre-cleanup baseline
- `data/trade-analysis/v16-baseline-ctx-jul-30m-1777485135/` — post-cleanup baseline with TD/PDZ/Div
- `data/trade-analysis/v16-fix12-jul-30m-1777477370/` — FIX 12 V3 smoke (rejected)
- `data/trade-analysis/v16-canon-julapr-30m-1777489874/` — FIX 12 V4 partial canon (rejected, July only)

## Lessons for future iterations

1. **Counterfactual ≠ live.** Always validate with a smoke before promoting. Counterfactuals assume independence between trades that doesn't exist in slot-constrained systems.
2. **Path-dependence is real.** Removing a trade changes which other trades enter, which changes which positions exist when the next signal fires, etc. The system is a chaotic dynamical system at fine granularity.
3. **Quality at entry-time selection > quality at post-hoc filter.** If you want to filter, sort the candidates first.
4. **Keep DA flags on rejected experiments.** Code stays for revisits; flags off prevents accidents.
5. **Orphan cleanup is non-trivial.** Live cron + persistent positions table + KV cache → triple bookkeeping. Always check all three before running new backtests.
