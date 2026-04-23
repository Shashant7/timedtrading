# V11 Stale OPEN Positions — Root Cause Analysis

**Observed 2026-04-23, mid-run (day 144/210, V11 ID `phase-i-v11-1776897135`)**

## Symptoms

Query of `GET /timed/admin/trade-autopsy/trades?runId=phase-i-v11-…&archived=1` returned 12 trades with `status='OPEN'` or `status='TP_HIT_TRIM'`:

| Entry Date | Ticker | Age (cal-days) | PnL % | MFE % | Status | Setup |
|---|---|---:|---:|---:|---|---|
| 2025-08-18 | SGI | 161 | — | — | TP_HIT_TRIM | tt_pullback |
| 2025-08-19 | BABA | **160** | +1.26 | null | OPEN | tt_pullback |
| 2025-08-19 | ITT | **160** | +4.71 | null | OPEN | tt_pullback |
| 2025-08-21 | LITE | 158 | — | — | TP_HIT_TRIM | tt_pullback |
| 2025-08-26 | AAPL | **153** | +1.20 | null | OPEN | tt_pullback |
| 2025-08-27 | J | **152** | -0.34 | null | OPEN | tt_pullback |
| 2025-11-25 | AGQ | **62** | +0.93 | null | OPEN | tt_pullback |
| 2025-12-01 | AAPL | 56 | — | — | TP_HIT_TRIM | tt_pullback |
| 2025-12-08 | CCJ | **49** | -1.11 | null | OPEN | tt_pullback |
| 2025-12-11 | GRNY | **46** | +0.10 | null | OPEN | tt_momentum |
| 2025-12-23 | LSCC | 34 | +0.61 | null | OPEN | tt_pullback |
| 2026-01-26 | TSM | 0 | -0.16 | null | OPEN | tt_pullback |

The Phase-I W1.3 stale-position timeout (DA key `deep_audit_stale_position_force_close_days=45`) **is active** but failed to fire on 7 positions past 45 days.

## Root causes

### #1 — Guard polarity wrong for mature profitable drifters

`worker/index.js:6735`:
```js
if (_agDays >= _stalePosDays && _mfeAbs < 2.0 && pnlPct < 1.0) {
  tickerData.__exit_reason = "STALE_POSITION_TIMEOUT";
```

The `pnlPct < 1.0` clause was intended as "don't kick out a position that's currently winning." In practice it shields positions drifting at +1% to +5% for 4+ months — exactly what the guard is meant to prevent.

**Blocked trades (gate said "you're profitable, stay alive"):**
- BABA: +1.26 % after **160 days**
- ITT: +4.71 % after **160 days**
- AAPL: +1.20 % after **153 days**
- AGQ: +0.93 % after 62 days  (would have fired: pnl < 1.0)
- GRNY: +0.10 % after 46 days (would have fired)

### #2 — MFE never persists for OPEN trades

Per-status MFE population audit:

| Status | has_mfe | no_mfe |
|---|---:|---:|
| WIN | 76 | 0 |
| LOSS | 52 | 9 |
| TP_HIT_TRIM | 0 | 3 |
| OPEN | 0 | 9 |
| FLAT | 0 | 4 |

MFE/MAE are only written to the trade row at **exit time**. Open positions carry `max_favorable_excursion=null`, so the intra-run MFE-aware exit tiers (`phase_i_mfe_fast_cut_zero_mfe`, `phase_i_mfe_cut_2h`, `phase_i_mfe_cut_4h`, 72h stale, 24h dead-money) are effectively disabled for live-evaluated positions.

The stale-position gate happens to still work because its predicate `_mfeAbs < 2.0` is trivially satisfied when `_mfeAbs=0`. Other MFE tiers are stricter and silently no-op.

### #3 — TP_HIT_TRIM runners have no close rule

SGI (Aug 18, 161d), LITE (Aug 21, 158d), AAPL (Dec 1, 56d) all reached TP1, trimmed, and the runner leg has been drifting for months. The stale-position guard may not even evaluate positions with `currentTrimPct > 0`, and the runner-drawdown cap (`deep_audit_runner_drawdown_cap_pct=-2.0`) only fires on drawdown, not on time.

**We have no time-based exit rule for a runner that is neither deeply red nor stopped out.**

## Blast radius on V11 metrics

If any of BABA/ITT/AAPL/J close on 2026-04-30 (last day of backtest) as WIN:
- Misattributes +4.71 % over 160 days as a "win" when the thesis expired months ago
- Inflates win rate and PnL
- Masks the fact that the entry was long since invalidated by regime change

If they close as LOSS:
- Concentrates losses on the last day, distorting monthly attribution

Either way the metrics are corrupted. We need the patch live before V12.

## Proposed V12 patches (NOT to apply mid-V11)

### Patch 1 — Tighten stale-position guard

```js
// OLD
if (_agDays >= _stalePosDays && _mfeAbs < 2.0 && pnlPct < 1.0) { … }

// NEW — drop the pnlPct shield entirely. If a position has drifted
// for 45+ calendar days, it should close regardless of current pnl.
// The ONLY reason to keep a 45-day-old position open is if it's
// hit meaningful MFE AND is currently breaking out. Replace the
// "currently up" shield with a "currently breaking out" shield.
const _currentlyBreakingOut =
  (pnlPct > 2.0) ||                            // big green
  (pnlPct > 0.5 && _mfeAbs >= 3.0 && _mfeAbs - pnlPct < 0.5); // near MFE
if (_agDays >= _stalePosDays && !_currentlyBreakingOut) { … force-close … }
```

### Patch 2 — Persist MFE/MAE on every eval tick for OPEN trades

In the replay executor, after computing `pnlPct` for each open position each bar, persist `max_favorable_excursion = max(current, pnl_pct)` and `max_adverse_excursion = min(current, pnl_pct)` back to the trade row. Expensive but one row/ticker/bar — bearable.

Alternative: carry MFE in memory only (replay state) and flush to D1 every N bars or on exit.

### Patch 3 — Time-based cap on TP_HIT_TRIM runners

Add a new gate: if `currentTrimPct > 0 && _agDays > 30 && pnlPct < pnlAtTrim - 0.5`, flatten. A runner that's given back half a percent over 30 days post-trim has failed its runner thesis — take it off.

Simpler alternative: all TP_HIT_TRIM positions auto-flatten at 45 days absolute, same threshold as stale-position.

## Immediate action

**None.** V11 runs to completion (~63 days left × 3 min/day ≈ 3 hrs). We'll measure the stale-OPEN impact in the V11 autopsy and apply all three patches for the V12 re-run.

Recording lesson in `tasks/lessons.md` under "Exit-rule integrity — never shield force-close on current pnl alone."
