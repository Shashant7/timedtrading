# Three-Week Live Review — 2026-05-06 → 2026-05-27

> Written 2026-05-27 22:55 UTC against `main` worker `https://timed-trading-ingest.shashant.workers.dev`. All trade numbers come from `/timed/ledger/trades?limit=2000`, model-perf from `/timed/admin/mission-control`, system health from `/timed/admin/system-health` + `/timed/admin/cron-status`, AI CIO state from `/timed/admin/ai-cio/{decisions,accuracy,probe}`, and stage state from `/timed/all`.

---

## 1. TL;DR

| Question | Answer |
|---|---|
| Is the system more stable than 3-6 weeks ago? | **Partly.** Shipping cadence is ~2× higher (673 commits / 250 PRs vs 380 / 43 in the prior 3-week window), live data accidents are being caught and repaired (MU, NXT, TSM, PCE incidents). But three cron ops are currently FAILING and several silent paths are still leaking — see §3. |
| Is every element working as expected with no blind spots? | **No.** Six silent issues are live right now — see §3. The biggest is that **AI CIO has logged 0 decisions since 2026-03-23** despite being enabled in `model_config`. |
| Is AI CIO working / self-learning / self-calibrating? | CIO is **enabled in config and the probe endpoint returns real LLM decisions**, but the live `processTradeSimulation` entry path has been silently bypassing the CIO call since 2026-03-23. P0.7.170 (2026-05-15) added a lazy-load patch but no new CIO rows have landed in D1 since then. Weekly retro and continuous learning are working at the data layer (`ticker_profiles`, `path_performance`), but two of the three feedback crons are red (`candle_freshness_d`, `candle_freshness_60`, `weekly_retro`). |
| Are current simulation settings sane / is capital free for new trades? | **Yes — capital is not the blocker.** Account = $100k, 8 open positions worth $52,861 (~53% of book), `MAX_OPEN_POSITIONS=35` (27 free slots), `MAX_SAME_DIRECTION=25`. The 39 tickers in Setup lane are blocked by `outside_RTH` because it is after the 16:00 ET close — not by capital, sector caps, or correlation gates. |
| Is trade execution working properly? | Mechanically yes (entries, trims, exits, Discord alerts all fire), but the **execution surface is repeatedly creating P0 incidents** — see §4. Five MU/TSM/NXT/PCI/UNP-class issues have been hot-patched since 2026-05-22. |
| Is win-rate and PnL performing well? | **No, this is the most important finding.** Past 3 weeks: 45 entries, 37 closed, **27% WR, −$2,278 P&L**, avg win $34 vs avg loss $97 (1:2.85 expectancy). May is the worst single month of 2026 (−$2,431 / 27.5% WR), wiping out April's +$3,116 / 59% WR. All-time is still +$37,656 but the trailing-30-day series is firmly negative. |
| Are we producing solid trades that look like winners? | **No, current trades do not have winner characteristics.** Setup-grade mix is dominated by Speculative (26/45). Only direction taken is LONG (44/45). The two highest-volume setups are bleeding: `tt_gap_reversal_long` 21% WR / −$790 and `tt_n_test_support` 40% WR / −$653. Avg trade rank is 69 (acceptable) but the recent winners are tiny (avg $34) and the losers wide (avg $97), which is the opposite of the all-time profile. |

---

## 2. Trade performance — full window grid

`/timed/ledger/trades?limit=2000` returned 635 rows back to 2025-07-01.

```
Window                                       trades | closed | open | W   | L   | WR     | Net PnL    | avgW | avgL
All-time (Jul-01 2025 → today)                635     627      8     318    308   50.7%     +$37,656     247    -133
YTD 2026                                      258     250      8     119    130   47.6%     +$ 6,868     199    -129
Apr 2026                                       22      22      0      13      9   59.1%     +$ 3,116     282     -61
May 2026 (entries since 5/01)                  48      40      8      11     28   27.5%     -$ 2,431      31     -99
Last 4 weeks (since 4/29)                      52      44      8      12     31   27.3%     -$ 2,610      29     -95
Last 3 weeks (since 5/06)  ← user’s window     45      37      8      10     27   27.0%     -$ 2,278      34     -97
Last 2 weeks (since 5/13)                      40      33      7       8     25   24.2%     -$ 2,062      27     -91
Last 1 week  (since 5/20)                      17      11      6       5      6   45.5%     -$   273      30     -71
```

