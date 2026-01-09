# Fundamental Metrics Enhancement

## Summary
Enhanced the fundamental data collection to include **EPS Growth Rate** and **PEG Ratio** from the advanced P/E analysis scripts. These metrics provide better context for valuation and help identify growth stocks.

---

## New Metrics Added

### 1. EPS Growth Rate (Annualized %)
- **What it is**: Annualized percentage growth rate of earnings per share
- **Calculation**: Uses linear regression on quarterly EPS data (last 4+ quarters)
- **Formula**: `(slope / avgEPS) * 4 * 100` (annualized percentage)
- **Use Case**: 
  - Identify high-growth stocks (>20% growth)
  - Filter for growth vs. value stocks
  - Context for P/E ratio (high P/E justified by high growth)

### 2. PEG Ratio (Price/Earnings to Growth)
- **What it is**: P/E ratio divided by earnings growth rate
- **Calculation**: `P/E Ratio / EPS Growth Rate`
- **Interpretation**:
  - **PEG < 1.0**: Potentially undervalued (growth justifies P/E)
  - **PEG = 1.0**: Fairly valued
  - **PEG > 1.0**: Potentially overvalued
- **Use Case**: 
  - Better than P/E alone for growth stocks
  - Compare stocks with different growth rates
  - Identify undervalued growth opportunities

---

## Data Flow

```
TradingView Pine Script
    ↓
Calculates EPS Growth Rate (from quarterly data)
    ↓
Calculates PEG Ratio (P/E / Growth Rate)
    ↓
Sends in JSON alert:
{
  "eps": 12.50,
  "pe_ratio": 28.50,
  "eps_growth_rate": 25.5,  // NEW
  "peg_ratio": 1.12         // NEW
}
    ↓
Worker stores in KV:
timed:fundamentals:{ticker}
    ↓
Available via API endpoints
```

---

## API Usage

### Get Fundamentals for a Ticker
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/latest?ticker=CAT" | jq '.fundamentals'
```

**Response:**
```json
{
  "pe_ratio": 28.50,
  "eps": 12.50,
  "eps_growth_rate": 25.5,
  "peg_ratio": 1.12,
  "market_cap": 150000000000,
  "industry": "Construction Machinery",
  "pe_percentiles": {
    "p10": 18.5,
    "p25": 22.0,
    "p50": 25.5,
    "p75": 30.0,
    "p90": 35.0,
    "avg": 25.2,
    "count": 1260
  },
  "pe_percentile_position": "Above Median",
  "fair_value_pe": {
    "historical_avg": 25.2,
    "historical_median": 25.5,
    "growth_adjusted": 25.5,
    "preferred": 25.5
  },
  "fair_value_price": 318.75,
  "premium_discount_pct": -2.5,
  "valuation_signal": "fair",
  "is_undervalued": false,
  "is_overvalued": false,
  "valuation_confidence": "medium",
  "valuation_reasons": []
}
```

---

## Use Cases

### 1. Filter Growth Stocks
```javascript
// Find stocks with high growth (>20% annually)
const growthStocks = tickers.filter(t => 
  t.fundamentals?.eps_growth_rate > 20
);
```

### 2. Identify Undervalued Growth Opportunities
```javascript
// PEG < 1.0 suggests undervalued growth stock
const undervaluedGrowth = tickers.filter(t => 
  t.fundamentals?.peg_ratio < 1.0 && 
  t.fundamentals?.eps_growth_rate > 15
);
```

### 3. Rank by PEG Ratio
```javascript
// Lower PEG = better value for growth
tickers.sort((a, b) => {
  const pegA = a.fundamentals?.peg_ratio || Infinity;
  const pegB = b.fundamentals?.peg_ratio || Infinity;
  return pegA - pegB;
});
```

### 4. Sector Analysis
```javascript
// Compare PEG ratios within a sector
const sectorTickers = getTickersInSector("Information Technology");
const avgPEG = sectorTickers
  .map(t => t.fundamentals?.peg_ratio)
  .filter(p => p != null)
  .reduce((a, b) => a + b, 0) / sectorTickers.length;
