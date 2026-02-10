# Security Fixes: Quick Implementation

## Critical Issues Found

1. **CORS is wide open** - Allows any website to access your API
2. **All data is public** - No authentication for read endpoints
3. **No rate limiting** - API can be abused
4. **Worker URL exposed** - Visible in page source

## Quick Fixes (Implement Now)

### Fix 1: Restrict CORS

Update `worker/index.js`:

```javascript
function corsHeaders(env, req) {
  // Get allowed origins from environment variable (comma-separated)
  const allowedOrigins = (env.CORS_ALLOW_ORIGIN || "").split(",").filter(Boolean);
  const origin = req?.headers?.get("Origin") || "";
  
  // If no allowed origins configured, default to "*" (backward compatible)
  // Otherwise, only allow configured origins
  const allowed = allowedOrigins.length === 0 
    ? "*" 
    : allowedOrigins.includes(origin) 
      ? origin 
      : "null";
  
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
```

Then update all `corsHeaders(env)` calls to `corsHeaders(env, req)`.

Set environment variable:
```bash
wrangler secret put CORS_ALLOW_ORIGIN
# Enter: https://your-pages-domain.pages.dev,https://your-custom-domain.com
```

### Fix 2: Add Basic Rate Limiting

Add to `worker/index.js`:

```javascript
async function checkRateLimit(KV, identifier, endpoint, limit = 100, window = 3600) {
  const key = `ratelimit:${identifier}:${endpoint}`;
  const count = await KV.get(key);
  const current = count ? Number(count) : 0;
  
  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }
  
  await KV.put(key, String(current + 1), { expirationTtl: window });
  return { allowed: true, remaining: limit - current - 1 };
}
```

Use in GET endpoints:
```javascript
// GET /timed/all
if (url.pathname === "/timed/all" && req.method === "GET") {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimit = await checkRateLimit(KV, ip, "/timed/all", 100, 3600);
  
  if (!rateLimit.allowed) {
    return sendJSON(
      { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
      429,
      corsHeaders(env, req)
    );
  }
  
  // ... rest of endpoint logic
}
```

### Fix 3: Optional - Add Read-Only API Key

For additional security, require a read-only key for GET endpoints:

```javascript
function requireReadKeyOr401(req, env) {
  const expected = env.READ_ONLY_API_KEY; // Different from TIMED_API_KEY
  if (!expected) return null; // Optional, can be disabled
  
  const url = new URL(req.url);
  const qKey = url.searchParams.get("key");
  if (qKey && qKey === expected) return null;
  
  return sendJSON({ ok: false, error: "unauthorized" }, 401, corsHeaders(env, req));
}
```

## What This Fixes

### Before Fixes:
- ❌ Anyone can access your API from any website
- ❌ No protection against abuse
- ❌ All data is publicly accessible
- ❌ Can be scraped easily

### After Fixes:
- ✅ Only your domain(s) can access the API
- ✅ Rate limiting prevents abuse
- ✅ Still public data, but harder to abuse
- ⚠️ Data is still accessible if someone has the URL (but harder to scrape)

## Is It Safe to Share Now?

### Sharing UI URL: ✅ **Safer**
- Users can see the dashboard
- CORS prevents other sites from accessing your API
- Rate limiting prevents abuse
- Still can inspect source, but harder to abuse

### Sharing API URL Directly: ⚠️ **Still Risky**
- If someone has the direct API URL, they can still access data
- But CORS + rate limiting makes it harder
- For true security, add authentication

## Next Steps

1. **Implement Fix 1** (CORS) - 5 minutes
2. **Implement Fix 2** (Rate Limiting) - 10 minutes
3. **Deploy worker** - 2 minutes
4. **Test** - 5 minutes

**Total time: ~20 minutes**

## For Production (Future)

- Add user authentication
- Implement proper access control
- Add monitoring and alerts
- Consider API keys per user