**Mission Control (`model_perf.trailing`) corroborates from the trades table:**
- 7d: 12 trades, 6W/6L, −$245, −2.4% return
- 14d: 34 trades, 10W/24L, −$1,913, **−40%** return on risk
- 30d: 46 trades, 14W/31L, −$2,096, **−42%** return on risk

The system has reverted hard from its April form. The 1-week sample is encouraging (45% WR, smaller drag) but is dominated by 6 open positions whose mark-to-market is not yet realized.

### Daily exit-PnL since 2026-05-06

```
2026-05-07   1  0W  1L   -$252
2026-05-12   2  1W  1L   -$ 50
2026-05-13   2  0W  1L   -$ 63
2026-05-14   3  1W  2L   -$273
2026-05-15   2  0W  2L   -$140
2026-05-18   7  0W  7L   -$518   ← all-loss day (CHOP regime, 7 SL/max_loss exits)
2026-05-20  10  3W  7L   -$737   ← 10-exit drag day
2026-05-21   1  1W  0L   +$ 12
2026-05-22   3  2W  1L   -$ 19
2026-05-26   5  2W  2L   +$656   ← MU recovery day + PRE_PCE wins
2026-05-27   4  1W  3L   -$255
```

Two days (5/18 and 5/20) account for 55% of the loss. Both were stale-data / event-window days that have since been patched (PR #283, #284, #287, #317, #327).

### Setup-level scoreboard (last 3w)

```
setup                            n     closed    WR      Net PnL
tt_gap_reversal_long             17    14        21.4%   −$790
tt_n_test_support                13    10        40.0%   −$653
tt_ath_breakout                   6     6        33.3%   −$116
TT Setup (no specific lane)       5     4        25.0%   −$492
tt_pullback                       3     2         0.0%   −$168
tt_range_reversal_long            1     1         0.0%   −$ 58
```

`tt_gap_reversal_long` is supposed to be our workhorse (PF 2.98 all-time per CONTEXT.md). Running it at 21% WR for 3 weeks is a regime/quality mismatch, not a strategy failure. `tt_n_test_support` is a 2026-04 surge setup that's only just starting to mature and is bleeding the same way.

### Direction & grade

```
LONG    44  WR 25.0%   −$2,284
SHORT    1  WR 100.0%  +$    7

Speculative  26 closed=23 WR 30.4% −$1,304
Confirmed    14 closed=11 WR 18.2% −$  771
Prime         5 closed= 3 WR 33.3% −$  202
```

We are **operationally long-only** right now — 1 SHORT in 3 weeks is a side-effect of the SHORT min-rank gate (`deep_audit_short_min_rank=65`) being designed for bear regimes that haven't appeared. Speculative dominates volume because Prime/Confirmed grades require setups that simply aren't being printed in current market structure. None of the three grades is profitable in this window.

### Top open positions (full $52,861)

```
GS    LONG  $12,000  entry 2026-05-27 19:04  tt_pullback           Confirmed
TSM   LONG  $ 9,677  entry 2026-05-26 17:48  tt_n_test_support     Confirmed
HIMX  LONG  $ 9,457  entry 2026-05-21 19:05  tt_gap_reversal_long  Prime
SNDK  LONG  $ 9,422  entry 2026-05-06 14:28  TT Setup              Prime
MU    LONG  $ 4,269  entry 2026-05-22 19:07  tt_gap_reversal_long  Confirmed   (recovered from stale-price incident)
INTC  LONG  $ 2,868  entry 2026-05-14 17:59  tt_gap_reversal_long  Speculative
AA    LONG  $ 2,739  entry 2026-05-22 19:27  tt_n_test_support     Speculative
TLN   LONG  $ 2,430  entry 2026-05-27 18:48  tt_n_test_support     Speculative
```

SNDK is 21 days old — that's well inside the `STALL_FORCE_CLOSE` 24h / `RUNNER_STALE_FORCE_CLOSE` 120h windows for untrimmed/trimmed runners. Worth a manual look — see §6.

---

## 3. Silent / blind issues currently live

These are the items the system is NOT surfacing in normal operator UI but are misbehaving under the hood.

### 3.1 AI CIO has logged 0 decisions for 65+ days (P0)

```
ai_cio_enabled            : true   (set 2026-05-07, updated_by=deep_audit)
ai_cio_shadow_mode        : true   (set 2026-05-12, updated_by=system)
deep_audit_ai_cio_enabled : true   (set 2026-05-06)
OPENAI_API_KEY            : present (probe endpoint returned a real REJECT in 4.5s)
```

`/timed/admin/ai-cio/probe` is healthy. Direct call to `evaluateWithAICIO()` returns a real LLM decision. But `/timed/admin/ai-cio/decisions?limit=500` shows the **latest row was created at 2026-03-23 17:07 UTC** — 65 days ago. `model_perf.ai_cio_7d.total = 0` in Mission Control. The weekly retro markdown literally says "No CIO decisions this week (entry engine quiet or shadow mode)."

The code comment at `worker/index.js:16064-16078` acknowledges this exact bug:

> *"ai_cio_decisions has 0 new rows since 2026-03-23 despite ~24 entries firing"*

P0.7.170 (2026-05-15) added a lazy-load patch for `env._deepAuditConfig` and P1 HOTFIX (2026-05-19) added a `tickerData._env._deepAuditConfig` backfill. Neither has actually restored CIO writes — the 45 entries that fired in the past 3 weeks all bypassed the CIO call silently.

**Net effect:** CIO blacklist (AMZN, META, RKLB, RDDT, NVDA), CIO franchise (PH, AVGO, APP, …), crypto leading indicator REJECTs (all those SHORT MSFT/AVGO/TSLA from March), and 7-layer memory are **not** influencing live entries today. The system is running on pure rule-based gates.

This is the single most consequential silent issue. Repro probe: `GET /timed/admin/ai-cio/decisions?limit=10&key=...` → newest `created_at` is 2026-03-23.

### 3.2 Higher-timeframe candle staleness (P0)

`/timed/admin/cron-status` and `/timed/admin/candle-freshness`:

```
candle_freshness_60   worst stale 124.5h (DELL)   threshold 24h   FAILING (15 consecutive failures)
candle_freshness_d    worst stale 12.8d  (AA  )   threshold  5d   FAILING (14 consecutive failures)
weekly_retro          unknown error               cron failing    (2 consecutive failures)

by-timeframe p95:
  5m   p95 0.1d      ok
  10m  p95 0.1d      ok
  60m  p95 0.1d      ok
  240m p95 0.2d      ok
  15m  p95 0.1d      ok BUT worst 80.3d (BTCUSD)
  30m  p95 71.2d     RED  — half the universe has 30m candles >71 days stale
  D    p95 13.0d     RED  — almost the entire 252-ticker universe is 13d stale on daily
  W    p95 17.0d     RED  — 17 days stale on weekly
```

Intraday p95 looks healthy but the daily / weekly / 30m grain is systemically stale. This matters because the entry pipeline uses D-cloud and W-EMA structure for bias alignment and the move-phase profile. We've been making decisions on 2-week-old higher-TF data. AA has an open position right now and its daily candle is 13 days behind.

Likely root cause: a TwelveData D/W backfill cron broke around 2026-05-14. The 13-day staleness for 252 tickers all in one cluster is suspicious. The aliasing on `30m` (71d) and `15m` (80d for BTCUSD) suggests those buckets fall back to incomplete legacy paths that haven't been refreshed.

### 3.3 `weekly_retro` cron failing

Cron has failed twice (count=2 in `cron-status`). The retro markdown for 2026-05-07 → 2026-05-14 is the most recent that landed (1 win / 4 losses / −$413.71 for that week). The retro for 2026-05-14 → 2026-05-21 and 2026-05-21 → 2026-05-28 has not generated. Self-calibration loop is degraded.

### 3.4 Daily Brief prediction scorecard is barely populated

`/timed/admin/mission-control.brief_accuracy.window_days=30`:

```
spy: { n: 2, mean: 0.25 }
qqq: { n: 2, mean: 0.50 }
iwm: { n: 2, mean: 0.50 }
total_scored: 2
latest_date: 2026-05-15
```

Only 2 briefs scored in 30 days. The scorecard MISS-fix from PR #299 closed one false-positive, but the scoring mechanism itself isn't running daily. This blocks Daily Brief from being a true forecasting feedback loop.

### 3.5 Reset-guard / replay-clean-slate audit log is being spammed by reference-intel

`data_audit_log` past 30 days = **50 `CANDLE_REPLAY_CLEAN_SLATE_BLOCKED` + 49 `ADMIN_RESET_LEDGER_BLOCKED`** — all from the reference-intel scheduled refresh (`chore(reference-intel): scheduled refresh …` PRs). Reason: `missing_confirmation`. The guard is correctly preventing accidental ledger nukes, but the noise is hiding any *real* attempts. Should reference-intel either drop the `cleanSlate=1` param or include the confirmation token.

### 3.6 Historic integrity-wipe incident on 2026-05-18

`INTEGRITY_WIPE_DETECTED` in audit log at 2026-05-18 22:22:06 UTC: trades dropped 618 → 0 (100%), ledger dropped 1284 → 0 (100%), 1902 rows affected. Triggered by `cron:*/1 * * * *`. Data was restored (we have 635 trades now). This was the original justification for adding `ADMIN_RESET_LEDGER_BLOCKED` confirmation. Hasn't recurred — appears closed.

---

## 4. Trade-execution health

**Mechanically working.** In the past 50 activity events: 17 ENTRY, 11 TRIM, 21 EXIT, 1 AUDIT. Discord alerts firing (PR #328 made TRADE_ENTRY unconditional). Trade Autopsy events are now chronological (PRs #322-#324). Correct-trim admin endpoint repairs multi-trim cases (PRs #321, #325, #326).

**But the execution surface keeps producing P0 incidents.** Past 14 days, hot-patched:

| Date | Incident | Fix |
|---|---|---|
| 2026-05-22 | MU stale pre-market price → bogus SL exit at $751 vs market $785+ | PR #283 (OOH RECONCILE freshness guard) + PR #284 (smart-SL lock-in floor + EXT wick guard) |
| 2026-05-22 | MU recovery via direct D1 update — first time we manually un-closed a trade | data-only fix |
| 2026-05-23 | TLN/UNP/PCI re-fired PRE_PCE trim+close in same tick (event-risk dedup broken by trim% bumping the dedup key) | PR #287 (event-identity dedup) |
| 2026-05-25 | TSM stale-price guard at first cron after RTH open | PR #317 |
| 2026-05-26 | NXT closed at −0.12% loss via `atr_week_618_full_exit` (designed to be a +0.5R full-profit, not a flat loss) | PR #327 |
| 2026-05-27 | TRADE_ENTRY Discord alert gated by rank/RR — silent for low-rank entries | PR #328 |

Pattern: every one of these is a **silent corner case in a guard that was designed to help**. Smart SL is now well-instrumented (PR #290 sl-guard-stats endpoint, PR #294 nightly KV flush) so the next incidents will be visible faster.

Trade-management exit reasons last 3w (closed only):

```
atr_week_618_full_exit                   n=5   W=2    PnL $ −2     (was firing at −0.12% pre PR #327)
sl_breached                              n=5   W=0    PnL $-676    ← largest dollar bucket
atr_day_adverse_382_cut                  n=4   W=0    PnL $-254
thesis_flip_htf                          n=4   W=1    PnL $-125
max_loss                                 n=3   W=0    PnL $-293
doctrine_force_exit                      n=2   W=0    PnL $-330
sl_breached,left_entry_corridor          n=2   W=2    PnL $ +18
v13_hard_pnl_floor                       n=2   W=0    PnL $-199
HARD_LOSS_CAP                            n=2   W=0    PnL $-122
PRE_PCE_RISK_REDUCTION                   n=1   W=1    PnL $ +80
early_dead_money_flatten                 n=1   W=1    PnL $  +5
SMART_RUNNER_SUPPORT_BREAK_CLOUD         n=1   W=1    PnL $ +35
phase_i_mfe_fast_cut_2h                  n=1   W=0    PnL $-139
etf_stagnant_exit                        n=1   W=1    PnL $ +28
```

`sl_breached` (5) + `max_loss` (3) + `HARD_LOSS_CAP` (2) + `v13_hard_pnl_floor` (2) = 12 hard-loss exits totalling −$1,290. That's 57% of the total drag in 3 weeks. The cost is in the SL/loss-cap path, not in the trim/runner path.

---

## 5. Capital allocation — the "39 setup" question

**The 39 tickers in Setup lane are not being held back by capital.** Mechanics:

- Account: $100,000 (`PORTFOLIO_START_CASH` in `worker/pipeline/sizing.js:4`)
- Base sizing: 1% risk per trade ($1,000), max 20% notional per position ($20,000)
- Min/Max notional: $1,000 / $20,000
- `MAX_OPEN_POSITIONS = 35` (currently 8 → 27 free)
- `MAX_OPEN_POSITIONS_HARD_LIMIT = 50`
- `MAX_SAME_DIRECTION = 25` (currently 8 LONG → 17 free)
- `MAX_PER_SECTOR` = `max(4, 20% of sector universe)`
- `MAX_DAILY_ENTRIES` = 999 (effectively uncapped; can lower via `deep_audit_max_daily_entries`)

Open notional: **$52,861 (~53% of $100k)**. There is ~$47k and 27 position slots free right now.

So why are the 39 setups not converting? `/timed/all` returned `__execution_block_reason: "outside_RTH"` for **every single one** of the 39. The market closed at 16:00 ET (~20:00 UTC) and we ran this query at 22:55 UTC. The Setup-lane card display does not get suppressed when RTH closes — that's design — but no entries can fire until 09:30 ET tomorrow. When RTH reopens:

- Each setup will be re-evaluated against entry quality / cohort gate / event-risk gate / pre-earnings block / SHORT min-rank / consecutive-loss cooldown / sector cap / correlation guard / VIX filter / smart-gate. Those drop the candidate pool, often dramatically.
- The cohort-fail block (`gates.cohort_fail_block: true`, `cohort_min_n=15`, `cohort_wr_floor=0.4`, `cohort_pf_floor=1`) blocks any setup whose 30-day cohort track record is below floor. In a losing 30-day window like the one we're in, this gate becomes much harder to pass — it is partly **why we have fewer entries** right now.
- The continuation_trigger gates and gap_reversal_knife filter (PR #283 era) tightened the gap setup, reducing `tt_gap_reversal_long` admissions further.

**Recommendation: pull the same `/timed/all` payload at 09:45 ET tomorrow** and re-check `__execution_block_reason` on the same setup-lane tickers. If most still show `outside_RTH` or a specific gate name, the bottleneck is identifiable. The current snapshot can't isolate it because we're post-close.

The investor lane has 8 holdings totalling $37,500.01 in cost basis — separate account, separate sizing pool, doesn't compete with active-trader capital.

---

## 6. Self-learning / self-calibrating

| Layer | State |
|---|---|
| `ticker_profiles.learning_json` (rebuilt on trade close via `d1UpdateLearningOnClose`) | Updating on close events. Endpoint to inspect freshness is not exposed; verified via PR #218 commit and active code path. |
| `path_performance` table (entry path → WR/PF tracker) | Live; CIO memory reads it from D1 (per CONTEXT §AI CIO Memory Service). |
| `weekly_retro` cron | **FAILING** (cron-status). Last retro = 2026-05-14. |
| Daily Brief prediction scoring | Anemic — only 2 scored predictions in 30 days. |
| Reference-intel refresh (cron via GitHub Action since PR #270) | Running on schedule (twice-daily commits visible in git log). |
| AI CIO memory + reference priors | Pre-loaded at scoring cycle start; but the consumer (`evaluateWithAICIO`) hasn't been invoked since 2026-03-23 — see §3.1. |
| Adaptive Scoring Layer 1 (PR #300) | Shipped, default-off via `gates.adaptive_scoring_v1`. |
| Phase 6 cell-Markov G3 evaluator (PR #301) | Shipped in shadow-mode; never live-promoted. |
| Markov universe matrix + per-ticker + expanded (PRs #308-#311) | Bootstrapped 2026-05-26 (PR #279). KV keys populated. Default-on. |
| HMM regime (BULL/CHOP/BEAR) | Trained 2026-05-26 weekly cron. `BULL_TREND` posterior 1.0. Currently labelled BULL despite breadth ≈ 0.25 — a known disagreement flagged in `2026-05-23-progress-recap.md` §4.3. |
| Calibration apply | `model_perf.last_calibration: null` — no calibration run has been applied in the past 30 days. |

Bottom line: the data layer of self-learning IS running. The **decision layer that consumes it (AI CIO) is silently disconnected** from live entries, and the **review layer that closes the loop (weekly retro, brief scoring)** is half-broken. So even though every trade since 2026-03-23 has updated learning state, none of that learning has fed back into next-trade decisions through the CIO path.

---

## 7. Stability vs prior window

```
3-week shipping cadence:
  prior window (~6→3 weeks ago)   :  43 PRs merged,  380 commits, 129 commits matching fix-prefix
  current 3-week window           : 250 PRs merged,  673 commits, 214 commits matching fix-prefix
```

PRs/week ~6× faster. Commits/week 1.8× faster. Fix-prefixed commits 1.7× faster. So "we have fewer bugs" — depends on definition. **Bugs caught and fixed per week is higher than ever** because instrumentation (sl-guard-stats, provider-fallback-stats, structured logs PR #286, nightly KV flushes PR #294) is exposing what used to be silent. **Bug-rate net of fixes is hard to judge** without an explicit defect-count tracker, but the residual silent issues in §3 say we are not yet at "fewer blind spots."

P0 incidents that landed and got patched in past 14 days: MU stale price (#283), MU smart-SL hardening (#284), TLN/UNP/PCI event-risk dedup (#287), TSM stale-price reconcile (#317), correct-trim multi-trim handling (#322-#326), NXT atr_week_618 PnL floor (#327), TRADE_ENTRY alert always-on (#328), Daily Brief stale-level pre-market (#283), fundamentals 0.7% gross margin display (#306). That's a *lot* of P0s in 14 days; the velocity speaks to product-market-fit pressure, not to system maturity.

---

## 8. Direct answers to the user's seven questions

1. **System more stable / fewer bugs?**  Stability is improving, especially on the observability front. But the bug-discovery rate is still high (9+ P0 hotfixes in the last 14 days) and three crons are red right now. *Net: trending in the right direction, not yet stable.*
2. **Each element working, no silent issues?**  No — six silent issues are active right now (§3). The most consequential is AI CIO being effectively off since 2026-03-23 despite reading as enabled.
3. **AI CIO / self-learning / self-calibrating working?**  CIO is wired but not running on live entries. The data feeds for learning ARE running, but the loop that closes them (CIO + weekly_retro + brief scoring) is half-broken.
4. **Simulation settings / capital correct? Why 39 in Setup?**  Settings are correct; capital is not the blocker. The 39 setups are stuck behind `outside_RTH` because the market is closed. Pull `/timed/all` again at 09:45 ET tomorrow to identify the real RTH-time block reasons. There is $47k and 27 position slots available — capital is not constraining us.
5. **Trade execution working?**  Mechanically yes. Practically, the execution path keeps producing P0 incidents that need hot-patching (stale prices, event-window dedup, exit-reason mis-firing). Each one is being fixed within hours and instrumentation is improving, but the surface is not yet quiet.
6. **WR / PnL performing well?**  No. 3-week trailing: 27% WR, −$2,278, expectancy 1:2.85 wrong direction. May is the worst single month of 2026. All-time is still +$37,656 but the trailing-30-day equity curve is firmly down.
7. **Solid trades with winner characteristics?**  No. Speculative grade dominates (58% of trade flow), `tt_gap_reversal_long` (the workhorse) is running at 21% WR, and the LONG/SHORT mix is 44:1. Winners are small ($34 avg) and losers are wide ($97 avg) — the inverse of the all-time profile.

---

## 9. Recommended next actions (no code in this branch; review-only)

| Priority | Action | Where |
|---|---|---|
| P0 | Fix or hot-flip AI CIO so it actually evaluates live entries. Either complete the lazy-load fix or move the CIO call to a code path that always has `env._deepAuditConfig`. Validate with one D1 row landing per entry over a 1-day window. | `worker/index.js:22389-22500` |
| P0 | Restart the failing D / 60m candle-freshness backfill. AA has an open trade and 13-day-stale daily candles. | `worker/index.js` candle pull cron + `loadDailyCandlesFromD1` |
| P0 | Investigate and re-enable `weekly_retro` cron. Self-calibration depends on it. | `scheduled()` handler |
| P1 | Tighten the SHORT entry gate or temporarily lower `deep_audit_short_min_rank` from 65 to 55 in chop tape so we are not de facto long-only. CONTEXT.md flags this gate explicitly. | `model_config.deep_audit_short_min_rank` |
| P1 | Raise the Speculative-grade bar OR cap Speculative volume at ≤ 30% of weekly flow. Current 58% is the inverse of what win-rate evidence supports. | `worker/phase-c-setup-admission.js` |
| P1 | Drop `cleanSlate=1` from the reference-intel scheduled refresh OR have it include the new confirmation token, so the reset-guard audit log stops being noise. | `scripts/reference-intel-refresh.py` |
| P2 | Manually inspect SNDK (21 days old, still untrimmed). Either it's a legitimate Prime hold or `STALL_FORCE_CLOSE`/`RUNNER_STALE_FORCE_CLOSE` are not firing. | Trade Autopsy → SNDK |
| P2 | HMM label disagreement (currently `BULL_TREND` posterior 1.0 with breadth 25%) — track via `GET /timed/admin/hmm-labelling-check` for the 14-day swap recommendation flag from PR #295. | Operator dashboard |

---

*Generated 2026-05-27 by automated review. All numbers are reproducible from the API endpoints listed in §1.*
