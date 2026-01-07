# Security Fixes Deployment Guide

## Changes Made

### 1. CORS Restriction
- Updated `corsHeaders()` to accept `req` parameter
- Now checks `CORS_ALLOW_ORIGIN` environment variable (comma-separated list)
- Only allows requests from configured origins
- Falls back to `"*"` if no origins configured (backward compatible)

### 2. Rate Limiting
- Added `checkRateLimit()` function
- Applied to all GET endpoints:
  - `/timed/all`: 100 requests/hour
  - `/timed/latest`: 200 requests/hour
  - `/timed/tickers`: 200 requests/hour
  - `/timed/trail`: 200 requests/hour
  - `/timed/top`: 200 requests/hour
  - `/timed/momentum`: 200 requests/hour
  - `/timed/momentum/history`: 200 requests/hour
  - `/timed/momentum/all`: 100 requests/hour
  - `/timed/health`: 60 requests/hour
  - `/timed/version`: 60 requests/hour
  - `/timed/alert-debug`: 100 requests/hour
  - `/timed/trades`: 200 requests/hour

### 3. Updated All Endpoints
- All `corsHeaders(env)` calls updated to `corsHeaders(env, req)`
- All `ackJSON()` calls updated to pass `req` parameter

## Deployment Steps

### Step 1: Set CORS Environment Variable

```bash
cd worker
wrangler secret put CORS_ALLOW_ORIGIN
```

When prompted, enter your allowed origins (comma-separated):
```
https://your-pages-domain.pages.dev,https://your-custom-domain.com
```

**Example:**
```
https://timed-trading.pages.dev,https://timedtrading.com
```

**Note:** If you don't set this, CORS will default to `"*"` (allows all origins) for backward compatibility.

### Step 2: Deploy Worker

```bash
cd worker
wrangler deploy
```

### Step 3: Verify Deployment

Test the API from your domain:
```bash
curl -H "Origin: https://your-pages-domain.pages.dev" \
  https://timed-trading-ingest.shashant.workers.dev/timed/health
```

You should see:
- `Access-Control-Allow-Origin: https://your-pages-domain.pages.dev` in response headers

Test from unauthorized domain:
```bash
curl -H "Origin: https://evil-site.com" \
  https://timed-trading-ingest.shashant.workers.dev/timed/health
```

You should see:
- `Access-Control-Allow-Origin: null` in response headers (blocked)

### Step 4: Test Rate Limiting

Make 101 requests quickly:
```bash
for i in {1..101}; do
  curl https://timed-trading-ingest.shashant.workers.dev/timed/health
done
```

After 100 requests, you should see:
```json
{
  "ok": false,
  "error": "rate_limit_exceeded",
  "retryAfter": 3600
}
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ALLOW_ORIGIN` | No | `"*"` | Comma-separated list of allowed origins |
| `TIMED_API_KEY` | Yes | - | API key for write endpoints |

### Rate Limits

Rate limits are per IP address, per endpoint, per hour. Limits are stored in KV with 1-hour TTL.

## Rollback

If you need to rollback:

1. **Remove CORS restriction:**
   ```bash
   wrangler secret delete CORS_ALLOW_ORIGIN
   ```
   This will default back to `"*"` (allows all origins).

2. **Rate limiting:** Cannot be easily disabled without code changes. If needed, you can increase limits in code.

## Testing Checklist

- [ ] CORS works from your domain
- [ ] CORS blocks unauthorized domains
- [ ] Rate limiting works (test with 100+ requests)
- [ ] UI still loads correctly
- [ ] All API endpoints respond correctly
- [ ] TradingView webhooks still work (POST /timed/ingest)

## Security Improvements

### Before:
- ❌ CORS allowed any origin
- ❌ No rate limiting
- ❌ API could be abused

### After:
- ✅ CORS restricted to your domain(s)
- ✅ Rate limiting prevents abuse
- ✅ Better protection against scraping

## Next Steps (Optional)

For even better security:
1. Add authentication for read endpoints
2. Implement IP whitelisting
3. Add request logging/monitoring
4. Consider Cloudflare Access for additional protection

