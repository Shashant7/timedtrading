# Track B — Active Trader Engine Validation (kickoff 2026-06-15)

Separate from the foundation rebuild (own branch
`cursor/track-b-active-trader-validation-cbcd`). Validates/tunes the CURRENT
engine against live outcomes, now that the foundation gives fresh scores and the
replay harness is warm. Owed items from
`tasks/2026-06-12-never-stale-and-performance-review.md` (Part 5).

## Data sources (confirmed)
- **All closed trades:** live D1 `timed-trading-ledger` `trades` table (read-only).
  594 closed trades, **51% WR, +$38,929 net**. (NB: the `losing-trades-report`
  admin endpoint returns LOSERS ONLY — do NOT use it for WR/expectancy.)
- **Conviction components per trade are NOT stored** in the trade record
  (`signal_snapshot_json` has avg_bias/tf/gap/cvg/lineage/regime, not the
  conviction breakdown). Re-weighting (#2) therefore needs a **replay sweep**:
  re-score each ticker at its `entry_ts` and extract the conviction components,
  then correlate with `pnl`.

## Finding #1 — expectancy by exit lane (all 594 closed trades, live)

**Biggest LOSS lanes (fast-cut / risk tuning candidates, #3):**
| exit_reason | n | WR% | sum$ |
|---|---:|---:|---:|
| doctrine_force_exit | 58 | 7 | **-8,467** |
| HARD_LOSS_CAP | 14 | 0 | -5,867 |
| max_loss_time_scaled | 33 | 15 | -3,496 |
| max_loss | 19 | 11 | -3,249 |
| thesis_flip_htf | 42 | 17 | -2,932 |
| phase_i_mfe_fast_cut_2h | 15 | 0 | -1,876 |
| atr_day_adverse_382_cut | 26 | 12 | -1,768 |
| phase_i_mfe_fast_cut_zero_mfe | 12 | 0 | -1,644 |

**Biggest WIN lanes (working — protect/keep):**
| exit_reason | n | WR% | sum$ |
|---|---:|---:|---:|
| TP_FULL | 47 | 100 | +15,354 |
| HARD_FUSE_RSI_EXTREME | 22 | 91 | +14,262 |
| ST_FLIP_4H_CLOSE | 27 | 100 | +9,438 |
| sl_breached | 29 | 66 | +8,319 |
| peak_lock_ema12_deep_break | 19 | 95 | +5,747 |
| mfe_decay_structural_flatten | 32 | 91 | +5,163 |
| atr_week_618_full_exit | 33 | 76 | +4,649 |
| PROFIT_GIVEBACK_STAGE_HOLD | 36 | 94 | +3,358 |

### Reads
- **MFE ratchet (#1) is doing its job directionally:** the `phase_i_mfe_fast_cut_*`
  lanes show 0% WR (they exit positions already turning into losers — cutting
  dead money early), while the profit-protection side
  (`mfe_decay_structural_flatten` +$5,163 @ 91%, `peak_lock_ema12_deep_break`
  +$5,747 @ 95%) is strongly positive. The small negative on the fast-cut lanes
  is the cost of cutting early vs a larger loss — the intended trade-off. The
  equal-scope 60-day replay (still owed) quantifies the net counterfactual.
- **`doctrine_force_exit` is the single biggest bleed (-$8,467 @ 7% WR)** — the
  top candidate to investigate/tune (is it firing too late / on recoverable
  setups?).
- **`HARD_FUSE_RSI_EXTREME` (+$14,262 @ 91%)** is a star exit — keep/strengthen.

## Owed items + approach (next, on this branch)
1. **MFE ratchet 60-day equal-scope replay** (#1): run candle-replay over the
   last 60d with the ratchet on vs off; confirm the +$3,037 / +7pt-WR
   counterfactual + the Monday-RTH proof the open book isn't force-clipped.
2. **Conviction re-weighting** (#2): replay-sweep each closed trade's `entry_ts`,
   extract conviction components from `rank_trace_json`, correlate each with
   `pnl` (current overall corr ≈ -0.02), re-weight so the signal separates
   winners/losers; keep Tier-C suspended until it does.
3. **Fast-cut lane keep/loosen/kill** (#3): use the expectancy table above +
   the continuation table to decide per lane; the kill-switch + tunable windows
   already ship (`deep_audit_phase_i_fast_cut_*`).
4. **Short-shadow review** (#4): after ~2 weeks of `[SHORT_SHADOW]` logs.

## Wrap-up (2026-06-15) — what's done + what's handed off

### Done this session
- **Investor rebalance churn FIXED + deployed** (operator-reported IWM/TWLO
  Add-then-Trim). Root cause: a `watch`-stage position below `WATCH_ALLOC_PCT`
  got an auto-rebalance top-up (`auto_rebalance_watch` BUY) while the
  exhaustion-trim sweep locked in 20% on the same `watch`+exhaustion condition
  (`exhaustion_lock_in` SELL) in the SAME run/price — opposing signals, net a
  trim, pure noise. Fix: never ADD to a watch position that is exhaustion-flagged
  (the trim is the correct intent). Live, reversible via
  `INVESTOR_WATCH_ADD_EXHAUSTION_GUARD=off`.
- **Exit-structure read (594 trades):** healthy by construction — losers exit via
  STOPS (max_loss/HARD_LOSS_CAP/atr_adverse/thesis_flip, all correctly negative,
  small per-trade) and winners via PROFIT lanes (TP_FULL/HARD_FUSE_RSI/ST_FLIP/
  peak_lock/mfe_decay, strongly positive). 51% WR, +$38.9K net. **No rash
  keep/loosen/kill change warranted** — the MFE fast-cut lanes (0% WR) are
  cutting dead money as intended; the profit-protection ratchet lanes are the
  big winners (MFE ratchet #1 validated directionally).
- **Biggest single bleed = `doctrine_force_exit` −$8,467 @ 7% WR**, and **51/58 of
  those have `entry_path='(none)'`** (~49h holds). The bleed is concentrated in
  UNTRACKED-entry positions force-exited after ~2 days — ties directly to the R7
  entry-path-tracing item (#649). Action: trace/stamp those entry paths (R7) and
  re-examine whether doctrine_force_exit is too aggressive on them, BEFORE any
  config change.

### Handed off (needs the replay harness — own focused run)
- **MFE ratchet 60-day equal-scope replay** (#1): on-vs-off counterfactual +
  Monday-RTH no-clip proof. (Directionally validated by the exit-lane data here.)
- **Conviction re-weighting** (#2): replay-sweep each closed trade's `entry_ts`,
  extract conviction components from `rank_trace_json`, correlate with pnl
  (≈ -0.02 today), re-weight; Tier-C stays suspended until it discriminates.
- **Fast-cut final tuning** (#3): start with `doctrine_force_exit` on
  `(none)`-entry positions; needs the post-exit continuation table (replay).
- **Short-shadow review** (#4): after ~2 weeks of `[SHORT_SHADOW]` logs.

## Conviction re-weighting (#2) — method + readiness (2026-06-15)

**Goal:** re-weight the `computeConvictionScore` components so conviction
separates winners from losers (corr ≈ -0.02 today), which is the gate to
**un-suspend Tier-C** (`deep_audit_focus_suspend_tier_c`).

**Input READY:** 639 closed trades w/ `entry_ts` + `ticker` + `pnl`
(2025-07-01 → 2026-06-05, 323 wins = 50.5% WR) in live D1 `trades` (read-only).

**Why it needs a replay sweep:** conviction components are NOT persisted on the
trade (`signal_snapshot_json` lacks them). They must be reconstructed by
re-scoring each ticker at its `entry_ts` and reading the conviction breakdown
(`computeConvictionScore` components: liquidity, volatility, trend, sector, RS,
history, saty_atr_proximity, phase/RSI alignment, setup bonuses) from
`rank_trace_json`.

**Sweep plan (own focused run — substantial):**
1. Backfill pre-prod candles for the ~50+ traded tickers over 2025-07→2026-06
   (the harness needs complete history at each entry_ts). NB: the chain now
   provides this for LTF, but a deep daily/240 backfill is still needed.
2. For each trade, candle-replay-score the ticker as-of `entry_ts`; extract the
   conviction component vector.
3. Correlate each component (and the composite) with `pnl` / win-flag across the
   639 trades; rank components by discriminative power (point-biserial / AUC).
4. Re-weight (down-weight non-discriminating components, up-weight the
   separating ones); re-run the correlation to confirm separation improves.
5. Only then un-suspend Tier-C, config-gated, and watch live.

This is a multi-step harness analysis (hours of backfill + per-trade scoring),
best as a dedicated run — not a quick pass. Input + method are ready above.

## CADENCE FIX SHIPPED (2026-06-15 ~16:24 UTC) — root cause of "Active Trader stopped"
Diagnosis (live): **last entry 06-05, 10 days of ZERO entries.** Cause: the
conviction funnel was choked — **78% of the universe is Tier-C (203/259); 76% of
high-rank candidates (rank≥65) are Tier-C (87/114)** — and **Tier-C entries were
suspended** (`deep_audit_focus_suspend_tier_c`, default true). Conviction median
is **57/206** vs the tier cut (A≥110/B≥80/C<80), so almost everything lands in C;
and per the 60-day review conviction is **non-predictive (corr -0.02)** — so the
gate rejected ~3/4 of candidates WITHOUT filtering by quality.
**Fix:** un-suspended Tier-C live via `POST /timed/admin/model-config`
(`deep_audit_focus_suspend_tier_c=false`; in REPLAY_DA_KEYS + the lazy-load list
→ hot-reloads). Reversible. Cadence should resume on the next entry cron.

## ⚠️ CADENCE RE-DIAGNOSIS (2026-06-15 ~16:40 UTC) — the Tier-C theory is WRONG
Deeper live investigation overturns the prior premise. The 10-day entry stall is
NOT the conviction floor / Tier-C suspension:
- Market is **bullish** (SPY/QQQ HTF_BULL_LTF_BULL, regime 4) — not a regime block.
- **27 of 127** high-rank candidates pass the 80 floor (Tier B/A): CAT conv105,
  RTX 106, CW 104, EME 94, XLRE 99, UNH 85, GE 80 — prime bullish names that
  enter regardless of Tier-C. **Un-suspending Tier-C is redundant** with the 80
  floor (both reject conviction<80) and does NOT explain why these B/A names sit.
- Slots open (**3/6** positions). Portfolio risk breaker **off**
  (`block_new_entries=false`, only **23.3%** deployed, DD 0%). No pause/kill flag.
  No regime-shock directive.
So the blocker is **downstream in the per-ticker entry funnel**, not conviction.

### Strong suspect (defect, fix regardless): Phase-C Loop 1 stale scorecards
`loop1_specialization_enabled=true`, but `phase-c:scorecards` is **FROZEN at
2026-05-08** (>1 month stale). Loop 1 permanently enforces month-old, partly
degenerate verdicts: **blocks** `momentum_score:trending:pullback_player:L`
(wr=0% n=20), `ema_regime_confirmed_long:transitional:pullback_player:L` (0%),
`tt_ath_breakout:trending:pullback_player:L` (15%); **raise_bar** on 7 more
(tt_pullback:trending:* 36-38%, etc.). Only **6** LONG combos allowed (mostly
gap_reversal / volatile_runner). The scorecard updater appears to have stopped
feeding from live closes — a frozen learning gate is a bug.
CAVEAT: entries DID flow 06-02..06-05 with loop1 already blocking since 05-08, so
loop1 is not provably the SOLE 06-06 trigger — but stale enforcement is a real
defect that narrows the LONG funnel and must be repaired or disabled.

### Definitive next step (not yet done)
The only way to pin the exact per-candidate rejection is an **entry-explain
probe**: a read-only admin endpoint that runs `qualifiesForEnter` for a known
candidate (CAT/RTX) and returns the FIRST failing gate. Recommend building it
(read-only) before changing more knobs. Candidate levers once confirmed:
(a) repair the loop1 scorecard updater or set `loop1_specialization_enabled=false`
(reversible); (b) lower `deep_audit_focus_min_entry_conviction` (only if the floor
is confirmed to bind). Do NOT stack blind config flips.

### Changed this session (reversible)
- `deep_audit_focus_suspend_tier_c=false` (live) — approved; harmless + correct
  directionally, but per the above it is NOT the cadence fix on its own.

## CONVICTION REDESIGN (operator direction 2026-06-15) — make it predictive + CRO/CTO/CIO-aware

### Why conviction is broken today
`computeConvictionScore` (worker/focus-tier.js) uses an OLD component set
(liquidity, volatility, trend, sector, RS, history, saty_atr, phase, rsi, +
setup bonuses). Two failures:
1. **Structurally low:** the big components — `relative_strength` (0-25) and
   `history` (0-20, needs prior wins on the SAME ticker) — are ~0 for most names,
   so conviction lands ~57 and everything is Tier-C. The A/B/C cuts (110/80) were
   calibrated assuming those contribute; they usually don't.
2. **Non-predictive (corr -0.02):** the components don't separate winners/losers.

### Add the C-suite signals (the operator's insight — they're richer + already computed)
- **CIO** (`__cio_lifecycle_decision` / `__cio_loop2_override`): `edge_remaining`
  (0-1), `confidence`, `risk_flags`. → component `scoreCioEdge` (e.g. 0-20 from
  edge_remaining × confidence; penalty on risk_flags). This is the strongest
  candidate — the CIO already adjudicates edge.
- **CTO** (`cto_upside` / `cto_downside` targets): reward-to-risk to the CTO
  levels. → component `scoreCtoTargets` (0-15 from upside/downside skew).
- **CRO** (`cro_theme_rank_boost` / FSD / research sentiment): theme tailwind.
  → component `scoreCroTheme` (0-15 from theme rank + FSD).
These plug into computeConvictionScore as new component scorers, config-gated.

### Calibration: "see where conviction was wrong" (the replay sweep)
The method that answers it directly:
1. For each of the 639 closed trades, replay-score the ticker AS-OF `entry_ts` and
   capture conviction (old + new components) + the outcome (pnl, win).
2. **Reliability table:** bucket by conviction score (deciles) and tier → WR +
   avg pnl per bucket. This SHOWS where conviction was wrong: high-conviction
   buckets that lost, low-conviction buckets that won, monotonicity (should rise).
3. **Per-component discrimination:** point-biserial corr / AUC of each component
   (old AND new CIO/CTO/CRO) vs win. Rank; drop noise/inverted, up-weight
   separating ones (logistic fit → weights).
4. Re-score with new weights; confirm the reliability table is now monotone and
   composite corr > 0; re-calibrate A/B/C cuts to the actual distribution.
5. Re-enable Tier-C *selectively* (it's already on now as a stopgap) once the
   score discriminates.

### Tooling
`scripts/conviction-sweep.js` (this branch) is the runnable harness scaffold:
pulls closed trades, replays each at entry_ts on pre-prod, extracts the
conviction breakdown, writes `data/parity/2026-conviction-sweep.json`, and emits
the reliability table + per-component discrimination. Needs a pre-prod candle
backfill for the ~170 traded tickers over the trade window first (heavy — own
focused run).

## Guardrails
Config-gated, safe defaults, replay-validated before any live weight change.
Do NOT mix into the foundation PR. Keep on the #649 / Track B branch.