```

---

## ✅ Completed Enhancements

### ✅ Historical P/E Percentiles
**Status**: ✅ Implemented

**Implementation**:
1. ✅ Store historical P/E ratios in KV (`timed:pe_history:{ticker}`)
2. ✅ Calculate percentiles (10th, 25th, 50th, 75th, 90th) in worker
3. ✅ Add to fundamentals object:
   ```json
   {
     "pe_percentiles": {
       "p10": 15.2,
       "p25": 18.5,
       "p50": 22.0,
       "p75": 28.5,
       "p90": 35.0,
       "avg": 22.3,
       "count": 1260
     },
     "pe_percentile_position": "Above Median"  // Bottom 25%, Below Median, Above Median, Top 25%
   }
   ```

**Use Case**: Identify if current P/E is historically high/low

### ✅ Fair Value Calculation
**Status**: ✅ Implemented

**Implementation**:
1. ✅ Calculate fair value P/E based on:
   - Historical average P/E
   - Historical median P/E
   - Growth-adjusted P/E (EPS Growth Rate × Target PEG = 1.0)
2. ✅ Calculate fair value price: `Fair Value = EPS × Fair P/E`
3. ✅ Add to fundamentals:
   ```json
   {
     "fair_value_pe": {
       "historical_avg": 22.3,
       "historical_median": 21.5,
       "growth_adjusted": 25.5,
       "preferred": 25.5  // Uses growth-adjusted if available, else median, else avg
     },
     "fair_value_price": 281.25,
     "premium_discount_pct": 5.2  // % above/below fair value
   }
   ```

**Use Case**: Filter trades by valuation (only trade undervalued stocks)

### ✅ Valuation Signals
**Status**: ✅ Implemented

**Implementation**:
1. ✅ Add valuation flags to fundamentals:
   ```json
   {
     "valuation_signal": "undervalued|fair|overvalued",
     "is_undervalued": true,
     "is_overvalued": false,
     "valuation_confidence": "high|medium|low",
     "valuation_reasons": [
       "Price 18.5% below fair value",
       "PEG ratio 0.75 suggests undervalued growth",
       "P/E in bottom 25% historically"
     ]
   }
   ```
2. ⏳ Use in ranking/scoring algorithm (next step)

**Use Case**: Boost rank for undervalued stocks, penalize overvalued

---

## Integration with Ranking

### Current Ranking Formula
```
Rank = Technical Score + Sector Boost
```

### Proposed Enhanced Ranking (Ready to Implement)
```
Rank = Technical Score + Sector Boost + Valuation Boost

Where:
- Valuation Boost = 
  - +5 if undervalued (is_undervalued = true, confidence = high)
  - +3 if undervalued (is_undervalued = true, confidence = medium)
  - +2 if PEG < 0.8 (undervalued growth)
  - +1 if PEG < 1.0 (fairly valued growth)
  - 0 if PEG 1.0-1.5 (neutral)
  - -1 if PEG > 1.5 (overvalued)
  - -3 if overvalued (is_overvalued = true, confidence = medium)
  - -5 if overvalued (is_overvalued = true, confidence = high)
```

**Implementation Status**: Functions ready, needs integration into `computeRank()` function

---

## Example Scenarios

### Scenario 1: High Growth, Reasonable PEG
- **Stock**: NVDA
- **P/E**: 45
- **EPS Growth**: 50% annually
- **PEG**: 0.9
- **Analysis**: High P/E is justified by exceptional growth. PEG < 1.0 suggests undervalued.

### Scenario 2: Low Growth, High P/E
- **Stock**: MCD
- **P/E**: 30
- **EPS Growth**: 5% annually
- **PEG**: 6.0
- **Analysis**: High P/E not justified by growth. Overvalued.

### Scenario 3: Moderate Growth, Fair PEG
- **Stock**: CAT
- **P/E**: 25
- **EPS Growth**: 20% annually
- **PEG**: 1.25
- **Analysis**: Fairly valued. Growth justifies P/E.

---

## Data Availability

### When Metrics Are Available
- **EPS Growth Rate**: Requires at least 4 quarters of quarterly EPS data
- **PEG Ratio**: Requires both P/E ratio and EPS growth rate

### When Metrics Are Missing
- New IPOs (insufficient historical data)
- Companies with negative/zero EPS
- Companies with negative growth rates (PEG not calculated)
- ETFs/Indices (no earnings data)

### Handling Missing Data
- `eps_growth_rate`: `null` if insufficient data
- `peg_ratio`: `null` if growth rate unavailable or negative

---

## Testing

### Verify EPS Growth Calculation
1. Check ticker with known growth (e.g., NVDA)
2. Verify `eps_growth_rate` is reasonable (should match analyst estimates)
3. Verify `peg_ratio` calculation: `pe_ratio / eps_growth_rate`

### Verify Data Storage
1. Send test alert with new metrics
2. Check KV storage: `timed:fundamentals:{ticker}`
3. Verify API endpoint returns new fields

---

## References

- **Pine Script**: `tradingview/TimedTrading_ScoreEngine.pine`
- **Worker**: `worker/index.js` (fundamentals storage)
- **Source Scripts**: 
  - "Price vs Earnings - Advanced (Growth & Forecast)"
  - "P/E Ratio Analyzer - 5 Year Historical"

---

## Next Steps

1. ✅ **Completed**: Added EPS Growth Rate and PEG Ratio to Pine Script
2. ✅ **Completed**: Updated worker to store new metrics
3. ✅ **Completed**: Historical P/E percentile tracking
4. ✅ **Completed**: Fair value calculation (multiple methods)
5. ✅ **Completed**: Valuation signals (undervalued/fair/overvalued)
6. ⏳ **Next**: Integrate valuation signals into ranking algorithm
7. ⏳ **Future**: Add API endpoints to filter/query by valuation criteria
