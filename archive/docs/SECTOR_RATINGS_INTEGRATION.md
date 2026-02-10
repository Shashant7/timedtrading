# Sector Ratings & Fundamental Analysis Integration Plan

## Executive Summary

This document outlines how to integrate VIP analyst sector ratings (overweight/underweight) with fundamental analysis to enhance stock selection and scoring within the Timed Trading system.

---

## 1. Script Analysis

### Script 1: "Price vs Earnings - Advanced (Growth & Forecast)"

**Strengths:**
- ✅ Comprehensive P/E analysis with multiple valuation modes
- ✅ Growth-adjusted PEG ratio calculation (accounts for earnings growth)
- ✅ Historical P/E context (average, median)
- ✅ Forward-looking EPS forecast capability
- ✅ Valuation bands (overvalued/undervalued zones)
- ✅ Rich metrics: Current P/E, Fair P/E, EPS, Growth Rate, PEG, Premium/Discount

**Key Metrics Provided:**
- `currentPE`: Current P/E ratio
- `fairValuePE`: Fair value P/E (based on mode)
- `epsGrowthRate`: Annualized earnings growth rate (%)
- `pegRatio`: P/E to Growth ratio
- `premium`: Premium/discount to fair value (%)
- `isOvervalued` / `isUndervalued`: Boolean flags

**Use Cases:**
- Identify fundamentally attractive stocks (low P/E relative to growth)
- Filter out overvalued stocks even if technical setup is good
- Boost stocks with strong growth-adjusted valuations

### Script 2: "P/E Ratio Analyzer - 5 Year Historical"

**Strengths:**
- ✅ Simple, focused on historical context
- ✅ 5-year percentile bands (10th, 25th, 75th, 90th)
- ✅ Clear undervalued/overvalued signals
- ✅ Historical average and median P/E

**Key Metrics Provided:**
- `peRatio`: Current P/E
- `histAvg`: 5-year historical average P/E
- `histMedian`: 5-year historical median P/E
- `p10`, `p25`, `p75`, `p90`: Percentile bands
- `isUndervalued`: P/E < 85% of historical average
- `isOvervalued`: P/E > 115% of historical average

**Use Cases:**
- Quick valuation check (is stock cheap/expensive historically?)
- Percentile ranking within historical context
- Simple filter for fundamentally sound stocks

---

## 2. Stock Selection Strategy: Market Cap vs P/E Ratio

### Recommendation: **Hybrid Approach**

For sector-based stock selection, use a **multi-factor ranking** rather than a single metric:

#### **Primary Ranking Factors (in order):**

1. **Technical Setup Quality** (Your existing system)
   - HTF/LTF scores
   - Corridor alignment
   - Risk/reward ratio
   - This should remain the primary filter

2. **P/E Ratio Context** (Fundamental filter)
   - Use Script 2's percentile ranking
   - Prefer stocks in bottom 50th percentile (cheaper historically)
   - Avoid stocks in top 25th percentile (expensive historically)
   - **Why**: Even in favored sectors, avoid overpaying

3. **Market Cap** (Liquidity & Stability)
   - Use market cap as a **filter**, not primary ranker
   - Minimum: $500M market cap (liquidity)
   - Preferred: $2B+ for stability
   - **Why**: Larger caps = better liquidity, less volatility

4. **Growth-Adjusted Valuation** (Script 1 - for growth sectors)
   - For growth sectors (Tech, Healthcare): Use PEG ratio
   - Prefer PEG < 1.5 (growth justifies valuation)
   - **Why**: Growth stocks can have high P/E but still be attractive if growth is strong

#### **Sector-Specific Recommendations:**

| Sector Type | Primary Metric | Secondary Metric |
|------------|---------------|------------------|
| **Value Sectors** (Financials, Energy, Utilities) | Historical P/E Percentile | Market Cap |
| **Growth Sectors** (Tech, Healthcare, Consumer Discretionary) | PEG Ratio | Historical P/E Percentile |
| **Cyclical Sectors** (Industrials, Materials) | Historical P/E Percentile | Market Cap |
| **Defensive Sectors** (Consumer Staples, REITs) | Historical P/E Percentile | Dividend Yield (if available) |

---

## 3. Integration Architecture

### Phase 1: Data Collection (Display Only)

**Goal**: Collect and display fundamental data without affecting scoring

