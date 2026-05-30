# Phase-I: Best-Attempt Plan

**Status:** DRAFT  
**Date:** 2026-04-22  
**Supersedes:** Phase-H (stopped at v10b day 92/210, Nov 7 2025 replay)

---

## 0. What just happened (v10b stopped for cause)

v10b ran Jul 1 → Nov 7, 2025 on the full 215-ticker universe with H.3 entry
discipline + H.4.0 earnings block + H.4.2 regime-flip exit. Stopped at
day 92/210 (~44% through) for analysis.

### Headline results (v10b closed trades, Jul-Nov 7)

| Metric | v10b | v9 (40T smoke) | v7 (40T best) | v6b (40T peak) |
|---|---|---|---|---|
| Trades | 101 | 24 | 89 | 82 |
| Win rate | **50.5%** | 70.8% | 53.9% | 54.9% |
| Sum PnL % | +19.86% | +20.11% | **+36.38%** | +12.46% |
| Profit factor | 1.24 | **2.48** | 1.84 | 1.20 |
| Big losers (≤ -5%) | **5** | 1 | 0 | 1 |

### Plus 15 orphaned OPEN positions

None of these open trades are accounted for in the Sum PnL %. If we
assume realistic mark-to-market on Nov 7 they'd add noise but not
change the conclusion.

### Honest verdict

- **v7 (40-ticker) remains our best run.** H.3/H.4 generalized poorly
  to 215 tickers.
- **v10b PnL is okay, but WR (50.5%), PF (1.24), and big-loser count (5)
  are all regressions** vs v7.
- **Exit logic has visible gaps**: 15 open trades (some 92 days open),
  TPL identical-price duplicate shorts, `max_loss_time_scaled` firing 11
  times at ~0% to -3% after 4-220h holds.

---

## 1. Root-cause findings (what the data tells us)

### 1.1 The SHORT-side collapse on 215-ticker

```
LONG:  91 trades, WR 51.6%, +29.87%  (avg +0.33%)
SHORT: 10 trades, WR 40.0%, -10.00%  (avg -1.00%)
```

On v9 (40T) SHORTs were highly selective and profitable. On v10b (215T)
we still only took 10 shorts — but 4 of 5 big losers were ISRG SHORTs
in Sep/Oct against a bullish regime.

**Cause:** H.3 regime-adaptive gate allows SHORTs in non-uptrend cycles,
but the SPY monthly cycle was classified as `neutral` or `choppy` for
Sep/Oct (not explicitly `uptrend`), so ISRG SHORT passed repeatedly
against a market that was grinding higher.

### 1.2 The open-position bug (TPL case)

```
TPL SHORT entered 2025-08-13 15:30 @ $288.33  → OPEN 85 days
TPL SHORT entered 2025-08-15 17:30 @ $288.33  → OPEN 83 days
```

**Identical entry price on two separate entries 48h apart.** Engine
has dedup logic (multiple code paths in `worker/index.js`) but
something bypassed it for these trades. The `$288.33` match is
suspicious — suggests the original trade's entry price may have been
written as the "current price" the second time too.

More broadly: **9 of 15 open trades had a prior closed trade on the
same ticker** (some within 24-48h). Our re-entry throttle either
doesn't exist for SHORT-after-SHORT or has a gap.

### 1.3 Oct bleed pattern

```
Oct losers (7 total):
  3× max_loss_time_scaled  (ANET, AA, IBP) — all -0 to -3% after 4-220h
  1× HARD_LOSS_CAP         (ISRG SHORT)    — -6.83%
  1× atr_week_618_full_exit (AR LONG)     — -1.90%
  1× SMART_RUNNER_SUPPORT_BREAK_CLOUD (FN)  — -1.56%
  1× early_dead_money_flatten (ALB)         — -1.15%
```

**Two patterns:**
- **Trade-through-4h-loss**: AA, ANET bought near highs on 10-29, 10-31
  (end of month), held exactly 4h → `max_loss_time_scaled`. These
  entered into a late-October selloff that was already visible in SPY.
- **SHORT into a rally**: ISRG short at $435.28 with SPY/ISRG still
  in uptrend → big loss.

### 1.4 What Aug did right (60% WR, +26.95%)

