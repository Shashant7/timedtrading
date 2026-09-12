# Weekend CMT Desk / Timed Upticks

**WHEN:** Market is closed (weekend / holiday) and the book needs a
CMT-style pass across the universe — trendlines, EMA structure,
SuperTrend magnets, imbalance, news, Momentum Elite, and screener
names outside the book — plus the Saturday email so traders can
prepare for the open.

This is a **highlight / email** pass. Not a new buy path. Do not add
`tt_weekend_upticks` or skip setup grade.

## Why it exists

The `*/5` scoring cron **returns early** outside operating hours
(4 AM–8 PM ET weekdays). Friday close stamps sit unchanged until
Monday unless something forces `assembleTickerData`. The weekend desk
is that force: paged `rescoreStaleUniverse({ all: true })` on
Saturday, then compose Timed Upticks from the stamps the book
already knows.

Timed Upticks are **Timed's** confluence list (2+ CMT families,
score ≥ 36). They are not Newton's monthly Upticks. Newton overlap
is noted, not the definition.

## Cadence (tt-research hourly)

| NY slot | Action |
|---|---|
| Sat 10:00 | Start paged universe rescore + compose |
| Sat 11:00–16:00 | Continue rescore pages if a cursor remains |
| Last rescore page | Compose + one Weekend Desk email (Pro/VIP/Admin, `weekend_desk` pref) |
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

# Email immediately from current stamps (do not wait for rescore)
curl -s -A "Mozilla/5.0" -X POST "${LIVE}/timed/admin/weekend-desk?phase=refresh&email=1&force=1" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H "content-type: application/json" -d '{}'
```

Pro/VIP/Admin: `GET /timed/weekend-desk` (KV latest). Members/anon get
`error_kind: "tier_required"`.

## What it reads (no new indicator engine)

| Stamp | Source |
|---|---|
| Trendline / retest / breakout | `_breakout_watch` / `skills/breakout-watch.md` |
| SuperTrend hold / flat magnet | `flags.st_hold_*`, `flags.st_magnet_*` |
| EMA structure | `ema_map`, `ema_regime_daily` |
| FVG imbalance | `fvg_imbalance_D` |
| Momentum Elite | `flags.momentum_elite` |
| News / analyst | `_news_summary`, fundamentals snapshot |
| Outside-book candidates | `discovery_promotion_queue` (`needs_review` / `ready_to_add`) |

## Verify

1. `GET /timed/admin/weekend-desk` returns `timed_upticks` + `promotion_candidates`.
2. Email copy has no second person ("the trader" / "the book").
3. `/timed/health` `operatingHours` may be false — that is expected.
4. Do **not** treat a Timed Uptick as an entry. Setup grade still applies Monday.

## Source

`worker/weekend-desk.js` · cron in `worker/index.js` scheduled() hourly
(research role) · pref `weekend_desk` in `worker/email.js`.
