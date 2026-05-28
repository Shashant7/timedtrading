# Dell — staleness investigation + earnings-radar miss (2026-05-28)

> Written 2026-05-28 21:45 UTC against `main` worker
> `https://timed-trading-ingest.shashant.workers.dev`. All numbers below
> were probed live from public endpoints + the codebase.

## TL;DR

User asked "look into Dell — why is it so stale, and why didn't it show on
our earnings radar?"

1. **Stale in our system** — three independent failures, only one of which
   was patched by PR #265 (2026-05-22). DELL is the **only ticker** that is
   simultaneously missing from BOTH `/timed/all` AND `/timed/prices` while
   still being registered in `/timed/tickers`. `timed:latest:DELL` is frozen
   at the **exact same `ts` and `price` ($203.14) that PR #265 flagged six
   days ago** — the SECTOR_MAP fix landed but the KV stub never refreshed.
2. **Earnings radar miss** — DELL **does** make it into the
   `/timed/earnings/upcoming` API payload (via the D1 `market_events`
   fallback added in the 2026-05-20 INTU fix), but is silently truncated
   off the Today-page UI by the `EarningsStrip`'s **per-day cap of 6
   rows**. 22 tickers report today; only 6 are rendered. DELL is 7th in
   the alphabetical AMC sort. It also fails the TwelveData confirmation
   gate in the backend.
3. DELL reported Q1 FY27 today (2026-05-28 AMC, 04:05 PM ET): **revenue
   +88% YoY, non-GAAP EPS $4.86 vs consensus $2.997 → +62% beat**. This is
   exactly the kind of catalyst the radar exists to surface. We did not.

---

## 1. Evidence

### 1.1 `timed:latest:DELL` is frozen 24 days

Probe: `GET /timed/latest?ticker=DELL`

```
ts                  2026-05-04 20:00:00 UTC  (24 days stale)
trigger_ts          2026-04-15 13:30:00 UTC  (43 days stale)
ingest_ts           2026-05-04 20:00:00 UTC
data_source_ts      2026-05-04 20:00:00 UTC
price               203.14         ← DELL closed yesterday at ~$305
close               null
prev_close          null
day_change          null
day_change_pct      null
session             null
data_source         "candle_replay"
_scoring_skip_reason null
```

