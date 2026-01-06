# Momentum Elite: Worker-Based Architecture

## Why Move Calculations to Worker?

### Current Approach (Pine Script)
- ❌ Limited data access (no market cap API)
- ❌ Calculations run on every bar (inefficient)
- ❌ Can't cache results
- ❌ No history tracking
- ❌ Pine Script limitations (timeframe restrictions)

### Worker-Based Approach (Recommended)
- ✅ Access to external APIs (market cap, fundamentals)
- ✅ Calculate once, cache results
- ✅ Maintain history of Momentum Elite status
- ✅ Better performance (pre-computed, ready to serve)
- ✅ UI becomes pure presentation layer
- ✅ Can enrich with multiple data sources

## Architecture

```
┌─────────────┐
│ Pine Script │  → Sends basic data (price, volume, etc.)
└─────────────┘
       ↓
┌─────────────┐
│   Worker    │  → Calculates Momentum Elite
│             │  → Caches results (KV)
│             │  → Maintains history
└─────────────┘
       ↓
┌─────────────┐
│     UI      │  → Pure presentation layer
│             │  → Displays pre-computed data
└─────────────┘
```

## Implementation Plan

### 1. Worker Calculation Function
- Calculate all Momentum Elite criteria
- Use external APIs for market cap
- Cache results with appropriate TTL

### 2. Caching Strategy
- **Market Cap**: Cache 24 hours (changes infrequently)
- **ADR/Volume**: Cache 1 hour (daily data)
- **Momentum %**: Cache 15 minutes (weekly/monthly data)
- **Final Status**: Cache 5 minutes (recalculate frequently)

### 3. History Tracking
- Store Momentum Elite status changes
- Track when ticker enters/leaves Momentum Elite
- Enable historical analysis

### 4. Data Sources
- Market Cap: External API (Alpha Vantage, Yahoo Finance, etc.)
- Price/Volume: From TradingView payload
- Historical data: From TradingView or external APIs

## Performance Benefits

### Before (Pine Script)
- Calculation: Every bar (every 1-5 minutes per ticker)
- Data access: Limited
- Caching: None
- History: None

### After (Worker)
- Calculation: Once per cache period (5-60 min depending on data)
- Data access: Full (external APIs)
- Caching: Aggressive (reduce API calls)
- History: Full tracking

## Cache Keys

```
timed:momentum:${ticker}           → Current Momentum Elite status + metadata
timed:momentum:history:${ticker}    → History of status changes
timed:momentum:cache:marketcap      → Market cap cache (per ticker)
timed:momentum:cache:adr            → ADR cache (per ticker)
timed:momentum:cache:volume         → Volume cache (per ticker)
```

## API Endpoints

### GET `/timed/momentum?ticker=AAPL`
Returns current Momentum Elite status for a ticker.

### GET `/timed/momentum/history?ticker=AAPL`
Returns history of Momentum Elite status changes.

### GET `/timed/momentum/all`
Returns all Momentum Elite tickers (pre-filtered).

## Benefits Summary

1. **Performance**: Calculate once, serve many times
2. **Accuracy**: Access to real market cap data
3. **Flexibility**: Easy to add new criteria
4. **History**: Track status changes over time
5. **Scalability**: Worker handles all heavy lifting
6. **UI Speed**: Pure presentation, no calculations

