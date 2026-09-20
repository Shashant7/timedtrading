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

Live management must key off the **ticket** (`tt_cloud_pivot_long` /
`TT Cloud Pivot`), not the current card score. Profit-lock (MFE ≥ 1.2%,
keep peak-scaled `cloudPivotKeepFrac`) runs even when the 10m 5/12 print
is missing — that is how TJX +12% MFE died at the stop.

**The loss side gets the same treatment (2026-09-20).** Everything below
`if (!c512) return null` needs a 10m print, so a trade that never armed
the lock had no family exit at all and inherited the generic stop: on
2026-09-04 four unproven tickets reached −5.1% to −6.5% (EXPE, ULTA,
TSLA, BG — none with MFE over 1%), $121 of the family's losses.
`tt_cloud_pivot_loss_cap` is a full exit at −2.5%, placed beside the
profit lock so it also survives a missing print.

Gated to **unproven** trades only — not trimmed, MFE below the lock arm.
MAE is a whole-life number, so an ungated cap forfeits a runner that
dips *after* banking half (RBLX long realized +$13.53 on a −4.37%
drawdown). Once MFE clears the arm the profit lock and ribbon trail own
the exit and the cap stands down.

2.5% is a backstop, not a tighter stop: August's working `max_loss`
exits all landed in the −2.0..−2.4% band, so the cap sits just outside
it. 1.5% scores better on the 46-trade record (+$100 vs +$65) and was
rejected for pre-empting a stop that already works on a 46-trade sample.
Retune or disable without a deploy via
`deep_audit_tt_cloud_pivot_loss_cap_pct` /
`deep_audit_tt_cloud_pivot_loss_cap_enabled` (both allow-listed in
`REPLAY_DA_KEYS`, so the knob genuinely reaches `daCfg`).

Do not read the family's per-leg PF as a verdict on the setup — see
[learning-loops.md](learning-loops.md) for why the long leg's PF 0.24
was an exit defect, not an edge failure.

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
  (`TTLaneCard` + WAIT/BUY + LONG/SHORT chips + LAST/NOW/COVER
  progress bar) when `desk.watching` is non-empty. One call word:
  WAIT outside RTH, BUY for a paper 0.1× ticket in the regular
  session. Cover is labeled ahead vs behind. Do not add cover/last
  price chips or R/S metrics on these cards.
- Unit: `npx vitest run worker/foundation/tt-cloud-pivot.test.js`
- Loss cap against the real tickets (caps the four 2026-09-04 losers,
  leaves the open trimmed runners alone):
  `npx vite-node scripts/verify-cloud-pivot-loss-cap.mjs`

## Source

- `worker/foundation/tt-cloud-pivot.js` — `inspectTtCloudPivot`,
  `buildCloudPivotDesk`
- `scripts/scan-cloud-pivot-desk.mjs`
- `plans/tt-cloud-pivot-slice.plan.md`