`data_source: "candle_replay"` is the smoking gun — the last writer to
this KV key was a **replay run**, not the live scoring cron. The live
cron has not re-written this key in 24 days even though DELL has been in
SECTOR_MAP since 2026-05-22 (PR #265 commit `b8d65f4f`).

The price `$203.14` is the **exact value** PR #265 called out in its
commit body:
> "DELL closed yesterday at $252.80 but our system reports $203.14 (~20% miss)"

so PR #265 added DELL to `SECTOR_MAP` but did not clear or trigger a
re-write of `timed:latest:DELL`, and nothing since has re-written it.

### 1.2 DELL is the only ticker missing from BOTH downstream surfaces

```
/timed/tickers           259 tickers  ← DELL ✅
/timed/prices            259 tickers  ← DELL ❌
/timed/all               253 tickers  ← DELL ❌
```

Set differences:

```
in /tickers but not in /timed/all     : DELL, GME, IGV, RMBS, TTMI, ZETA, ZM
in /tickers but not in /timed/prices  : DELL, HG1!, NG1!
in /timed/all but not in /timed/prices: HG1!, NG1!, _price_overlay
in /timed/prices but not in /timed/all: DBA, FBL, GME, IGV, PCI, RMBS, TTMI, ZETA, ZM
```

`DELL` is **the only ticker** missing from BOTH `/timed/all` AND
`/timed/prices`. HG1!/NG1! are TV-only futures (expected). All other
tickers that miss `/timed/all` still have price data; all that miss
`/timed/prices` still get scored.

For comparison the rest of the IT cohort is healthy in `/timed/prices`:

```
DELL    MISSING
AAPL    p=312.21  pc=310.85  dp=0.44   age=5m
NVDA    p=214.15  pc=212.60  dp=0.73   age=3m
MSFT    p=427.75  pc=412.67  dp=3.65   age=11m
AMD     p=521.20  pc=495.54  dp=5.18   age=3m
ORCL    p=209.30  pc=190.96  dp=9.60   age=20m
AVGO    p=431.91  pc=421.86  dp=2.38   age=45m
NOW     p=108.75  pc=102.12  dp=6.49   age=494m  ← also stale
IBM     p=264.19  pc=255.20  dp=3.52   age=494m  ← also stale
PSTG    p=1507.01 pc=1550.63 dp=-2.81  age=1874m ← M&A limbo, known
CLS     p=350.98  pc=357.70  dp=-1.88  age=105m
PANW    p=261.90  pc=248.47  dp=5.41   age=50m
```

NOW/IBM are also stale (~8.2h) and PSTG is the documented M&A-limbo
exception. DELL is uniquely **completely missing** — not stale, missing.

### 1.3 Candle pipeline IS getting some data

```
tf=10m     last bar 2026-05-27 21:10 UTC  (24h stale)  3000 candles
tf=30m     last bar 2026-05-27 21:00 UTC  (24h stale)  1924 candles
tf=60m     last bar 2026-05-27 21:00 UTC  (24h stale)  1538 candles
tf=D       last bar 2026-05-27 04:00 UTC  (41h stale)   823 candles
```

After PR #265 added DELL to SECTOR_MAP on 2026-05-22, the candle backfill
sweep DID start populating DELL bars. But **all bars stop at the close of
2026-05-27 RTH** — no 2026-05-28 trading-day data has been ingested for
DELL on any timeframe. So today's intraday and EOD data are missing too.

This is precisely the condition that surfaces in
`tasks/2026-05-27-three-week-live-review.md` §3.2:

> `candle_freshness_60   worst stale 124.5h (DELL)`

— DELL has been the worst-stale 60m candle for 15 consecutive cron
failures.

### 1.4 Earnings radar: backend + frontend both filter DELL

Probe: `GET /timed/earnings/upcoming?debug=1&check=DELL`

```
finnhub_range            { today: "2026-05-28", future: "2026-06-02" }
finnhub_total            101 events
DELL on Finnhub          [{ symbol: "DELL", date: "2026-05-28", hour: "amc" }]
DELL on TwelveData       []        ← TD calendar does NOT confirm DELL
twelvedata_total         1200 events (so TD calendar is working in general)
```

#### 1.4.a Backend "TwelveData gate" drops Finnhub's DELL row

`worker/index.js:46832-46845`:

```js
// TwelveData gate: only show earnings when TwelveData confirms
// (avoids Finnhub false positives)
try {
  const tdRes = await tdFetchEarningsCalendar(env, today, future);
  if (!tdRes._error && tdRes.earnings && typeof tdRes.earnings === "object") {
    const tdConfirmed = new Set();
    for (const [date, arr] of Object.entries(tdRes.earnings)) {
      if (Array.isArray(arr)) for (const e of arr) {
        const sym = String(e.symbol || "").toUpperCase();
        if (sym) tdConfirmed.add(`${sym}|${(date || "").slice(0, 10)}`);
      }
    }
    if (tdConfirmed.size > 0) filtered = filtered.filter(
      e => tdConfirmed.has(`${e.symbol}|${(e.date || "").slice(0, 10)}`),
    );
  }
} catch (_) {}
```

The TD calendar legitimately doesn't list DELL today (TD's calendar
is known-incomplete for the largest US names — same class as the
2026-05-20 INTU miss). The gate is supposed to *reject Finnhub false
positives*, but it doesn't have a special case for "TD missed a
universe-grade name." So `filtered.DELL` becomes `[]` and the KV cache
written by the cron has zero DELL rows.

The 2026-05-20 INTU fix added a **D1 `market_events` post-filter merge**
that runs AFTER the cache is loaded (lines 46911-46951). This is the only
reason DELL appears in the API response at all — and the merged row is
tagged `_source: "d1_market_events"`. So today's response payload contains
35 events including DELL, but DELL was dropped by the "primary" Finnhub-
+ TD-gated path.

#### 1.4.b Frontend per-day cap drops DELL from the visible UI

`react-app/today.html:2237-2297` — `EarningsStrip`:

```js
events.sort((a, b) => {
  const da = String(a?.date || ""); const db = String(b?.date || "");
  if (da !== db) return da.localeCompare(db);
  const ho = HOUR_ORDER(a?.hour) - HOUR_ORDER(b?.hour);  // bmo<dmh<amc<unknown
  if (ho !== 0) return ho;
  return String(a?.symbol || "").localeCompare(String(b?.symbol || ""));
});
const limited = events.slice(0, 18);
const byDay = {};
for (const ev of limited) { (byDay[ev.date] = byDay[ev.date] || []).push(ev); }
const days = Object.keys(byDay).slice(0, 5);
...
days.slice(0, 6).map(d =>
  h("div", { ... },
    h("div", { ... }, d),
    h("div", { ... },
      byDay[d].slice(0, 6).map((ev, i) => { ... })   // ← per-day cap of 6
    ),
  ),
)
```

The 22 confirmed 2026-05-28 events (1 BMO + ~17 AMC + ~4 unknown-hour)
sort to:

