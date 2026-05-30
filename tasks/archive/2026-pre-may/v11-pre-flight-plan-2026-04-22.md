# V11 Pre-Flight Plan — Making the Last Run Count

**Date:** 2026-04-22  
**Goal:** V11 must answer the questions Phase-I left open, not just produce another number.  
**Branch:** `cursor/phase-i-implementation-2e87`

---

## 1. The `setup_name=None` problem, diagnosed

### What's happening

When a trade is created via the **main entry path** (`ENTER_NOW → processTradeSimulation → trade creation at worker/index.js line ~17745`), it's tagged with:

```js
const setupName = formatSetupName(entryPath);  // "TT Tt Pullback", "TT Tt Momentum", etc.
const { tier: setupGrade, ... } = computeSetupTier(...);  // "Prime" | "Confirmed" | "Speculative"
```

Both fields flow into the trade record and later into D1 via `d1UpsertTrade`.

When a trade is created via a **secondary/replay path** (multiple exist — exit-then-re-enter, carry-over from open position, executor-adapter synthesis) the `setupName` and `setupGrade` fields are `null`. D1 persists the null. Result: 39 of 58 Phase-I closed trades had `setup_name=None`.

### What's in `entry_path` for those trades

Each trade carries an `entryPath` / `entry_path` field that IS populated even on the secondary paths (we saw `tt_pullback` in signal_snapshot_json on v10b trades). The problem is **we're only persisting `setup_name` (display string) to D1, not the underlying `entry_path`** for most trades.

### Per-run evidence

The Phase-I closed set:
- 39 trades with setup_name=None (67%) — average pnl +1.61%, sum +62.89%
- 19 trades with setup_name set — average pnl +1.14%, sum +21.64%

The "None" trades are our **actual volume and alpha generators**. We're running blind.

---

## 2. The fix — minimal but mandatory before v11

### 2.1 Persist `entry_path` on every trade write

One-line fix per code site. The `entry_path` field already exists on trades internally (set during entry evaluation). We need to:

1. Ensure `entryPath` is set on the trade object whenever a trade record is created, not just the primary ENTER_NOW path.
2. Ensure D1 `trades` table has an `entry_path` column.
3. Ensure `d1UpsertTrade` binds `entryPath` on INSERT and UPDATE.
4. Ensure the trade-autopsy export includes `entry_path`.

### 2.2 Also persist `setup_name` / `setup_grade` when `entry_path` is known

