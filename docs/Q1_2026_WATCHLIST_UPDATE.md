# Q1 2026 Watchlist Update Guide

## Summary of Changes

This document outlines the updates needed to sync the platform with the Q1-2026 watchlist.

## Files Updated

### 1. **Worker (`worker/index.js`)**
- ✅ Updated cleanup endpoint with exact Q1-2026 watchlist
- ✅ Added AAPL to Social group in cleanup list
- ✅ All tickers from Q1-2026 file are now in the approved list

### 2. **Frontend (`react-app/index-react.html`)**
- ✅ Updated GROUPS to match Q1-2026 exactly
- ✅ Removed APLD from Upticks (only in Social)
- ✅ Added MU to Social group
- ✅ Added AAPL to Social group

### 3. **Pine Script (`tradingview/TimedTrading_ScoreEngine_Enhanced.pine`)**
- ✅ Reduced `periodicUpdateMinutes` from 30 to **5 minutes**
- ✅ Updated `shouldSend` logic to always send when periodic update is due
- ✅ This ensures every ticker in the watchlist gets regular updates every 5 minutes

### 4. **TradingView Watchlist File**
- ✅ Created `tradingview/WATCHLIST_Q1_2026.txt` with all tickers in TradingView format

## What Needs to Be Done

### Step 1: Update TradingView Watchlist
1. Open TradingView
2. Go to your watchlist
3. Import or manually add tickers from `tradingview/WATCHLIST_Q1_2026.txt`
4. Ensure all tickers are added (including Gold and Silver)

### Step 2: Update Pine Script Settings
1. Open the Pine Script indicator on your chart
2. Set **Periodic update interval** to **5 minutes** (default is now 5)
3. Optionally enable **FORCE: Send baseline every bar** temporarily to force initial baseline for all tickers
4. Save and apply to your watchlist

### Step 3: Run Cleanup Endpoint
After deploying the updated worker, run the cleanup to sync the platform:

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/cleanup-tickers?key=AwesomeSauce"
```

This will:
- Remove all unapproved tickers
- Keep only tickers from Q1-2026 watchlist
- Normalize ticker names (BRK-B → BRK.B, etc.)

### Step 4: Verify Data Flow
1. Check that TradingView alerts are firing for all watchlist tickers
2. Verify that AAPL, APLD, and other tickers appear in the dashboard
3. Check Activity Feed for events from all tickers

## Architecture Changes

### Periodic Updates (Always-On Data)
The Pine Script now sends updates every 5 minutes for **every ticker in the watchlist**, even if nothing has changed. This ensures:
- ✅ All tickers maintain current data
- ✅ No tickers are missed due to lack of movement
- ✅ History is maintained for all tickers
- ✅ Worker always has fresh data to evaluate

### Worker Evaluation
The worker now:
- ✅ Receives periodic updates from all watchlist tickers
- ✅ Evaluates conditions for Discord alerts
- ✅ Evaluates conditions for simulated trades
- ✅ Maintains activity feed for all tickers

## Expected Behavior

After these updates:
1. **Every ticker in the watchlist** will send data every 5 minutes
2. **Platform will only show** tickers from Q1-2026 watchlist
3. **AAPL and APLD** will appear in the dashboard (they're in Social group)
4. **Worker will evaluate** all tickers for alerts and trades
5. **Activity Feed** will show events from all tickers

## Troubleshooting

### If AAPL/APLD still don't appear:
1. Check TradingView watchlist - ensure they're added
2. Check TradingView alerts - ensure alerts are firing for these tickers
3. Check worker logs - look for ingest events for these tickers
4. Run cleanup endpoint again to ensure they're in the approved list
5. Check `/timed/check-ticker?ticker=AAPL` endpoint to see if data exists

### If periodic updates aren't working:
1. Verify `periodicUpdateMinutes` is set to 5 (or > 0)
2. Check TradingView alert settings - ensure "Once Per Bar Close" is enabled
3. Verify watchlist alerts are enabled for all tickers
4. Check worker logs for incoming alerts

## Next Steps

1. ✅ Deploy updated worker
2. ✅ Update TradingView watchlist
3. ✅ Update Pine Script settings (periodic update = 5 min)
4. ✅ Run cleanup endpoint
5. ✅ Verify all tickers appear in dashboard
6. ✅ Monitor Activity Feed for events

