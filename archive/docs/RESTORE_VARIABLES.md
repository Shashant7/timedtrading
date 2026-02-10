# Restoring Cloudflare Worker Variables & Secrets

## Required Variables & Secrets

### 🔐 Secrets (Set via `wrangler secret put` or Dashboard)

These are sensitive values that should be stored as secrets:

1. **TIMED_API_KEY** (Required)
   - Purpose: Authentication key for `/timed/ingest` endpoint
   - Used in: API key validation for TradingView webhooks
   - Example: `AwesomeSauce` (or your custom key)

2. **DISCORD_WEBHOOK_URL** (Optional but Recommended)
   - Purpose: Discord webhook URL for trade alerts
   - Used in: Discord notification function
   - Format: `https://discord.com/api/webhooks/...`

3. **OPENAI_API_KEY** (Optional)
   - Purpose: OpenAI API key for AI Assistant features
   - Used in: AI chat, market updates, pattern recognition
   - Format: `sk-...`

### ⚙️ Environment Variables (Set via Dashboard or `wrangler.toml`)

These can be set as plain environment variables:

1. **DISCORD_ENABLE** (Optional)
   - Purpose: Enable/disable Discord alerts
   - Values: `"true"` or `"false"` (string, not boolean)
   - Default: `"false"`

2. **ALERT_MIN_RR** (Optional)
   - Purpose: Minimum Risk/Reward ratio for alerts
   - Default: `"1.5"`
   - Recommended: `"1.5"` (based on Self-Learning: 78.9% win rate)

3. **ALERT_MAX_COMPLETION** (Optional)
   - Purpose: Maximum completion % for alerts
   - Default: `"0.4"`
   - Recommended: `"0.4"` (40%)

4. **ALERT_MAX_PHASE** (Optional)
   - Purpose: Maximum phase % for alerts
   - Default: `"0.6"`
   - Recommended: `"0.6"` (60%)

5. **ALERT_MIN_RANK** (Optional)
   - Purpose: Minimum rank score for alerts
   - Default: `"70"`
   - **Recommended: `"70"`** (based on Self-Learning: Rank ≥ 70 aligns with trade simulation)
   - **Optimal: `"74"`** (based on Self-Learning: 100% win rate)

6. **OPENAI_MODEL** (Optional)
   - Purpose: OpenAI model to use
   - Default: `"gpt-3.5-turbo"`
   - Options: `"gpt-3.5-turbo"`, `"gpt-4"`, etc.

7. **CORS_ALLOW_ORIGIN** (Optional)
   - Purpose: CORS origin whitelist
   - Default: `"*"`
   - Recommended: `"*"` or specific domain

8. **TV_ACK_ALWAYS_200** (Optional)
   - Purpose: Always return 200 for TradingView
   - Default: `"true"`
   - Recommended: `"true"`

## How to Restore

### Method 1: Cloudflare Dashboard (Easiest)

1. Go to: https://dash.cloudflare.com
2. Navigate to: **Workers & Pages** → **timed-trading-ingest**
3. Click: **Settings** → **Variables**
4. Add each variable:
   - Click **"Add variable"**
   - Enter name and value
   - Click **"Save"**

5. For Secrets:
   - Click **Settings** → **Secrets**
   - Click **"Add secret"**
   - Enter name and value
   - Click **"Save"**

### Method 2: Wrangler CLI (Recommended for Secrets)

```bash
cd worker

# Set secrets (these are encrypted)
wrangler secret put TIMED_API_KEY
# Enter your API key when prompted

wrangler secret put DISCORD_WEBHOOK_URL
# Enter your Discord webhook URL when prompted

wrangler secret put OPENAI_API_KEY
# Enter your OpenAI API key when prompted

# Set environment variables (add to wrangler.toml or use Dashboard)
# Note: wrangler.toml doesn't support secrets, only variables
```

### Method 3: Bulk Restore Script

Create a script to restore all variables at once (for non-secrets only):

```bash
# Note: This only works for environment variables, not secrets
# Secrets must be set via Dashboard or `wrangler secret put`
```

## Quick Restore Checklist

### Critical (Required for Basic Functionality)
- [ ] **TIMED_API_KEY** (Secret) - Required for ingestion
- [ ] **DISCORD_ENABLE** (Variable) - Set to `"true"` if using Discord
- [ ] **DISCORD_WEBHOOK_URL** (Secret) - Required if DISCORD_ENABLE=true

### Recommended (For Full Functionality)
- [ ] **ALERT_MIN_RANK** (Variable) - Set to `"70"` (or `"74"` for optimal)
- [ ] **ALERT_MIN_RR** (Variable) - Set to `"1.5"`
- [ ] **ALERT_MAX_COMPLETION** (Variable) - Set to `"0.4"`
- [ ] **ALERT_MAX_PHASE** (Variable) - Set to `"0.6"`

### Optional (For AI Features)
- [ ] **OPENAI_API_KEY** (Secret) - For AI Assistant
- [ ] **OPENAI_MODEL** (Variable) - Set to `"gpt-3.5-turbo"` or `"gpt-4"`

## Verification

After restoring, verify configuration:

```bash
# Test ingestion endpoint (should work if TIMED_API_KEY is set)
curl "https://timed-trading-ingest.shashant.workers.dev/timed/health"

# Check if Discord is configured (check logs)
cd worker
wrangler tail timed-trading-ingest
# Look for: [DISCORD CONFIG] messages
```

## Important Notes

1. **Secrets vs Variables**: 
   - Secrets are encrypted and can't be viewed after setting
   - Variables are plain text and visible in Dashboard
   - Use Secrets for sensitive data (API keys, webhooks)
   - Use Variables for configuration (thresholds, flags)

2. **String Values**: 
   - All values are strings in Cloudflare Workers
   - Use `"true"` not `true` for boolean flags
   - Use `"70"` not `70` for numbers

3. **Deployment**: 
   - Variables/Secrets persist across deployments
   - Changes take effect immediately (no redeploy needed)
   - But you may need to wait a few seconds for propagation

## Current Recommended Values (Based on Self-Learning)

Based on the Self-Learning Module analysis showing 78.9% win rate:

```
ALERT_MIN_RANK=70        # Minimum (matches trade simulation)
# OR
ALERT_MIN_RANK=74        # Optimal (100% win rate range)

ALERT_MIN_RR=1.5
ALERT_MAX_COMPLETION=0.4
ALERT_MAX_PHASE=0.6
DISCORD_ENABLE=true
```
