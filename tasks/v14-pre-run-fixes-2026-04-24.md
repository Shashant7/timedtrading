# V14 Pre-Run Fixes & Calibration Plan

**Context:** V13e smoke (Jul-Sep 2025, 203-ticker universe, Focus Tier conviction gate active) captured the data we need for two calibration tracks and surfaced two exit-rule bugs that must be fixed before the full V14 run.

## Bugs surfaced by V13e (fix before V14)

### Bug 1 — Stale `pnl_pct` on open trade records

**Symptom:** TPL SHORT (entered Jul 18) and NXT LONG (entered Jul 22) stayed OPEN through the whole smoke window. Trade record showed `pnl_pct: -0.59%` while the live bar-computed pnl was -8% to -10%.

**Root cause:** `pnl_pct` on the open-trade KV record is only refreshed on trim/exit events, not per-bar. Any exit rule that reads the stored field (vs computing live from entry + current price) sees stale data and doesn't fire.

**Evidence:**
- NXT dropped >8% below entry by Jul 29, stayed below -8% through Aug 4
- `deep_audit_hard_loss_cap_pct=5` should have fired at -5% on Jul 29
- HARD_LOSS_CAP **did not fire** → exit path either reads stale stored field OR has another gate we missed

**Fix:** Audit every exit rule to confirm it uses live `pnlPct` (recomputed from `entryPrice` + current bar price) not the stored `openTrade.pnl_pct`. The ones we know work fine (V13e saw PKG/GRNY/DCI fire stagnant correctly) use live values. The ones to audit:
- `HARD_LOSS_CAP` in `processTradeSimulation` (line 16045+)
- `max_loss`, `max_loss_time_scaled`, `atr_day_adverse_382_cut`
- `stale_position_force_close` (45-day rule)
- `runner_time_cap` (30-day rule)

### Bug 2 — `stale_position_force_close` didn't fire at 45 days

**Symptom:** NXT should have been force-closed Sep 5 (45 cal-days after Jul 22 entry). V13e reached Sep 16+ without firing.

**Root cause (likely):** the 45-day rule has "currently breaking out" carve-outs that may have matched on NXT's volatile price action even though it was net losing. Or it's gated on `trimmed_pct > 0` (i.e. only fires on trimmed runners, not pure OPEN).

**Fix:** Pull the logic into this doc and add a simple "force close any OPEN trade > 45 calendar days old regardless of pnl or MFE" fallback. Stagnant-cut covers dormant-flat; this covers deeply-losing-and-stuck.

## Calibration tracks (both use V13e data)

### Track A — Fix rank formula

**Input:** V13e's `rank_trace_json` — 100% coverage per entry, with full parts breakdown.

**What we'll do:**
1. Pull every closed V13e trade's `rank_trace_json`
2. For each rank component (htf, ltf, completion, phase, rr, tfSummary, triggerSummary, completeness), measure WR-lift and PnL-lift of that component being >= median vs < median
3. Refit the weights based on empirical lift (the same approach as `computeRankV2` but on a clean, 100%-capture sample instead of the biased 32% V11 had)
4. Ship `computeRankV3` alongside V2 (toggle via `deep_audit_rank_formula=v3`)

**Target:** rank/pnl Pearson correlation > 0.20 (V11 was 0.002).

**Script to write:** `scripts/v14-rank-recalibration.py` — reads V13e trades, emits proposed weights + expected correlation improvement.

### Track B — Calibrate conviction score

**Input:** V13e's `focus_conviction_breakdown` on every trade + outcome.

**What we'll do:**
1. For each of the 6 signals (liquidity, volatility, trend, sector, relative_strength, history), correlate points awarded vs trade outcome
2. Adjust signal weights: boost signals that actually predict outcomes, deemphasize those that don't
3. Re-threshold tier cutoffs — V13e showed Tier A at 75% WR vs Tier B at 50%, so the 75/50/45 boundaries roughly work; fine-tune based on the final distribution
4. Review TT_SELECTED bonus magnitude — +15 might be too much; check if TT_SELECTED members underperform intrinsic score

**Target:** Tier A WR ≥ 80%, Tier B WR ≥ 60%, clear separation without over-weighting the hard-coded list.

**Script to write:** `scripts/v14-conviction-calibration.py`

## Learnings to carry forward

From V13e preliminary results:

| Signal | V13e reading |
|---|---|
| **Tier system works** | Tier A 75% WR vs Tier B 50% — 25pp genuine separation |
| **Stagnant rule works** | 9+ closures caught the dormant-drift pattern |
| **Focus conviction captured** | 100% trace coverage, 6 signals differentiating |
| **Universe pruning works** | Dropped 12 V11 losers, no ORCL/CDNS drift |
| **Exit rules have gaps** | 2 trades stuck OPEN 40+ days — HARD_LOSS_CAP path needs audit |

## The run sequence

**Next session, in order:**

1. **Finalize V13e autopsy** — build `scripts/v13-final-autopsy.py` that emits:
   - Aggregate metrics (WR, PF, PnL)
   - Per-tier breakdown (A/B/C WR, PnL, avg hold)
   - Exit-reason distribution
   - Stuck-position audit (any OPEN > 30 days)
   - Rank component × outcome correlation matrix
   - Conviction signal × outcome correlation matrix
2. **Fix Bug 1 + Bug 2** — exit-rule pnl-refresh + 45-day force-close fallback
3. **Calibrate rank (Track A)** — ship `computeRankV3`
4. **Calibrate conviction (Track B)** — adjust weights + thresholds
5. **Micro-smoke V14a** — Jul-Sep 2025 (same window as V13e) to validate all changes against the V13e baseline
6. **If V14a matches or exceeds V13e** → launch **V14 full 10-month run (Jul 2025 → Apr 2026)** — this is the final golden-master proof run

## Acceptance criteria for V14 full run

- Zero stuck-OPEN positions at smoke completion
- Rank/pnl Pearson correlation ≥ 0.20
- Conviction Tier A ≥ 80% WR on its trades
- Overall WR ≥ 65%
- Total PnL over 10 months ≥ +80%
- Every big loser (< -3%) audit-able to a legitimate market event, not an exit-rule miss
