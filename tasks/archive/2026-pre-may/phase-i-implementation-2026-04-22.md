# Phase-I: Implementation Plan

**Branch:** `cursor/phase-i-implementation-2e87`  
**Supersedes:** `phase-i-best-attempt-plan-2026-04-22.md` (updated with v9/v10b universe analysis findings)

---

## 0. New evidence (updates the plan)

### The real root cause: universe dilution, not H.3 failure

Per-universe split of v10b closed trades:

```
v9-subset tickers (22 trades from curated 40):   68.2% WR, +20.07% PnL
NEW-215 tickers  (79 trades from expanded 175):  45.6% WR,  -0.20% PnL
```

Inside the NEW-215 bucket:
- **35 "single-trade" tickers** (one trade across 4 months): 31.4% WR, -32.91% PnL
- 4 of 5 big losers came from here (AGYS, CSX, ISRG×2)

**This reframes the problem:**
- H.3 worked correctly on v9's 40-ticker curated universe (70.8% WR)
- The engine was NEVER trained on or validated for the 175 "new" tickers
- Rank-floor=90 filters to top ~4 of 40 (tight), but top ~21 of 215 (5x looser)
- Result: 79 marginal trades on under-studied tickers diluted the edge

### The rank-field data gap

`deep_audit_min_rank_floor` gate reads `scores?.rank ?? d?.rank`. On v10b these fields are often `0`, and line 344 of `tt-core-entry.js` **bypasses the gate when rankScore is 0**:

```js
if (_h3RankFloor > 0 && rankScore > 0 && rankScore < _h3RankFloor) { reject }
//                      ^^^^^^^^^^^^^^ bypass condition
```

So the H.3 rank floor may literally have been a no-op for many v10b entries. This is a real bug.

---

## 1. Workstream 1 — Position-lifecycle fixes

### 1.1 Pre-entry re-entry throttle

**Current state:** 3 post-hoc dedup code paths exist (`[TRADE RECONCILE]`, `/timed/debug/cleanup-duplicates`, `/timed/admin/dedupe-trades`). None of them block a second entry from being created.

**Evidence:** 9 of 15 open trades at v10b stop had a prior closed trade on the same ticker within 1-18 days. Specifically:
- `TPL SHORT`: 2 opens at identical $288.33, 48h apart
- `SGI LONG`: 2 opens 24 days apart (first still open)
- `KWEB LONG`: open-after-close gap of just 24h
- `AU LONG`: re-entered 91 days after prior close

**Implementation:**

Add early rejection in `worker/pipeline/tt-core-entry.js`:

```js
// Phase-I.1.1 — Re-entry throttle
const _reentryThrottleHours = Number(daCfg.deep_audit_reentry_throttle_hours ?? 24);
if (_reentryThrottleHours > 0 && ctx?.recentTrades?.length) {
  const cutoffMs = (ctx.nowTs || Date.now()) - _reentryThrottleHours * 3600 * 1000;
  const recentSameSymbol = ctx.recentTrades.filter(t =>
    String(t.ticker).toUpperCase() === tickerUpper
    && String(t.direction).toUpperCase() === side
    && (Number(t.exit_ts) || 0) >= cutoffMs
  );
  if (recentSameSymbol.length > 0) {
    return rejectEntry("phase_i_reentry_throttle", {
      last_exit: recentSameSymbol[0].exit_ts,
      last_pnl_pct: recentSameSymbol[0].pnl_pct,
      throttle_hours: _reentryThrottleHours,
    });
  }

  // Hard-block any same-direction entry while an existing trade is still OPEN
  const stillOpen = ctx.recentTrades.filter(t =>
    String(t.ticker).toUpperCase() === tickerUpper
    && String(t.direction).toUpperCase() === side
    && !t.exit_ts
  );
  if (stillOpen.length > 0) {
    return rejectEntry("phase_i_duplicate_open", {
      existing_entry_ts: stillOpen[0].entry_ts,
    });
  }
}
```

Need to thread `ctx.recentTrades` through `trade-context.js` from the existing trade lookup in `replay-candle-batches.js`.

**DA key:** `deep_audit_reentry_throttle_hours` (default 24)

**Acceptance:** Rerun of v10b window produces zero same-direction duplicate opens.

### 1.2 TPL identical-price bug root cause

**Hypothesis:** The second TPL entry's `entry_price` was stored as $288.33 — exactly the first trade's entry price, not the current bar's close. This suggests one of:

