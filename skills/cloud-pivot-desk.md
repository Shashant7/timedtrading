# Cloud Pivot desk (super minions)

**WHEN to use:** Operator asks who is watching the Ripster-style tape,
wants a weekend/night stare at 10m 5/12 + 1H magnets, or says "be the
minions." Not for the ETH 3-minute kitchen sink.

## What the minions watch

Same atoms as `tt_cloud_pivot` — branded Timed Trading, not "Ripster":

| Tape | Meaning |
|---|---|
| 10m 5/12 curl / cross | Ride trigger |
| 10m 34/50 vs that curl | Mixed-cloud is OK when a 1H magnet is ahead |
| Next 1H then 4H 34/50 (then 72/89) | Magnet — cover/trim on tag |
| Earnings DTE −2..0 + 1H holds | Day2/3 keep watching |
| BTCUSD / ETHUSD / SPY / QQQ 10m curl | Leader; fan `TICKER_PROXY_MAP` followers |
| Catalyst PMH/PDL if/then | Long over X / short under Y |

`detectTtCloudPivot` stays RTH-windowed for paper entries. The desk
**inspects without a session** so Saturday/Sunday still ranks magnets.

A desk pick is not an immediate entry. WAIT outside the regular
session. BUY in RTH opens a paper 0.1× sim ticket and the same 0.1×
broker order so 5/12 / magnet exits can be followed. Canonical core
paths stay full size.

The 1H/4H 34/50 (then 72/89) magnet is the **last cover** once the
live print has passed it — never show it as "toward." Next cover
reuses the same Short Term / Long Term rail levels already on the
ticker (nearest on the trade side): Monthly 21 EMA, then Weekly/Daily
21, then Short Term trim/exit. ETH ~$2416 → next cover is Monthly 21
(~$2519), not a missing destination. Do not show Lead on the Today
cards. Index Day-Trade is a separate options lean.

## Commands

```bash
# Live book from production KV (vite-node: CJS sector-mapping interop)
npx vite-node scripts/scan-cloud-pivot-desk.mjs

# Already-downloaded snapshot
npx vite-node scripts/scan-cloud-pivot-desk.mjs --snapshot /tmp/timed-all-snapshot.json --limit 24
```

Writes `data/cloud-pivot-desk/report.md` + `summary.json` (do not commit
the 20MB+ snapshot).

Live API (Pro / admin): `GET /timed/plays/today` → `desk.watching`.
KV cache: `timed:cloud-pivot:desk` (6h TTL, refreshed on that GET).

```bash
cd worker
../node_modules/.bin/wrangler kv key get --remote --binding=KV_TIMED \
  --env production "timed:cloud-pivot:desk"
```

## Verify

- Weekend: `inspectTtCloudPivot` returns magnet/curl while
  `detectTtCloudPivot` is null.
- Today Families strip shows a CLOUD DESK horizontal card row
  (`TTLaneCard` + Call / Side / Cover / Size) when `desk.watching` is
  non-empty. One call word: WAIT outside RTH, BUY for a paper 0.1×
  ticket in the regular session. Cover is labeled ahead vs behind.
- Unit: `npx vitest run worker/foundation/tt-cloud-pivot.test.js`

## Source

- `worker/foundation/tt-cloud-pivot.js` — `inspectTtCloudPivot`,
  `buildCloudPivotDesk`
- `scripts/scan-cloud-pivot-desk.mjs`
- `plans/tt-cloud-pivot-slice.plan.md`