Aug's 12 winners:
- **All LONG** (H.3 blocked the one SHORT attempt, good)
- **9 of 12 = TT Tt Pullback (Prime grade)** — the default workhorse
- **Hold times 24h-1103h** — mix of fast scalps and week-long runners
- **Winners came out via `mfe_proportional_trail`, `TP_FULL`, `HARD_FUSE_RSI_EXTREME`, `SMART_RUNNER_SUPPORT_BREAK_CLOUD`** — our good exit signals fired

**What's different about Aug?** SPY was in a clean uptrend with VIX
low. Most setups hit. Nothing fancy about the entries — the market
carried them.

### 1.5 The `max_loss_time_scaled` noise (11 trades, all -0 to -3%)

Exits at 4h, 30h, 50h, 90h, 120h, 213h, 221h — **the timer-scaled cut
is firing inconsistently**. Some trades:
- ETN @ 213h, -0.21% — this was correct; trade had stagnated
- AA @ 4h, -2.59% — this was TOO EARLY; gave up in a drawdown
- IBP @ 221h, -0.00% — FLAT after 9 days

The rule needs tiered thresholds: faster cut if deep drawdown from
start, slower cut if merely sideways.

---

## 2. Phase-I: the plan

Three workstreams, in order of leverage. Each has a concrete DA-key or
code change and an acceptance criterion.

### Workstream 1: Fix the open-position bug (highest leverage)

**Hypothesis:** At least 2-3 of the 15 open trades represent real alpha
that leaked away because the engine couldn't close them. If we fix this
we both (a) stop writing ~0% FLAT exits and (b) reclaim the actual PnL
of winners like RTX (+3.35% on the first leg, second leg still open at
Aug 6 entry 92 days later).

**Actions:**

- **I.1.1** — Audit duplicate-open prevention in `worker/index.js`:
  the 3 existing dedup code paths (`[TRADE RECONCILE]`,
  `/timed/debug/cleanup-duplicates`, `/timed/admin/dedupe-trades`) are
  all *post-hoc* cleanup. Need a *pre-entry* guard: "if a trade is OPEN
  for (ticker, direction) within the last 72h, reject with reason
  `reentry_throttle`".

- **I.1.2** — Investigate why TPL SHORT opened twice at **identical**
  `entry_price=$288.33`. This is not coincidence; the second entry
  likely echoed the first trade's stored price instead of the current
  bar's price. Find the bug in `tt-core-entry.js` or
  `worker/replay-candle-batches.js`.

- **I.1.3** — Add a "position age" force-close exit: if a trade is
  open more than N calendar days (default 30) with no progress,
  force-close at market via `STALE_POSITION_TIMEOUT`. RTX, WM, ELF,
  TPL×2, SGI all fall in this bucket.

**Acceptance:** Running a rerun over the same Jul-Nov window should
produce **≤ 3 open positions at end**, not 15. None of them duplicate.

### Workstream 2: SHORT selectivity — block against uptrend better

**Hypothesis:** ISRG's 2 big losses (-6.83% + -5.35%) both came when
the SHORT should never have been taken because SPY/QQQ were making
new highs. The H.3 regime-adaptive gate is too lenient on `neutral`
/ `choppy` cycle labels.

**Actions:**

- **I.2.1** — Tighten `deep_audit_regime_adaptive_enabled` threshold:
  for SHORT entries, require SPY's 30-day trend slope to be <0
  (not just "cycle != uptrend"). DA-key:
  `deep_audit_short_requires_spy_downtrend`.

- **I.2.2** — Add a **sector-vs-SPY SHORT guard**: SHORT on a ticker
  whose sector is outperforming SPY over last 10 trading days gets
  blocked unless rank ≥ 95.

- **I.2.3** — ISRG specifically: healthcare/medtech names had a
  persistent uptrend during our test window. Consider an
  **industry-relative-strength** gate: block SHORT if the ticker's
  industry ETF is in the top quartile vs SPY on 4h timeframe.

**Acceptance:** Rerun should have **0 SHORT big-losers** (≥5% loss)
against a verified SPY uptrend day. SHORT count drops from 10 to
probably 3-5, but WR on those should be ≥ 60%.

### Workstream 3: Smart `max_loss_time_scaled` tiering

**Hypothesis:** The timer-based cut is both too slow for 4h disasters
(AA, ANET −2.5 to −3%) and too fast for healthy sideways patterns
that would have resolved up (ETN 213h).

