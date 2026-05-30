---
title: Investor Mode WR Improvement Plan (Phase 4 — deep-analysis pass)
date: 2026-05-11
status: DESIGN — to be executed in a later session
preconditions:
  - PR #97 (TH wiring) merged, deployed to live
  - PR #100 (Phase 3.9d strong-score 70→65) merged, deployed
  - PR #101 (Phase 3.9e momentum-runner branch) merged, deployed
  - PR #102 (Phase 3.9f preprod backfill report) merged
  - Live investor tables now seeded from preprod (87 positions, 160 lots,
    Σ +$32,356 realized — see scripts/replace-live-investor-from-preprod.mjs)
---

# Investor Mode WR Improvement Plan

The Phase 3.9d+e tuning + 3.9f backfill produced a working Investor Mode strategy:

- **+$32,356 realized over ~10 months on $100k start (+42.98% peak equity)**
- 87 positions opened, 72 closed
- **WR: 36% (25W / 44L / 3 flat)** — modest

The headline PnL is positive because of left-skew distribution (top 5 winners = $37k vs sum of all losers = −$9.7k). But a 36% WR means **two-thirds of entries lose money on average**, and there's clear room to improve. This doc lays out a deep-analysis tuning roadmap to lift WR.

## Loss-side anatomy (current state)

Losers from the live import (post-3.9f):

| ticker | n | W | WR | avg hold (days) | Σ pnl |
|---|---:|---:|---:|---:|---:|
| **ETN** | 5 | 1 | 20% | 15 | −$1,715 |
| **TSLA** | 3 | 0 | 0% | 22 | −$1,280 |
| **ITT** | 4 | 0 | 0% | 23 | −$1,255 |
| **MSFT** | 2 | 0 | 0% | 68 | −$1,177 |
| RIOT | 2 | 0 | 0% | 5 | −$998 |
| META | 2 | 0 | 0% | 41 | −$986 |
| CDNS | 4 | 1 | 25% | 25 | −$842 |
| RTY1! | 1 | 0 | 0% | 42 | −$410 |
| (8 more) | | | | | |
| **Σ losers** | **33** | **5** | **15%** | | **−$9,713** |

### Pattern observations

1. **Re-entry without learning** — ETN re-entered 5 times, ITT 4×, CDNS 4×. The strategy keeps trying the same name with no negative feedback loop.
2. **0% WR clusters** — TSLA / ITT / MSFT / RIOT / META all have 0% WR across multiple entries. The signal is structurally wrong on these names, not unlucky.
3. **Hold-period bimodal** — losers split between short-hold (RIOT 5d) and long-hold (MSFT 68d). Short = bad signal at entry; long = bad management at exit.
4. **Sector mix** — industrials (ETN, ITT), mega-cap tech (MSFT, META), volatile growth (TSLA, RIOT, CDNS). No single sector to ban — but possibly per-sector calibration helps.

## Improvement levers — ordered by leverage

Each lever is independently shippable. Pick whichever subset matches the next session's time budget.

### Lever 1: Persistent-loser cooldown gate (highest impact, simplest)

**Hypothesis**: after 2 consecutive losses on a ticker, the signal is structurally wrong for that ticker's current regime. Block re-entry for a cooldown window.

**Implementation**:
- Add `deep_audit_investor_loser_cooldown_consec_losses` (default 2)
- Add `deep_audit_investor_loser_cooldown_days` (default 60)
- In `runInvestorDailyReplay`, before opening a position, query closed positions in the last N days for that ticker. If consecutive_losses ≥ threshold, skip.
- Mirror the trader-side `phase_i_reentry_throttle_hours` pattern (already wired in `worker/replay-runtime-setup.js`).

**Expected impact** (rough estimate from current data):
- Eliminates entries 3-5 of ETN (4 of 5 = −$1,715 → −$343 ~ saves ~$1,372)
- Eliminates entries 3-4 of ITT (saves ~−$628)
- Eliminates entries 2-4 of CDNS (saves ~−$632)
- Eliminates entries 2-3 of TSLA (saves ~−$853)
- **Estimated saves: $3-5k** of the $9.7k loss bucket

**Effort**: ~50 LOC + 3 tests. ~30 min.

### Lever 2: Hold-period-aware reduce/exit gates (high impact, medium effort)

**Hypothesis**: long-hold losers (MSFT 68d, META 41d) are getting reduce signals but not actually closing. Either the reduce-stage logic doesn't translate to closing, or the `core_hold` gates re-fire and override.

**Investigation**:
1. Pull `investor_lots` for MSFT-1 / META-1 / META-2. Look at the action sequence (BUY → BUY → BUY → SELL?). Did the strategy DCA into the loss?
2. Pull `portfolio_snapshots` for those positions to see whether the daily score crossed reduce thresholds and was ignored.
3. Cross-reference with the worker logs (or daystate KV) for what `classifyInvestorStage` returned each day.

**Implementation candidates**:
- Tighten `reduce` gate: `score < 50 AND days_held > 5 → reduce` (currently only fires on more extreme conditions)
- Add `force_exit_at_loss_pct = -8` (close at any -8% individual position loss)
- Add `time_at_score_below_50 ≥ 7d → force_exit`

**Effort**: investigation 1-2h, implementation ~100 LOC + tests. Half-day.

### Lever 3: Component-level score forensics on winners vs losers

**Hypothesis**: at-entry score is similar between winners and losers (both at gate threshold ~65-75). But COMPONENT mix differs — winners have stronger weeklyTrend/monthlyTrend, losers have inflated accumulationSignal compensating for weak fundamentals.

