# The universe snapshot (`timed:all:snapshot`)

**WHEN to use:** you need scored data for many tickers at once, you are
adding a field to the snapshot, you are writing a lane that scans the
universe, or something is serving stale scores.

**TL;DR:** the snapshot is a SLIM INDEX, not a payload store. Scan it for
selection; read `timed:latest:<SYM>` for detail. Never read the key
directly.

---

## Why it is slim

It used to hold the full scoring payload per ticker, and the universe grew
into two hard platform limits:

| Limit | Value | What happened |
|---|---|---|
| KV value size | 26,214,400 bytes | Hit 26,195,645 on 2026-08-14 (18,755 bytes spare). Every write after that was **silently rejected**. The blob served 2026-08-14 scores for 40 days while the cron logged success. |
| Worker isolate memory | 128 MB | ONE rebuild measured 182.1 MB (37.7 assembled graph + 36.7 payloads read + 57.7 stringify). The `*/5` scoring cron ended in `outcome: exceededMemory` every pass. |

At 333 tickers a full snapshot needs **52,687,072 bytes — 201% of the
ceiling** (a `timed:latest:` payload averages 158 KB; `tf_tech` alone is
27 KB). It does not fit and never will again.

The slim index is 1.75 MB at 333 tickers, one build costs 7.9 MB, and peak
retention during a build is the index plus a **single** payload.

---

## The API — `worker/all-snapshot.js`

```js
import {
  ALL_SNAPSHOT_KEY, ALL_SNAPSHOT_FIELDS, ALL_SNAPSHOT_SCHEMA,
  readAllSnapshot, hydrateSnapshotRows, selectAndHydrate,
  buildAllSnapshot, allSnapshotEnvelope, isSlimAllSnapshot,
  projectAllSnapshotRow, projectSnapshotPatch, applySnapshotEnrichment,
} from "./all-snapshot.js";
```

### Reading

```js
// ALWAYS state how stale you can accept. There is no default on purpose.
const snap = await readAllSnapshot(KV, { maxAgeMs: 6 * 3600 * 1000 });
const rows = snap?.data || {};          // { SYM: slimRow }
```

Four lanes had NO freshness gate and served 40-day-old scores:
`loadLatestPredictionTicker` (right rail), the convexity scanner, the
options plays lane, and the index-trend / day-trade dispatch. That is the
likely reason the model stopped taking options day trades. **If your read
has no age gate, it will one day serve a frozen blob and nobody will
notice.**

### Needing full payloads

```js
// Bounded. Chunked at 25, capped at 60 -- a careless caller still cannot
// hold the universe.
const full = await hydrateSnapshotRows(KV, ["SPY", "QQQ", "IWM", "DIA"]);

// Or: select on slim rows, hydrate the survivors.
const rows = await selectAndHydrate(KV, snap, (all) =>
  Object.entries(all).sort((a, b) => b[1].rank - a[1].rank).slice(0, 20).map(([s]) => s));
```

Every caller that used to read the blob already narrowed to a handful —
the options and index-trend lanes to the 4 index tickers
(`INDEX_TREND_TICKERS === DAY_TRADE_TICKERS === {SPY,QQQ,IWM,DIA}`), the
convexity scanner to its top 20. Reading those per ticker is **74x
cheaper** than the blob it replaced.

### Writing (the `*/5` scoring tick only)

```js
const built = await buildAllSnapshot(
  activeSyms,
  (sym) => kvGetJSON(KV, `timed:latest:${sym}`),
  { onRow: (sym, row, payload) => { /* enrich `row`; `payload` dies next iteration */ } },
);
await kvPutJSON(KV, ALL_SNAPSHOT_KEY, allSnapshotEnvelope(built));
```

`buildAllSnapshot` reads one payload, projects it, and lets it go before
the next read. The byte budget (`ALL_SNAPSHOT_MAX_BYTES`, 12 MB) is
checked as rows accumulate, so a runaway universe **degrades** (rows
omitted, `built.omitted` non-zero) rather than failing the write and
freezing the snapshot again.

---

## Adding a field

1. Is it a **selection criterion** — something a lane filters or ranks the
   whole universe on? Add it to `ALL_SNAPSHOT_FIELDS`. Measure it first
   (`JSON.stringify(payload[field]).length` across a few live payloads);
   the whole slim row averages 5.2 KB, so a 27 KB blob does not belong.
2. Is it **detail** for one ticker's view? Leave it out. Read it via
   `hydrateSnapshotRows`.
3. Does the CRON compute it rather than the payload carrying it (live
   price, sparkline, alignment, investor stage, leader/follow)? Add it to
   `ALL_SNAPSHOT_ENRICHED_FIELDS` too, or the D1 `ticker_latest` sync will
   silently go back to serving the scoring-time value.
4. Patching a row later? Go through `projectSnapshotPatch`, not a raw
   assign — thin-slice stamps are built for the full payload and would
   grow the index back toward the ceiling one stamp at a time.

`worker/all-snapshot.test.js` asserts the slim row satisfies
`extractSliceFields` identically to a full payload. If you break the Today
queue by dropping a field, that test tells you.

---

## Gotchas

- **`{data, count, built_at}` is an envelope, not a map.** `all[sym]` is
  `undefined`; you want `all.data[sym]`. `/timed/futures-pairs` got this
  wrong in both copies and silently took every field from `timed:prices`.
- **A slim index must not serve a full `/timed/all`.** Check
  `isSlimAllSnapshot(snapshot)` before serving a request that promises
  full payloads; the full path assembles from D1 (and has been since
  2026-08-14).
- **No module-level caches of the blob.** Isolates are reused, so module
  state outlives the invocation. `cro/fsd-rewriter.js` cached it for 60s
  and retained 25 MB across requests.
- **Accumulating "just the rows" can still retain the payloads.** If a row
  holds a reference into the payload, the payload is alive. Build the
  finished row at collection time (this is what `pendingTrailPoints` got
  wrong, carrying 329 payloads into the tail of the tick).
- **Rank where the data already is.** The Cloud Pivot desk needs deep
  10m/1h ripster clouds, so `/timed/plays/today` used to read the blob for
  them. It is ranked inside the scoring tick now
  (`rankCloudPivotDeskRow` + `assembleCloudPivotDesk`), which retains 69 KB
  of ranked rows instead of 52 MB of payloads — and the desk is fresh every
  five minutes instead of only when someone loads the page.

---

## Checking the live state

```bash
KVNS=e48593af3ef74bf986b2592909ed40cb
# Size + freshness (a slim index should be ~2 MB and minutes old)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$KVNS/values/timed:all:snapshot" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log("bytes",s.length,"rows",j.count,"schema",j.schema,"omitted",j.omitted||0,
        "built",new Date(j.built_at).toISOString(),"age_min",((Date.now()-j.built_at)/60000).toFixed(1));})'

# Is the scoring cron surviving? (exceededMemory means it is not)
bash /tmp/woutcome.sh $(( $(date +%s%3N) - 21600000 )) $(date +%s%3N) tt-engine
```

---

## Source

- `worker/all-snapshot.js` — the projection, the build, the readers
- `worker/all-snapshot.test.js` — projection completeness + budget degradation
- `worker/cloud-pivot-desk-streaming.test.js` — the desk moved into the tick
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "The snapshot outgrew its key" [2026-09-23]