**Actions:**

- **I.3.1** — Tiered time-scaled rule:
  - Hold < 8h + PnL < -1.5% AND no MFE > 0.5% → cut immediately
  - Hold 8-48h + PnL < -2.0% AND no MFE > 1.0% → cut
  - Hold 48-168h + PnL < 0% → cut
  - Hold > 168h + MFE < 1.0% → cut

- **I.3.2** — Integrate MFE context: if trade reached > 1.5% MFE at any
  point then drifted back to -1%, use different exit logic
  (`PROFIT_GIVEBACK_STAGE_HOLD` is right). Current MLTS ignores MFE.

**Acceptance:** Rerun should eliminate the 11 `max_loss_time_scaled`
trades clustered at -0% to -3% in favor of either (a) proper earlier
cuts (saving 1-2%) or (b) legitimate holds that work out.

### Workstream 4 (optional): Investigate H.3 drop-off at universe scale

**Hypothesis:** H.3's rank floor (90) + consensus gate (≥3 of 5) was
calibrated on 40 curated tickers. On 215 tickers, the ranker emits
MORE scores above 90 per bar (pure combinatorics), so the "floor"
becomes less restrictive.

**Actions:**

- **I.4.1** — Collect rank distributions from v9 (40T) vs v10b (215T)
  across the same dates. If 215T emits 3× the count at rank ≥90,
  the floor needs to be raised to 95 for 215T, or replaced with
  **top-N** selection ("take best 3 signals/day regardless of rank").

- **I.4.2** — **Top-N daily picks** (if I.4.1 confirms): instead of
  "rank ≥ 90", use "top 5 ranks per direction per day, regardless of
  absolute score". This naturally scales with universe size.

---

## 3. Execution sequence

### Step 1: Ship the surgical fixes (1-2 days, code-only)
- I.1.1 pre-entry re-entry throttle
- I.1.2 TPL identical-price bug investigation + fix
- I.1.3 position-age force-close

Deploy. Re-run Jul-Nov smoke (40-ticker curated subset) to verify
no regression on v9's strong numbers.

### Step 2: Tighten SHORT selectivity (1 day)
- I.2.1 SPY downtrend requirement
- I.2.2 sector-vs-SPY relative strength guard

Deploy. Re-run Sep-Oct smoke on 215T to verify ISRG no longer takes
bad shorts.

### Step 3: Smart MLTS (1 day)
- I.3.1 tiered thresholds
- I.3.2 MFE-aware path

Deploy. Re-run full Jul-Nov smoke to verify -0% MLTS trades are
either (a) properly cut earlier or (b) legitimately held.

### Step 4: Phase-I full 10-month run (Jul 2025 - Apr 2026, 215T)

**Acceptance criteria for v11:**
- Win rate ≥ 58%
- Profit factor ≥ 1.8
- Big losers (≤ -5%) ≤ 2
- Open positions at end ≤ 3 (and none duplicated)
- SHORT side: WR ≥ 55%, positive sum PnL
- `max_loss_time_scaled` firing ≤ 5 times total (was 11 in 4 months)

Launch with the new hardened watchdog + heartbeat architecture from the
last session.

### Step 5 (parallel): Investigate H.3 universe scaling (optional)
Only if Step 4 doesn't hit criteria. If v11 hits the targets, H.3 as-is
is fine — the bugs, not the gate design, were the problem.

---

## 4. Risks & assumptions

1. **I assume** the TPL identical-price bug is a single root cause that
   also explains some open-trade pile-up. If it's more systemic, we
   may need a broader trade-lifecycle review.
2. **I assume** v7's numbers are reproducible on today's codebase with
   H.3 off. Worth verifying before we commit to beating them.
3. **The VM-pause issue remains** — doesn't block anything but adds
   wall-clock time. Fine.

---

## 5. What I'm NOT proposing (and why)

- **No aggressive new entry gates.** v7 already proved the engine can
  do 53.9% WR with 1.84 PF. The problem isn't bad entries — it's
  ungraceful exits and lifecycle bugs.
- **No full-universe rerun until fixes are validated.** v10b already
  taught us what we needed. No more 15-hour speculative runs.
- **No change to Phase-H.3 gates yet.** They may actually be fine once
  the bugs are out of the way. I.4 is a backstop, not a starting move.
