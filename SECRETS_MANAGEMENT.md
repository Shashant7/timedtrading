# Secrets Management Guide

## ⚠️ Important Security Note

**Secrets (API keys, webhooks) are NOT stored in `wrangler.toml`** for security reasons.
They must be set via Cloudflare Dashboard or `wrangler secret put`.

## Current Configuration

### ✅ Stored in `wrangler.toml` (Non-Sensitive Variables)

These are stored locally and persist across deployments:

```toml
[env.production.vars]
DISCORD_ENABLE = "true"
ALERT_MIN_RR = "1.5"
ALERT_MAX_COMPLETION = "0.4"
ALERT_MAX_PHASE = "0.6"
ALERT_MIN_RANK = "70"
OPENAI_MODEL = "gpt-3.5-turbo"
CORS_ALLOW_ORIGIN = "*"
TV_ACK_ALWAYS_200 = "true"
```

### 🔐 Secrets (Must be set via Dashboard or CLI)

These are encrypted and cannot be stored in `wrangler.toml`:

1. **TIMED_API_KEY**: `<your_timed_api_key>`
2. **DISCORD_WEBHOOK_URL**: `<your_discord_webhook_url>`
3. **OPENAI_API_KEY**: `<your_openai_api_key>`

## Restoring Secrets After Loss

If secrets are lost, restore them via:

### Method 1: Cloudflare Dashboard
1. Go to: Workers & Pages → timed-trading-ingest → Settings → Secrets
2. Add each secret individually

### Method 2: Wrangler CLI
```bash
cd worker
wrangler secret put TIMED_API_KEY
# Enter: AwesomeSauce

wrangler secret put DISCORD_WEBHOOK_URL
# Enter: <your_discord_webhook_url>

wrangler secret put OPENAI_API_KEY
# Enter: <your_openai_api_key>
```

## Why This Approach?

1. **Security**: Secrets are encrypted and never exposed in code
2. **Persistence**: Environment variables in `wrangler.toml` persist across deployments
3. **Version Control**: `wrangler.toml` can be committed (no secrets exposed)
4. **Flexibility**: Secrets can be updated without code changes

## Verification

After setting secrets, verify:
```bash
# Test health endpoint
curl "https://timed-trading-ingest.shashant.workers.dev/timed/health"

# Check logs for Discord config
cd worker
wrangler tail timed-trading-ingest
# Look for: [DISCORD CONFIG] messages
```
