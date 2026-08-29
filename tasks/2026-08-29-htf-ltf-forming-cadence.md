# LTF + complementary HTF forming (different cadences)

Shipped on `cursor/htf-ltf-forming-cadence-dbdd`. Companion diagnosis:
`tasks/2026-08-29-june-present-move-review.md` (PR #1383).

## What changed

`worker/mtf-forming.js` — `resolveFormingPair`:

| Clock | TFs | Meaning |
|---|---|---|
| LTF (fast) | 10m / 30m / 1H | Constructing (ST / 5-12 / structure / score) |
| HTF (slow) | 4H / D / W | Forming (turn: 4H ST, daily 21, D magnet) or formed (score+ST already with) |

Complementary = same side, LTF forming, HTF forming **or** formed, weekly/monthly ST not sloping against. HTF score may still be negative on a turn. LTF structure cues are side-aware so a bullish 30m/1H stack cannot count as SHORT forming. Stretch chase (`pct_above_e21 > 4` and `days_above_e21 > 5` unless HTF already formed) is not complementary.

Wired to:

1. `inferSide` — `HTF_BEAR_LTF_PULLBACK` is no longer auto-SHORT when the pair is a long turn (TSLA Aug 13).
2. SuperTrend trigger — parked daily bear is not `htf_against` when the pair is complementary (`freshness = htf_forming`).
3. Snapshot stamp — `assembleTickerData` writes `_mtf_forming`.
4. Entry — `tt_forming_pair` before the pullback/momentum reject cascade.

Kill switch (default ON): `deep_audit_forming_pair_enabled` and
`deep_audit_forming_pair_entry` in `REPLAY_DA_KEYS`.

Does **not** fire AAPL-June dumps (15m+30m structure broken).

## Verify

```
npx vitest run worker/mtf-forming.test.js worker/supertrend-hold.test.js worker/foundation/play-catalog.test.js worker/discovery/gameplan.test.js
```

## Preprod (2026-08-29)

- Worker: `timed-trading-ingest-preprod` version `2b929f0a-b1a7-473f-977b-d59ed2644aa3` from this branch. **Not** deployed to prod.
- Flags ON: `deep_audit_forming_pair_enabled`, `deep_audit_forming_pair_entry`.
- Copied prod Jun–Aug 2026 candles for TEAM / TSLA / AAPL (10/15/30/60/240/D/W/M/5). TEAM 10m now ends 2026-08-28 (was 2026-06-18).
- Lock free. Slice not started.

```
scripts/monthly-slice.sh \
  --month=2026-07 \
  --run-id=forming-pair-team-jul-on \
  --label=forming-pair-team-jul-on \
  --tickers=TEAM,TSLA,AAPL \
  --ticker-batch=3 \
  --interval-minutes=30 \
  --watchdog-seconds=900 \
  --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```