- Race condition where the same candle's entry was written twice
- State pollution: the first trade's `entry_price` field persisted into a second trade's write path
- Entry detection used stale `tickerData` that hadn't refreshed between batches

**Diagnostic first:**

Add logging to the trade-creation path in `worker/index.js` (near the existing dedup):

```js
// Phase-I.1.2 — Log suspicious identical-price re-entries
if (existingByKey?.length > 0) {
  const priorPrice = Number(existingByKey[0].entry_price);
  const newPrice = Number(trade.entry_price);
  if (Math.abs(priorPrice - newPrice) < 0.01 && existingByKey[0].ticker === trade.ticker) {
    console.warn(`[PHASE_I_DUP_PRICE] ${trade.ticker} ${trade.direction} @ $${newPrice} — identical to prior trade @ $${priorPrice}`);
  }
}
```

**After W1.1 lands:** The re-entry throttle would have prevented both TPL opens anyway. W1.2 is diagnostic-only to confirm the root cause for post-run investigation.

### 1.3 Stale-position force-close

**Evidence:** Open trades older than 60 replay days with no exit signal:
- RTX (92 days), WM (91), ELF (90), TPL×2 (85/83), SGI (80), AAPL (72), KWEB (64), EME (57)

**Implementation:**

Add to `worker/index.js` exit logic (near `EARLY_HARD_EXIT_GUARDS`):

```js
// Phase-I.1.3 — Stale position force-close
const _stalePositionDays = Number(daCfg.deep_audit_stale_position_force_close_days ?? 45);
if (_stalePositionDays > 0 && tradeAgeDays > _stalePositionDays) {
  const mfeAbs = Math.abs(Number(t.max_favorable_excursion) || 0);
  const currentPnlPct = Number(computeTradePnlPct(t, tickerData)) || 0;
  // Only force-close if the position hasn't made meaningful progress
  // (MFE < 2% and current pnl < 1%). Otherwise it may still be a valid runner.
  if (mfeAbs < 2.0 && currentPnlPct < 1.0) {
    return {
      shouldExit: true,
      reason: "STALE_POSITION_TIMEOUT",
      details: { ageDays: tradeAgeDays, mfe: mfeAbs, pnl: currentPnlPct },
    };
  }
}
```

**DA key:** `deep_audit_stale_position_force_close_days` (default 45)

**Acceptance:** No position open for more than 45 replay days without either meaningful MFE (≥ 2%) or current profit (≥ 1%).

---

## 2. Workstream 2 — SHORT selectivity vs SPY regime

### 2.1 Require SPY downtrend for SHORTs

**Evidence:** 4 of 5 big losers in v10b were ISRG SHORTs against a clear SPY uptrend. The existing H.3 regime-adaptive gate allows shorts in `neutral` / `choppy` cycles, which were the Sep/Oct classifications.

**Implementation:**

Tighten H.3 Layer 2 in `tt-core-entry.js`:

```js
// Phase-I.2.1 — Require SPY confirmed downtrend for SHORT
const _shortSpyGate = String(daCfg.deep_audit_short_requires_spy_downtrend ?? "true") === "true";
if (_shortSpyGate && isShort) {
  const spyDaily = ctx?.market?.spyDailyStructure || {};
  const spyBelowE21 = spyDaily.close_below_e21 === true;
  const spyE21SlopeNeg = Number(spyDaily.e21_slope_5bar_pct) < 0;
  const spyBearRegime = Number(spyDaily.ema_regime_daily) <= -1;
  const spyDowntrend = spyBelowE21 && spyE21SlopeNeg && spyBearRegime;
  if (!spyDowntrend) {
    // Allow SHORT only if rank >= 95 AND ticker is speculative cohort (carves out crypto/meme shorts)
    const rankHighEnough = rankScore >= 95;
    const speculativeCohort = String(d._cohort || "").toLowerCase() === "speculative";
    if (!(rankHighEnough && speculativeCohort)) {
      return rejectEntry("phase_i_short_no_spy_downtrend", {
        spyDowntrend, spyBelowE21, spyE21SlopeNeg, spyBearRegime,
        rank: rankScore, cohort: d._cohort,
      });
    }
  }
}
```

**DA key:** `deep_audit_short_requires_spy_downtrend` (default `"true"`)

### 2.2 Sector-vs-SPY relative strength guard for SHORTs

