# Wrangler.toml Variables Configuration

## ✅ Current Status

The `wrangler.toml` file is correctly configured. A dry-run test confirms all environment variables are recognized:

```
env.DISCORD_ENABLE ("true")
env.ALERT_MIN_RR ("1.5")
env.ALERT_MAX_COMPLETION ("0.4")
env.ALERT_MAX_PHASE ("0.6")
env.ALERT_MIN_RANK ("70")
env.OPENAI_MODEL ("gpt-3.5-turbo")
env.CORS_ALLOW_ORIGIN ("*")
env.TV_ACK_ALWAYS_200 ("true")
```

## About the Error

If you're seeing "Invalid environment name" error, it might be:

1. **From Cloudflare Dashboard**: Dashboard validation might be stricter
2. **Solution**: Variables in `wrangler.toml` will be applied on next `wrangler deploy`
3. **No Dashboard needed**: Since variables are in `wrangler.toml`, they persist automatically

## Next Steps

### Option 1: Deploy with Wrangler (Recommended)
```bash
cd worker
wrangler deploy --env production
```

This will apply all variables from `wrangler.toml` automatically.

### Option 2: Keep Dashboard Variables
If you prefer Dashboard, you can keep them there. The `wrangler.toml` serves as a backup.

## Verification

After deploying, verify variables are set:
```bash
cd worker
wrangler deploy --dry-run --env production
# Should show all variables listed under "Environment Variable"
```

## Important Note

- **Variables in `wrangler.toml`**: Applied automatically on deploy
- **Secrets**: Must be set via Dashboard or `wrangler secret put` (not in wrangler.toml)
- **Dashboard vs Wrangler**: Both work, but `wrangler.toml` ensures persistence
