# SuperTrend hold vs flip

**WHEN to use:** A name tests a flat SuperTrend and holds (ETHUSD monthly
style), or the book looks like it is chasing a fresh ST flip stretched off
the 21 EMA. Also when confluence is READY only because ST is flat.

## Rule

- Pine convention: **`stDir -1` = bull**, **`+1` = bear**.
- **Entry:** flat ST, price tests the line (even a momentary pierce), close
  holds. Risk is the ST line.
- **Do not chase:** ST just flipped, line still sloping, `|px − ema21| / ATR > ~1.5`,
  no retest yet.
- Proximity to the 21 EMA is a **quality** score, not a validity gate.
  High = hold near the 21. Still valid = crash-base far from the 21 (ETH).

## Where it lives

| Piece | Path |
|---|---|
| Detector | `worker/supertrend-hold.js` |
| Bundle / flags / `tf_tech.stLine` | `worker/indicators.js` (`computeTfBundle`, `detectFlags`, `assembleTickerData`) |
| RIDE vs READY gate | `worker/root-strategy.js` (`scoreRootConfluence`) |
| Tests | `worker/supertrend-hold.test.js` |

Payload: `st_hold_setup.best`, `flags.st_hold_*`, `tf_tech.*.stHold`,
`monthly_bundle.st_hold`. Confluence copies `st_hold` onto the verdict.

## Do not

- Treat a sloping flip as stronger than a tested hold.
- Require the 21 EMA for a hold to count.
- Read `st_support.W` as a price — weekly ST **price** is
  `weekly_bundle.supertrend_line`.
- “Fix” L7 `stDir === 1` as bull unless that path is being rewritten.
  New code must use Pine `-1 = bull`.
