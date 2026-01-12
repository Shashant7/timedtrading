# Installing Wrangler CLI

## Quick Install

### Using npm (if Node.js is installed):
```bash
npm install -g wrangler
```

### Using Homebrew (macOS):
```bash
brew install cloudflare-wrangler
```

### Using cargo (Rust):
```bash
cargo install wrangler
```

### Direct Download:
Visit: https://github.com/cloudflare/workers-sdk/releases

## After Installation

1. **Authenticate**:
   ```bash
   wrangler login
   ```
   This will open your browser to authenticate with Cloudflare.

2. **Verify installation**:
   ```bash
   wrangler --version
   ```

3. **Fetch logs**:
   ```bash
   cd worker
   wrangler tail timed-trading-ingest --format pretty > ../logs.txt
   ```

4. **Analyze logs**:
   ```bash
   cd ..
   node scripts/analyze-logs.js logs.txt
   ```

## Troubleshooting

If `npm` is not found:
- Install Node.js from https://nodejs.org/
- Or use Homebrew: `brew install node`
- Or use nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`

If authentication fails:
- Make sure you're logged into Cloudflare dashboard
- Check that you have access to the Workers account
- Try: `wrangler logout` then `wrangler login` again
