# Lessons Archive (Moved from lessons.md)

> Run-specific analysis, config tuning sessions, and per-trade deep dives. Kept for reference.

---

## Saty Phase & ATR Exits — Bug Fixes [2026-03-13]

- **Phase exit "leaving" flags are instantaneous, not sticky**: `satyPhaseSeries()` compares `osc[last-1]` vs `osc[last]` to detect zone-leaving. This fires for ONE bar only. For 1H candles, the signal window is a single hour-long bar. If `processTradeSimulation` doesn't check during that exact interval, the signal is missed permanently. Fix: replaced instantaneous `leaving` detection with persistent **peak-decline tracking** in `execState`. Track `satyPhasePeak1H` and `satyPhasePeak30` (max directional oscillator value during the trade). Fire trim when peak was >= threshold AND current value has declined by a configurable amount. Configurable via `deep_audit_phase_peak_extreme` (80), `deep_audit_phase_decline_extreme` (30), `deep_audit_phase_peak_distrib` (50), `deep_audit_phase_decline_distrib` (25). [2026-03-13]
- **ATR Range Exhaustion thresholds were too strict**: Weekly displacement >= 1.0 ATR (full weekly ATR move) is very rare for intraday trades. Combined with dRangeOfATR >= 90% and PnL > 1.0%, the signal never fired in 421 trades. Fix: (1) Lowered weekly displacement from 1.0 to 0.786, secondary threshold from 0.618 to 0.500, dRangeOfATR from 90% to 70%. (2) Added daily horizon as independent signal source (dDisp >= 0.786 + dRange >= 70%, or dGateCompleted + dRange >= 80%). (3) Lowered PnL floor from 1.0% to 0.5%. [2026-03-13]
- **Backtest open positions bug — `<` vs `<=` comparison**: `full-backtest.sh` used `[[ "$END_DATE" < "$TODAY_KEY" ]]` to decide whether to close positions at end. When END_DATE equals today (the default when no end date specified), the comparison is false, and positions are kept open. This caused 37 phantom open positions in the saty-phase-atr-v1 backtest. Fix: always close positions at replay end unless `--keep-open-at-end` is explicitly set. [2026-03-13]

## RVOL Analysis & Multi-Factor Danger Score [2026-03-13]

- **RVOL was computed but never captured in trade artifacts**: `volRatio`, `rvol5`, `rvolSpike` computed per-TF in `computeTfBundle()`. `rvol_best` stored as column in `direction_accuracy`, but NOT included in trade-autopsy export, NOT in `signal_snapshot_json` lineage, NOT in `backtest_run_direction_accuracy` archive. All 86 prior backtest artifacts have zero RVOL data. Fix: added `rvol_best` + `entry_quality_score` to trade-autopsy query (both live and D1 paths), lineage snapshot (`rvol: { "30m", "1H", "D" }`), and backtest archival. [2026-03-13]
- **Retroactive RVOL analysis via TwelveData API**: Fetched 30m bars for 108 tickers, computed RVOL at each of 1,630 trade entries. Key finding: **RVOL 1.0–1.3 is the goldilocks zone (65.2% WR, +1.65% PnL)** — 9pp above overall 56.1%. High RVOL hurts: >1.3 = 50.7%, >1.8 = 49.3%, >2.5 = 51.6% WR. SHORTs with RVOL ≥1.3 had only 42.2% WR vs 58.6% for low-RVOL shorts. Correlation is weakly negative (r=-0.069). [2026-03-13]
- **RVOL ceiling gate (DA-11)**: System had a floor (dead zone) but no ceiling. Added `deep_audit_rvol_ceiling` (2.5 for LONGs) and `deep_audit_rvol_ceiling_short` (1.8 for SHORTs). RVOL between `high_threshold` (1.5) and ceiling reduces position to 50%. Verified: 13 blocks on July 1 replay. [2026-03-13]
- **Multi-factor danger score (DA-12)**: Composite of 7 factors from deep analysis of 431 trades. 0–1 danger signals = 73.9% WR; 3+ = 45.8% WR. Factors: Daily ST against (-25pp), 30m ST flat (-18.7pp), 1H EMA depth < 5 (-17pp), 4H ST against (-16.5pp), LTF ST flat (-16pp), VIX > 25 (-7.4pp), ST momentum < 3/5 TFs (-6.2pp). Trades exceeding `danger_max_signals` (3) are blocked; 2+ signals reduce size to 50%. Verified: 28 blocks on July 1 replay. [2026-03-13]
- **Danger score and RVOL are additive size reducers**: Both `__da_rvol_high_size_mult` and `__da_danger_size_mult` multiply against regime position size. A trade with high RVOL (0.5x) and 2 danger signals (0.5x) gets 0.25x size — preserving optionality while limiting risk. [2026-03-13]

## RSI Divergence + TD Sequential Awareness [2026-03-13]