**Methodology**:
1. SELECT closed investor positions joined with the at-entry investor score components (need to log components into a new table or back into `investor_lots.notes` JSON)
2. For each position: at first BUY, what was the score breakdown across the 9 components?
3. Aggregate winners-vs-losers: which components separate?
4. Apply a "min component threshold" (e.g. weeklyTrend ≥ 18 of 25) as a hard gate on entry.

**Caveat**: requires per-entry component logging — not currently captured. Add a hook in `runInvestorDailyReplay` to write `investor_entry_components` rows.

**Effort**: data plumbing 1-2h, analysis 1h, implementation 1h. ~Half-day.

### Lever 4: Cross-mode signal validation (use trader-side gates as filter)

**Hypothesis**: Investor Mode runs in parallel to Trader Mode. The trader's calibrated entry gates (rank, RR, entry quality, calibration profiles) ALREADY validate that conditions are favorable for entry. Investor entries that DON'T pass trader's gates are likely lower-quality.

**Methodology**:
1. For each investor entry, also evaluate `qualifiesForEnter` from the trader pipeline.
2. Tighten Investor entry: require either (a) matching trader entry on same ticker / day, OR (b) trader-side rank ≥ N, OR (c) trader-side calibration profile gives green.
3. Test: do losers have trader-side rejection signals that we're ignoring?

**Effort**: ~half-day. Can be done in parallel with the per-component analysis (Lever 3).

### Lever 5: Sector / regime context filter

**Hypothesis**: certain sectors / SPY regimes lead to higher WR. The losers cluster in volatile-growth (TSLA, RIOT, CDNS) and certain industrials. Maybe in choppy SPY regimes, Investor Mode should be more selective.

**Methodology**:
1. Tag each closed position with the SPY regime at entry (uptrend / downtrend / transition / choppy).
2. WR by regime cohort.
3. Add `deep_audit_investor_regime_filter`: skip entries during certain regimes, or require higher score in choppy regimes.

**Effort**: ~half-day.

### Lever 6: TD9 / RSI-divergence exit triggers (mirror of TH suppression list)

**Hypothesis**: Trend-Hold lifecycle module tracks "structural break" signals to demote. Investor Mode's reduce gate uses a subset but not all. Adding more exit triggers for active investor positions would close losers earlier.

**Methodology**:
1. List all the structural-break signals available (weekly TD9 sell-setup complete, monthly stBear, weekly cascade flip, RSI bear divergence, etc.).
2. For each losing position, identify which break signals fired during the hold but didn't trigger reduce.
3. Add config-driven gates: `deep_audit_investor_demote_on_*` keys.

**Effort**: ~half-day.

### Lever 7: Position-size dynamic scaling

**Hypothesis**: $5k flat per position is suboptimal. Higher-conviction entries (in-zone + score 80+) deserve $7-10k; marginal entries (score 60-65, watch zone) deserve $2-3k.

**Methodology**:
1. Define `position_size = base * confidence_multiplier(score)`.
2. Confidence multiplier: e.g. score 60→0.5x, 65→0.75x, 70→1.0x, 80→1.5x, 90→2.0x.
3. Cap total notional at $100k (current behavior).
4. Test: does dynamic sizing improve PnL? Lower WR (smaller initial bets) but higher Σ?

**Effort**: medium. Requires changing the entry sizing logic. ~Full-day.

## Recommended next-session sequence

If you have **half a day**, pick:
- Lever 1 (persistent-loser cooldown) — biggest immediate $ saved, smallest code change
- Lever 5 (regime filter) — easy to add a `block_choppy` flag

If you have **a full day**:
- Lever 1 + Lever 3 (per-component forensics) — addresses both re-entry and entry-quality gaps

If you have **multi-day**:
- All of Lever 1, 3, 4, 6 — full deep-analysis tuning pass

## Reproduce / continue

Live state at this writing (post-3.9g replace-investor):
- 87 investor positions on live, 72 closed (25W/44L/3 flat = 36% WR)
- Σ +$32,356 realized
- 15 still open (will continue to manage via daily cron)
- Trader unchanged: 590 trades, +$40,020 realized

Continued forward observation will accumulate new live trades, broadening the dataset before the deep-analysis pass.

## Forensic-dry-run extensions to build

For Phase 4:

1. **`scripts/forensic-investor-loss-anatomy.mjs`** — mirror `forensic-th-dry-run.mjs` but for losing investor positions. Pull the daily score / stage / component snapshots from `portfolio_snapshots` + per-day daystate KV. Show per-position the score evolution; identify "should-have-exited" moments.

2. **Investor component logging table** — `investor_entry_components`:
   ```sql
   CREATE TABLE investor_entry_components (
     position_id TEXT PRIMARY KEY,
     ts INTEGER,
     ticker TEXT,
     score INTEGER,
     weekly_trend INTEGER,
     monthly_trend INTEGER,
     rs INTEGER,
     accum_signal INTEGER,
     trend_durability INTEGER,
     sector_context INTEGER,
     ichimoku_confirm INTEGER,
     momentum_health INTEGER,
     daily_st_bonus INTEGER,
     stage TEXT,
     accum_zone_type TEXT
   );
   ```

3. **Replay-replay test harness** — for each tuning lever, re-run the Jul→May backfill on preprod with the new config, compare WR + PnL deltas. Reproducibility: each run takes ~7 min, easy to iterate.

## Pointers

- Module: `worker/investor.js`
- Config loader: `loadInvestorConfig` in same file
- DA keys list: `worker/replay-runtime-setup.js` (`REPLAY_DA_KEYS`)
- Backfill script: `scripts/investor-backfill-jul-may.sh`
- Replace-live tool: `scripts/replace-live-investor-from-preprod.mjs`
- Existing forensic dry-runs: `scripts/forensic-{th,investor}-dry-run.mjs`
