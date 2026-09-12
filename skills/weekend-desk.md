# Weekend CMT Desk / TT Setups

**WHEN:** Market is closed (weekend / holiday) and the book needs a
CMT-style pass across the universe — trendlines, volume, EMA structure,
SuperTrend magnets, imbalance, news — then a short Saturday email so
traders can prepare for the open.

This is a **highlight / email** pass. Not a new buy path. Do not add
`tt_weekend_upticks` or skip setup grade. Do not call the list
Upticks — that name is Newton's monthly list.

## Why it exists

The `*/5` scoring cron **returns early** outside operating hours
(4 AM–8 PM ET weekdays). Friday close stamps sit unchanged until
Monday unless something forces `assembleTickerData`. The weekend desk
is that force: paged `rescoreStaleUniverse({ all: true })` on
Saturday, then compose **TT Setups** from the stamps the book
already knows.

TT Setups are a **short unique list** (3–4 names). Each name is a
structure story: named **support** or **resistance** (not "the
line"), daily-brief tone + ticker chips, and **daily candles** so
gaps stay visible. Also-on-the-tape names get the same charts.
Longs lead; a quality short (retest / fired / quiet probe) is added
only when longs are thin. If the setup fired, or a flat HTF shelf is
the magnet, the mail names the **target** and the potential R:R when
both sides are real. Magnet cards always name the shelf price even
when `stLine` is missing. Distant 150/300/500 handles are not first
targets — only a nearby handle on a fired break. Personality, psych
handles, and earnings appear only when the payload already has them. Volume is a first-class CMT
input. Indicator tags stay off the subscriber email.

**Email is admin-only** until `WEEKEND_DESK_BROADCAST=1` is set on
the worker. Cron and `force=1` still send, but only to
`ADMIN_EMAIL`. Do not blast members while the copy is being locked.

Admin GET still keeps the internal buckets for ops.

## Cadence (tt-research hourly)

| NY slot | Action |
|---|---|
| Sat 10:00 | Start paged universe rescore + compose |
| Sat 11:00–16:00 | Continue rescore pages if a cursor remains |
| Last rescore page | Compose + one TT Setups email to `ADMIN_EMAIL` (members only after `WEEKEND_DESK_BROADCAST=1`) |
| Sun 10:00 | Recompose from Saturday stamps; email only if Saturday did not send |

## Commands

```bash
LIVE=https://timed-trading-ingest.shashant.workers.dev

# Compose from current KV/D1 stamps (no rescore, no email)
curl -s -A "Mozilla/5.0" -X GET "${LIVE}/timed/admin/weekend-desk?fresh=1" \
  -H "X-API-Key: ${TIMED_API_KEY}" | python3 -m json.tool | head -80

# Run now: paged rescore + email when the last page finishes
curl -s -A "Mozilla/5.0" -X POST "${LIVE}/timed/admin/weekend-desk?rescore=1&email=1&notify=1" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H "content-type: application/json" -d '{}'

# Admin-only preview from current stamps (do not wait for rescore)
curl -s -A "Mozilla/5.0" -X POST "${LIVE}/timed/admin/weekend-desk?phase=refresh&email=1&force=1" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H "content-type: application/json" -d '{}'
```

Until `WEEKEND_DESK_BROADCAST=1`, that send goes only to `ADMIN_EMAIL`
even with `force=1`. Expect `email.recipients === 1` and
`email.preview === true`.

Pro/VIP/Admin: `GET /timed/weekend-desk` (KV latest). Members/anon get
`error_kind: "tier_required"`.

## What it reads (no new indicator engine)

| Stamp | Source |
|---|---|
| Trendline / retest / breakout | `_breakout_watch` / `skills/breakout-watch.md` |
| Volume / quiet pierce | `_breakout_watch.rvol`, `reason=tl_through_low_rvol`, `rvol_map` |
| SuperTrend hold / flat magnet | `flags.st_hold_*`, `flags.st_magnet_*` |
| EMA structure | `ema_map`, `ema_regime_daily` (confluence only — not a featured headline) |
| FVG imbalance | `fvg_imbalance_D` |
| Momentum Elite | `flags.momentum_elite` (confluence only) |
| News / analyst | `_news_summary`, fundamentals snapshot |
| Outside-book candidates | `discovery_promotion_queue` (`needs_review` / `ready_to_add`) |

## Verify

1. `GET /timed/admin/weekend-desk` returns `featured` (unique tickers) + `story` on each card.
2. Email copy says **TT Setups**, uses ticker chips + Georgia "Weekend watch", `/timed/chart-image?style=candles`, named support/resistance (no "the line"), no `st_magnet` / `ema_short` tags, no repeated tickers. Daily candles are 60 unique sessions (one bar per day). D/W writes snap to 00:00 UTC and drop sibling 04:00 stamps. Displayed R:R caps at 4. Magnet stories use a daily chart. Opposite-side magnets that sit far away are not called the target.
3. Email copy has no second person ("the trader" / "the book" / "the model").
4. `/timed/health` `operatingHours` may be false — that is expected.
5. Do **not** treat a TT Setup as an entry. Setup grade still applies Monday.

## Source

`worker/weekend-desk.js` · cron in `worker/index.js` scheduled() hourly
(research role) · pref `weekend_desk` in `worker/email.js`.
