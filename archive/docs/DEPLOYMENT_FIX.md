# Fixing Wrangler Deployment Issues

## Problem
- Wrangler deployments lose bindings configured in Dashboard
- Dashboard shows stale code (old version)
- Bindings need to be re-added manually after each deployment

## Root Cause
- Bindings configured in Dashboard are NOT included in wrangler deployments
- Dashboard code editor shows cached/stale code
- Need to configure bindings in `wrangler.toml` for persistence

## Solution: Configure Bindings in wrangler.toml

### Step 1: Get KV Namespace ID

1. Go to Cloudflare Dashboard:
   https://dash.cloudflare.com

2. Navigate to:
   Workers & Pages -> KV

3. Find your namespace:
   - Look for "TIMED_TRADING_KV" or similar
   - Click on it

4. Copy the Namespace ID:
   - It looks like: `abc123def456...` (long alphanumeric string)
   - This is the ID you need

### Step 2: Update wrangler.toml

Uncomment and update the KV namespace binding section:

```toml
[env.production]
name = "timed-trading-ingest"

# KV Namespace binding for production
[[env.production.kv_namespaces]]
binding = "KV_TIMED"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with actual ID from Dashboard
```

### Step 3: Deploy with Wrangler

```bash
cd worker
wrangler deploy --env production
```

This will:
- ✅ Deploy the latest code (all 11000+ lines)
- ✅ Include KV bindings from wrangler.toml
- ✅ Preserve bindings across future deployments

## Important Notes

1. **Always deploy via wrangler** (not Dashboard):
   - Dashboard deployments can overwrite bindings
   - Dashboard code editor shows stale code
   - Wrangler ensures consistency

2. **Bindings in wrangler.toml persist**:
   - They're part of the deployment
   - Won't be lost on future deployments
   - Can be version controlled

3. **Dashboard bindings are separate**:
   - Only used if not in wrangler.toml
   - Can be overwritten by wrangler deployments
   - Not recommended for production

## Verification

After deploying, verify bindings:

```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/trades"
```

Should return `{"ok": true, ...}` not `kv_not_configured`

