# 2026-06-16 — Registry source of truth, day-trade lean, PML horizon, AT no-fire

Branch: `cursor/central-ticker-registry-cbcd` · PR #683. Four operator items.

## 1. Ticker registry = single source of truth (DONE)
**Problem:** unscored tickers clustered at (0,0) on the Bubble Map; "various
lists of tickers." **Root cause:** scoring cron unioned only `SECTOR_MAP ∪
user_tickers`; `/timed/tickers` unioned 5 sources incl. KV `timed:tickers`;
**screener promotion wrote only `timed:tickers`** → orphans (in registry, never
scored). PR #680 was a frontend band-aid.

**Fix:** `worker/universe.js` `resolveScoringUniverse()` — the canonical resolver
(`SECTOR_MAP ∪ active user_tickers ∪ KV timed:tickers (+ D1 ticker_index) −
timed:removed`). The scoring cron AND `/timed/tickers` both route through it, so
the scored set == registry. `MARKET_PULSE` stays out (context, not registry).
Sanctioned mutation paths unchanged (ADD: Admin/User Slot/ETF Sync/Screener;
REMOVE: Admin/User Slot/ETF Sync). Skill: `skills/ticker-registry.md`. 7 tests.

## 2. Docs cleanup (DONE)
Added `skills/ticker-registry.md` (+ README index), CONTEXT.md critical-lesson
bullets (registry, day lean/PML, AT no-fire), this session log.

## 3. Active Trader no-fire — VALID (verified, no code change)
0 rows in `ai_cio_decisions` for the day → nothing reached the CIO gate. The
upstream entry-qualification gate rejected the top candidates:
`VMI/TTMI/CPER → h3_consensus_below_min`, `MOD → focus_conviction_below_floor`,
`PM → focus_tier_c_below_c_floor`. SPY regime combined = NEUTRAL. AT hunts
durable LONG moves; correctly sat out a neutral/bearish range day (the edge was
index puts — a day-trade/short play AT doesn't chase). Probe:
`GET /timed/admin/entry-explain?ticker=X`.

## 4. Day-trade lean + PML horizon (DONE)
- **Day lean:** `computeDayLean` (`worker/day-trade-game-plan.js`) — near-term
  directional read from gap vs prior close, overnight-midpoint position,
  opening-range break (resolved only), + daily-structure nudge. The brief Index
  Playbook + AI prompt now LEAD with the favored side ("Lean SHORT — primary
  play bear below X; flips long only on Y") instead of a symmetric menu. This is
  the day-trader's edge; iteration 1, tunable. Threaded `trendBias` from
  `ticker-scenario.js` (5-day SMA deviation). 5 tests.
- **PML horizon:** CTO `HORIZON_BARS`/`HORIZON_DAYS` 20 → **10** (~2 weeks),
  env `CTO_HORIZON_BARS`. Close magnets + a 20-day window made every level read
  "highly likely"; ~2 weeks differentiates them and matches the Active Trader's
  multi-day lane.

## Lane hierarchy (operator framing, keep honest)
Day Trader (today/tomorrow) → Active Trader (multi-day/weeks) → Investor (long
haul). Investor working; AT correctly quiet on range days; Day-trader
predictions now express a lean.

## Verify after deploy
- Trigger a scoring cycle; confirm a screener-promoted ticker gets scores (not
  an orphan). `/timed/all` scored count ≈ `/timed/tickers` count − MARKET_PULSE.
- Morning brief Index Playbook shows a single lean per index, not bull+bear.
- PML rows show "~10 sessions" horizon note.
