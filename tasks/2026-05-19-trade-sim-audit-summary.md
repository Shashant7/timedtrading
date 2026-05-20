# Trade Simulation Audit — 2026-05-19 (P0 SL-leak root cause + 11 ancillary bugs)

**Date:** 2026-05-19
**Status:** All fixes shipped across PRs #217–#229. Pending merge of #223–#229 for full resolution.
**Trigger:** User-reported P0 — four trades (IWM, DE, DIA, MLI) trading 0.7%–3.4% past their stop loss for hours without closing.

This doc is the single coordinated view of every bug found and every fix shipped during the systematic walkthrough of `processTradeSimulation`. Read this if you want to understand the SL-leak incident end-to-end, or to verify the trade-management surface is now coherent.

---

## TL;DR

The SL leak was a **silent crash** caused by two compounding bugs in code paths that pre-dated the safety nets we'd been shipping:

1. **Bug A** (Bug #3 in audit): `getOpenPositionAsTrade` computed `trimmedPct = trimmedQty / pos.total_qty` — but `pos.total_qty` is the **remaining** qty, not original. Every 50%-trimmed trade reported `trimmedPct = 1.0`.
2. **Bug B** (TDZ #1): The ZOMBIE FIX block (which fires when `trimmedPct ≥ 0.9999`) referenced `pxNow` ~256 lines BEFORE the `let pxNow` declaration in the same scope. JavaScript Temporal Dead Zone → `ReferenceError: Cannot access 'pxNow' before initialization`.

Together: every 50%-trimmed trade triggered ZOMBIE FIX → which crashed `processTradeSimulation` → which prevented the SL safety net (added in PR #218/#220) from ever executing. PRs #217 → #221 all appeared to do nothing because **the code they added literally never executed for the stuck trades.**

The explore-agent audit also surfaced 10 more bugs in the same surface area, ranging from a second TDZ (Bug #2) to gate-ordering issues and persistence holes. Fixed in PRs #224 → #229.

---

## How we got here — incident timeline

| Time (UTC) | Event |
|------------|-------|
| ~21:30 | User reports 4 trades past SL, asks to investigate |
| 21:35 | PR #217 ships: regex fix for `sl_breached` in `isSLExit` / `_exitIsHard`. Believed to be the fix. |
| 22:23 | PR #218 ships: SL safety net at line ~19507 that overrides `exitReasonRaw='sl_breached'` regardless of doctrine shadow. |
| 23:01 | PR #220 ships: safety net also clears `fuseExitFired` + `__force_defend_stage`. |
| 23:20 | PR #221 ships: `[SL_SAFETY_NET_TRACE]` + `[SL_GATE_TRACE]` diagnostic logs. |
| 23:24 | User asks me to "walk through the entire process tediously and spot check everything." |
| 23:27 | Live `wrangler tail` captures the smoking gun: `(error) [TRADE SIM ERROR] {sym}: ReferenceError: Cannot access 'pxNow' before initialization` for all 4 tickers. **Every `*/5` scoring cron has been crashing for these tickers for hours.** |
| 23:37 | PR #223 ships: trimmedPct miscompute + ZOMBIE FIX TDZ — the actual root cause. |
| 23:46 | PR #224 ships: ZOMBIE FIX TDZ #2 (`_parityNoReentryH`) + incomplete D1 close. |
| 23:49 | PR #225 ships: shares double-discount. |
| 23:52 | PR #226 ships: hard SL bypasses minAge + `openTrade.sl` from D1. |
| 23:57 | PR #227 ships: close-adapter failure handling + allTrades sync. |
| 23:59 | PR #228 ships: backfill `tickerData._env._deepAuditConfig` from `env`. |
| 00:03 | PR #229 ships: dead-code removal + `parity_skip` replay-gated + close-skipped logs. |

---

## The 15-part hotfix bundle

PRs grouped by the trade-lifecycle layer they fix.

### Layer A: ENTRY / construction

#### PR #223 part 5 — `getOpenPositionAsTrade` trimmedPct (Bug — silent correctness, P0)

**Before:**
```javascript
trimmedPct = Math.min(1, trimmedQty / totalQty);  // totalQty = REMAINING
// 50%-trimmed: 50 / 50 = 1.0 (wrong)
```

**After:**
```javascript
const originalQty = totalQty + trimmedQty;
trimmedPct = Math.min(1, trimmedQty / originalQty);  // 50 / 100 = 0.5 (correct)
```

Affected every multi-trim position in the system since commit `d07d01e` introduced this loader.

#### PR #225 part 8 — `getOpenPositionAsTrade` shares (Bug #3, P0)

**Before:** `shares: totalQty` (remaining)
**After:** `shares: originalQty || totalQty` (original)

Aligns with codebase convention: every consumer multiplies `shares × (1 - trimmedPct)` to get remaining. With shares=remaining and trimmedPct=correct, the math double-discounted on every close/trim/smart-runner/adapter call.

#### PR #226 part 9 — `d1GetOpenPosition` SELECT (Bug #9, P1)

**Before:** SELECT missing `stop_loss` and `take_profit`
**After:** SELECT includes them; `getOpenPositionAsTrade` exposes `sl` / `stop_loss` / `tp` / `take_profit` on the returned object.

Defend logic, smart-runner tighten, MFE-safety, trim-SL adjustments, and the `*/1` price-feed SL check all read `openTrade.sl` → previously `undefined` → silent no-ops.

#### PR #228 part 12 — backfill `tickerData._env._deepAuditConfig` (Bug #10, P1)

163 in-function reads of `tickerData?._env?._deepAuditConfig?.*` were silently `undefined` on non-scoring invocations (POSITION RECONCILE, HTTP routes, queue-drain). Phase 4 G1/G2 gates, chop haircut, V13 safety nets, time-scaled max-loss, etc. all silently bypassed.

**Fix:** at top of `processTradeSimulation`, backfill `tickerData._env._deepAuditConfig` from `env._deepAuditConfig` (which the lazy-load already populates).

### Layer B: STATE / SCOPE bugs

#### PR #223 part 5 — ZOMBIE FIX `pxNow` TDZ (P0 — actual crash)

```javascript
// line ~16058 (pre-fix)
openTrade.exitPrice = Number(openTrade.trim_price || openTrade.trimPrice || pxNow) || 0;
//                                                                       ^^^^^^
// `let pxNow` declared at line ~16314 in the same scope. TDZ.
```

**Fix:** use `Number(tickerData?.price)` directly inside the zombie block.

#### PR #224 part 6 — ZOMBIE FIX `_parityNoReentryH` TDZ (Bug #2, P0)

Same class of bug, second occurrence. `_parityNoReentryH` and `parityNoReentryBlocked` declared at line ~20632, referenced at line ~16092 inside the zombie block.

**Fix:** inline a local read of the parity-window config; the canonical re-entry-block check at line ~20634 already scans `allTrades` for recent TP_FULL closes so the in-flight flag set is redundant.

### Layer C: EXIT / persistence

#### PR #224 part 7 — ZOMBIE FIX incomplete D1 close (Bug #4, P0)

**Before:** only `UPDATE trades SET status=...`. Did NOT update `positions` (status stayed OPEN) or insert an `execution_actions` CLOSE row.
**After:** also `UPDATE positions SET status='CLOSED'` and `INSERT INTO execution_actions ... 'CLOSE'`. POSITION RECONCILE no longer re-processes zombie-closed positions every cron.

#### PR #226 part 8 — hard SL bypasses `exitMinAgeOk` (Bug #8, P1)

The main exit gate at line ~19695 required `exitMinAgeOk` (default 15 min). A stop hit in the first 15 minutes was silently held with `[TRADE SIM] exit blocked: position only Xm old (min 15m)`.

**Fix:** define `_exitIsHardClass` using the same regex as `_exitIsHard`; gate is now `(exitMinAgeOk || _exitIsHardClass)`. Hard exits (SL, max_loss, HARD_LOSS_CAP, v13_hard_*) bypass the minimum-age guard.

#### PR #227 part 10 — `closeTradeAtPrice` adapter failure (Bug #5, P1)

**Before:** `await adapter.closePosition(...).catch((e) => console.error(...))`. Silent failure → in-memory looked closed, ledger EXIT inserted, KV cleared, but D1 positions stayed OPEN → next cron double-counted.
**After:** explicit `try/catch`; `[TRADE CLOSE OK]` on success, `[TRADE CLOSE FAILED]` on failure; KV entry-state clear is gated on success.

#### PR #227 part 11 — `persistTrades` stale OPEN (Bug #6, P1)

`closeTradeAtPrice` mutated `trade` but never updated the matching record in `allTrades`. End-of-function `persistTrades()` wrote stale OPEN to KV until next D1 reconcile.

**Fix:** after successful close, find matching trade in `allTrades` by id/trade_id and merge the closed-trade fields in. Gated on `_closeAdapterOk` so failed closes don't pollute KV.

#### PR #229 part 14 — `parity_skip_sl_breach` replay-gated (Bug #11, P2)

Historical backtest-parity crutch that suppresses `sl_breached` exits for `momentum_score / ripster_momentum / *_confirmed_long` paths. Already disabled in production config in this incident, but code path remained.

**Fix:** `_paritySkipSlEnabled = isReplay && (...)`. Flag still mirrors backtest behavior; never affects live trading.

### Layer D: OBSERVABILITY

#### PR #221 part 4 — `[SL_SAFETY_NET_TRACE]` + `[SL_GATE_TRACE]`

Trace logs that surface every guard value when an SL breach is detected. Now superseded by the actual fix (PR #223) but kept for forward-looking diagnostics.

#### PR #229 part 13 — dead code in `*/1` SL flag write (Bug #7, P2)

`*/1` cron wrote `trade._price_sl_triggered` flags + the entire trades list back to KV when any trigger hit. Zero consumers read the flags.

**Fix:** replace with a single INFO log showing crossed-SL detail. Sub-5-minute SL reaction is a separate intentional feature.

#### PR #229 part 15 — `closeTradeAtPrice` silent skips (Bug #12, P2)

Three guards in `closeTradeAtPrice` (invalid price, reference rail defer, non-finite shares) returned silently with no log.

**Fix:** explicit `[CLOSE_SKIPPED] {sym} {reason} — ...` markers for each.

---

## Bug catalog status (all 12 from explore audit + originals)

| # | Severity | Title | PR | Status |
|---|----------|-------|----|----|
| Original | P0 | SL leak: trimmedPct miscompute + ZOMBIE FIX `pxNow` TDZ | #223 | shipped |
| #1 | (re-evaluated) | SL safety net + isExit gate interaction | — | Not-a-bug; HTF cushion is intentional |
| #2 | P0 | ZOMBIE FIX `_parityNoReentryH` TDZ | #224 | shipped |
| #3 | P0 | `shares` double-discount in `getOpenPositionAsTrade` | #225 | shipped |
| #4 | P0 | ZOMBIE FIX leaves D1 positions OPEN | #224 | shipped |
| #5 | P1 | `closeTradeAtPrice` adapter failure swallowed | #227 | shipped |
| #6 | P1 | `persistTrades` overwrites KV with stale OPEN | #227 | shipped |
| #7 | P2 | `*/1` price-feed SL flags written but never consumed | #229 | shipped |
| #8 | P1 | 15-min `exitMinAgeOk` blocks hard SL | #226 | shipped |
| #9 | P1 | `openTrade.sl` missing from D1 load | #226 | shipped |
| #10 | P1 | Entry gates miss `env._deepAuditConfig` on non-scoring paths | #228 | shipped |
| #11 | P2 | `parity_skip_sl_breach` live-suppresses SL | #229 | shipped (replay-gated) |
| #12 | P2 | `closeTradeAtPrice` silent early-returns | #229 | shipped |

---

## Operational note: `*/5` cron CPU limit

`wrangler tail` also captured: `"*/5 * * * *" @ 11:15:05 PM - Exceeded CPU Limit`. The scoring cron is approaching the Workers CPU budget. Likely contributors (per explore agent):
- Full-universe scoring with `d1GetCandlesAllTfs` per ticker (batches of 15)
- KV snapshot assembly (N × `kvGetJSON`)
- Sparkline CTE
- D1 `ticker_latest` batch sync (up to 200 tickers × 40/chunk)
- Sequential `processTradeSimulation` for every open trade + ~200 execution tickers (each invoking management, optional AI CIO, multiple D1 reads)

**Not addressed in this audit** (would need a dedicated optimization pass). Mitigations to consider:
- Move snapshot/D1 sync to `ctx.waitUntil`
- Cap per-tick `processTradeSimulation` count
- Prioritize open positions only
- Split the `*/5` into two crons (open-trade management vs scoring/sync)

---

## Verification after all PRs merge

```bash
# 1. No more TDZ crashes
wrangler tail timed-trading-ingest --search "ReferenceError"
# Expected: silent.

# 2. SL safety net actually fires
wrangler tail timed-trading-ingest --search "SL_SAFETY_NET"
# Expected: [SL_SAFETY_NET] IWM LONG px=273 past sl=281.01 by 2.84% — forcing sl_breached...

# 3. 4 stuck trades close
wrangler d1 execute timed-trading-ledger --remote --command "
  SELECT ticker, status, exit_ts, exit_reason FROM trades
  WHERE ticker IN ('IWM','DE','DIA','MLI') AND status IN ('OPEN','TP_HIT_TRIM')"
# Expected: 0 rows. All closed with exit_reason='sl_breached'.

# 4. trimmedPct on /timed/all matches D1
wrangler d1 execute timed-trading-ledger --remote --command "
  SELECT ticker, trimmed_pct FROM trades WHERE status IN ('OPEN','TP_HIT_TRIM')"
# Expected: matches what /timed/all reports per ticker.

# 5. Phase 4 G1/G2 gates fire on non-scoring paths too
wrangler tail timed-trading-ingest --search "phase4_paused_gap_reversal_long\|cohort_fail_block"
# Expected: see rejections from POSITION RECONCILE / HTTP / queue paths.

# 6. Zombie close is fully clean
wrangler d1 execute timed-trading-ledger --remote --command "
  SELECT t.trade_id, t.status AS t_status, p.status AS p_status, p.closed_at,
    (SELECT COUNT(*) FROM execution_actions
     WHERE position_id = p.position_id AND action_type='CLOSE') AS close_actions
  FROM trades t JOIN positions p ON p.position_id = t.trade_id
  WHERE t.exit_reason = 'TP_FULL' ORDER BY t.exit_ts DESC LIMIT 5"
# Expected: t_status=WIN/LOSS/FLAT, p_status=CLOSED, close_actions>=1.
```

---

## Lessons added

1. **TDZ is a silent killer in long functions.** A `let` declaration anywhere in a function creates TDZ for the entire scope above it. In a 5,000-line function, you can have references to a variable 5,000 lines before its declaration with no IDE warning. Two instances in the same block (`pxNow`, `_parityNoReentryH`) cost us hours of misdirected hotfixing.
2. **Field naming matters.** `pos.total_qty` reads like "original qty" but is actually "remaining qty after trims." Code-review review for any field whose name doesn't disambiguate original-vs-current state.
3. **D1 must be internally consistent.** Closing only `trades` while leaving `positions` OPEN (zombie fix bug #4) created infinite re-processing AND broke audit ledgers. Any code that closes a trade must close the position and log the execution_action.
4. **Lazy-load lists are a hidden coupling.** Adding a new `_deepAuditConfig` key requires touching FOUR places: model_config, the inline `_daKeys` lazy-load, REPLAY_DA_KEYS, and the consumer's tickerData._env fallback. Fixed in PRs #214 / #228.
5. **Hard exits must bypass soft-signal gates.** SL is a hard ceiling — no minAge, no defer, no cushion (beyond intentional HTF cushion), no parity flag should EVER block an actual stop breach. Fuse paths already bypassed; we extended that to kanban+safety-net path.
6. **Silent .catch() is dangerous.** `adapter.closePosition(...).catch(e => console.error(e))` looks safe but lets in-memory state diverge from D1. Use explicit try/catch with success/failure markers.
7. **Diagnostic logs pay back fast.** PR #221's trace logs never fired (TDZ crashed before reaching them) — but the empty-tail observation is what made me look elsewhere and find the crash. Logs that DON'T fire are signal too.
8. **Walk the whole flow when you're stuck.** Three hotfix iterations (#217 → #218 → #220) all targeted the symptom (gate logic blocking close) when the real bug was upstream (silent crash). The explore-agent audit catalogued 11 more bugs in 30 minutes — should have done it earlier.