```
position 1   DXLG  (bmo)
position 2   ADSK  (amc)
position 3   AEO   (amc)
position 4   AMBA  (amc)
position 5   ASAN  (amc)
position 6   CHA   (amc)
─── per-day cap of 6 cuts here ───
position 7   COST  (amc)        ← dropped
position 8   DELL  (amc)        ← dropped  ← the one the user noticed
position 9   ESTC  (amc)        ← dropped
position 10  HQY   (amc)        ← dropped
position 11  MDB   (amc)        ← dropped
position 12  NTAP  (amc)        ← dropped
position 13  OKTA  (amc)        ← dropped
position 14  PATH  (amc)        ← dropped
position 15  PD    (amc)        ← dropped
position 16  PLUS  (amc)        ← dropped
position 17  S     (amc)        ← dropped
position 18  VSAT  (amc)        ← dropped
...
```

Today is the busiest single earnings day of FY27-Q1 season (the post-
NVDA Wed/Thu Mag-7-adjacent cluster), so this is also why `COST`,
`MDB`, `NTAP`, `OKTA`, `PATH` — *all* highly relevant names — are
invisible too. The user will perceive this as "the radar isn't working"
across the board, with `DELL` the most obvious miss because of the
earnings result.

### 1.5 Real-world context

Web search confirmed DELL Q1 FY27 reported today at 04:05 PM ET:
- Revenue $43.8B (+88% YoY) — record
- GAAP EPS $5.24, non-GAAP EPS $4.86 (consensus per our KV: $2.997)
  → +62% beat on the headline number
- AI-optimized server revenue $16.1B
- Raised FY27 guidance to $165-169B

This is a market-moving print in our IT/AI Data Center cohort
(NVDA/AMD/AVGO/AMC/etc.). Missing it on the radar is high-impact.

---

## 2. Root-cause map

| # | Surface | Root cause | Status |
|---|---|---|---|
| 1 | `timed:latest:DELL` frozen at 2026-05-04 | `data_source: "candle_replay"` — the live scoring cron either never reaches DELL or its write is silently failing every cycle since 2026-05-22 when DELL re-entered SECTOR_MAP. Possibilities: (a) `computeServerSideScores` is throwing (caught at `worker/index.js:81527` as `errors++`, no tombstone), (b) the replay stub has a malformed shape that `scoreTicker`'s diff-write logic treats as "unchanged" and never overwrites. | **open** |
| 2 | `timed:prices.DELL` missing | `dataFetchSnapshots → fetchLatestQuotes → tdFetchQuote` returns nothing for DELL AND the Alpaca quotes fallback (`_withAlpacaQuotesFallback`) doesn't heal it. Either Alpaca is also silently rejecting DELL, or the snapshot loop has a `displayPrice > 0` guard that drops it. The D1 daily-candle fallback further down requires `dp !== 0` and 2 candles within 14 days; with PR #265 backfill DELL now has both, but the upstream snapshot loop's silent drop appears to short-circuit before that. | **open** |
| 3 | `/timed/all` missing DELL | Downstream of #1 — the scoring cron's snapshot loop reads `timed:latest:${sym}` per ticker (`worker/index.js:81611-81615`). If the key doesn't exist or is the malformed replay stub, DELL never appears in `timed:all:snapshot`. The price-overlay step (`worker/index.js:81740-81770`) does NOT add a ticker not already in the snapshot — it only overlays new prices onto existing rows. So #2 can't rescue #1. | **open** |
| 4 | Earnings radar: TwelveData gate drops DELL | `worker/index.js:46832-46845` — the gate is a strict AND of Finnhub + TD. TD's calendar misses universe-grade names regularly. Same class of bug as the 2026-05-20 INTU miss; the fix from that incident only addressed the D1 merge path, not the cache-population path. | **open** |
| 5 | Earnings radar UI per-day cap of 6 | `react-app/today.html:2271` — `byDay[d].slice(0, 6)`. Hard-cap was fine when the universe was 60 tickers but at 252 + busy season days it routinely truncates >50% of rows. | **open** |

---

## 3. Recommended fixes

Listed in order of "smallest blast radius first."

### 3.1 P0 — One-time KV clear for `timed:latest:DELL`

The simplest possible action: delete the stale replay stub so the next
scoring cron iteration starts from a clean slate. If the scoring cron is
silently failing for DELL (option 1.a), this won't help. If the cron is
skipping DELL because of a diff-check against the malformed stub (option
1.b), this will fix it instantly.

Admin endpoint exists: `POST /timed/admin/seed-ticker` does the inverse
(seeds a stub). The cleanup path is `DELETE /timed/admin/ticker` or a
direct `KV.delete("timed:latest:DELL")` via the admin KV endpoint
(`POST /timed/admin/kv/delete?k=timed:latest:DELL`).