**Implementation:**
1. Add fundamental data fields to ticker data structure:
   ```javascript
   {
     // Existing fields...
     fundamentals: {
       peRatio: number,
       pePercentile: number, // 0-100, where 0 = cheapest historically
       pegRatio: number,
       epsGrowthRate: number,
       marketCap: number,
       isUndervalued: boolean,
       isOvervalued: boolean,
       fairValuePE: number,
       premiumToFairValue: number // %
     }
   }
   ```

2. Create endpoint to fetch/store fundamental data:
   - `POST /timed/fundamentals?key=...` - Update fundamental data
   - Data can come from TradingView alerts (using your scripts) or external API

3. Display in UI:
   - Add fundamental metrics to ticker detail panels
   - Show P/E percentile, PEG ratio, valuation status
   - Color-code: Green (undervalued), Red (overvalued), Gray (neutral)

### Phase 2: Sector Rating Integration

**Goal**: Apply sector ratings as a boost/penalty to scoring

**Implementation:**
1. Create sector mapping:
   ```javascript
   const SECTOR_MAP = {
     'AAPL': 'Technology',
     'MSFT': 'Technology',
     'JPM': 'Financials',
     // ... etc
   };
   ```

2. Store sector ratings:
   ```javascript
   const SECTOR_RATINGS = {
     'Technology': { rating: 'overweight', highlighted: true },
     'Financials': { rating: 'underweight', highlighted: false },
     // ... etc
   };
   ```

3. Apply sector boost to rank:
   ```javascript
   function applySectorBoost(ticker, baseRank) {
     const sector = SECTOR_MAP[ticker];
     const rating = SECTOR_RATINGS[sector];
     
     if (!rating) return baseRank;
     
     let boost = 0;
     if (rating.rating === 'overweight') {
       boost = 5; // +5 rank boost
       if (rating.highlighted) boost += 3; // +3 more if highlighted
     } else if (rating.rating === 'underweight') {
       boost = -3; // -3 rank penalty
     }
     
     return baseRank + boost;
   }
   ```

### Phase 3: Fundamental Filtering (Optional)

**Goal**: Use fundamentals to filter/boost stocks within sectors

**Implementation:**
1. Apply fundamental boost:
   ```javascript
   function applyFundamentalBoost(ticker, tickerData, baseRank) {
     const fund = tickerData.fundamentals;
     if (!fund) return baseRank;
     
     let boost = 0;
     
     // Boost undervalued stocks
     if (fund.isUndervalued && fund.pePercentile < 25) {
       boost += 3; // Bottom quartile = attractive
     }
     
     // Boost growth stocks with reasonable PEG
     if (fund.pegRatio && fund.pegRatio < 1.5 && fund.epsGrowthRate > 15) {
       boost += 2; // Strong growth at reasonable price
     }
     
     // Penalize overvalued stocks
     if (fund.isOvervalued && fund.pePercentile > 75) {
       boost -= 2; // Top quartile = expensive
     }
     
     return baseRank + boost;
   }
   ```

2. Combined scoring:
   ```javascript
   finalRank = baseRank 
     + applySectorBoost(ticker, baseRank)
     + applyFundamentalBoost(ticker, tickerData, baseRank);
   ```

---

## 4. Stock Selection Within Sectors

### Recommended Approach: **Multi-Factor Ranking**

For each sector, rank stocks by:

1. **Technical Score** (Your existing HTF/LTF system) - 60% weight
2. **Fundamental Attractiveness** (P/E percentile, PEG) - 25% weight  
3. **Market Cap** (Liquidity filter) - 15% weight

**Example Ranking Function:**
```javascript
function rankStocksInSector(sectorTickers, tickerData) {
  return sectorTickers
    .map(ticker => {
      const data = tickerData[ticker];
      const fund = data.fundamentals || {};
      
      // Technical score (0-100, your existing rank)
      const technicalScore = data.rank || 0;
      
      // Fundamental score (0-100)
      let fundamentalScore = 50; // Neutral
      if (fund.pePercentile !== undefined) {
        // Lower percentile = cheaper = better
        fundamentalScore = 100 - fund.pePercentile;
      }
      
      // Market cap score (0-100)
      let capScore = 50;
      if (fund.marketCap) {
        if (fund.marketCap > 10_000_000_000) capScore = 100; // Large cap
        else if (fund.marketCap > 2_000_000_000) capScore = 75; // Mid cap
        else if (fund.marketCap > 500_000_000) capScore = 50; // Small cap
        else capScore = 25; // Micro cap
      }
      
      // Weighted composite score
      const compositeScore = 
        (technicalScore * 0.60) +
        (fundamentalScore * 0.25) +
        (capScore * 0.15);
      
      return {
        ticker,
        compositeScore,
        technicalScore,
        fundamentalScore,
        capScore,
        ...data
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);
}
```

