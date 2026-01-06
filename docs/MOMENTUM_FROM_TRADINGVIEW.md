# Momentum Calculations from TradingView

## Problem
Since we just started capturing data, we don't have historical trail data going back weeks or months. We need momentum percentages immediately.

## Solution ✅
**TradingView now calculates and sends momentum % in the webhook payload!**

---

## What Changed

### 1. Pine Script (`TimedTrading_ScoreEngine_Enhanced.pine`)

Added momentum % calculations that use TradingView's historical data:

```pinescript
// Get daily close prices for different periods
f_daily_close(int barsAgo) =>
    [closePrice] = request.security(syminfo.tickerid, "D", [close[barsAgo]], lookahead=barmerge.lookahead_off)
    closePrice

// Get historical prices
priceWeekAgo = f_daily_close(5)      // ~5 trading days ago
priceMonthAgo = f_daily_close(20)    // ~20 trading days ago
price3MonthsAgo = f_daily_close(60)  // ~60 trading days ago
price6MonthsAgo = f_daily_close(120) // ~120 trading days ago

// Calculate percentage changes
pctChangeWeek = ((currentPrice - priceWeekAgo) / priceWeekAgo) * 100
pctChangeMonth = ((currentPrice - priceMonthAgo) / priceMonthAgo) * 100
// ... etc
```

**Added to JSON payload:**
```json
{
  "momentum_pct": {
    "week": 12.5,
    "month": 28.3,
    "three_months": 55.2,
    "six_months": 105.8
  }
}
```

### 2. Worker (`worker/index.js`)

Updated `computeMomentumElite()` to:
1. **First**: Use `momentum_pct` from TradingView payload (most accurate, immediate)
2. **Fallback**: Calculate from trail history (for older data or if TradingView doesn't send it)

```javascript
// Prefer TradingView payload data
const momentumPct = payload.momentum_pct || {};
const weekPct = momentumPct.week != null ? Number(momentumPct.week) : null;

if (weekPct != null || monthPct != null || ...) {
  // Use TradingView data (percentages are in % form, e.g., 10.5 means 10.5%)
  const weekOver10Pct = weekPct != null && weekPct >= 10.0;
  // ... check all criteria
} else {
  // Fallback to trail calculation
  // ... existing trail logic
}
```

---

## Benefits

✅ **Works immediately** - No need to wait for months of trail data  
✅ **More accurate** - Uses TradingView's historical daily data  
✅ **Always available** - TradingView has access to all historical data  
✅ **Backward compatible** - Falls back to trail calculation if payload missing  

---

## How It Works

1. **TradingView** calculates momentum % using `request.security()` to get historical daily closes
2. **Webhook** includes `momentum_pct` object in JSON payload
3. **Worker** reads `momentum_pct` from payload and checks criteria:
   - Week > 10%
   - Month > 25%
   - 3 Months > 50%
   - 6 Months > 100%
4. **Momentum Elite** activates if any criteria met + base criteria (price, market cap, ADR, volume)

---

## Testing

After deploying:

1. **Update TradingView script** - Copy the updated Pine Script
2. **Deploy Worker** - `wrangler deploy`
3. **Check payload** - Verify `momentum_pct` appears in webhook data
4. **Test endpoint**:
   ```bash
   curl "https://YOUR-WORKER.workers.dev/timed/momentum?ticker=AAPL"
   ```

Expected response:
```json
{
  "ok": true,
  "ticker": "AAPL",
  "data": {
    "momentum_elite": true,
    "criteria": {
      "priceOver4": true,
      "marketCapOver1B": true,
      "adrOver2Pct": true,
      "volumeOver2M": true,
      "allBaseCriteria": true,
      "anyMomentumCriteria": true
    }
  }
}
```

---

## Notes

- **Percentages are in % form**: `10.5` means 10.5%, not 0.105
- **Uses trading days**: 5 days ≈ 1 week, 20 days ≈ 1 month, etc.
- **Cached for 15 minutes**: Reduces recalculation overhead
- **Fallback to trail**: If TradingView doesn't send `momentum_pct`, uses trail calculation

---

## Status

✅ **Ready to deploy!**

- Pine Script: ✅ Updated
- Worker: ✅ Updated
- Backward compatible: ✅ Yes (falls back to trail if needed)