After delete, watch the next 5-min `/scheduled` cycle: if a fresh
`timed:latest:DELL` appears with `data_source: "twelvedata"` or
`"alpaca"`, root cause was 1.b. If it stays missing, root cause is 1.a
and we move to §3.2.

### 3.2 P0 — Tombstone-on-error in `scoreTicker`

`worker/index.js:81526-81529` swallows scoring errors with `errors++` and
a console warn. If DELL is throwing every cycle, we have no surface to
detect it. Replace with:

```js
} catch (e) {
  errors++;
  console.warn(`[SCORING] ${ticker}:`, String(e));
  // P0 — surface silent per-ticker failures so DELL-class incidents
  // can't sit dark for 6 days
  ctx.waitUntil(recordCronFailure(env, {
    op: `score_ticker:${ticker}`,
    error: String(e?.message || e).slice(0, 300),
    caller: "scoring_cron",
  }).catch(() => {}));
}
```

This makes any DELL-class scoring failure visible in
`/timed/admin/cron-status` instead of dying in logs the operator never
reads. (KV TTL on tombstones is already 7 days.)

### 3.3 P0 — Drop the strict TwelveData earnings gate; switch to "AND OR D1"

`worker/index.js:46843`:

```js
if (tdConfirmed.size > 0) {
  filtered = filtered.filter(e => tdConfirmed.has(`${e.symbol}|${e.date}`));
}
```

Change to a SOFT gate: keep TD-confirmed rows AND keep Finnhub rows for
tickers that already have a D1 `market_events` row for that date. That
way universe-grade names whose D1 was already populated by admin-seed or
daily-brief paths survive the gate. The pure-Finnhub rows still get
filtered (the original false-positive concern remains addressed).

Alternative (simpler): drop the gate entirely for tickers in
`SECTOR_MAP`. Finnhub false positives are mostly in the long tail of
small caps that aren't in our universe anyway.

### 3.4 P1 — Earnings strip per-day cap raise + relevance-aware sort

`react-app/today.html:2270-2272`:

Two-part fix:

1. Raise per-day cap from **6 → 12** so busy days fit. Keeps the strip
   readable; even 12 rows in a card is a quick scan.
2. Within a day, sort by "relevance to our active book" first, then
   alphabetical. "Relevance" = `(in SECTOR_MAP) ? 0 : 1` would put DELL,
   COST, MDB, NTAP, OKTA, PATH ahead of the random small caps. Simple
   ~3-line change.

Cheap follow-up: include "n more" affordance on the right edge of each
day card showing the truncated count, so operators know when the cap is
biting.

### 3.5 P1 — Operator alert when a SECTOR_MAP ticker is missing from `/timed/all`

The freshness monitor at `worker/index.js:78838-78956` watches candle
staleness but doesn't watch the **snapshot completeness**. Add a daily
check: `Object.keys(SECTOR_MAP).filter(t => !timedAllData.has(t))` →
post to `recordCronFailure` if length > 0. This would have caught DELL's
6-day silence immediately.

---

## 4. Quick repro / verification

After deploy:

1. **Delete the stub**: `POST /timed/admin/kv/delete?k=timed:latest:DELL&key=...`
2. **Wait one scoring cycle** (~5 min).
3. **Verify**: `GET /timed/latest?ticker=DELL` → `ts` within last 5 min,
   `data_source: "twelvedata"`, `price` matches Yahoo's last DELL print.
4. **Verify**: `GET /timed/all` includes `DELL` with a fresh `ts`.
5. **Verify**: `GET /timed/prices` includes `DELL`.
6. **Verify** earnings strip on `today.html` shows DELL within the
   2026-05-28 column after the strip fix lands.

If step 3 fails (no fresh write), proceed with §3.2 to surface the
per-ticker error and re-investigate.

---

## 5. Open questions for follow-up

1. Why does `_withAlpacaQuotesFallback` not heal DELL? Worth a one-off
   `console.log` of `_providerFallbackStats.counts` snapshot after a
   cycle to confirm.
2. Is the comment at `worker/data-provider.js:29-30` ("DELL in M&A
   limbo") still accurate? DELL is not in M&A — it's a fully active
   public name. The comment was speculative and should be updated
   ("intermittent TwelveData coverage for unknown reasons") or deleted.
3. The 2026-05-22 PR #265 comment also says "DELL removed because it's
   no longer in SECTOR_MAP" at `worker/index.js:39039-39040` — DELL IS
   in SECTOR_MAP today (PR #265 put it back). That comment block was
   written *before* the SECTOR_MAP fix landed and is now misleading.
   Should also be cleaned up.
