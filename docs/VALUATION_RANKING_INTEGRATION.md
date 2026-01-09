# Valuation Ranking Integration

## Summary
Valuation signals (undervalued/fair/overvalued) are now integrated into the ranking algorithm. Stocks with favorable valuations receive rank boosts, while overvalued stocks are penalized.

---

## Ranking Formula

### Before
```
Rank = Technical Score + Sector Boost
```

### After
```
Rank = Technical Score + Sector Boost + Valuation Boost
```

Where:
- **Technical Score**: Base rank from `computeRank()` (0-100)
- **Sector Boost**: Based on sector rating (Overweight: +5, Neutral: 0, Underweight: -3)
- **Valuation Boost**: Based on fundamental analysis (-8 to +8)

---

## Valuation Boost Calculation

The `calculateValuationBoost()` function considers three factors:

### Factor 1: Valuation Signal (Primary) - Up to ±5 points
- **Undervalued (High Confidence)**: +5 points
- **Undervalued (Medium Confidence)**: +3 points
- **Overvalued (High Confidence)**: -5 points
- **Overvalued (Medium Confidence)**: -3 points
- **Fair**: 0 points

### Factor 2: PEG Ratio (Secondary) - Up to ±3 points
- **PEG < 0.8**: +2 points (Excellent - undervalued growth)
- **PEG 0.8-1.0**: +1 point (Good - fairly valued growth)
- **PEG 1.0-1.5**: 0 points (Neutral)
- **PEG 1.5-2.0**: -1 point (Poor - overvalued)
- **PEG > 2.0**: -3 points (Very poor - highly overvalued)

### Factor 3: Premium/Discount to Fair Value (Tertiary) - Up to ±2 points
- **< -20%**: +2 points (Significantly below fair value)
- **-20% to -10%**: +1 point (Moderately below fair value)
- **-10% to +10%**: 0 points (Near fair value)
- **+10% to +20%**: -1 point (Moderately above fair value)
- **> +20%**: -2 points (Significantly above fair value)

### Total Boost Cap
- **Maximum**: +8 points (all factors align favorably)
- **Minimum**: -8 points (all factors align unfavorably)

---

## Example Scenarios

### Scenario 1: Undervalued Growth Stock
- **Base Rank**: 75
- **Sector Boost**: +5 (Overweight)
- **Valuation Signal**: Undervalued (High Confidence) = +5
- **PEG Ratio**: 0.75 = +2
- **Premium/Discount**: -18% = +2
- **Total Valuation Boost**: +9 (capped at +8)
- **Final Rank**: 75 + 5 + 8 = **88**

### Scenario 2: Overvalued Stock
- **Base Rank**: 70
- **Sector Boost**: +5 (Overweight)
- **Valuation Signal**: Overvalued (Medium Confidence) = -3
- **PEG Ratio**: 1.8 = -1
- **Premium/Discount**: +15% = -1
- **Total Valuation Boost**: -5
- **Final Rank**: 70 + 5 - 5 = **70**

### Scenario 3: Fairly Valued Stock
- **Base Rank**: 65
- **Sector Boost**: 0 (Neutral)
- **Valuation Signal**: Fair = 0
- **PEG Ratio**: 1.2 = 0
- **Premium/Discount**: -5% = 0
- **Total Valuation Boost**: 0
- **Final Rank**: 65 + 0 + 0 = **65**

---

## Implementation Details

### Code Location
- **Function**: `calculateValuationBoost(fundamentals)` in `worker/index.js`
- **Integration**: Applied after `computeRank()` and fundamentals calculation
- **Storage**: Boost amount stored in `payload.rank_components.valuation_boost`

### When Boost is Applied
1. **During Ingest**: When TradingView sends fundamental data
2. **Sector Ranking**: When ranking tickers within a sector (`rankTickersInSector`)
3. **Recommendations**: When generating sector recommendations

