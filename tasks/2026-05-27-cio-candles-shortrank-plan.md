# Fix Plan — 2026-05-27: AI CIO + Candle Staleness + SHORT Min Rank

## Root causes confirmed

### A. AI CIO (silent since 2026-03-23, despite enabled)
`worker/index.js` has 3 sites that load deep-audit config via:
```js
const daKeys = REPLAY_DA_KEYS;
const daRows = (await db.prepare(
  `SELECT config_key, config_value FROM model_config WHERE config_key IN (${daKeys.map((_, i) => `?${i + 1}`).join(",")})`
).bind(...daKeys).all())?.results || [];
```
- Line 55399 — backtest replay
- Line 61370 — TrendHold gate eval
- Line 79237 — **the live */5 scoring cron**

`REPLAY_DA_KEYS.length === 474` today. Cloudflare D1's bind-param cap is ~100. The query throws, silent `} catch (_) {}` swallows it, `env._deepAuditConfig` stays `{}` or unset.

All 5 CIO lifecycle gates read `String(env?._deepAuditConfig?.ai_cio_enabled ?? "false") === "true"`:
- Line 19707 — STALL_FORCE_CLOSE exit CIO
- Line 19792 — RUNNER_STALE_FORCE_CLOSE exit CIO
- Line 20362 — EXIT CIO
- Line 20746 — TRIM CIO
- Line 22393 — ENTRY CIO

All evaluate to false → CIO bypassed on every entry/trim/exit/stall in production.

Same Bug C pattern that `worker/replay-runtime-setup.js:loadRunConfigSubset` already fixed for backtests — never propagated to the live `worker/index.js` paths.

### B. Candle staleness (D/60m for 252 tickers stale 13+ days)
`worker/index.js:77564` — the freshness auto-heal **SKIPS entirely** when `_staleTickersToHeal.length > 50`. We have 252 stale tickers → heal disabled, monitor keeps complaining without action. The original logic was "don't spam TwelveData" but the practical effect is "fleet-wide outage = system stops healing itself."

The deeper issue: even on a healthy system, open positions can drift to stale candles without any guard. A management decision (trim/exit/SL move) on a stale candle is operationally dangerous — see MU 2026-05-22 ($751 vs market $785 — first time we manually un-closed a trade).

### C. SHORT min rank
`model_config.deep_audit_short_min_rank = 80` today (set 2026-05-06). My 3-week review showed 1 SHORT in 45 entries (44 LONG / 1 SHORT). User asked to relax this.

---

## Fix design — minimal-impact, atomic

### Fix A — restore CIO lifecycle
- Replace the 3 `IN (?, …, ?)` loaders with the Bug C pattern: `SELECT config_key, config_value FROM model_config` (no filter), then filter in JS against `new Set(REPLAY_DA_KEYS)`. ~470 rows is cheap to fetch.
- Tighten the line-16079 lazy-load guard from `!env._deepAuditConfig` to `!env._deepAuditConfig || Object.keys(env._deepAuditConfig).length === 0`. An empty `{}` from a previous failed load no longer permanently disables re-load.
- Tag the load-failure path with an explicit `console.warn` (currently swallowed silently) so the next outage is visible in `wrangler tail` immediately.
- Validate via `GET /timed/admin/ai-cio/decisions?limit=5` — expect rows with `created_at` after the deploy, OR via a synthetic entry probe in the next cron tick.

### Fix B — candle freshness guarantee for open positions
Three layers, smallest blast radius first:

**B1 — Drop the fleet-wide-skip cap.** In `worker/index.js:77564`, when `_staleTickersToHeal.length > 50`, chunk into sequential 50-ticker batches instead of skipping. Still rate-limited by the 8-symbol/8s TwelveData PRO inside `DataProvider.backfill`. Worst case 252 tickers = 6 chunks × 30s/chunk = 3 min, all inside `ctx.waitUntil` so the cron itself doesn't block.

**B2 — Open-position freshness preflight.** New function `ensureOpenPositionCandlesFresh(env, openTickers, opts)`:
1. For each open-position ticker, read `MAX(ts)` for tf in (D, 60, 5) from `ticker_candles`.
2. Threshold: D ≤ 24h, 60 ≤ 2h during RTH (12h overnight/weekend), 5 ≤ 15min during RTH (no check OOH).
3. Any ticker stale on any TF → add to a `needs_heal` list.
4. If `needs_heal.length > 0`: call `DataProvider.backfill(env, needs_heal, "D", { sinceDays: 5 })`, then `"60"`, then `"5"`. Small set = single batch = fast.
5. Re-check freshness. Return `{ healed: [...], still_stale: [...] }`.

Wire it into:
- OOH POSITION RECONCILE loop (`worker/index.js:79041`) — call before the per-ticker `processTradeSimulation` loop.
- In-scoring TRADE UPDATE loop (`worker/index.js:80318`) — same shape.

**B3 — Block management on still-stale tickers.** When `still_stale` is non-empty:
- Stamp `tickerData.__candle_data_stale = true` (with detail of which TF) on the affected ticker's latest payload.
- In `processTradeSimulation`, before any trim/SL/exit/entry mutation, check the flag. If set: log `[STALE_CANDLE_BLOCKED]`, audit via `auditDataChange`, optionally fire a deduped Discord alert. Skip the action.
- One side effect: a freshly-opened entry that has 13-day-stale daily candles would also be blocked — that is the correct conservative behavior.

This makes the design promise: **the engine refuses to trade or manage on stale candle data**. The MU incident shape (stale price drives bogus SL exit) cannot recur via this surface.

### Fix C — relax SHORT entry
`POST /timed/admin/model-config` with:
```json
{ "updates": [
  { "key": "deep_audit_short_min_rank", "value": 55,
    "description": "Relaxed 80→55 (2026-05-27): 1 SHORT / 45 entries in 3-week live window made system de facto long-only in chop tape" }
] }
```

---

## Verification

After deploy:
1. `GET /timed/admin/ai-cio/decisions?limit=10` → newest `created_at` must be > deploy time.
2. `GET /timed/admin/cron-status` → `candle_freshness_d` + `candle_freshness_60` move from FAILING → ok within 1-2 cron ticks (after self-heal chunks through).
3. `GET /timed/admin/candle-freshness` → D p95 drops from 13d → < 1d.
4. `GET /timed/admin/model-config?prefix=deep_audit_short_min_rank` → value `55`, updated_at after deploy.
5. Watch `wrangler tail` for `[STALE_CANDLE_BLOCKED]` events on open positions (should be zero after B1+B2 stabilize).

## Rollback

- Fix A: revert the 3 query rewrites + lazy-load guard tighten in `worker/index.js`. CIO returns to silent.
- Fix B: revert the freshness preflight + chunked heal. Auto-heal returns to the >50 skip behavior.
- Fix C: re-POST with `value: 80`.

All three rollbacks are independent and code-only.

## Out of scope (intentional — defer)
- `weekly_retro` cron failure root-cause (separate fix; can investigate after this lands).
- HMM label-disagreement watch (operator action, not code).
- Speculative-grade volume cap (separate decision — needs evidence first).