- **TD Sequential counts captured in trade lineage**: Added `td_counts` to `buildTradeLineageSnapshot` with compact format `{ "15": { bp, bl, xp, xl }, "30": ..., "60": ..., "240": ..., "D": ... }`. Enables retroactive analysis of whether entries happen at exhaustion counts.
- **Retroactive TD count analysis (82 trades)**: LONGs entering when bearish prep count is 4-6 (building) have 26.3% WR vs 62.7% when fresh (0-3). LONGs aligned with bullish prep 4-6 have 71.4% WR. TD9 completion during trade shows modest improvement (52.9% vs 49.2% WR). Key insight: counter-exhaustion at entry is a strong negative signal.
- **RSI Divergence indicator (`detectRsiDivergence`)**: Uses `findSwingPivots` (existing function) + `rsiSeries` to detect bearish divergence (price higher-high + RSI lower-high) and bullish divergence (price lower-low + RSI higher-low). Returns `strength` (RSI gap in points) and `barsSince` (freshness). Only flagged `active` if `barsSince <= maxAge`. Exposed per-TF in `tf_tech.rsiDiv` and top-level `rsi_divergence` in `assembleTickerData`.
- **Divergence as danger score factor (DA-12 Factor 8)**: If LONG and bearish divergence active on 1H or 30m, increments `dangerCount`. If SHORT and bullish divergence active, same. Gated by `deep_audit_danger_div_enabled` config key.
- **RSI_DIVERGENCE fuse exit in trade management**: Sticky flag (`execState.rsiDivSeen`) — once divergence detected against open trade, it stays flagged. If untrimmed+profitable, trims to standard tier. If post-trim runner, tightens trailing stop to `deep_audit_div_runner_trail_pct` (1% default). Prevents the common pattern of entering on a pullback, trimming at the peak, then holding through the divergence-driven reversal to exit near BE.
- **Config keys**: `deep_audit_danger_div_enabled` (true), `deep_audit_div_exit_enabled` (true), `deep_audit_div_exit_min_strength` (3), `deep_audit_div_pivot_lookback` (5), `deep_audit_div_max_age_bars` (10), `deep_audit_div_runner_trail_pct` (0.01).
- **Mean Reversion TD9 Aligned entry path**: Implemented `detectMeanReversionTD9()` in `indicators.js` — fires when D+W+1H TD9 bullish aligned, Phase leaving accumulation/ext-down, RSI daily <= 30 + 1H <= 40, and at least 2/3 support conditions (daily FVG, weekly SSL, psych level). Feature-flagged via `deep_audit_mean_revert_td9_enabled` (default: false). Counter-trend sizing at 0.5x. Direction forced to LONG regardless of state. Helper primitives: `isNearPsychLevel()`, `td9AlignedLong/Short()`, `countRecentBearishFVGs()`.

## TD Sequential Entry Guard & Yield Optimization [2026-03-13]

- **Multi-TF TD analysis (82 trades, 5 TFs)**: Fetched 30m/1H/4H/D/W bars for all trade tickers. Key findings: (1) LTF bearish 4-6 at LONG entry → 26%/25% WR (counter-momentum), (2) D/W bearish 7-9 → 61%/58% WR (seller exhaustion = good for longs), (3) D+W both high prep ≥5 → 63.2% WR, (4) D TD9 bearish at entry → 80% WR (n=5), (5) Winners exit at D bearish prep avg=4.9 vs losses at 2.2.
- **Entry guard rewrite**: Original guard penalized D/W bearish exhaustion identically to LTF — this blocked exactly the trades that win most. Rewritten to: (a) only count 1H/4H as LTF exhaustion (block at 2+ TFs), (b) preserve D/W exemption for LONGs since seller exhaustion is favorable, (c) add panic guard at 4+ TFs all showing counter-prep ≥5 (41.2% WR, -1.05% avg PnL observed).
- **TD_EXHAUSTION_EXIT yield optimization**: Three-signal system wired into `processTradeSimulation`: (1) **D/W buyer exhaustion (bearish prep=9)** → trim if untrimmed+profitable, tighten trail to `deep_audit_td_exit_trail_pct` (1.5%) if post-trim. This is the INTU topping signal. (2) **LTF counter-prep building (30m/1H bearish ≥6 for LONG)** → tighten post-trim trail to `deep_audit_td_ltf_trail_pct` (2.0%). Early warning that selling pressure is building. (3) **4H favorable prep golden zone (4-6)** → HOLD signal tracked in `execState.td4hGoldenZone`. When active, momentum fade threshold raised from 2 to 3 signals, preventing premature exit during high-conviction moves (75% WR, +0.88% avg PnL).
- **Config keys**: `deep_audit_td_exit_enabled` (true), `deep_audit_td_exit_trail_pct` (1.5), `deep_audit_td_ltf_trail_pct` (2.0).

## TD Sequential Label Corrections & Candle Quality Insight [2026-03-13]

- **Label corrections in investor.js**: Several human-readable strings had bullish/bearish exhaustion labels swapped. Fixed: `bullish_prep` (price falling) = **seller exhaustion** (bounce potential). `bearish_prep` (price rising) = **buyer exhaustion** (drop potential). Scoring logic was already correct — only display strings were wrong.
- **TD9 candle quality on LTFs (observation)**: When a TD9 fires (prep count = 9), the quality of the completing candle matters — especially on 15m/30m. If in a LONG and 15m bearish TD9 fires but the candle is **bullish** (close > open), the exhaustion signal is weak — likely a recycled count that will reset for another countdown. If the candle is **bearish** (close < open), the exhaustion is confirmed by price action — more likely to see a pullback or mean reversion. This pattern is most observable on LTFs. **Future work**: capture candle polarity (close vs open) at TD9 completion and use it to weight signal strength in exit logic.

## Backtest Trade Autopsy: "Perfect Entry → Perfect Trim → Exit Too Late" Pattern [2026-03-13]

### Data (60 classified trades from October backtest)

**Entry evaluation breakdown:**
- `perfect_timing`: 31 trades, 90.3% WR, $58.71 avg PnL — **entry engine is working**
- `late_entry`: 26 trades, 46.2% WR, -$9.60 avg PnL — chasing hurts
- `chasing`: 13 trades, 38.5% WR, -$13.41 avg PnL — worst entry type
- `not_enough_confirmation`: 9 trades, 11.1% WR — almost always loses

