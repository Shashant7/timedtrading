# Worker Deployment Verification Guide

## Step 1: Check Cloudflare Worker Logs

After deploying, check your Cloudflare Worker logs to see if requests are reaching the worker:

1. Go to Cloudflare Dashboard → Workers & Pages → Your Worker
2. Click on "Logs" tab
3. Look for these log entries (in order of appearance):

### Expected Log Sequence for Successful Ingestion:
```
[INGEST REQUEST RECEIVED] IP: <ip>, User-Agent: <user-agent>
[INGEST AUTH PASSED] Processing request from IP: <ip>
[INGEST RAW] <TICKER>: { hasTicker: true, hasTs: true, ... }
[INGEST] <TICKER>: { ts: ..., htf: ..., ltf: ..., ... }
[INGEST STORED] <TICKER> - latest data saved
[INGEST COMPLETE] <TICKER> - added to index and stored
[INGEST SUCCESS] <TICKER> - completed successfully
```

### If You See These Logs:
- ✅ **Requests ARE reaching the worker** - The issue is elsewhere
- ✅ **Check for `[INGEST AUTH FAILED]`** - API key might be wrong
- ✅ **Check for `[INGEST JSON PARSE FAILED]`** - TradingView payload format issue
- ✅ **Check for `[INGEST VALIDATION FAILED]`** - Missing required fields

### If You DON'T See `[INGEST REQUEST RECEIVED]`:
- ❌ **Requests are NOT reaching the worker**
- Possible causes:
  1. Cloudflare-level rate limiting (check Cloudflare dashboard)
  2. CORS preflight failing (check for OPTIONS requests)
  3. Route configuration issue
  4. TradingView webhook URL incorrect

## Step 2: Test the Endpoint Manually

Test the ingest endpoint directly to verify it's working:

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/ingest?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "TEST",
    "ts": 1704067200000,
    "htf_score": 10.5,
    "ltf_score": 5.2,
    "state": "HTF_BULL_LTF_BULL",
    "price": 100.0
  }'
```

Expected response:
```json
{
  "ok": true,
  "ticker": "TEST"
}
```

## Step 3: Check for 429 Errors

If you're still seeing 429 errors:

1. **Check Cloudflare Rate Limiting Rules**:
   - Go to Cloudflare Dashboard → Security → WAF
   - Look for any rate limiting rules that might be blocking requests
   - Check if there are IP-based rate limits

2. **Check TradingView Webhook Logs**:
   - In TradingView, check the alert history
   - See what HTTP status codes are being returned
   - Note the exact error messages

3. **Verify API Key**:
   - Make sure the API key in TradingView webhook URL matches `TIMED_API_KEY` secret
   - Test with a manual curl request using the same key

## Step 4: Monitor Real-Time Logs

Use Cloudflare's real-time logs feature:

```bash
# If using Wrangler CLI
wrangler tail --format pretty
```

This will show live logs as requests come in.

## Step 5: Check Health Endpoint

Verify the worker is responding:

```bash
curl https://timed-trading-ingest.shashant.workers.dev/timed/health
```

Should return:
```json
{
  "ok": true,
  "now": <timestamp>,
  "lastIngestMs": <timestamp>,
  "minutesSinceLast": <number>,
  "tickers": <count>,
  "dataVersion": "2.1.0",
  "expectedVersion": "2.1.0"
}
```

## Common Issues and Solutions

### Issue: No logs appearing at all
**Solution**: 
- Verify worker is deployed to production
- Check route configuration in `wrangler.toml`
- Verify domain/route is correct

### Issue: `[INGEST AUTH FAILED]` logs
**Solution**:
- Verify `TIMED_API_KEY` secret is set correctly
- Check TradingView webhook URL has correct `?key=` parameter
- Test with manual curl request

### Issue: `[INGEST JSON PARSE FAILED]` logs
**Solution**:
- Check TradingView alert message format
- Verify JSON is properly formatted
- Check if TradingView is sending valid JSON

### Issue: Still seeing 429 errors
**Solution**:
- Check Cloudflare dashboard for rate limiting rules
- Verify no WAF rules are blocking requests
- Check if TradingView IPs are being rate limited
- Use `/timed/clear-rate-limit` endpoint if needed

## Next Steps After Verification

1. **If logs show requests are reaching worker**: The issue is likely in processing logic
2. **If logs show no requests**: The issue is before the worker (routing, CORS, rate limiting)
3. **If you see errors in logs**: Check the specific error message and stack trace

## Debugging Commands

### Clear rate limits for a specific IP:
```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/clear-rate-limit?key=YOUR_API_KEY&ip=IP_ADDRESS"
```

### Check alert debug for a ticker:
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/alert-debug?ticker=AAPL"
```

### Check if ticker data exists:
```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/check-ticker?ticker=AAPL"
```

