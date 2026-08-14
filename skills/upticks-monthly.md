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
"Technology Services" / Bloomberg-style labels).

## Fast-track weighting

Conviction uses:

- `+10` when `env._currentUpticks` contains the ticker (loaded each
  scoring cron from `timed:admin:upticks`)
- `+15` when in `TT_SELECTED` / `TT_SELECTED_DEFAULT`

After a monthly rotation, update **both** hardcoded sets to match the
live KV list so cold isolates and backtest-safe defaults stay aligned.

## Verify

```bash
curl -s "${LIVE}/timed/admin/upticks" -H "X-API-Key: ${TIMED_API_KEY}" | jq .
curl -s -X POST "${LIVE}/timed/admin/rescore-ticker?ticker=VLO" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' -d '{}' | jq .
# expect has_W/has_M true, sector Energy, non-null rank
```

## Macro Minute note

Upticks is Newton. Tom Lee Macro Minute is a separate arm — see
[macro-minute-ingest.md](macro-minute-ingest.md).