### Rank Components Object
```json
{
  "rank": 88,
  "rank_components": {
    "base_rank": 75,
    "valuation_boost": 8
  }
}
```

---

## API Response Changes

### `/timed/latest?ticker=XYZ`
Now includes valuation boost in rank:
```json
{
  "ticker": "CAT",
  "rank": 88,
  "rank_components": {
    "base_rank": 75,
    "valuation_boost": 8
  },
  "fundamentals": {
    "valuation_signal": "undervalued",
    "is_undervalued": true,
    ...
  }
}
```

### `/timed/sectors/:sector/tickers`
Now includes valuation boost in boosted rank:
```json
{
  "tickers": [
    {
      "ticker": "CAT",
      "rank": 75,
      "boostedRank": 88,
      "sectorBoost": 5,
      "valuationBoost": 8,
      ...
    }
  ]
}
```

### `/timed/sectors/recommendations`
Recommendations now sorted by total boosted rank (technical + sector + valuation):
```json
{
  "recommendations": [
    {
      "ticker": "CAT",
      "rank": 75,
      "boostedRank": 88,
      "sectorBoost": 5,
      "valuationBoost": 8,
      ...
    }
  ]
}
```

---

## Benefits

### 1. Better Stock Selection
- Undervalued stocks rank higher, making them more likely to be selected
- Overvalued stocks rank lower, reducing risk

### 2. Balanced Approach
- Combines technical analysis (momentum, setup quality) with fundamental analysis (valuation)
- Prevents chasing overvalued momentum stocks

### 3. Sector + Valuation Synergy
- Overweight sectors with undervalued stocks get maximum boost
- Helps identify best opportunities within favored sectors

---

## Testing

### Verify Boost Calculation
1. Check ticker with undervalued fundamentals
2. Verify `rank_components.valuation_boost` is positive
3. Verify final rank = base_rank + sector_boost + valuation_boost

### Verify Sector Ranking
1. Query `/timed/sectors/Industrials/tickers?limit=10`
2. Verify `valuationBoost` field is present
3. Verify `boostedRank` includes valuation boost

### Verify Recommendations
1. Query `/timed/sectors/recommendations?limit=10`
2. Verify top recommendations have favorable valuations
3. Verify sorting by `boostedRank` (includes valuation)

---

## Configuration

### Adjusting Boost Amounts
Edit `calculateValuationBoost()` function in `worker/index.js`:

```javascript
// Increase boost for undervalued stocks
if (fundamentals.is_undervalued) {
  if (fundamentals.valuation_confidence === "high") {
    boost += 7; // Increased from 5
  }
}

// Increase penalty for overvalued stocks
if (fundamentals.is_overvalued) {
  if (fundamentals.valuation_confidence === "high") {
    boost -= 7; // Increased from 5
  }
}
```

### Adjusting Boost Cap
Change the cap in `calculateValuationBoost()`:
```javascript
// Increase cap from ±8 to ±10
return Math.max(-10, Math.min(10, boost));
```

---

## Monitoring

### Logs
When valuation boost is applied, logs show:
```
[RANK] CAT: Base=75, Valuation Boost=8, Final=88
```

### Debugging
Check `rank_components` object in API responses to see:
- Base rank (technical score)
- Valuation boost amount
- Final rank calculation

---

## Future Enhancements

### Potential Improvements
1. **Dynamic Boost Scaling**: Adjust boost based on market conditions
2. **Sector-Specific Thresholds**: Different PEG thresholds per sector
3. **Time-Based Decay**: Reduce boost impact over time
4. **Combined Signals**: Weight boost based on number of factors agreeing

---

## References

- **Function**: `calculateValuationBoost()` in `worker/index.js`
- **Integration**: Applied in ingest endpoint and `rankTickersInSector()`
- **Related Docs**: 
  - `docs/FUNDAMENTAL_METRICS_ENHANCEMENT.md`
  - `docs/VALUATION_FEATURES_SUMMARY.md`
