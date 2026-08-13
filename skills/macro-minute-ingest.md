# Macro Minute (Tom Lee) night-take ingestion

**WHEN:** Tom Lee's Macro Minute *spoken* substance is missing from the research
desk (FSD only stored the ~600 char blurb), or the morning brief is light on
calendar context (CPI, PPI, NFP, FOMC, earnings, policy) vs Newton's daily
technical note.

## What actually works (2026-08-13)

Daily Macro Minute is **not** on the public YouTube channel. It is a ~5 minute
Vimeo inside the Fundstrat Direct WP post. Player config exposes English
auto-captions. That VTT is the night take.

| Path | Role |
|---|---|
| FSD WP REST + Vimeo captions | **Primary.** Module `worker/cro/vimeo-transcript.js`, hooked in `ingestSinglePublication`. |
| Hourly FSD 14–23 UTC | Same-day posts that land by ~7 PM ET. |
| `fsd-evening` 00–03 UTC | 8–11 PM ET catch-up so 9 AM ET morning brief has it. |
| Nightly 22:00 UTC | `enrichMacroMinuteTranscripts` backfills thin blurbs (captions not ready on first fetch). |
| YouTube Data API | Optional mirror only. `@Fundstrat_Direct` is interviews, not current MM. |

## How to run

Admin route is key-or-admin. Header auth, not `?key=`.

```bash
curl -s -X POST "${LIVE}/timed/admin/cro/macro-minute/ingest" \
  -H "X-API-Key: ${TIMED_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"limit":8}'
# → { ok, vimeo: { scanned, attempted, ingested, results:[{pub_id, char_count, vimeo:{chars}}] }, youtube }
```

New FSD ingests attach `--- VIDEO TRANSCRIPT ---` automatically when the title
matches Macro Minute (or `Video:` + a Vimeo embed).

## Verify

```bash
wrangler d1 execute timed-trading-ledger --remote --json --command \
  "SELECT substr(p.title,1,80) AS title, t.char_count,
          instr(t.text_full, 'VIDEO TRANSCRIPT') AS has_tr
   FROM cro_publications p
   JOIN cro_publication_text t ON t.pub_id=p.pub_id
   WHERE lower(p.title) LIKE '%macro minute%'
   ORDER BY p.fetched_at DESC LIMIT 5"
```

`char_count` should be multiple thousand (spoken 5 min), not ~600. `has_tr` > 0.

## Notes

- Referer `https://fundstratdirect.com/` is required for `player.vimeo.com/video/{id}/config`.
- Prefer official English captions; fall back to `en-x-autogen`.
- YouTube Data API still cannot download caption tracks with an API key.
- PR **#718** is a stale YouTube-only duplicate of **#1232**. Leave it closed.
- Parsers: `worker/cro/vimeo-transcript.test.js`.