Where we currently skip setting `setupName` (because the secondary path doesn't call `formatSetupName`), call it from `entryPath`. This is a 3-line change per secondary path — max 4 sites.

### 2.3 Post-run analysis script

Ship a `scripts/v11-entry-path-analysis.py` that:
- Groups trades by `entry_path`
- Computes WR, sum PnL, avg winner, avg loser, big-loser count per path
- Cross-breaks by direction and regime
- Produces a table that says: **"path X, N trades, Y% WR, Z sum PnL — this is worth X% of total alpha"**

With this we finally know:
- Which entry trigger is really generating edge
- Which ones are noise
- Where to focus the next tuning cycle

### 2.4 Also capture `rank_trace` + `execution_profile_name` on every trade

Both exist in memory; we need to persist them in D1 or at least the trade-autopsy export. Answers:
- Are high-rank entries actually better? (v10b said no. V1 formula is suspect.)
- Which execution profile (correction_transition, choppy_selective, etc.) ships the winners?

---

## 3. Additional pre-flight fixes (from the Phase-I retrospective)

### 3.1 W3 Tier 1 boundary gap

```js
// Current — age=4h exactly slips through Tier 1 and Tier 2's pnl threshold
if (_agH >= 2 && _agH < 4 && pnlPct <= -0.8 && _mfeAbs < 0.3) { /* Tier 1 */ }
if (_agH >= 4 && _agH < 8 && pnlPct <= -1.5 && _mfeAbs < 0.5) { /* Tier 2 */ }
```

PATH (09-23, 4h hold, 0.00% MFE, -3.89%) hit neither — pnl -3.89% met Tier 2's -1.5% but was allowed to cross over from Tier 1 without being cut earlier.

Fix: widen Tier 1 window to catch hard-and-fast disasters regardless of exact hour:

```js
// Tier 1 now: any age < 4, deep immediate red, zero MFE
if (_agH < 4 && pnlPct <= -1.0 && _mfeAbs < 0.3) { /* Tier 1 — immediate cut */ }
```

### 3.2 Verify W1.3 stale-position timeout fires

SGI LONG entered 08-18 sat open 80+ days until `replay_end_close` snagged it. The 45-day stale timeout should have fired at 10-02. Two possibilities:
- The timeout check is in a code path that doesn't execute during replay (most likely)
- The (MFE < 2% AND pnl < 1%) condition doesn't match SGI's profile

Action: trace the check. If replay skips it, add a replay-aware invocation. If the condition is too strict, relax to (MFE < 2% OR age > 60d) OR-semantics.

### 3.3 Capture MFE + MAE on every trade

`max_favorable_excursion` and `max_adverse_excursion` already exist in KV trade records but are sometimes dropped in D1. Verify these persist — they're core to any future exit-rule calibration.

---

## 4. V11 run parameters

### 4.1 Window

- **Start:** 2025-07-01
- **End:** 2026-04-30
- **Days:** 210 trading days
- **Universe:** `@configs/backfill-universe-2026-04-18.txt` (215 tickers)

### 4.2 DA configuration

- W1 (lifecycle): ON
- W2 (SHORT gates): ON
- W3 (MFE exits) with Tier 1 fix: ON
- V2 rank formula: OFF (v1 stays; v2 research is separate)
- H.3 baseline + H.4.0/H.4.2 (Earnings + mid-trade regime flip): ON
- Universe-adaptive rank: OFF (was a blind alley)

### 4.3 Orchestration

Managed through Worker cron orchestrator (no more VM). Enqueue via:

```bash
curl -X POST ".../timed/admin/backtest/enqueue?key=$TIMED_API_KEY" \
  -d '{
    "run_id": "phase-i-v11-jul-apr",
    "start_date": "2025-07-01",
    "end_date": "2026-04-30",
    "tickers": "<full 215-list>",
    "notes": "Phase-I W1+W2+W3 full validation, entry_path captured"
  }'
```

Expected runtime: **~10.5 hours unattended**.

### 4.4 Acceptance criteria for "ship Phase-I to production"

v11 must hit ALL of:
- WR ≥ 58% (Phase-I smoke was 63.8%)
- PF ≥ 1.8 (Phase-I smoke was 4.14 — aim to hold above 2.0 on full window)
- Big losers ≤ 5 (Phase-I smoke was 0 — aim to hold ≤ 3)
- Open positions at end ≤ 3 (Phase-I smoke was 3)
- Zero duplicate opens (hard requirement)
- At least one month of full SHORT activation (likely Jan–Mar bear chop) with WR > 50%
- `entry_path` populated on 100% of trades

---

## 5. Post-run deliverables (what we get from v11)

These are the **questions v11 answers** that Phase-I couldn't:

1. **Which entry_paths generate alpha?** (from 2.3 analysis script)
2. **Does Phase-I hold across the full Jul 2025 – Apr 2026 window**, including the hard months (Oct 2025 bleed, Dec 2025 chop, Feb–Apr 2026 rebound)?
3. **Does MFE early-cut logic scale?** (v10b's "never hits 1.5% MFE = losing" pattern — does it still hold at 210-day horizon?)
4. **What does the rank distribution of winners look like on V1?** (to inform whether V2 re-calibration is worth a future cycle)
5. **How do SHORTs perform when W2 DOES let them through?** (bearish-cycle days will show what W2's carve-out trades look like)
6. **Is the "setup=None" secondary-path collection more valuable than the primary TT Pullback/Momentum paths?** (answers whether we should double-down on the secondary triggers)

Each answer is a data-driven input to the NEXT (and hopefully last) tuning cycle.

---

## 6. Sequence

1. **Fix entry_path persistence** (~30 min work)
2. **Fix W3 Tier 1 boundary** (5-line change)
3. **Verify W1.3 stale-position timeout** — trace, fix if broken
4. **Deploy worker**
5. **Enqueue v11 via orchestrator**
6. **Wait ~10.5 hours**
7. **Run entry_path + full-retrospective analysis**
8. **Decision gate:** Phase-I hits criteria → merge to main. Else → scoped follow-up cycle (single specific issue).
