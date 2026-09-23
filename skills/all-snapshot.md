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

The snapshot was the largest cause of the `exceededMemory` kills but not the
only one — four more followed it, and fixing this one alone did not turn the
tick green. See [the 128 MB is per ISOLATE](#the-128-mb-is-per-isolate-not-per-invocation).

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
await kvPutJSONIfFits(KV, ALL_SNAPSHOT_KEY, allSnapshotEnvelope(built), null,
  { label: ALL_SNAPSHOT_KEY });
```

`buildAllSnapshot` reads one payload, projects it, and lets it go before
the next read. The byte budget (`ALL_SNAPSHOT_MAX_BYTES`, 12 MB) is
checked as rows accumulate, so a runaway universe **degrades** (rows
omitted, `built.omitted` non-zero) rather than failing the write and
freezing the snapshot again.

---

## Any KV value that scales with the universe

`kvPutJSONIfFits` (`worker/storage.js`) is the guard. It measures, then
skips with a log rather than attempting a put that cannot succeed — a 413
on `ctx.waitUntil` keeps the whole value alive until the rejection settles,
which is half of how the isolate died.

```js
import { kvPutJSONIfFits, estimateMapBytes } from "./storage.js";

// A `{ SYM: row }` map: estimate first. Serializing 30 MB purely to measure
// IS the allocation you are trying to avoid. Sampling 3 rows of 330 is three
// ~93 KB stringifies instead of one 30 MB one.
await kvPutJSONIfFits(KV, key, { data, built_at }, 420, {
  label: "/timed/all micro full",
  estimateBytes: estimateMapBytes(data),
});
```

An estimate may only short-circuit a **refusal**, never approve a write —
if it says the value fits, the real byte count is still measured.

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
  five minutes instead of only when someone loads the page. The scoring tick
  OWNS `timed:cloud-pivot:desk`; `/timed/plays/today` reads it and never
  writes it, and decides it is real by `scanned > 0` — an empty `watching`
  array is truthy, and a handler-written empty desk shadowed the real one
  for a whole 6h TTL.
- **`nocache=1` bypasses the READ, not the WRITE.** The cron pre-warm passes
  it precisely so it does not serve itself a stale value; gating the write on
  it means the pre-warm warms nothing. And a micro-cache TTL must exceed the
  read window AND the pre-warm cadence (both 300s here, so 420s).
- **Pre-warm only a key that can actually be written.** The FULL `/timed/all`
  micro-cache is above the KV ceiling at this universe size, so dispatching
  it built ~30 MB of JSON over a ~38 MB graph, twice per tick, to write
  nothing. `?slim=1` is 244 KB and does land.
- **D1 caps a statement at 100 bound parameters.** `ticker IN (?,?,…)` over
  the universe throws `too many SQL variables`. Chunk it —
  `fetchSparklinesFromD1` in `worker/sparkline-d1.js` is the pattern.

---

## The 128 MB is per ISOLATE, not per invocation

Three separate causes hid behind that one sentence, and none of them was a
single large allocation. Each was found only after the previous one was
fixed and the kills continued.

- **Two heavy phases at once is a sum, not a max.** The scoring tail (slim
  index build, desk scan, D1 batch sync) was fired into `ctx.waitUntil` the
  moment scoring finished, so it ran alongside the kanban pass and position
  reconcile. `ctx.waitUntil` in a CRON handler buys nothing — there is no
  response to return early — it only buys overlap, and overlap is what the
  cap counts. The tail is stashed in `_deferredScoringTail` and awaited
  after reconcile. If you move that drain, keep it ABOVE the `isAITime`
  early return, or the tail silently stops running on all but three ticks a
  day. `worker/engine-oom-mirror-loss-2026-09-22.test.js` pins the order.
- **Count the SETS of payloads you hold, not the bytes you read.** Reading
  the universe one payload at a time is free; holding 268 of them is 128 MB
  on its own, because a `timed:latest` payload is ~165 KB of JSON and
  several times that as a parsed object graph. The D1 batch sync chunk is
  12 for the same reason — a chunk holds three payload-sized graphs per
  ticker (hydrated, enriched, and the previous payload parsed back out of
  D1), and it pushes the thin patch onto the write-back list, not the
  payload the patch came from.
- **Ranking needs the scores, not the payloads.** A score is a number.
  `processRankedCandidates` (`worker/ranking/candidate-rank.js`) scans
  every candidate, keeps `{ticker, score}`, drops the payload, sorts, then
  re-reads only the entry candidates it has to rank — one at a time, with
  one read in flight ahead so the reads overlap but the work stays strictly
  sequential (a later entry must observe the earlier one's capacity usage).
  It must stay streaming: the batched version it replaced was deleted
  rather than left beside it.
- **Two ticks can share one isolate.** When a `*/5` pass runs longer than
  five minutes the next one starts on top of it, in the same isolate, and
  both die. `_fiveMinHeavyPassSince` is a module-level lease for exactly
  that reason — two passes only contend when they share an isolate, and
  when they share an isolate they share the variable. It is engine-only:
  the monolith's `*/5` carries the price feed, which must never be skipped.
- **You cannot attribute a log line to a tick when two are running.** The
  kanban pass was read as "24s" by splicing one tick's scoring timestamp to
  the other's summary. It had always been ~200s. Check `outcome`/wall per
  invocation (`/tmp/woomts.sh <from> <to> <script>`) before believing a
  duration derived from timestamps.

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
- `worker/storage.js` — `kvPutJSONIfFits`, `estimateMapBytes`, `KV_MAX_VALUE_BYTES`
- `worker/kv-put-budget.test.js` — the put guard and the estimate
- `worker/sparkline-d1.js` / `worker/sparkline-d1.test.js` — chunked D1 reads
- `worker/ranking/candidate-rank.js` — streaming rank, never holds the batch
- `worker/engine-oom-mirror-loss-2026-09-22.test.js` — phase ordering + the lease
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "The snapshot outgrew its key" [2026-09-23]
