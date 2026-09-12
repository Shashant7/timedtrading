# Newton Upticks monthly list update

**WHEN:** Fundstrat publishes a new monthly Upticks PDF / FSD post
(`Upticks – Month YYYY`) with Additions / Deletions, or the operator
hands over the PDF and asks to fast-track the new names.

## Source of truth

| Store | Role |
|---|---|
| FSD pub (WP) | Authoritative narrative + `$TICKER` cashtags |
| KV `timed:admin:upticks` | Live list used for +10 conviction bonus |
| `TT_SELECTED` / `TT_SELECTED_DEFAULT` | +15 curated bonus (keep aligned with KV) |
| `SECTOR_MAP` | GICS sector for scoring / investor |
| KV `timed:tickers` | Registry membership (must include adds) |

PDF reference copies live under `docs/reference-pdfs/`.

## Prefer FSD ingest over hand-editing

```bash
# 1) Find the pub
curl -s -X POST "${LIVE}/timed/admin/cro/fsd/list" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"limit":20}' | jq '.publications[] | select(.title|test("Upticks";"i"))'

# 2) Ingest if missing, then sync
curl -s -X POST "${LIVE}/timed/admin/cro/fsd/ingest" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"pub_id":"<ID>","force":true}'

curl -s -X POST "${LIVE}/timed/admin/cro/upticks/sync" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"pub_id":"<ID>","force":true}'
# → parsed.added / parsed.removed; KV already_current when list matches
```

Manual override (only if FSD text parse fails):

```bash
curl -s -X PUT "${LIVE}/timed/admin/upticks" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"tickers":["GOOGL","BA", "...full list..."]}'
```

## Onboard + score additions

Use **GOOGL** not GOOG when Newton writes Alphabet that way.

```bash
curl -s -X POST "${LIVE}/timed/watchlist/add" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"tickers":["GOOGL","BA","VLO","CVX"]}'

for t in GOOGL BA VLO CVX; do
  curl -s -X POST "${LIVE}/timed/admin/rescore-ticker?ticker=$t" \
    -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' -d '{}'
done
```

If a name is missing from `SECTOR_MAP`, add the GICS sector in
`worker/sector-mapping.js` in the same PR (do not leave KV as
"Technology Services" / Bloomberg-style labels). Sep 2026: `ALL` /
`DAL` were live Upticks with no map row; `DBA` was also missing from
D1 `ticker_index` **and** left on `timed:removed`. Adding the GICS
row is not enough — `POST /timed/admin/universe` must lift the
blocklist, and watchlist add must not reject ETFs via the TwelveData
stock list.

`GET /timed/admin/registry-alignment` (and the hourly
`registry_alignment` sweep) flags live Upticks on `timed:removed`,
missing GICS, and live-vs-`TT_SELECTED_DEFAULT` drift.

## Fast-track weighting

Conviction uses:

- `+10` when `env._currentUpticks` contains the ticker (loaded each
  scoring cron from `timed:admin:upticks`)
- `+15` when in `TT_SELECTED` / `TT_SELECTED_DEFAULT`

After a monthly rotation, update **`TT_SELECTED_DEFAULT`** in
`worker/focus-tier.js` (index.js aliases it — do not fork a second
Set). Then rescore every add. A KV-only sync without the code list
leaves new names at +0 curated / frozen D1 scores (DDOG Sep 2026:
on the live list, last `ticker_latest.ts` 2026-08-27, dead-weight
classified it as an unused add).

`worker/upticks-alignment.js` `diffUpticksAlignment(live, hardcoded)`
is the check. Adds also need a GICS row in `worker/sector-mapping.js`
— theme membership is not enough (DDOG/TEAM were `ai_software` only).

## Verify

```bash
curl -s "${LIVE}/timed/admin/upticks" -H "X-API-Key: ${TIMED_API_KEY}" | jq .
curl -s -X POST "${LIVE}/timed/admin/rescore-ticker?ticker=DDOG" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' -d '{}' | jq .
# expect sector Information Technology, non-null rank, fresh ts

curl -s "${LIVE}/timed/admin/entry-explain?ticker=DDOG" \
  -H "X-API-Key: ${TIMED_API_KEY}" | jq '.diag|{conviction,tier,focus_bonuses,in_upticks,in_tt_selected}'
# expect upticks:10, tt_selected:15, in_upticks/in_tt_selected true

curl -s "${LIVE}/timed/admin/registry-alignment" \
  -H "X-API-Key: ${TIMED_API_KEY}" | jq '{ok,upticks_on_removed,live_not_in_selected,selected_not_live}'
# expect ok:true, empty drift lists. If DBA is on timed:removed:
# POST /timed/admin/universe {"ticker":"DBA"}
```

## Macro Minute note

Upticks is Newton. Tom Lee Macro Minute is a separate arm — see
[macro-minute-ingest.md](macro-minute-ingest.md).
