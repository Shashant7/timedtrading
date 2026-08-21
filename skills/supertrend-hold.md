# SuperTrend hold vs flip

**WHEN to use:** A name tests a flat SuperTrend and holds (ETHUSD monthly
style), price is walking into a flat *opposite-side* ST (TSLA daily
reversal), or the book looks like it is chasing a fresh ST flip
stretched off the 21 EMA. Also when confluence is READY only because
ST is flat.

## Rule

- Pine convention: **`stDir -1` = bull**, **`+1` = bear**.
- **Continuation entry:** same-side flat ST, price tests the line (even a
  momentary pierce), close holds. Risk is the ST line. Prefer a
  **flip then retest** over a fresh flip.
- **Reversal magnet:** while a reversal is underway the HTF ST **stays
  the old color and goes flat**. That is expected — SuperTrend cannot
  flip until the close takes the line. Price inching toward that flat
  opposite-side ST *is* the confluence (the line is the magnet). The
  flip is confirmation / late, not the setup. TSLA 2026-08: daily ST
  sat bear at $356.77 from Aug 3–20 while price walked 1.87 → 0.35 ATR
  into it; Aug 21 flip printed 1.41 ATR off the 21 EMA.
- **Do not chase:** ST just flipped, line still sloping, `|px − ema21| / ATR > ~1.5`,
  no retest yet — especially on 10m/30m.
- **Do not ignite LTF slope** when D/W/M SuperTrend is *sloping* the
  other way. A **flat** opposite-side daily ST is the magnet, not a
  hard veto of the reclaim.
- Proximity to the 21 EMA is a **quality** score, not a validity gate.
  High = hold near the 21. Still valid = crash-base far from the 21 (ETH).
- Session charts: **6.5H** = one NYSE RTH bar; **9H** = 00/09/18 America/New_York.
  Synthesized from 30m/60m (`worker/session-tfs.js`). They are **against-vetoes**,
  not RIDE ignition. Swing slope trigger is 1H/4H/D/W/M. Closed ST book
  (2026-08-21): monthly/weekly *slope* is the edge; 6.5H holds lost.

## Where it lives

| Piece | Path |
|---|---|
| Detector | `worker/supertrend-hold.js` |
| Session TFs (6.5H / 9H) | `worker/session-tfs.js` |
| Closed-book review | `scripts/analyze-st-mtf-trades.mjs`, `tasks/2026-08-21-st-mtf-review.md` |
| Bundle / flags / `tf_tech.stLine` | `worker/indicators.js` (`computeTfBundle`, `detectFlags`, `assembleTickerData`) |
| RIDE vs READY gate | `worker/root-strategy.js` (`scoreRootConfluence`) |
| Tests | `worker/supertrend-hold.test.js`, `worker/session-tfs.test.js`, `worker/st-mtf-review.test.js` |

Payload: `st_hold_setup.best`, `flags.st_hold_*`, `tf_tech.*.stHold`,
`monthly_bundle.st_hold`. Confluence copies `st_hold` onto the verdict.

## Do not

- Treat a sloping flip as stronger than a tested hold.
- Treat a flat opposite-side ST as “no setup yet” or wait for the
  flip. Same-side hold = continuation. Opposite-side flat + ATR gap
  closing = reversal magnet. The detector today only scores same-side
  tests (`bearTest` = SHORT hold under a bear line).
- Require the 21 EMA for a hold to count.
- Read `st_support.W` as a price — weekly ST **price** is
  `weekly_bundle.supertrend_line`.
- “Fix” L7 `stDir === 1` as bull unless that path is being rewritten.
  New code must use Pine `-1 = bull`.
