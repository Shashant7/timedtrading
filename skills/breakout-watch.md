# Breakout + trendline watch

**WHEN to use:** A name looks like it is breaking out (swing level or a
drawn trendline) and the question is whether the model is watching it —
or why it is in the Setup lane without a new buy.

This is a **watch / setup signal**, not a new auto-buy path. Setup grade
still applies. Do not add `tt_trendline_breakout` or skip
`qualifiesForEnter`.

## What promotes to Setup

| Kind | Fired when | Setup? |
|---|---|---|
| `trendline` | Daily close through a **2–3 touch** descending resistance (LONG) or ascending support (SHORT), RVOL ≥ 1.15 | Yes |
| `daily_level` | Existing `detectBreakout()` swing-level hit (already volume-gated) | Yes |
| `retest` | Price pulls back to a recently broken line and holds the breakout side | Yes — this is the look-for-entry |
| `atr_breakout` / `ema_stack` | Still stamped on `tickerData.breakout` for rank + the existing entry path | **No** — informational only |

Approaching the line, or a close-through with RVOL < 1.15, stays
`watch` with a **TL Watch** badge. A several-ATR-late print is ignored
(chase).

The visual line is the pair of recent swings that other swings do not
pierce (extra touches confirm). Last few bars are excluded from the fit
so the breakout print does not rewrite the line.

## Where it lives

| Piece | File |
|---|---|
| Pure detector + setup helper | `worker/breakout-watch.js` |
| Stamp on score | `assembleTickerData` → `_breakout_watch` / flags |
| Kanban | `classifyKanbanStage` (promote) + `deriveKanbanMeta` (Setup + approaching Watch) |
| Explain | `GET /timed/admin/entry-explain` `diag.breakout_watch` |
| Desk | Today `viewportActionChips`, right-rail badges, Active Trader row label |
| Existing entry path | `breakout_{type}_{long/short}` in `qualifiesForEnter` — **unchanged** |

Flags: `breakout_watch` (promotes), `breakout_approaching`, `breakout_retest`.

## Do not

- Invent a SuperTrend ENTRY / `tt_*` buy path for the trendline
- Bypass setup grade, rank, or CIO
- Unpause Support Bounce (`tt_n_test_support`)
- Promote EMA-stack / ATR range hits into Setup
- Treat Ripster EMA clouds as this overlay (Ripster in this repo is 5/12, 8/9, 34/50)

## Verify

```bash
node node_modules/vitest/vitest.mjs run \
  worker/breakout-watch.test.js \
  worker/api-tier.test.js
```

After deploy, rescore a name under a descending daily trendline (CRDO-class)
and check:

```bash
curl -sS -A "Mozilla/5.0" \
  "${WORKER}/timed/admin/entry-explain?ticker=CRDO&key=${TIMED_API_KEY}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('decision',{}).get('stage'), d.get('diag',{}).get('breakout_watch'))"
```

Fired / retest → stage `setup`. Approaching or low-RVOL pierce → `watch`
+ `approaching`. Members/anon must not see `breakout` / `breakout_watch`.
