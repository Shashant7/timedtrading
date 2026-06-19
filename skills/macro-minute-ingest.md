# Macro Minute (Tom Lee) full-content ingestion

**WHEN:** you want Tom Lee's Macro Minute *video* substance (not just the FSD
one-paragraph blurb) flowing into the research desk, or you're debugging why
Macro Minute content is thin.

## Background

The FSD fetch (`worker/cro/fsd-client.js`) already pulls each Macro Minute
**post**, but the body is ~1.7 KB — the blurb + a video embed. The substance is
in the video. Fundstrat mirrors every Macro Minute on its public YouTube
channel (`@fundstrat`, channel id `UCXKmQMS4TsR0fpviXJ17lRw`), so we ingest the
**transcript** (or, as a fallback, the richer YouTube description) through the
same CRO/FSD pipeline as the written notes.

Module: `worker/cro/macro-minute-youtube.js`. Lane is **OFF by default**.

## YouTube reality (verified 2026-06-18)

From a server/Worker context YouTube does **not** expose caption tracks in the
watch-page HTML, the `timedtext` endpoint returns empty, and the public
`videos.xml` RSS is throttled (1 entry). So a reliable pipeline needs keys:

| Need | Env var(s) | Notes |
|---|---|---|
| Reliable video **discovery** + descriptions | `YOUTUBE_API_KEY` | Google Cloud, free quota. Uses Data API `playlistItems` on the uploads playlist. RSS is a best-effort fallback. |
| Full **transcript** | `YT_TRANSCRIPT_API_URL` + `YT_TRANSCRIPT_API_KEY` | Provider-agnostic, Supadata-shaped (`GET ?url=<watch>&text=true`, `x-api-key`). Without it, we ingest the YouTube **description** (still richer than the FSD blurb). |
| Enable the nightly lane | `MACRO_MINUTE_YT_INGEST=on` | Runs in the `0 22 * * *` batch (~6 PM ET, after the video posts). |

Add secrets in the Cursor Dashboard (Cloud Agents → Secrets) or via
`wrangler secret put`.

## How to run

```bash
# Manual trigger (admin/API key):
curl -s -X POST "$LIVE/timed/admin/cro/macro-minute/ingest?key=$KEY" \
  -H 'content-type: application/json' -d '{"limit":5,"force":false}'
# → { ok, discovered, ingested, results:[{videoId, source:"transcript"|"description", chars}] }
```

Each video is ingested once (KV flag `timed:cro:mm-yt:ingested:{videoId}`, 180-day
TTL). `force:true` re-ingests. Content lands in `cro_publications` (title
`Video: Macro Minute: … (YouTube transcript)`, source_url = the watch URL) and
flows through extraction → CRO proposal → research note like any FSD note.

## Verify

```bash
# Did tonight's video land with real substance (not the 1.7KB blurb)?
wrangler d1 execute timed-trading-ledger --remote --json --command \
  "SELECT title, bytes_len, source_url FROM cro_publications WHERE source_url LIKE '%youtube.com%' ORDER BY fetched_at DESC LIMIT 5"
```

`bytes_len` should be multiple KB (transcript) vs ~1.7 KB for the FSD blurb.

## Notes / gotchas

- Discovery filters titles via `isMacroMinuteTitle()` (matches `macro minute` /
  `macro-minute`).
- If the operator cuts over to the standalone tt-research worker
  (`RESEARCH_EXTERNAL=true`), this nightly hook lives in the monolith block —
  port it to `worker/research/nightly-batch.js` at that point.
- Pure parsers (RSS, timedtext, provider JSON, title match) are unit-tested in
  `worker/cro/macro-minute-youtube.test.js`.
- For the @DeItaone / X ingestion ask (separate), there is still no X lane — the
  social tracker is StockTwits + ApeWisdom only; X needs the X API + a secret.