**Evidence:** ISRG (healthcare) was outperforming SPY in Sep/Oct. Shorting sector leaders is a low-probability trade.

**Implementation:**

```js
// Phase-I.2.2 — Block SHORTs when sector is beating SPY
const _sectorStrengthGate = String(daCfg.deep_audit_short_sector_strength_gate ?? "true") === "true";
if (_sectorStrengthGate && isShort) {
  const sectorReturn10d = Number(ctx?.market?.sector10dReturn) || 0;
  const spyReturn10d = Number(ctx?.market?.spy10dReturn) || 0;
  const sectorBeating = sectorReturn10d > spyReturn10d;
  if (sectorBeating && rankScore < 98) {
    return rejectEntry("phase_i_short_sector_outperforming", {
      sectorReturn10d, spyReturn10d, rank: rankScore,
    });
  }
}
```

Requires populating `ctx.market.sector10dReturn` and `ctx.market.spy10dReturn` in `trade-context.js` — both computed from the backdrop JSONs we already have.

**DA key:** `deep_audit_short_sector_strength_gate` (default `"true"`)

**Acceptance:** Rerun Sep-Oct slice — ZERO ISRG SHORTs (or similar healthcare shorts).

---

## 3. Workstream 3 — Smart max_loss_time_scaled tiering

### 3.1 Tiered time + MFE-aware thresholds

**Evidence:** 11 MLTS firings across hold times 4h–221h, all closed at -0% to -3%. Specifically:
- 4h fires that were premature (AA -2.59%, ANET -3.16%) — trades that had not had time to develop
- 90-221h fires on positions with zero MFE (BWXT, J, CCJ, IBP) — stagnant but not catastrophic

**Implementation:**

Replace the existing `max_loss_time_scaled` logic in `worker/index.js` with tiered thresholds:

```js
// Phase-I.3.1 — Tiered max_loss_time_scaled with MFE awareness
const _mltsV2 = String(daCfg.deep_audit_max_loss_time_scaled_v2 ?? "true") === "true";
if (_mltsV2) {
  const ageH = tradeAgeHours;
  const pnlPct = currentPnlPct;
  const mfeAbs = Math.abs(Number(t.max_favorable_excursion) || 0);

  // Tier 1: short-term disaster (< 8h, deep drawdown, never profitable)
  if (ageH < 8 && pnlPct < -1.5 && mfeAbs < 0.5) {
    return exitNow("max_loss_time_scaled_short_cut", { tier: 1, ageH, pnlPct, mfeAbs });
  }
  // Tier 2: mid-term still underwater (8-48h, > 2% loss, no sustained rally)
  if (ageH >= 8 && ageH < 48 && pnlPct < -2.0 && mfeAbs < 1.0) {
    return exitNow("max_loss_time_scaled_mid_cut", { tier: 2, ageH, pnlPct, mfeAbs });
  }
  // Tier 3: long holder that never took off (48-168h, still red, weak MFE)
  if (ageH >= 48 && ageH < 168 && pnlPct < 0 && mfeAbs < 1.5) {
    return exitNow("max_loss_time_scaled_stall_cut", { tier: 3, ageH, pnlPct, mfeAbs });
  }
  // Tier 4: long sideways (> 168h, weak MFE)
  if (ageH >= 168 && mfeAbs < 1.0) {
    return exitNow("max_loss_time_scaled_stale_cut", { tier: 4, ageH, pnlPct, mfeAbs });
  }
}
```

**DA keys:** `deep_audit_max_loss_time_scaled_v2` (default `"true"`), plus per-tier threshold tuning keys.

**Acceptance:** Rerun shows cleaner MLTS pattern — fewer near-zero exits, earlier cuts on quick disasters.

---

## 4. Workstream 4 — Universe scaling (top-N picks)

**Evidence:**
- V9 rank floor=90 filtered top ~10% of 40-ticker universe = ~4 candidates/day
- V10b rank floor=90 filtered top ~10% of 215-ticker universe = ~21 candidates/day
- 35 "single-trade" tickers in v10b had 31% WR, -33% PnL — the long tail is noise

### 4.1 Top-N daily picks (replaces absolute rank floor for large universes)

Instead of "rank ≥ 90", use "top N ranks per direction per day". Naturally scales with universe size.

**Implementation:**

New daily picks resolution in `worker/pipeline/tt-core-entry.js`:

