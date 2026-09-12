# Breakout + trendline watch

**WHEN to use:** A name looks like it is breaking out (swing level, ATR
range, or a drawn trendline) and the question is whether the model is
watching it — or why it is in the Setup lane without a new buy.

This is a **watch / setup signal**, not a new auto-buy path. Setup grade
still applies. Do not add `tt_trendline_breakout` or skip
`qualifiesForEnter`.

## What the model watches

| Kind | Source | Fired when |
|---|---|---|
| `daily_level` / `atr_breakout` / `ema_stack` | `detectBreakout()` in `worker/indicators.js` | Existing volume-confirmed level / range / stack break |
| `trendline` | `detectTrendlineBreak()` in `worker/breakout-watch.js` | Daily close through a **descending resistance** (LONG) or **ascending support** (SHORT), same swing+regression math as the right-rail overlay |

Approaching the line stays `watch`. Only a this-bar close-through
promotes to `setup` with `__setup_reason` `breakout_watch:<kind>:<dir>`
and the copy "look for a good entry".

A close already several ATR past the line is treated as late (chase),
not a fresh watch.

## Where it lives

| Piece | File |
|---|---|
| Pure detector + setup helper | `worker/breakout-watch.js` |
| Stamp on score | `assembleTickerData` → `_breakout_watch` / `breakout_watch` / `flags.breakout_watch` |
| Kanban | `classifyKanbanStage` (no open position) |
| Explain | `GET /timed/admin/entry-explain` `diag.breakout_watch` |
| Activity tape | `type: breakout_watch` (no extra Discord; setup lane already covers it) |
| Existing entry path | `breakout_{type}_{long/short}` in `qualifiesForEnter` — **unchanged** |

## Do not

- Invent a SuperTrend ENTRY / `tt_*` buy path for the trendline
- Bypass setup grade, rank, or CIO
- Unpause Support Bounce (`tt_n_test_support`)
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

Fired → stage `setup`, `diag.breakout_watch.active=true`.
Approaching → stage stays `watch`, `approaching=true`.
Members/anon must not see `breakout` / `breakout_watch` (`redactTickerSnapshot`).
