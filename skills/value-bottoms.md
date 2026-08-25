# Value Bottoms strip + outcome ledger

**WHEN to use:** Adding or debugging the Today "Value Bottoms" strip
(FV discount + technical bottom), or asking how those picks are graded
for model calibration.

## What it is

Ranks investor-score rows where:

1. `_fair_value` / `fairValue` is a fresh **discount** (≤ −10% vs FV)
2. Quality grade is A/B/C
3. Technical bottom evidence: `timing_primary=BOTTOM`, `TIME_BOTTOM`,
   compounder `dip_buy`, or oversold `accumZone` (not bare `momentum_runner`)

Composite score ≈ value depth + bottom strength + investor/FSD bias.

## Code

| Piece | Path |
|---|---|
| Ranker (pure) | `worker/value-bottoms.js` |
| Tests | `worker/value-bottoms.test.js` |
| Cache on compute | `cacheInvestorValueBottoms` in `worker/index.js` |
| KV | `timed:investor:value-bottoms` |
| API | `GET /timed/investor/value-bottoms` (Pro-gated like holdbook) |
| Today UI | `ValueBottomsStrip` in `react-app/today.html` |

## Outcome tracking

On each full investor compute, ranked names are written to
`signal_outcomes` via `valueBottomToSignal`:

- `signal_id`: `valuebottom:{YYYY-MM-DD-ET}:{TICKER}` (idempotent / day)
- `source`: `value_bottom`, `desk`: `investor`, `direction`: LONG
- `horizon_days`: 60
- entry = live price, target = fair value, stop = thesis invalidation

Nightly resolver grades like other directional calls. Inspect with:

```bash
curl -s "$API/timed/admin/signal-outcomes?days=90&limit=50&status=open" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" | jq '.rows[] | select(.source=="value_bottom")'
```

## Tuning

Adjust gates / weights only in `worker/value-bottoms.js` and pin tests.
Do not mix style-bucket `value` (sector-mapping) with FV discount.