```js
// Phase-I.4.1 — Top-N daily picks
const _topNEnabled = String(daCfg.deep_audit_top_n_picks_enabled ?? "false") === "true";
const _topNCount = Number(daCfg.deep_audit_top_n_picks_per_direction ?? 5);
const _topNMinRank = Number(daCfg.deep_audit_top_n_picks_min_rank ?? 75);

if (_topNEnabled && ctx?.dailyCandidateRanks) {
  // ctx.dailyCandidateRanks = [{ticker, direction, rank}] for today
  const sameDirCandidates = ctx.dailyCandidateRanks
    .filter(c => c.direction === side)
    .sort((a, b) => b.rank - a.rank);
  const topN = sameDirCandidates.slice(0, _topNCount).map(c => c.ticker);
  if (!topN.includes(tickerUpper)) {
    return rejectEntry("phase_i_not_top_n_pick", {
      rank: rankScore, topN, _topNCount, sameDirCount: sameDirCandidates.length,
    });
  }
  // Still require minimum floor for even the top N (no garbage picks when nothing ranks high)
  if (rankScore < _topNMinRank) {
    return rejectEntry("phase_i_top_n_rank_too_low", {
      rank: rankScore, minRank: _topNMinRank,
    });
  }
}
```

Requires a daily candidate aggregation pass in `replay-candle-batches.js` — before processing a day's entries, compute rank for all candidates and rank-sort.

**DA keys:**
- `deep_audit_top_n_picks_enabled` (default `"true"` for 215T runs)
- `deep_audit_top_n_picks_per_direction` (default 5)
- `deep_audit_top_n_picks_min_rank` (default 75)

### 4.2 Rank-field propagation fix

**Bug:** `scores?.rank ?? d?.rank` can be 0 for many v10b candidates, bypassing H.3 rank floor entirely.

**Fix:** In `tt-core-entry.js` line 344, remove the `rankScore > 0` bypass:

```js
// BEFORE (bug):
if (_h3RankFloor > 0 && rankScore > 0 && rankScore < _h3RankFloor) reject;

// AFTER (strict):
if (_h3RankFloor > 0 && rankScore < _h3RankFloor) reject;
// This blocks entries when rank can't be computed (conservative default).
```

**DA key:** `deep_audit_strict_rank_required` (default `"true"`)

**Acceptance:** No more rank=0 trades slipping through the rank-floor gate.

---

## 5. Validation plan

### Phase 1: Unit smoke (fast)
After W1+W2+W3+W4 implementation, run a 1-month smoke (August 2025) on 215T:
- Expected: ≤ 20 trades (was 20 in v10b Aug), WR ≥ 60%, zero duplicate opens, zero stale positions.

### Phase 2: Cross-regime smoke
Run Sep+Oct 2025 on 215T:
- Expected: Oct bleed cut in half or better, no ISRG shorts, MLTS firings ≤ 3.

### Phase 3: Jul-Nov full slice
Rerun v10b window (Jul 1 – Nov 7) on 215T with Phase-I active:
- Acceptance for v11 baseline:
  - WR ≥ 58%
  - PF ≥ 1.8
  - Big losers ≤ 2
  - Open positions at end ≤ 3 (none duplicated)
  - Zero `HARD_LOSS_CAP` firings on SHORTs against SPY uptrend

### Phase 4: Full 10-month v11 (Jul 2025 – Apr 2026)
Only if Phase 3 hits targets. This is the real validation — all backdrops, all regimes.

---

## 6. Risks

1. **Top-N picks require a daily aggregation pass** — adds complexity to `replay-candle-batches.js`. If this doesn't work cleanly, fall back to raising rank floor (simpler but less elegant).
2. **Removing the rank=0 bypass may over-filter if the rank computation is broken for some tickers.** Need to verify rank is being computed for all 215T universe members.
3. **Stale-position timeout** might close legitimate runners on slow-moving ETFs (GLD, etc.). Consider per-cohort overrides if we see false positives.
4. **SHORT gates are aggressive** — may drop SHORT count from 10 to 3-5. Acceptable if remaining shorts are profitable, but we need to verify we're not giving up legitimate edge.

---

## 7. Out of scope (deliberate)

- Retraining the ranker — the v9 results prove it's good enough on curated universes
- Introducing new technical indicators — we have enough signals
- Changing the base entry triggers (TT Pullback, TT Momentum) — these work
- Changes to position sizing — not implicated in the analysis
