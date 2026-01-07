# How to Set CORS_ALLOW_ORIGIN

## Quick Command

```bash
cd worker
wrangler secret put CORS_ALLOW_ORIGIN
```

When prompted, enter your allowed origins (comma-separated, no spaces):
```
https://your-pages-domain.pages.dev,https://your-custom-domain.com
```

## Step-by-Step Instructions

### 1. Navigate to Worker Directory

```bash
cd worker
```

### 2. Set the Secret

```bash
wrangler secret put CORS_ALLOW_ORIGIN
```

### 3. Enter Your Origins

When prompted, enter your allowed origins. You can specify multiple origins separated by commas (no spaces):

**Example for Cloudflare Pages:**
```
https://timed-trading.pages.dev
```

**Example for Multiple Domains:**
```
https://timed-trading.pages.dev,https://timedtrading.com,https://www.timedtrading.com
```

**Example for Local Development (optional):**
```
https://timed-trading.pages.dev,http://localhost:3000,http://127.0.0.1:3000
```

### 4. Verify It's Set

```bash
wrangler secret list
```

You should see `CORS_ALLOW_ORIGIN` in the list.

## Important Notes

- **No spaces** in the comma-separated list
- **Include protocol** (`https://` or `http://`)
- **Include port** if not standard (e.g., `:3000` for local dev)
- **Case-sensitive** - URLs are case-sensitive

## Common Examples

### Single Domain (Production)
```
https://timed-trading.pages.dev
```

### Multiple Domains
```
https://timed-trading.pages.dev,https://timedtrading.com
```

### With Local Development
```
https://timed-trading.pages.dev,http://localhost:3000
```

### All Subdomains (if needed)
You'll need to list each subdomain explicitly:
```
https://timed-trading.pages.dev,https://www.timedtrading.com,https://app.timedtrading.com
```

## Updating the Value

To update the value, just run the same command again:

```bash
wrangler secret put CORS_ALLOW_ORIGIN
```

Enter the new value when prompted.

## Removing the Secret

If you want to remove it (will default to `"*"` - allows all origins):

```bash
wrangler secret delete CORS_ALLOW_ORIGIN
```

## Testing After Setting

After setting the secret and deploying, test it:

```bash
# Test from allowed origin
curl -H "Origin: https://your-pages-domain.pages.dev" \
  https://timed-trading-ingest.shashant.workers.dev/timed/health

# Should return: Access-Control-Allow-Origin: https://your-pages-domain.pages.dev

# Test from unauthorized origin
curl -H "Origin: https://evil-site.com" \
  https://timed-trading-ingest.shashant.workers.dev/timed/health

# Should return: Access-Control-Allow-Origin: null (blocked)
```

## Troubleshooting

### If CORS still allows all origins:
1. Make sure you deployed after setting the secret: `wrangler deploy`
2. Check the secret is set: `wrangler secret list`
3. Verify the format (no spaces, includes protocol)

### If your UI can't access the API:
1. Check the exact origin your UI is using (check browser console)
2. Make sure it matches exactly (including protocol, domain, port)
3. Add it to the CORS_ALLOW_ORIGIN list

### If you need to allow all origins temporarily:
```bash
wrangler secret delete CORS_ALLOW_ORIGIN
```
This will default back to `"*"` (allows all origins).