**Trade management breakdown:**
- `perfect_trim`: 33 trades, 78.8% WR, $37.80 avg — **trim logic is working**
- `perfect_exit`: 10 trades, 90% WR, $48.71 avg — gold standard
- `exited_too_late`: 24 trades (40% of all!), 62.5% WR, $20.44 avg — **#1 problem**
- `exited_too_early`: 11 trades, 90.9% WR, $65.92 avg — early exit still profitable

### The Core Problem
24/60 trades (40%) classified as "exited too late." Even when trades win, they only capture a fraction of the available move:
- **Avg MFE capture: 31.4%** on perfect-entry + perfect-trim + exited-too-late trades
- **Avg time from trim to exit: 83.5 hours** (3.5 days!)
- **21/24 exited via `sl_breached`** — the stop eventually gets hit after giving back most gains
- Trades like AWI: MFE=2.21%, final PnL=+0.08% (4% capture). FIX: MFE=5.17%, final PnL=-0.12% (negative capture!)

### Root Cause
After the first trim, the "runner" portion sits with:
1. `deep_audit_runner_trail_pct = 2.0%` trailing from peak — too wide for small-cap swing trades
2. `deep_audit_post_trim_trail_pct = 2.0%` — same problem for pre-runner trimmed positions
3. **`deep_audit_stale_runner_bars = 0` (DISABLED!)** — the stale runner timer that would snap SL tight when the move stalls is completely off
4. No mechanism to recognize the new swing high after trim as a natural exit point

### The Fix: Tighter Post-Trim Exit Management
1. **Enable stale runner timer**: Set `deep_audit_stale_runner_bars` to 16 (4 hours of 15-min bars). If the post-trim peak hasn't updated in 4 hours, snap SL to 0.25x ATR from current price. This catches the exact "consolidation after swing high" pattern.
2. **Tighten post-trim trail**: Reduce `deep_audit_post_trim_trail_pct` from 2.0% to 1.5%. The data shows winners peak quickly then consolidate — 2% gives back too much.
3. **Tighten runner trail**: Reduce `deep_audit_runner_trail_pct` from 2.0% to 1.5%. Same logic — the runner phase also bleeds gains.

### Why Not Exit Earlier?
`exited_too_early` trades actually had the best avg PnL ($65.92) and 90.9% WR. The system is too cautious about locking in profits after the swing high post-trim. The data strongly says: **lock it in faster.**

## Backtest-Driven System Tuning: 6 Fixes Applied [2026-03-10]

Based on 60 classified trades from October backtest and auto-recommendation analysis (27 findings):

### 1. SOFT_FUSE_RSI — Lower Arm Threshold (code)
- **Before**: RSI 1H >= 75 (LONG), <= 25 (SHORT)
- **After**: RSI 1H >= 70 (LONG), <= 30 (SHORT)
- **Why**: SOFT_FUSE_RSI_CONFIRMED was the best exit signal (100% WR) but only triggered 5x. Lowering threshold by 5 pts catches more swing highs before they reverse. The "exit too late" pattern (40% of trades) occurs because RSI peaks at 70-74 and doesn't quite reach 75.

### 2. Multi-TF RSI Chase Gate — Tightened (code)
- **Before**: Block LONG when 2+ of (30m, 1H, 4H, D) have RSI > 68
- **After**: Block LONG when 2+ TFs have RSI > 65, SHORT when 2+ TFs have RSI < 35
- **Why**: `late_entry` (46% WR, -$9.60 avg) and `chasing` (38% WR, -$13.41 avg) are the two worst entry classifications. Tightening by 3 pts catches entries where 2+ TFs are already extended.

### 3. Investor Engine — Reduce Threshold Lowered (code)
- **Before**: `investorScore < 50` → stage "reduce" → exit
- **After**: `investorScore < 40` → stage "reduce" → exit
- **Why**: Investor engine had 17.2% WR and -$2,575 total. Positions enter at score >= 70 but score can oscillate to 49 next day, triggering immediate exit. Scores 40-50 now route to "watch" stage (existing 50-65 catch), giving positions time to recover from normal fluctuations.

### 4. VIX Ceiling — Enabled (D1 config)
- **Before**: `deep_audit_vix_ceiling = 0` (disabled)
- **After**: `deep_audit_vix_ceiling = 30`
- **Why**: Analysis showed VIX > 25 correlated with significantly worse outcomes. Size reduction already exists at VIX 25 (0.75x) and 35 (0.5x), but no hard ceiling. Now blocks all new entries when VIX > 30.

### 5. Avoid Hours — Added Noon (D1 config)
- **Before**: `deep_audit_avoid_hours = [13]` (1 PM ET only)
- **After**: `deep_audit_avoid_hours = [12,13]` (noon + 1 PM ET)
- **Why**: Midday chop (12-1 PM ET) produced the worst entries in the backtest. Both hours now blocked.

### 6. SHORT Entry Gate — Relaxed (D1 config)
- **Before**: `deep_audit_short_min_rank = 70`
- **After**: `deep_audit_short_min_rank = 60`
- **Why**: Zero SHORT trades taken in the backtest. The rank threshold of 70 was too restrictive given that most tickers don't score that high on bearish signals. Lowering to 60 allows the system to take high-confidence SHORT entries.

### Combined with previous session's exit fixes:
- `deep_audit_stale_runner_bars`: 0 → 16 (enabled)
- `deep_audit_post_trim_trail_pct`: 2.0% → 1.5%
- `deep_audit_runner_trail_pct`: 2.0% → 1.5%

## Investor Signal Integration [2026-03-10]

