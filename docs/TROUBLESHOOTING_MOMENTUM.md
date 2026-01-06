# Troubleshooting Momentum Calculations

## Warning: "Not calculated for 2 symbols"

This warning appears when `request.security()` cannot fetch daily historical data for certain symbols.

### Common Causes

1. **Insufficient Historical Data**
   - New IPOs or recently listed symbols
   - Symbols with less than 120 trading days of history
   - Solution: Script will return `null` for momentum_pct, worker falls back to trail calculation

2. **Invalid Symbol Format**
   - Symbols with special characters or formatting issues
   - Solution: Check symbol format in TradingView

3. **Symbol Type Not Supporting Daily Timeframe**
   - Some crypto or futures symbols might not have daily data
   - Solution: Script handles gracefully, returns `null` values

4. **TradingView Data Limitations**
   - Some symbols may have restricted data access
   - Solution: Script continues normally, momentum_pct will be `null`

### What Happens

✅ **Script continues to work** - The script doesn't break, it just returns `null` for momentum percentages  
✅ **Worker handles gracefully** - Falls back to trail-based calculation if payload missing  
✅ **Other symbols unaffected** - Only the problematic symbols show the warning  

### How to Identify Problem Symbols

1. **Check TradingView Alert Logs**
   - Look for symbols that consistently fail
   - Check if they have sufficient historical data

2. **Check Worker Logs**
   - Look for payloads with `momentum_pct: null` or missing `momentum_pct`
   - These symbols will use trail-based calculation

3. **Manual Check**
   ```bash
   curl "https://YOUR-WORKER.workers.dev/timed/momentum?ticker=PROBLEM_SYMBOL"
   ```
   - If `momentum_pct` is missing or all null, that symbol is having issues

### Solutions

#### Option 1: Ignore the Warning (Recommended)
- The script handles it gracefully
- Worker falls back to trail calculation
- No action needed

#### Option 2: Remove Problem Symbols
- If specific symbols consistently fail, remove them from watchlist
- Or add them to an exclusion list

#### Option 3: Wait for More Data
- New symbols will work once they have 120+ days of history
- Trail calculation will work in the meantime

### Expected Behavior

**For symbols with sufficient data:**
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

**For symbols without sufficient data:**
```json
{
  "momentum_pct": {
    "week": null,
    "month": null,
    "three_months": null,
    "six_months": null
  }
}
```

The worker will use trail-based calculation for these symbols.

### Verification

After deploying the updated script:

1. **Check if warning persists** - Should be reduced or eliminated
2. **Verify payload** - Check webhook data for `momentum_pct` values
3. **Test endpoint** - Verify worker handles both cases correctly

```bash
# Test a working symbol
curl "https://YOUR-WORKER.workers.dev/timed/momentum?ticker=AAPL"

# Test a problematic symbol
curl "https://YOUR-WORKER.workers.dev/timed/momentum?ticker=PROBLEM_SYMBOL"
```

Both should return valid responses, even if momentum_pct is null.

