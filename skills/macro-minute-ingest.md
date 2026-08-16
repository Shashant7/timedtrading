# Macro Minute (Tom Lee) night-take ingestion

**WHEN:** Tom Lee's Macro Minute *spoken* substance is missing from the research
desk, the morning brief is light on calendar context vs Newton's daily
technical note, or pipeline-health shows `macro_minute_freshness` thin/stale.

Daily Macro Minute is a first-class research arm. Ingest it, keep it fresh,
and cascade it into CRO synthesis → CIO memory → entries/exits. Do not wait
for the next episode.

## What actually works (2026-08-13)

Daily Macro Minute is **not** on the public YouTube channel. It is a ~5 minute
Vimeo inside the Fundstrat Direct WP post. Player config exposes English
auto-captions. That VTT is the night take.

| Path | Role |
|---|---|
| FSD WP REST + Vimeo captions | **Primary.** `worker/cro/vimeo-transcript.js`, hooked in `ingestSinglePublication`. |
| Hourly FSD 14–23 UTC | Same-day posts that land by ~7 PM ET. |
| `fsd-evening` 00–03 UTC | 8–11 PM ET catch-up so 9 AM ET morning brief has it. |
| Nightly 22:00 UTC | Full CRO cycle enriches thin blurbs, syncs the episode, synthesizes CRO note. |
| Freshness guard | KV `timed:cro:mm-freshness`. Stale/missing pages Discord; thin is tombstone-only. Staleness counts **missed Mon-Thu evenings**, not elapsed hours — stale at 2 consecutive misses. |
| YouTube Data API | Optional mirror only. `@Fundstrat_Direct` is interviews, not current MM. |

Cascade (do **not** force-fire broker orders):

1. Vimeo transcript on the publication (`--- VIDEO TRANSCRIPT ---`).
2. Once-per-episode extract (`syncLatestMacroMinuteProposals`). Apply only if
   the live overlay is empty or already this MM — never clobber a newer Newton
   Daily Technical Strategy overlay.
3. CRO daily note pins `night_take` (spoken excerpt) as `role=tom_lee_night_take`.
4. CIO memory Layer 15c + Daily Brief addendum consume `night_take`.
5. Next tt-engine `*/5` scoring tick reads CRO addendum + tactical overlay.

## How to run

Admin route is key-or-admin. Header auth, not `?key=`.

```bash
# Catch up transcripts + once-per-episode strategy sync + freshness stamp
curl -s -X POST "${LIVE}/timed/admin/cro/macro-minute/ingest" \
  -H "X-API-Key: ${TIMED_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"limit":8}'
# → { ok, vimeo, youtube, sync, freshness }

# Full research cycle (CTO + rotation + FSD + MM + CRO note). Returns 202.
curl -s -X POST "${LIVE}/timed/admin/cro/cycle" \
  -H "X-API-Key: ${TIMED_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"force":true}'
# poll GET /timed/cro/last-summary

curl -s "${LIVE}/timed/admin/cro/macro-minute/freshness" \
  -H "X-API-Key: ${TIMED_API_KEY}"
```

New FSD ingests attach `--- VIDEO TRANSCRIPT ---` automatically whenever the
post embeds a Vimeo player. `shouldFetchVimeoTranscript` no longer requires a
`Video:` title prefix.

## Other video-backed series

Macro Minute is not the only note that ships as video. **Newton's Daily
Technical Strategy** (`Technical Strategy MM/DD/YYYY`, first seen 2026-08-14)
has a body that is only the "leave us a 5-star review" footer — ~174 chars —
with the whole narrative and its support/resistance levels in the video.

- Caption backfill for every video series: `enrichVideoTranscripts()`
  (`VIDEO_POST_TITLE_PATTERNS` = macro minute + `technical strategy %`).
  The Newton pattern is anchored so it catches the daily without sweeping in
  the intraday `Mark L. Newton, CMT – …` text flashes.
- `enrichMacroMinuteTranscripts()` is the Macro-Minute-scoped view; the night
  take sync and the freshness guard stay Tom Lee only.
- Newton videos need no special sync — once the transcript is attached, the
  normal FSD extract → tactical overlay path picks up the levels.

```bash
# Widen the admin caption pass to every video series
curl -s -X POST "${LIVE}/timed/admin/cro/macro-minute/ingest" \
  -H "X-API-Key: ${TIMED_API_KEY}" -H 'content-type: application/json' \
  -d '{"limit":10,"scope":"video"}'
```

Re-ingesting one publication by id preserves the stored title/url/date; pass
`title` explicitly only when repairing a row.

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
Pipeline-health `kv.macro_minute_freshness.status` should be `fresh`.
`timed:cro:latest` should include `night_take.has_transcript=true`.

## Cadence — Macro Minute is NOT daily

Mon-Thu only. Across Jul 1 - Aug 14 2026 **every Friday was skipped (7 of 7)**
and Thursdays are roughly half. Weekends never publish.

`macro_minute_freshness` therefore measures missed *publication opportunities*
(`countMissedMacroMinuteSessions`), not wall-clock age. An elapsed-hours model
paged on Sundays — a Wednesday episode hits 90h by Sunday afternoon even
though Fundstrat had no expected slot in between and nobody could act. The
slot closes at 22:00 ET; two consecutive closed slots with no episode is
stale. Before assuming a real gap, confirm the desk is not simply publishing
under a different title (see the Newton case below).

## Notes

- Referer `https://fundstratdirect.com/` is required for `player.vimeo.com/video/{id}/config`.
- Prefer official English captions; fall back to `en-x-autogen`.
- YouTube Data API still cannot download caption tracks with an API key.
- PR **#718** is a stale YouTube-only duplicate of **#1232**. Leave it closed.
- Parsers: `worker/cro/vimeo-transcript.test.js`, `worker/cro/macro-minute-freshness.test.js`.
- Do not widen `0 14-23` to catch evening MM — that cron also gates investor
  rebalance + flash insights. Use the independent `fsd-evening` label.