- **Momentum Health scoring adjustment**: Added `momentumHealth` component (-10 to +5 pts) to `computeInvestorScore`. Penalizes: weekly bearish divergence (-8), D/W TD bearish prep ≥7 (-5), weekly Phase distribution (-3), daily EMA regime ≤-2 (-4). Rewards: weekly Phase accumulation (+5). Prevents high scores on tickers at exhaustion points.
- **Accumulation zone signal enrichment**: Enhanced `detectAccumulationZone` with weekly bullish divergence (+25 confidence), TD seller exhaustion (+15), Phase accumulation (+20), and penalties for bearish divergence (-20) and daily buyer exhaustion bounce (-15). Provides better confirmation that a dip is a buying opportunity vs the start of a larger decline.
- **Stage classification signal overrides**: `classifyInvestorStage` now downgrades to `watch` on weekly bearish divergence, weekly TD buyer exhaustion (prep ≥8), or weekly Phase leaving distribution. Upgrades `watch` → `core_hold` when weekly bullish divergence is active (selling pressure weakening — hold, don't reduce).
- **Adaptive trailing stop**: Investor exit logic tightens trail from 3x ATR to 2x ATR when topping signals fire (weekly TD bullish prep ≥7, weekly bearish divergence, or weekly Phase distribution+leaving). Protects gains as exhaustion signals mount.
- **Signal-based profit trim**: Core hold positions with ≥5% profit auto-trim 20% when topping signals fire, locking in gains before potential reversal.
- **DCA divergence gate**: Skips DCA buys when daily bearish RSI divergence is active, preventing dollar-cost averaging into deteriorating momentum.
- **Thesis enrichment**: `generateThesis` now includes dynamic sentences for divergence ("uptrend may be losing steam"), TD exhaustion ("selling pressure elevated"), Phase accumulation ("favorable entry timing"), and distribution warnings. `checkThesisHealth` detects new invalidation conditions: weekly divergence confirmed with SuperTrend breakdown, and dual D+W buyer exhaustion.
- **Key principle**: All signals are adjustments to the existing Weekly/Monthly SuperTrend + RS + Ichimoku foundation, not replacements. They refine timing (when to accumulate, trim, tighten stops) rather than changing fundamental trend assessment.

## Phase 3+4 Indicator Tuning & SHORT Enablement [2026-03-10]

### Phase 4: Entry/Exit Indicator Tuning

**TD Sequential entry block (code)**
- **Before**: Block only when BOTH 1H and 4H show exhaustion (prep >= 7 or leadup >= 8)
- **After**: Block when ANY single TF at 1H or 4H shows exhaustion
- **Why**: Backtest showed LTF (30m/1H) bearish prep at LONG entry → 25-26% WR. Even one TF signaling exhaustion is predictive.

**Phase exits expansion (code)**
- PHASE_LEAVE_100: peak threshold 80 → 70, decline threshold 30 → 25
- PHASE_LEAVE_618: peak threshold 50 → 40, decline threshold 25 → 20
- Runner close now fires after TRIM-level (33%+), was EXIT-level (66%+)
- **Why**: PHASE_LEAVE_100 was the best single trade ($252, 100% WR) but fired only once. Lower thresholds catch momentum exhaustion earlier.

**RSI divergence trim (code)**
- Added 4H timeframe to divergence scan (was only 1H + 30m)
- Lowered minimum strength from 3 to 2
- **Why**: Divergence already had correct logic but was too conservative. 4H divergence is a stronger structural signal.

**4H SuperTrend flip as exit signal (code)**
- Added `st_flip_bull` flag in indicators.js (was never set — SHORT exits broken)
- Added `st_flip_4h` flag tracking
- New fuse exit: `ST_FLIP_4H_CLOSE` — closes runner when 4H ST flips against direction post-trim
- New fuse trim: `ST_FLIP_4H_TRIM` — trims when untrimmed and 4H ST flips
- **Why**: 4H ST flip is a structural break. Previously only 30m/1H flips triggered the weaker Kanban trim. Now 4H flip is a full exit signal for runners.

### Phase 3: Enable SHORT Trades

**CHOPPY regime (indicators.js)**
- `shortsAllowed`: false → true
- `shortRvolMin`: Infinity → 1.5
- SHORTs in CHOPPY now require RVOL >= 1.5 (institutional selling visible) plus all existing quality gates (minHTFScore 25, minRR 3.0, maxCompletion 0.30)

**TRANSITIONAL regime (indicators.js)**
- `shortRvolMin`: 1.3 → 0.7
- **Why**: Old 1.3 threshold was too restrictive; most tickers don't see RVOL > 1.3 on normal bearish moves.

**Bearish momentum path (index.js)**
- `HTF_BEAR_LTF_BEAR` now uses proper bearish signals: `st_flip_bear`, `hasEmaCrossBear`, `hasSqRelease`
- **Before**: Used bullish signals (`hasStFlipBull`, `hasEmaCrossBull`) even for bearish momentum — SHORT entries were structurally broken
- New path: `momentum_score_short` with reason `momentum_bear_with_signal`

**`deep_audit_short_min_rank`** (D1 config, applied in prior session): 70 → 60

## Smart Runner Exit Engine + Danger Score Bug Fix [2026-03-10]

### CRITICAL BUG: Inverted SuperTrend danger scoring

**`dirSign` in danger scoring system (index.js line ~2541)**
- **Before**: `const dirSign = isLong ? 1 : -1;`
- **After**: `const dirSign = isLong ? -1 : 1;`
- **Impact**: Pine convention uses `stDir = -1` for bullish, `stDir = 1` for bearish. The old code used `dirSign = 1` for LONG, which caused three danger factors (Daily ST, 4H ST, ST alignment count) to fire on ALIGNED SuperTrend and MISS OPPOSED SuperTrend.
- **Evidence**: 4 of 10 losses (-$1,209, 80% of total loss) entered LONG with 4H ST bearish. The danger system was supposed to catch these but didn't because the check was inverted.
- **Affects**: Danger Factors 1 (Daily ST), 4 (4H ST), and 7 (multi-TF ST alignment count).

### Smart Runner Exit Engine (new)

**Problem**: 20 of 56 wins exited via `sl_breached` after trim, averaging $49 and dragging 41 hours. The 33% trim captured a small slice; the 67% runner gave it back.

**Part 1: Raise trim from 33% to 66% (index.js)**
- `THREE_TIER_DEFAULTS.TRIM.trimPct`: 0.33 → 0.66
- `THREE_TIER_DEFAULTS.EXIT.trimPct`: 0.66 → 0.90
- **Why**: Simulation showed 66% trim adds +3.1% total PnL by locking in more at first target. The 34% runner is now a "free lottery ticket."

**Part 2: `evaluateRunnerExit()` function (index.js)**
- Runs every bar after trim for the remaining 34% runner position.
- Returns `{ action: "hold"/"close"/"tighten", reason }`.
- Evaluates 5 price-action conditions using signals already on `tickerData`:
  1. **Squeeze detection** (checked first): If 30m or 1H squeeze is on → HOLD. Compression precedes expansion. If squeeze releases against trade direction → CLOSE.
  2. **Swing high/low failure**: Price approached previous daily swing pivot (within 0.5×ATR) but failed to break → CLOSE. Confirmed by 1H ST flip or RSI declining.
  3. **Support/resistance break**: LONG breaks below 1H Ripster c34_50 cloud AND 30m ST flips bearish → CLOSE. Replaces arbitrary trailing % with structural support.
  4. **TD Sequential exhaustion**: 1H or 4H counter-direction prep count >= 7, combined with RSI or phase declining from peak → CLOSE.
  5. **Momentum consensus flip**: `swing_consensus.direction` opposes trade AND fuel is "critical" → CLOSE.
- Fires AFTER existing fuse exits (PHASE_LEAVE, SOFT_FUSE, ST_FLIP, RSI_DIV, TD_EXHAUST) but BEFORE trailing SL.
- Gated by `smart_runner_min_bars_post_trim` (default 4 bars = 1 hour) to give runner a chance.

**Config keys added to model_config:**
- `smart_runner_exit_enabled`: true (toggle)
- `smart_runner_swing_atr_proximity`: 0.5 (ATR multiplier for swing approach detection)
- `smart_runner_min_bars_post_trim`: 4 (grace period after trim)

### Loss Autopsy Summary (backtest 2025-07 through 2025-12)

| Category | Trades | PnL | Root Cause | Fix |
|---|---|---|---|---|
| LONG w/ 4H ST bearish | 4 | -$1,209 | Inverted danger dirSign | Bug fix |
| Low R:R (< 1.5) | 3 | -$535 | R:R gate bypass | Covered by danger fix |
| Acceptable small losses | 3 | -$80 | Normal trading | N/A |

Key stat: SHORTs performed strongly (83% WR, +$2,508 PnL), validating the Phase 3 SHORT enablement.

### Follow-up: dirSign Revert — "Bug" Was a Feature

**First rerun with corrected dirSign** produced 362 trades at 57.7% WR ($978 PnL). **Second rerun** with `danger_max_signals=2` produced 298 trades at 54.4% WR (-$1,406 PnL). Both dramatically worse than baseline (49 trades, 79.6% WR, $20K PnL).

**Root cause analysis**: The "inverted" dirSign (`isLong ? 1 : -1`) was accidentally creating a powerful pullback-only entry filter. In Pine convention, bullish stDir=-1. The old code penalized entries where SuperTrend was aligned (stDir=-1 for LONG → `-1 !== 1` → danger fires). In a trending market, most LONG entries have bullish ST alignment, so the danger system blocked ~85% of entries. Only deeply pulled-back setups (where LTF ST temporarily flipped bearish) could pass with low danger counts.

**Decision: REVERT dirSign** to `isLong ? 1 : -1` (the original "bug"). The accidental pullback filter was producing 80% WR. The correct convention (`isLong ? -1 : 1`) floods the system with 6x more entries that other gates can't adequately filter. Revert `danger_max_signals` to 3 as well.

**Key lesson**: Not all "bugs" should be fixed. When an accidental behavior produces excellent results, understand WHY it works before changing it. The inverted dirSign acted as a structural pullback filter — an extremely valuable property for a swing trading system.

### Pullback Support Shield (2026-03-14)

**Problem**: Trades with good entries and trims were exiting during healthy pullbacks that tested and held the 15m SuperTrend or 72-89 Ripster cloud. The smart runner exit fired `support_break_cloud`, `swing_high_failure`, or `momentum_flip_fuel_critical` prematurely because it only checked 1H/30m structure — not the intraday support levels that actually mattered.

**Fix**: Added a pullback support shield to `evaluateRunnerExit()` that checks 4 levels before allowing any close signal:
1. **15m SuperTrend** — if still aligned with trade direction and price holds it (±0.1 ATR tolerance)
2. **15m 72-89 cloud** — if price is above cloud bottom (LONG) or below cloud top (SHORT)
3. **15m 34-50 cloud** — secondary support (tighter tolerance ±0.05 ATR)
4. **30m 72-89 cloud** — broader structural support

If ANY of these hold, close signals from conditions 1 (swing failure), 2 (1H cloud break), 3 (squeeze release against), and 5 (momentum flip) are overridden to HOLD. Condition 4 (TD exhaustion) is NOT overridden — exhaustion is structural.

Also widened trail percentages: `runner_trail_pct` 1.5% → 2.5%, `post_trim_trail_pct` 1.5% → 2.5% to give normal pullbacks room.

### Position Sizing Uplift (2026-03-14)

**Problem**: Wins and losses were miniscule despite good entries. Previous live protected run: 57% WR, $14k+ P&L. Backtest: similar WR but tiny $ amounts. Root cause: tier risk percentages too conservative (Prime=1%, Confirmed=0.5%, Speculative=0.25%).

**Fix**: Doubled all tier risk percentages — Prime=2%, Confirmed=1%, Speculative=0.5%. Updated `grade_risk_map` proportionally (A+=2000, A=1700, etc.). Raised `MIN_NOTIONAL` $500→$1000, `MAX_NOTIONAL` $8k→$20k. Position cap remains at 20% of account to prevent concentration risk.

**Baseline saved**: `data/baseline-config-snapshot.json` + git tag `baseline-good-entries-20260314`.

### B to A+ Exit Intelligence Upgrade (2026-03-15)

**Problem**: 70% WR with good entries but only capturing 56% of available MFE (avg 1.61% of 3.24% MFE). Three specific exit weaknesses:
1. CLOUD_BREAK exits at 29% capture efficiency — closing on 1H cloud + 30m ST without checking 4H structure
2. Trades reaching 1%+ MFE without trimming, then reversing into -$1,175 in losses
3. Runner blowups (RKLB -31%, HOOD -15%) with no drawdown cap from peak

**Fixes applied**:
1. **4H SuperTrend gate on CLOUD_BREAK and SQUEEZE_RELEASE**: If 4H ST still supports the trade direction, demote close → "defend" (tighten trail to 1x ATR). Only close if 4H confirms the break.
2. **MFE Safety Trim**: Force 66% trim when unrealized P&L >= 1.2% and position is untrimmed. Config: `deep_audit_mfe_safety_trim_pct = 1.2`.
3. **Runner Circuit Breaker**: Close runner immediately if drawdown from peak >= 8%. Config: `deep_audit_max_runner_drawdown_pct = 8`.
4. **Adaptive Trail**: Runner ATR multiplier is now 3.0x when 4H supports, 1.5x when 4H breaks (replaces static 2.5x).

**Results** (exit-upgrade-v1, Jul-Dec 2025):
- Win Rate: 69.3% → **71.3%** (+2 pp)
- P&L: $4,217 → **$5,356** (+27%)
- Avg Loss: -$170 → **-$159** (improved)
- Profit Factor: 1.71 → **2.08** (+22%)
- Account Uplift: 4.2% → **5.36%** (on $100k starting balance)
- CLOUD_BREAK wins: 18 → 9 (trades now hold longer, exit via PHASE_LEAVE instead)
- PHASE_LEAVE wins: 28 → 34 (+6 trades captured at higher efficiency)
- Losses: 35 → 31 (-4 fewer losses)

### Exit Upgrade v2: Bug Fixes + Safety Nets (2026-03-15)

**Problem**: RKLB trade lost -$1,088 despite circuit breaker being in place. Root cause:
1. MFE Safety Trim trimmed 66% but did NOT set a protective stop — runner bled out with no floor
2. Circuit breaker tried to set SL to current mark, but the SL-tightening guard rejected it (can't move stop "downward" for longs)
3. Low Entry Quality trades (EQ<55) net -$583 ($1,835 in losses vs $1,252 in wins)

**Fixes applied**:
1. **Circuit Breaker moved to direct-close**: Now runs before evaluateRunnerExit and calls `closeTradeAtPrice` directly instead of trying to set SL through the guard
2. **MFE Safety Trim sets protective stop**: After trimming, calls `selectPostTrimProtectiveStop()` and sets SL to at least entry price (breakeven)
3. **Entry Quality gate**: Block entries with EQ < 55. Config: `deep_audit_min_entry_quality = 55`
4. **Per-trade hard loss cap**: Close any trade losing >= $300. Config: `deep_audit_hard_loss_cap = 300`
5. **Relaxed entry gates to increase trade volume** (108 trades in 6 months was too low):
   - `calibrated_rank_min`: 55 → 40
   - `deep_audit_min_htf_score`: 0.4 → 0.25
   - `deep_audit_min_1h_bias`: 0.25 → 0.15
   - `deep_audit_min_4h_bias`: 0.25 → 0.15
   - `deep_audit_ltf_rsi_floor`: 45 → 38
   - `deep_audit_min_ltf_ema_depth`: 5 → 3
   - `deep_audit_danger_max_signals`: 3 → 4
   - Per-path rank minimums: confirmed 50→35, breakout 70→50
   - Removed redundant EQ<55 smart gate (already enforced by vol-tier EQ gate in qualifiesForEnter)
6. **Added blocked-entry diagnostics**: Replay now tracks every gate rejection reason and reports cumulative stats at backtest end

### Calibrated-v3: Signal Journey + Liquidity + SHORT Fixes (2026-03-15)

**Findings from deep analysis of 219 trades (clean-launch-v1 backtest)**:

#### Entry Quality Inversion (FIXED)
- Old EQ formula rewarded full alignment across all TFs — but best entries happen on PULLBACK RECOVERY when LTF is still recovering from bearish
- Winners: EQ avg 73.86 vs Losers: EQ avg **77.63** (inverted!)
- New formula: HTF Foundation (30 pts: 4H+D alignment), LTF Recovery (35 pts: rewards pullback recovery, penalizes full alignment), Confirmation (35 pts: regime+phase+RSI)
- Key pattern: `pullback_recovery` (1H ST bearish, 15m flipping bullish) gets highest LTF Recovery score

#### 1H SuperTrend "Late Entry" Signal (APPLIED)
- Confirmed losers: 83% entered with 1H ST already bullish vs 65% of winners
- Untrimmed trades (14% WR): 80% had 1H+30m both bullish at entry
- Fix: Downgrade confidence (affects sizing/grade) when 1H+30m fully extended

#### Stall Force-Close (ADDED)
- Untrimmed trades: 85 trades, 14.1% WR, -$10,340 P&L (the #1 drag)
- Confirmed untrimmed: 49 trades, 6.1% WR — essentially guaranteed losers
- Fix: Force-close untrimmed trades after 36 hours. Config: `deep_audit_stall_force_close_hours = 36`

#### SHORT Logic Bugs (FIXED)
1. **DA-4 HTF gate blocked ALL shorts**: `htf < daMinHtf` with daMinHtf=0.25 blocks all negative HTF (all shorts). Fixed to be direction-aware.
2. **ema_regime_early_short used `hasStFlipBull`**: Bullish ST flip as confirmation for SHORT = wrong direction. Fixed to `flags.st_flip_bear`.
3. **GOLD SHORT relaxed**: Thresholds lowered from htf>=35 to htf>=30, added RSI divergence as confirmation.

#### Setup Lead-Up Phase (ANALYSIS COMPLETE, IMPLEMENTATION PLANNED)
Current system only captures signals AT entry, not the build-up before. Missing:
- TD9 reversal in opposite direction (SP=9 before LONG = powerful reversal signal)
- RSI extreme recovery (recent extreme + bounce = ideal entry window)
- Phase oscillator completion (satyPhase leaving signal = move exhausted)
- ST flip freshness (3-15 bars since flip = recovery window)
- Per-ticker personality (base-builder vs breakout vs mean-revert)

#### Liquidity Zone Integration (IMPLEMENTED — 2026-03-15)

**Evidence** (231 trades, full 4H candle backfill — 126,263 bars, 203 tickers):
- 4H 3+ pivot zones: 74% coverage, $352/trade P&L delta (zone reached: +$219 vs NOT: -$133)
- MFE hit rate: 68% of trades had peak price reach the zone (we just exited too early)
- Congested entries (<0.5 ATR from zone): 48.5% WR vs 56.8% for entries with room
- "What if" zone-based exits: +$2,983 additional P&L on same entries

**Changes applied** (`worker/indicators.js`, `worker/index.js`):

1. **Phase 1A — Persist liquidity in snapshots**:
   - Expanded `liq_4h` to include full `buyside`/`sellside` zone arrays
   - Added `liq_W` (Weekly) to `assembleTickerData`
   - Added compact `liq` snapshot to `buildTradeLineageSnapshot` (4H/D/W distances + counts)

2. **Phase 1B — EQ congestion penalty** (`computeEntryQualityScore`):
   - New `liqData` parameter, 4H primary / Daily fallback
   - -10 pts when <0.5 ATR from zone (congested), -5 pts at 0.5-1.0 ATR
   - +5 pts when 1.5-4.0 ATR (ideal room to run)

3. **Phase 1C — Runner management** (`evaluateRunnerExit`):
   - Computes nearest 4H liquidity target (buyside for LONG, sellside for SHORT)
   - `liq_zone_approach`: tighten trail when within 0.3 ATR of zone
   - `liq_zone_swept`: tighten trail when price moves 0.5+ ATR past zone

4. **Phase 1D — Entry rejection filter** (`qualifiesForEnter`):
   - Blocks entries within 0.5 ATR of 3+ pivot zone when momentum is weak
   - Logged to `_replayBlockedEntries` for backtest diagnostics

#### Setup Lead-Up Phase / Lookback Features (IMPLEMENTED — 2026-03-15)

**Gap identified**: System only captured signals AT entry, missing the "stalking" build-up phase (TD9 reversals, RSI extreme recovery, Phase completion, ST flip freshness).

**Changes applied** (`worker/indicators.js`):

1. **Phase 2A — Lookback features in `computeTfBundle`**:
   - `rsiWasExtremeLo15` / `rsiWasExtremeHi15`: RSI hit extreme in last 15 bars + recovered
   - `stFlipFresh`: SuperTrend flipped 3-15 bars ago (ideal recovery window)
   - Returned as `lookback` object on each bundle

2. **Phase 2B — Lookback bonus in `computeEntryQualityScore`**:
   - +5 pts for TD9 opposite exhaustion (opposing setup recently completed)
   - +4 pts for RSI extreme recovery
   - +3 pts for fresh ST flip on leading TF
   - Capped at +12 pts total

#### Investor Mode Improvements (IMPLEMENTED — 2026-03-15)

**Gaps identified**: Daily ST not in scoring, peak_price reset daily, no D/W/M alignment gate.

**Changes applied** (`worker/investor.js`, `worker/index.js`):

1. **Daily SuperTrend scoring**: +5 pts when D+W both bullish, +3 pts when D only
2. **Persistent peak_price**: Schema migration (`v2`), high-water mark tracked across all scoring cycles for accurate trailing stop
3. **D/W/M SuperTrend alignment gate**: Monthly bearish = hard block on new entries, require 2/3 bullish minimum

#### TD Sequential Replay Gap (FIXED — 2026-03-16)

**Critical bug discovered**: `computeTDSequentialMultiTF()` was NEVER called during candle-replay backtests. Only the synchronous `assembleTickerData()` was used (line 3354, indicators.js), which does NOT compute TD Sequential. The async `computeServerSideScores()` (which DOES compute it) was only used in live scoring.

**Impact**:
1. TD exhaustion entry gate was completely bypassed during all backtests (always null `td_sequential.per_tf`)
2. TD-based exit logic (runner TD exhaustion, deep audit TD exit) operated on empty/stale data
3. Entry + exit snapshots had stale td_counts carried from initial KV state via `...base` spread — **this is why exit TD counts matched entry counts exactly** (user spotted this on LRN, NXT, BE trades)
4. All TD Sequential exhaustion signals were invisible to the backtest engine

**Fix**: Added `computeTDSequentialMultiTF()` call in the replay loop right after `assembleTickerData()`, using sliced candles from `candleCache`. Added endIdx-based cache to skip recomputation when candle counts haven't changed (avoids performance hit on 5min intervals where D/W/M candles don't change).

#### Same-Direction Exhaustion Gate (ADDED — 2026-03-16)

**Pattern observed**: LRN LONG (9/9/25), NXT LONG (9/11/25), BE LONG (9/29/25) all entered when XP (bearish_prep) was 5-6 on 4H/D. This means the bullish move had been running for 5-6 bars of higher closes — approaching TD9 Sell. All three reversed immediately after entry, hitting max_loss.

**Root cause**: The existing TD guard only blocked counter-direction exhaustion with threshold >= 7 on 1H/4H. LRN had XP=5 (below 7) and only 2 TFs hit (needed 4 for panic gate).

**Fix**: Added **Guard 1 (Same-direction exhaustion / move topping)**: For LONG, blocks when bearish_prep >= 5 on 2+ of 1H/4H/D. For SHORT, blocks when bullish_prep >= 5 on 2+ of 1H/4H/D. Also lowered LTF counter-momentum threshold from 7 to 6, and panic gate threshold from 4 TFs to 3.

**Key learning**: `bearish_prep_count` counts consecutive bars closing higher than 4 bars ago. High XP at LONG entry = entering late in an up move that's approaching TD9 Sell. The model must detect "topping" before entering, not just look for counter-direction signals.

#### Zero SHORT Trades — Comprehensive Fix (2026-03-16)

**Problem**: Across 6+ months of backtesting (multiple runs), the model produced ZERO short trades despite having SHORT entry paths defined.

**Root causes found (5 issues)**:
1. **BEARISH pattern boost missing**: `classifyKanbanStage` only promoted watch→setup for BULLISH patterns. Bearish patterns never got the confidence boost needed to reach "enter" stage.
2. **`deep_audit_block_regime: ["EARLY_BEAR"]`** blocked ALL entries in EARLY_BEAR regime — the exact regime where SHORT opportunities appear. Gate was direction-blind.
3. **`mean_revert_td9` hardcoded to LONG**: Direction resolution in `processTradeSimulation` forced all mean_revert paths to LONG regardless of signal direction. `detectMeanReversionTD9` also had no SHORT counterpart.
4. **Sector-specific EQ adjustments only for LONG**: SHORT entries in historically bearish sectors (Financials, Growth, Tech) got no EQ relaxation.
5. **Cumulative SHORT gates too restrictive**: RVOL ceiling, 21-EMA gate, short rank minimum all stack up.

**Fixes applied**:
- Added BEARISH pattern boost + watch→setup promotion in `classifyKanbanStage`
- Made `deep_audit_block_regime` direction-aware: bear regimes allow SHORT, block LONG
- Added `detectMeanReversionTD9Short()` in indicators.js (mirrors LONG version with RSI > 70, phase leaving ext-up, resistance confluence)
- Direction resolution now reads `mean_revert_td9.direction` instead of hardcoding LONG
- Added sector-specific EQ adjustments for SHORT entries (Financials -5, Growth/Tech -3)
- Fixed kanban meta to display bearish pattern names (was always showing `bestBull.name`)

#### SPY Directional Regime Gate (ADDED — 2026-03-16)

**Problem**: The model kept entering LONG trades during market-wide pullbacks (Oct/Nov/Dec pattern). The regime system was direction-agnostic — a strong bear trend was classified as "TRENDING" (not blocked), and SPY's swing regime direction was never checked.

**Root causes**:
1. `regime_class` only measures trend strength (TRENDING/CHOPPY), not direction
2. Three-tier gate only blocks CHOPPY, never BEAR
3. SPY's `regime.combined` (EARLY_BEAR, STRONG_BEAR) was never used to gate entries
4. VIX ceiling defaulted to 0 (disabled)

**Fixes applied**:
- Added SPY directional regime gate: blocks LONG when SPY HTF < -15, EMA regime daily <= -1, or swing combined includes "BEAR". Blocks SHORT when SPY is bullish. Gold paths exempt (counter-trend by design).
- Enriched `_marketRegime` object with SPY's `htf_score`, `ema_regime_daily`, `swing_dir`, and `combined` (both live and replay paths)
- Ensured SPY is always processed first in replay (`allTickers.unshift("SPY")`)
- Set default VIX ceiling to 32 (blocks all entries in extreme fear)

**Key learning**: A direction-agnostic regime system is fundamentally insufficient. "TRENDING" must distinguish bull vs bear. The model needs a market-level directional overlay that prevents entering LONG when the broad market is bearish, regardless of individual ticker signals.

#### Remaining (Future Phases)
- Phase 2 (Liquidity Sweep as Setup Signal): Track zone sweep + recovery events as entry catalyst
- Phase 2D (Ticker Personality Profiles): Per-ticker SL width, hold duration, preferred entry path
- Phase 3B (Investor Replay Fidelity): Compute RS ranks + market health from historical candles in replay
