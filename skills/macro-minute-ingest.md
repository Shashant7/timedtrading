# Macro Minute (Tom Lee) full-content ingestion

**WHEN:** Tom Lee's Macro Minute *video* substance is missing from the research
desk (FSD only stored the ~1.7 KB blurb), or a YouTube Data API key was just
provisioned.

## Background

The FSD fetch (`worker/cro/fsd-client.js`) already pulls each Macro Minute
**post**, but the body is ~1.7 KB — the blurb + a video embed. The substance is
in the video. Fundstrat Direct hosts the clip on Vimeo (members). The public
YouTube channel (`@fundstrat`, `UCXKmQMS4TsR0fpviXJ17lRw`) is the ingest
source when they still mirror the episode there.

Module: `worker/cro/macro-minute-youtube.js`.

Nightly lane **auto-runs when `YOUTUBE_API_KEY` is set** on tt-research.
`MACRO_MINUTE_YT_INGEST=off` is the kill switch.

## Secrets (never commit the key)

| Need | Env var(s) | Where to put it |
|---|---|---|
| Reliable video **discovery** + descriptions | `YOUTUBE_API_KEY` | Cloudflare secret on **monolith** (admin route) **and** **tt-research** (22:00 UTC cron). Google Cloud YouTube Data API v3, free quota. |
| Full **spoken transcript** | `YT_TRANSCRIPT_API_URL` + `YT_TRANSCRIPT_API_KEY` | Optional. Provider-agnostic, Supadata-shaped. Without it, ingest uses the YouTube **description** (still richer than the FSD blurb). |
| Kill switch | `MACRO_MINUTE_YT_INGEST=off` | Dashboard **var** (not a secret). Omit or `on` to run when the Data API key is present. |

```bash
# Paste the key at the prompt (stdin). Both envs + tt-research.
cd worker
../node_modules/.bin/wrangler secret put YOUTUBE_API_KEY
../node_modules/.bin/wrangler secret put YOUTUBE_API_KEY --env production
cd ../worker-research
../node_modules/.bin/wrangler secret put YOUTUBE_API_KEY
../node_modules/.bin/wrangler secret put YOUTUBE_API_KEY --env production
```

Do **not** put the key in `wrangler.toml`, git, or chat logs.

## How to run

Admin route is key-or-admin. Send the API key in a header, not `?key=`.

```bash
curl -s -X POST "${LIVE}/timed/admin/cro/macro-minute/ingest" \
  -H "X-API-Key: ${TIMED_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"limit":5,"force":false}'
# → { ok, discovered, ingested, results, diag }
# diag: key_present, youtube_http, search_http, playlist_titles, youtube_error (redacted)
```

Each video is ingested once (KV flag `timed:cro:mm-yt:ingested:{videoId}`, 180-day
TTL). `force:true` re-ingests. Content lands in `cro_publications` (title
`Video: Macro Minute: … (YouTube transcript)`, `source=youtube`) and flows
through extraction → CRO proposal → research note like any FSD note.

The 22:00 UTC research batch (`worker/research/nightly-batch.js`) runs the same
ingest after the CRO cycle (~6 PM ET, after the video typically posts).

## Verify

```bash
wrangler d1 execute timed-trading-ledger --remote --json --command \
  "SELECT title, bytes_len, source, source_url FROM cro_publications WHERE source_url LIKE '%youtube.com%' ORDER BY fetched_at DESC LIMIT 5"
```

`bytes_len` should be multiple KB (transcript) or at least a richer description
than the ~1.7 KB FSD blurb.

## Notes / gotchas

- Discovery filters titles via `isMacroMinuteTitle()` (`macro minute` / `macro-minute`).
  It scans the last 50 uploads plus `search.list` for "Macro Minute" on `@fundstrat`.
- Empty `discovered:0` used to always say "configure YOUTUBE_API_KEY". The ingest
  payload now includes `diag` (playlist/search HTTP, sample titles, redacted API
  error). A 403 with a referrer restriction means the Google Cloud key must be
  unrestricted (no HTTP-referrer lock) — Workers have no stable referrer.
- YouTube Data API cannot download caption tracks with an API key (OAuth only).
  Spoken-word transcripts need `YT_TRANSCRIPT_API_*` or a later OCR sidecar for slides.
- PR **#718** is a stale duplicate of **#1232**. Close it; do not merge (conflicts;
  nightly hook was on the monolith `scheduled()` instead of `nightly-batch.js`).
- Pure parsers are unit-tested in `worker/cro/macro-minute-youtube.test.js`.