### Top 10 Selection Strategy

**Option A: Market Cap Weighted (Recommended for Stability)**
- Select top 10 by composite score
- Ensure minimum $500M market cap
- Prefer larger caps for liquidity

**Option B: Equal Weight (Recommended for Diversification)**
- Select top 10 by composite score
- Mix of large/mid/small cap
- Better sector representation

**Option C: Growth-Focused (For Growth Sectors)**
- Select top 10 by composite score
- Filter: PEG < 2.0
- Prefer higher growth rates

---

## 5. Implementation Recommendations

### Immediate Actions (Phase 1):

1. **Add Fundamental Data Fields**
   - Extend ticker data structure
   - Create storage/retrieval endpoints
   - Display in UI (read-only)

2. **Create Sector Mapping**
   - Map all tracked tickers to sectors
   - Store sector ratings
   - Display sector info in UI

3. **Test with Scripts**
   - Run both scripts on your watchlist
   - Collect P/E, PEG, growth data
   - Validate data quality

### Short-Term (Phase 2):

1. **Implement Sector Boost**
   - Add sector boost to rank calculation
   - Test impact on rankings
   - Adjust boost amounts based on results

2. **Add Fundamental Display**
   - Show P/E percentile in ticker cards
   - Color-code valuation status
   - Add tooltips explaining metrics

### Long-Term (Phase 3):

1. **Full Fundamental Integration**
   - Add fundamental boost to scoring
   - Implement sector-specific ranking
   - Create "Top Stocks by Sector" views

2. **Automated Data Collection**
   - Integrate with TradingView scripts via alerts
   - Or use external API (Alpha Vantage, Polygon, etc.)
   - Schedule periodic updates

---

## 6. Script Recommendations

### Use Script 1 ("Price vs Earnings - Advanced") For:
- ✅ Growth sectors (Tech, Healthcare)
- ✅ Stocks with high P/E ratios (need PEG context)
- ✅ Forward-looking analysis
- ✅ Detailed valuation analysis

### Use Script 2 ("P/E Ratio Analyzer") For:
- ✅ Value sectors (Financials, Energy)
- ✅ Quick valuation checks
- ✅ Historical context
- ✅ Simple filtering

### Combined Approach:
- Use **Script 2** for initial filtering (quick P/E percentile check)
- Use **Script 1** for detailed analysis of selected stocks
- Both can run simultaneously on TradingView

---

## 7. Example Workflow

### For an "Overweight Technology" Rating:

1. **Filter**: Get all Technology sector stocks
2. **Rank**: Sort by composite score (technical + fundamental)
3. **Fundamental Filter**: 
   - Prefer P/E percentile < 50 (cheaper than historical average)
   - For growth stocks: PEG < 1.5
   - Minimum market cap: $500M
4. **Technical Filter**: Your existing HTF/LTF corridor system
5. **Select**: Top 10-15 stocks meeting all criteria
6. **Boost**: Apply +5 rank boost to all selected stocks

### For an "Underweight Financials" Rating:

1. **Filter**: Get all Financials sector stocks
2. **Penalty**: Apply -3 rank penalty
3. **Still Trade**: If technical setup is exceptional (rank > 80), allow trades
4. **Display**: Show sector rating warning in UI

---

## 8. Next Steps

1. **Review this plan** and decide on Phase 1 scope
2. **Create sector mapping** for your current watchlist
3. **Set up data collection** for fundamental metrics
4. **Test scripts** on a few tickers to validate data
5. **Implement Phase 1** (display only) first
6. **Iterate** based on results

---

## Questions to Consider

1. **Data Source**: How will you get fundamental data?
   - TradingView scripts (via alerts)?
   - External API?
   - Manual entry?

2. **Update Frequency**: How often do sector ratings change?
   - Daily?
   - Weekly?
   - Monthly?

3. **Boost Amounts**: How much should sector ratings affect scoring?
   - Start conservative (+3/-3)
   - Adjust based on backtesting

4. **Sector Coverage**: Do you have ratings for all sectors?
   - Which sectors are most important?
   - Any sectors to exclude?
