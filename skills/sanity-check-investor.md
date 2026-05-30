# Investor Score Sanity Check

**WHEN to use:** A user reports an Investor score that looks "too high"
or "too low" relative to a third-party signal (Finnhub, Seeking Alpha,
analyst consensus). Common trigger: "Why is AMZN flagged ACCUMULATE
when consensus is HOLD?" or "Why is CDNS in the buy zone near ATH?"

**Prerequisites:**
- `TIMED_TRADING_API_KEY`
- (Optional) Finnhub API token for the third-party cross-check

---

## The 4-step sanity check

### 1. Pull the live Investor payload for the ticker

```bash
TICKER="AMZN"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/investor/ticker?ticker=$TICKER&key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool > /tmp/investor.json
head -80 /tmp/investor.json
```

Key fields to read:

- `investor_score` (0-100)
- `investor_score_breakdown` (the 7 components)
- `zone` (`accumulate` / `hold` / `distribute` / `momentum_runner`)
- `zone_type` — distinguishes "true accumulation" from
  "momentum_runner near ATH"
- `analyst_consensus` (mean target, distance from current price)
- `last_scored_at` (sanity check freshness; should be < 30 min old)

### 2. Check zone reasoning

If `zone === "accumulate"` but the ticker is at ATH, look at:

```bash
python3 -c "
import json
d = json.load(open('/tmp/investor.json'))
print('zone:', d.get('zone'))
print('zone_type:', d.get('zone_type'))
print('distance_from_52w_high_pct:', d.get('distance_from_52w_high_pct'))
print('distance_from_consensus_target_pct:', d.get('distance_from_consensus_target_pct'))
print('breakdown:')
for k, v in (d.get('investor_score_breakdown') or {}).items():
    print(f'  {k:20s} {v}')
"
```

**Rule of thumb (PR #382 zone-type differentiation):**

- `zone_type = "true_accumulation"` → ticker is at a meaningful pullback
  AND analyst consensus suggests upside ≥10%. Real accumulate signal.
- `zone_type = "momentum_runner"` → ticker is in momentum, near ATH,
  with positive technical confluence but limited consensus upside.
  Different label, different alert title.

If the score breakdown shows all 7 components ≥ 0.5 but consensus says
0% upside, the model is calling momentum, NOT a buy-the-dip.

### 3. Cross-check vs Finnhub (optional)

```bash
TICKER="AMZN"
curl -s "https://finnhub.io/api/v1/stock/recommendation?symbol=$TICKER&token=$FINNHUB_API_KEY" \
  | python3 -m json.tool | head -20
# Compare strongBuy/buy/hold/sell/strongSell against our analyst_consensus
```

### 4. If the score is genuinely wrong, force a rescore

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rescore-ticker" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d "{\"ticker\":\"$TICKER\"}" | python3 -m json.tool | head -30
```

If the rescore returns the SAME score, the data inputs are fine and the
model is producing this output deliberately. The next step is to look at
the `investor_score_breakdown` components and either accept the model's
verdict or open a `worker/indicators.js` PR to recalibrate.

---

## Common findings

- **"All 7 components are 0"** → Weekly/Monthly bundles missing. See
  [backfill-candles.md](backfill-candles.md) → wm-bootstrap.
- **"Score is 60 but zone is hold"** → score-zone mapping in
  `worker/indicators.js`. Zones aren't linear: 70+ is accumulate, 40-70
  is hold, <40 is distribute (with overrides for momentum_runner).
- **"Score updated overnight but alert didn't fire"** → 24h alert cooldown
  per ticker per zone. The model won't re-alert ACCUMULATE for the same
  ticker more than once per day. (PR #382)
- **"Alert text says ACCUMULATE but ticker is at ATH"** → that's a
  momentum_runner. The alert title and Discord embed should already be
  differentiated (PR #382). If they're not, the deploy didn't land.

## Source

- `worker/indicators.js` → `computeInvestorScore`, `classifyInvestorZone`
- `worker/alerts.js` → `createInvestorAlertEmbed` (zone-type aware copy)
- `worker/email.js` → `sendInvestorAlertEmails`
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Investor" entries
