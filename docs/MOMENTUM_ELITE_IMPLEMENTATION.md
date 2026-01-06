# Momentum Elite Implementation Guide

## Current Status

### ✅ Working Now
- Price > $4 check ✅
- Market cap check (defaults to true - needs API)
- ADR calculation (simplified - uses current bar)
- Volume check (simplified - uses current volume)
- Caching infrastructure ✅
- Score boost (+20 points) ✅
- UI display ✅

### ❌ Not Working Yet
- **Market Cap API** - Currently returns `null` (defaults to true)
- **Momentum % Calculations** - Currently returns `false` (placeholder)
  - Week > 10%
  - Month > 25%
  - 3 Months > 50%
  - 6 Months > 100%

---

## What Needs to Be Implemented

### Option 1: Use TradingView Data (Recommended - Easiest)

Since TradingView already sends price data, we can calculate momentum % from the trail history!

**Implementation**: Calculate momentum from stored trail data instead of external API.

**Pros**:
- No external API needed
- Uses data we already have
- Free
- Fast

**Cons**:
- Requires enough history (need 6 months of data)
- Less accurate for new tickers

### Option 2: External Stock API

Use a free/paid API for market cap and historical prices.

**Options**:
- **Alpha Vantage** (Free tier: 5 calls/min, 500/day)
- **Yahoo Finance** (Unofficial API, free but rate-limited)
- **Polygon.io** (Paid, reliable)
- **Finnhub** (Free tier: 60 calls/min)

### Option 3: Hybrid Approach (Best)

- **Market Cap**: Use external API (cached 24 hours)
- **Momentum %**: Calculate from TradingView trail data (we have this!)
- **ADR/Volume**: Use TradingView data (already working)

---

## Recommended Implementation: Use Trail Data

Since we already store trail history with prices, we can calculate momentum % from that!

### Implementation Steps

1. **Calculate from Trail History**
   - Week: Compare current price to price 1 week ago in trail
   - Month: Compare to price ~4 weeks ago
   - 3 Months: Compare to price ~12 weeks ago
   - 6 Months: Compare to price ~24 weeks ago

2. **Market Cap**: Use a simple API (Alpha Vantage or Yahoo Finance)

---

## Quick Implementation

### Step 1: Calculate Momentum from Trail

Update the `computeMomentumElite()` function to use trail data:

```javascript
// In computeMomentumElite(), replace the momentum criteria section:

// Get trail history
const trailKey = `timed:trail:${ticker}`;
const trail = await kvGetJSON(KV, trailKey) || [];

if (trail.length > 0) {
  const currentPrice = Number(payload.price) || 0;
  const now = Date.now();
  
  // Find prices from different time periods
  const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = now - (30 * 24 * 60 * 60 * 1000);
  const threeMonthsAgo = now - (90 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000);
  
  // Find closest trail points to these times
  const findClosestPrice = (targetTime) => {
    let closest = null;
    let minDiff = Infinity;
    for (const point of trail) {
      const diff = Math.abs(point.ts - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = point;
      }
    }
    return closest ? Number(closest.price || 0) : null;
  };
  
  const priceWeekAgo = findClosestPrice(oneWeekAgo);
  const priceMonthAgo = findClosestPrice(oneMonthAgo);
  const price3MonthsAgo = findClosestPrice(threeMonthsAgo);
  const price6MonthsAgo = findClosestPrice(sixMonthsAgo);
  
  // Calculate percentage changes
  const weekOver10Pct = priceWeekAgo && priceWeekAgo > 0 
    ? ((currentPrice - priceWeekAgo) / priceWeekAgo) >= 0.10 
    : false;
    
  const monthOver25Pct = priceMonthAgo && priceMonthAgo > 0
    ? ((currentPrice - priceMonthAgo) / priceMonthAgo) >= 0.25
    : false;
    
  const threeMonthOver50Pct = price3MonthsAgo && price3MonthsAgo > 0
    ? ((currentPrice - price3MonthsAgo) / price3MonthsAgo) >= 0.50
    : false;
    
  const sixMonthOver100Pct = price6MonthsAgo && price6MonthsAgo > 0
    ? ((currentPrice - price6MonthsAgo) / price6MonthsAgo) >= 1.00
    : false;
  
  anyMomentumCriteria = weekOver10Pct || monthOver25Pct || threeMonthOver50Pct || sixMonthOver100Pct;
} else {
  // No trail data yet, default to false
  anyMomentumCriteria = false;
}
```

### Step 2: Add Market Cap API (Optional but Recommended)

For Alpha Vantage:

```javascript
async function fetchMarketCap(ticker) {
  // Skip for non-stocks (crypto, futures, etc.)
  if (ticker.endsWith("USDT") || ticker.endsWith("USD") || ticker.endsWith("1!")) {
    return null; // Skip market cap check for these
  }
  
  try {
    // Get API key from environment (set via: wrangler secret put ALPHA_VANTAGE_API_KEY)
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) return null;
    
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data && data.MarketCapitalization) {
      return Number(data.MarketCapitalization);
    }
    return null;
  } catch (e) {
    console.error("Market cap fetch error:", e);
    return null;
  }
}
```

For Yahoo Finance (unofficial, free):

```javascript
async function fetchMarketCap(ticker) {
  try {
    // Yahoo Finance unofficial API
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data && data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const marketCap = result.meta?.marketCap;
      if (marketCap) return Number(marketCap);
    }
    return null;
  } catch (e) {
    return null;
  }
}
```

---

## Implementation Priority

### Phase 1: Quick Win (Use Trail Data) ⚡
- **Time**: 30 minutes
- **Impact**: High - Momentum % will work for tickers with history
- **Cost**: Free
- **Action**: Update `computeMomentumElite()` to use trail data

### Phase 2: Market Cap API (Optional)
- **Time**: 1 hour
- **Impact**: Medium - More accurate market cap filtering
- **Cost**: Free (Alpha Vantage) or Paid (Polygon.io)
- **Action**: Implement `fetchMarketCap()` with API

### Phase 3: Enhanced ADR/Volume (Optional)
- **Time**: 2 hours
- **Impact**: Low - Current simplified version works
- **Cost**: Free (use TradingView data)
- **Action**: Calculate 50-day averages from trail data

---

## Recommended: Start with Phase 1

The trail data approach will work immediately for any ticker that has been tracked for a while. This gets Momentum Elite working right away!

**Next Steps**:
1. Update `computeMomentumElite()` to calculate momentum from trail
2. Test with a ticker that has 6+ months of history
3. Verify Momentum Elite status appears correctly
4. Add market cap API later if needed

---

## Testing

After implementation, test with:

```bash
# Send test data
curl -X POST "https://YOUR-WORKER.workers.dev/timed/ingest?key=KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticker":"AAPL","ts":1704067200000,"htf_score":15,"ltf_score":5,"price":150.0}'

# Check momentum status
curl "https://YOUR-WORKER.workers.dev/timed/momentum?ticker=AAPL"
```

Expected: `momentum_elite: true` if criteria are met.

