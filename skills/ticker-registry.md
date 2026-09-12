# Ticker Registry — the single source of truth

**WHEN:** any time you touch "the ticker list," see unscored symbols clustering
at (0,0) on a Bubble Map, add/remove a ticker, or wonder "why is X in the
universe but not scored?" / "why are there several different ticker counts?"

## Doctrine (2026-06-16)

There is **ONE** tradeable registry. If a symbol is in the registry, the system
**must** be aware of it — i.e. it gets scored every cron cycle. The registry is
mutated **only** through the sanctioned paths:

- **ADD:** Admin Addition · User Slot Addition · ETF Sync · Screener Promotion
- **REMOVE:** Admin Removal · User Slot Removal · ETF Sync

`MARKET_PULSE_SYMS` (futures/crypto/proxy ETFs) are **NOT** registry tickers —
they are market-context symbols for the pulse bar, scored on the price-feed
path, and are appended only where a caller explicitly opts in (e.g. `/timed/all`
so the pulse bar resolves names).

## The canonical resolver — `worker/universe.js`

```js
import { resolveScoringUniverse } from "./universe.js";
// registry = SECTOR_MAP keys ∪ active user_tickers ∪ KV timed:tickers
//            (+ D1 ticker_index cache) − KV timed:removed
const universe = resolveScoringUniverse({
  sectorMapKeys, userTickers, kvTickers, removed,
});
```

Both the **scoring cron** (`worker/index.js`, ~`const allTickers =`) and
**`GET /timed/tickers`** route through this resolver, so the scored set and the
registry **cannot diverge**. `/timed/tickers` additionally appends
`MARKET_PULSE_SYMS` as context.

## History — why this exists

Before this, three lists diverged:
- `/timed/tickers` unioned 5 sources (incl. KV `timed:tickers`) → ~288.
- the scoring cron unioned only `SECTOR_MAP ∪ user_tickers` → ~259.
- **screener promotion wrote ONLY `timed:tickers`**, never onboarding into the
  scored set → those tickers were registry "orphans," never scored, and the
  Bubble Map (which treats missing scores as 0) stacked them at (0,0).

PR #680 was a frontend band-aid (hide unscored placeholders). The real fix
(PR #683) makes the scoring cron score the **full registry** so orphans can't
exist.

## Storage map (where a ticker actually lives)

| Store | Role |
|---|---|
| `SECTOR_MAP` (worker const, KV-hydrated overlay) | core universe + sector |
| KV `timed:tickers` | dynamic registry (admin / screener / ETF auto-add) |
| KV `timed:removed` | persistent blocklist — subtracted everywhere |
| KV `timed:sector_map:{T}` | per-ticker sector overlay for KV-added symbols |
| D1 `user_tickers` | per-user slot additions |
| D1 `ticker_index` | fast read cache for `/timed/tickers` (mirrors KV) |
| KV `timed:ticker-sources` | attribution: ticker → [source, …] |

## Gotchas

- **Screener promotion** (`worker/discovery/promotion-queue.js`) writes
  `timed:tickers` + backfills candles + sets a `fast_onboard` flag. Since the
  cron now scores `timed:tickers`, promoted tickers score on the next cycle
  (freshness-quarantined at rank 10 until candles backfill — that's expected,
  not an orphan).
- A promoted ticker must get a real GICS (file map, Granny holdings
  sector, or normalized profile). Do **not** persist `"Unknown"` to
  `timed:sector_map:{T}` — that freezes type/conviction and is how
  TEAM/DDOG/ALL/DAL went blind. TT Selected is a sentiment overlay
  (`+10` live Upticks / `+15` curated), not the only scored set.
- `timed:all:snapshot` and D1 `ticker_latest` batch sync must use the
  same registry as the scoring cron (`resolveRegistryUniverseTickers` /
  `allTickers`). Building the snapshot from `SECTOR_MAP ∪ user_tickers`
  only drops KV/`ticker_index` names after they score to `timed:latest`.
- Never re-introduce a divergent list. New consumers MUST call
  `resolveScoringUniverse` (or read `/timed/tickers`), never re-union sources.
- **Dead weight is a review list, not a delete job.** Names that never
  produced a live trade (screener adds, broken orphans, idle core-map
  names) are classified by `worker/dead-weight-tickers.js` from cheap
  tables only. KEEP always includes open books, user slots, live
  Upticks / `TT_SELECTED`, and index/pulse/levered proxies. A healthy
  scored registry name that is not in the static map is WATCH, not
  DEAD unused_add. Do not auto-REMOVE.
  Do not `GROUP BY ticker_candles` to build the list. Snapshot:
  [`docs/dead-weight-tickers-2026-09-12.md`](../docs/dead-weight-tickers-2026-09-12.md).
  Trimming the book does not fix D1 read overage
  (`docs/d1-billing-investigation-2026-06-22.md`).

## Verify

```bash
# scored count should ≈ registry count (minus MARKET_PULSE)
curl -s "$LIVE/timed/all?key=$KEY" | jq '[.data[]|select(.htf_score!=null or .rank!=null)]|length'
curl -s "$LIVE/timed/tickers?key=$KEY" | jq '.count'
# trigger a scoring cycle, then confirm a promoted ticker has scores:
curl -s "$LIVE/timed/all?key=$KEY" | jq '.data["<PROMOTED>"]'
```

Source: `worker/universe.js`, `worker/universe.test.js`, scoring cron in
`worker/index.js`, `GET /timed/tickers` handler.
