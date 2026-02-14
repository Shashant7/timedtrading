# Timed Trading -- Runbook

> Single reference document for product context, technical architecture, third-party integrations, and day-to-day maintenance.

---

## Part 1 -- Product

### A. Product Overview

Timed Trading is a **multi-timeframe scoring and Kanban trade-management platform** for US equities, ETFs, crypto, and futures.

The system continuously scores **200+ tickers across 9 timeframes** (Monthly, Weekly, Daily, 4H, 1H, 30m, 10m, 5m, 1m) and moves each ticker through a Kanban pipeline:

**Watch --> Setup --> Enter --> Hold --> Trim / Defend --> Exit**

It operates in two modes:

| Mode | Description |
|------|-------------|
| **Active Trader** | Automated entries/exits based on scoring signals. Kanban board, real-time cards, trade simulation. |
| **Investor** | Accumulation zones, DCA automation, portfolio rebalancing, relative-strength analysis. |

Supporting tools include a Screener, Model Dashboard (ML pattern recognition), Daily Briefs (AI-powered morning/evening summaries), and Trade Tracker (historical P&L, win rate, Sharpe).

### B. Hypothesis and How We Measure

**Core hypothesis:** Systematic, multi-timeframe technical scoring -- combined with automated entry/exit rules and risk management -- can consistently identify tradeable setups with a positive expectation.

**How we measure:**

| Metric | Target | Where to Check |
|--------|--------|----------------|
| Win rate | >55% | Simulation Dashboard --> Stats |
| Average P&L per trade | >0.5% | Simulation Dashboard --> Stats |
| Max drawdown | <-8% per position | Trade Tracker --> Worst trades |
| User retention (30-day) | >70% | Admin Clients page --> Active >30d |
| Scoring accuracy | Kanban stage predicts 5-day direction >60% | Model Dashboard --> Retrospective |
| Daily Brief usefulness | Users open brief >3x/week | Future: brief open tracking |

### C. Goals

**Phase 1 -- Validation (now):**
- Onboard first 10 paying users
- Validate $60/month price point (first month free trial)
- Achieve 70%+ 30-day retention
- Collect qualitative feedback on signal quality

**Phase 2 -- Growth (Q2 2026):**
- 50 active users
- Refine scoring model using ML retrospective data
- Add broker integration (Alpaca live trading)
- Social sharing / referral program

**Phase 3 -- Scale (Q3-Q4 2026):**
- 200+ users
- Options flow / sentiment data integration
- Mobile-optimized experience
- Premium tier differentiation

### D. Product Architecture

**User flow:**

```
Splash Page --> CF Access SSO (Google) --> Terms Acceptance --> Dashboard
```

**Pages:**

| Page | URL | Access |
|------|-----|--------|
| Splash / Landing | `/splash.html` | Public |
| Active Trader Dashboard | `/index-react.html` | Pro+ |
| Investor Dashboard | `/investor-dashboard.html` | Pro+ |
| Screener | `/screener.html` | Pro+ |
| Model Dashboard | `/model-dashboard.html` | Pro+ |
| Trade Tracker | `/simulation-dashboard.html` | Pro+ |
| Daily Brief | `/daily-brief.html` | Pro+ |
| Ticker Management | `/ticker-management.html` | Admin |
| Admin Clients | `/admin-clients.html` | Admin |
| Debug Dashboard | `/debug-dashboard.html` | Admin |
| Brand Kit | `/brand-kit.html` | Admin |
| Terms of Use | `/terms.html` | Public |

---

## Part 2 -- Technology

### A. Technical Overview

The entire stack runs on **Cloudflare's edge network** with zero traditional servers:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Cloudflare Pages | Static HTML/JS/CSS served globally |
| **Auth** | Cloudflare Access | Google SSO via Zero Trust, JWT cookies |
| **API** | Cloudflare Worker | Single worker handles all HTTP routes + cron jobs |
| **Hot Cache** | Workers KV | Sub-ms reads for price snapshots, scoring data, trades |
| **Database** | D1 (SQLite) | Ledger of truth: trades, positions, candles, users |
| **Real-time** | Durable Objects | WebSocket push for live prices and scoring updates |
| **Cron** | Worker Triggers | 3 schedules: every 1m, every 5m, top of hour |

**Key files:**

| File | Lines | Purpose |
|------|-------|---------|
| `worker/index.js` | ~36,000 | Main worker: HTTP routes, cron handlers, trade logic |
| `worker/api.js` | ~500 | Auth, CORS, rate limiting, CF Access JWT |
| `worker/indicators.js` | ~2,800 | Technical indicators, Alpaca API, server-side scoring |
| `worker/trading.js` | ~200 | Kanban stage definitions, trade rules |
| `worker/alerts.js` | ~450 | Discord webhook notifications |
| `worker/daily-brief.js` | ~1,400 | AI-powered daily briefs, Finnhub integration |
| `worker/investor.js` | ~400 | Investor scoring, DCA, rebalancing |
| `worker/model.js` | ~700 | ML pattern recognition, predictions |
| `worker/price-hub.js` | ~150 | Durable Object: WebSocket price/scoring push |
| `worker/execution.js` | ~250 | Trade execution adapter (D1 ledger writes) |
| `worker/storage.js` | ~400 | KV/D1 helpers, trail writes |
| `react-app/auth-gate.js` | ~1,660 | Shared auth wrapper, paywall, terms gate, push registration |
| `react-app/shared-price-utils.js` | ~210 | Daily change calculation (shared across all pages) |

### B. Technical Architecture

```
                          +-------------------+
                          |   Cloudflare CDN   |
                          |   (Pages + Access) |
                          +---------+---------+
                                    |
                          +---------v---------+
                          |  Browser (React)   |
                          |  index-react.html  |
                          |  + 12 other pages  |
                          +---------+---------+
                                    |
                     HTTP / WebSocket (CF Access JWT)
                                    |
                          +---------v---------+
                          |  Cloudflare Worker |
                          | timed-trading-     |
                          | ingest             |
                          +---------+---------+
                           /    |    |    \
                          /     |    |     \
                   +-----+  +--+--+ +--+--+ +-------+
                   | KV  |  | D1  | | DO  | | Crons |
                   +-----+  +-----+ +-----+ +-------+
                     |         |       |         |
              Prices,    Trades,  WebSocket   3 schedules:
              Latest,    Candles, (PriceHub)  */1, */5, 0 *
              Trades     Users,
                         Positions

              External APIs:
              +---------+  +---------+  +---------+
              | Alpaca  |  | OpenAI  |  | Discord |
              | (price) |  | (AI)    |  | (alert) |
              +---------+  +---------+  +---------+
              +---------+  +---------+
              | Stripe  |  | Finnhub |
              | (billing)|  | (econ)  |
              +---------+  +---------+
```

**Cron schedule:**

| Schedule | Runs | What Happens |
|----------|------|-------------|
| `*/1 * * * *` | Every minute | Alpaca price feed, 1m bar ingestion, SL/TP checks, WebSocket push, D1 sync |
| `*/5 * * * *` | Every 5 min | Full scoring loop (all tickers, 7 TFs), trade entry/exit evaluation, kanban updates, AI updates (3x daily), investor tasks |
| `0 * * * *` | Top of hour | Daily briefs (9 AM / 5 PM ET), ETF sync (7 AM ET), data lifecycle (4 AM UTC), ML prediction resolution |

**KV namespaces (key patterns):**

| Key | Purpose | Updated By |
|-----|---------|-----------|
| `timed:prices` | All-ticker price snapshot | Price feed cron (*/1) |
| `timed:latest:{TICKER}` | Scoring snapshot per ticker | Scoring cron (*/5) |
| `timed:all:snapshot` | Pre-assembled dashboard payload | Scoring cron (*/5) |
| `timed:trades:all` | Trade list (open + closed) | Trade simulation |
| `timed:tickers` | Active ticker list | Watchlist add/remove |
| `timed:removed` | Removed ticker blocklist | Watchlist remove |
| `timed:cache:daily_prev_close` | Prev close cache (48h TTL) | Price feed cron |
| `timed:heartbeat:{TICKER}` | TradingView price (futures) | TV webhook |

**D1 tables:**

| Table | Purpose |
|-------|---------|
| `users` | User accounts, tiers, Stripe IDs, login tracking |
| `ticker_candles` | Multi-TF OHLCV candles (1m through Monthly) |
| `ticker_latest` | Cached scoring snapshots |
| `ticker_index` | Ticker metadata |
| `timed_trail` | 7-day historical scoring trail |
| `trades` | Trade ledger (entry, exit, P&L) |
| `trade_events` | Execution events (ENTRY/TRIM/EXIT) |
| `positions` | Open position tracking |
| `lots` | Lot-based cost accounting |
| `execution_actions` | Execution action log |
| `account_ledger` | Cash balance + realized P&L |
| `push_subscriptions` | Web push subscription endpoints |
| `user_notifications` | In-app notification queue |
| `terms_acceptance` | Terms acceptance audit trail |

### C. Third-Party Overview and Details

#### Alpaca Markets

| Item | Detail |
|------|--------|
| **Purpose** | Real-time price snapshots, historical bar data (1m-Monthly), asset enrichment |
| **Plan** | Algo Trader+ (paid) -- gives SIP feed access |
| **Base URL** | `https://paper-api.alpaca.markets` (paper) / `https://api.alpaca.markets` (live) |
| **Data URL** | `https://data.alpaca.markets` |
| **Key endpoints** | `/v2/stocks/snapshots`, `/v2/stocks/bars`, `/v2/assets/{sym}`, `/v1beta3/crypto/us/bars` |
| **Rate limits** | 200 req/min (data), subject to plan |
| **Secrets** | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` |
| **Symbol quirks** | BRK-B --> BRK.B; futures/indices not supported; crypto uses separate endpoint |
| **Config** | `ALPACA_ENABLED=true`, `ALPACA_BASE_URL` in wrangler.toml |

#### Stripe

| Item | Detail |
|------|--------|
| **Purpose** | Subscription billing ($60/month, 30-day free trial) |
| **Dashboard** | [dashboard.stripe.com](https://dashboard.stripe.com) |
| **Webhook events** | `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` |
| **Worker endpoints** | `POST /timed/stripe/create-checkout`, `POST /timed/stripe/webhook`, `POST /timed/stripe/portal`, `GET /timed/subscription` |
| **Secrets** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` |
| **Manual override** | Admin Clients page --> "Set Pro" (sets `tier=pro`, `subscription_status=manual`) |
| **CF Access bypass** | `/timed/stripe/webhook` must bypass CF Access (no JWT on webhook calls) |

#### OpenAI

| Item | Detail |
|------|--------|
| **Purpose** | AI market analysis, daily briefs, proactive alerts |
| **Model** | `gpt-3.5-turbo` (configurable via `OPENAI_MODEL` env var) |
| **Schedule** | 3x daily: 9:45 AM, 12:00 PM, 3:30 PM ET |
| **Secrets** | `OPENAI_API_KEY` |
| **Usage** | ~3-5 calls/day; low cost |

#### Discord

| Item | Detail |
|------|--------|
| **Purpose** | Trade alerts (entry/exit/trim), kanban transitions, system notifications |
| **Secrets** | `DISCORD_WEBHOOK_URL` |
| **Config** | `DISCORD_ENABLE=true` in wrangler.toml |
| **Deduplication** | Daily dedupe keys prevent duplicate alerts |

#### Finnhub

| Item | Detail |
|------|--------|
| **Purpose** | Earnings calendar and economic calendar for Daily Briefs |
| **Rate limits** | Free tier: 60 calls/min |
| **Secrets** | `FINNHUB_API_KEY` |
| **Usage** | 2 calls/day (morning brief) |

#### Cloudflare Access (Zero Trust)

| Item | Detail |
|------|--------|
| **Purpose** | User authentication via Google SSO |
| **Team domain** | `timedtrading.cloudflareaccess.com` |
| **JWKS URL** | `https://timedtrading.cloudflareaccess.com/cdn-cgi/access/certs` |
| **Config** | `CF_ACCESS_TEAM_DOMAIN=timedtrading` in wrangler.toml; `CF_ACCESS_AUD` as secret |
| **Bypass rules** | Ingest endpoints, Stripe webhook, health check |
| **Auto-provision** | First login creates user in D1 with `tier=free`, `role=member` |
| **Admin auto-promote** | `ADMIN_EMAIL=shashant@gmail.com` auto-promoted to admin |

---

## Part 3 -- How to Maintain the System

### A. Cloudflare

#### Deploying

```bash
# Full deploy (build right rail + embed dashboard + deploy to production)
npm run deploy

# Also deploy to default env (both run the same crons)
cd worker && npx wrangler deploy

# Deploy only the worker (skip right-rail build)
npm run deploy:worker
```

Both `production` and the default environment must be deployed -- crons can fire from either.

#### Checking Logs

```bash
# Tail real-time logs (production)
cd worker && npx wrangler tail --env production

# Tail default env
cd worker && npx wrangler tail
```

Look for `[PRICE FEED]`, `[SCORING]`, `[TRADE]`, `[ENTRY]`, `[EXIT]`, `[TRIM]` prefixes.

#### Managing KV

```bash
# List keys
npx wrangler kv:key list --namespace-id=e48593af3ef74bf986b2592909ed40cb

# Read a key
npx wrangler kv:key get "timed:prices" --namespace-id=e48593af3ef74bf986b2592909ed40cb

# Delete a key
npx wrangler kv:key delete "timed:removed" --namespace-id=e48593af3ef74bf986b2592909ed40cb
```

Or use the Cloudflare Dashboard: Workers & Pages --> KV --> `TIMED_TRADING_KV`.

#### Managing D1

```bash
# Run a query
npx wrangler d1 execute timed-trading-ledger --command "SELECT COUNT(*) FROM users"

# Export data
npx wrangler d1 export timed-trading-ledger --output=backup.sql

# Run migrations
npx wrangler d1 execute timed-trading-ledger --file=worker/d1-schema.sql
```

Or use the Dashboard: Workers & Pages --> D1 --> `timed-trading-ledger` --> Console.

#### Managing Secrets

```bash
# Set a secret (both envs)
npx wrangler secret put SECRET_NAME --env production
npx wrangler secret put SECRET_NAME

# List secrets
npx wrangler secret list --env production
```

Secrets: `TIMED_API_KEY`, `DISCORD_WEBHOOK_URL`, `OPENAI_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `CF_ACCESS_AUD`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`.

#### Cron Monitoring

Check that crons are firing:
1. Dashboard --> Workers & Pages --> `timed-trading-ingest` --> Triggers tab
2. Tail logs and look for `[PRICE FEED]` (every 1m) and `[SCORING]` (every 5m)
3. `GET /timed/debug/staleness` -- returns tickers with stale data (>2h old)
4. Discord channel -- trade alerts indicate the system is processing

#### Pages Deployment

Static files deploy automatically when you push to `main`:
- GitHub repo --> Cloudflare Pages auto-build
- No build command needed (static HTML/JS/CSS served as-is)
- Custom domain: `timed-trading.com` routes to Pages; `/timed/*` routes to Worker

### B. Stripe

#### Checking Webhook Health

1. [Stripe Dashboard](https://dashboard.stripe.com) --> Developers --> Webhooks
2. Verify the endpoint URL points to `https://timed-trading.com/timed/stripe/webhook`
3. Check for failed deliveries and re-send if needed
4. Events to monitor: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

#### Customer Portal

Users with an active subscription see a "My Account" button that opens the Stripe Customer Portal (manage payment, cancel subscription).

#### Manual Tier Overrides

Use the Admin Clients page (`/admin-clients.html`):
- **Set Pro**: Sets `tier=pro`, `subscription_status=manual` (no Stripe charge)
- **Set Member**: Revokes to `tier=free`, `subscription_status=none`
- **Set Admin**: Sets `tier=admin`, `subscription_status=manual`

These overrides bypass Stripe entirely. The `*` marker in the admin table indicates manual upgrades.

### C. Alpaca

#### API Key Management

Keys are stored as Worker secrets. To rotate:
```bash
npx wrangler secret put ALPACA_API_KEY_ID --env production
npx wrangler secret put ALPACA_API_SECRET_KEY --env production
# Repeat for default env
```

#### Paper vs Live

Currently on paper trading (`ALPACA_BASE_URL=https://paper-api.alpaca.markets`). To switch to live:
1. Update `ALPACA_BASE_URL` in `wrangler.toml` (both top-level and `[env.production.vars]`)
2. Use live API keys from Alpaca dashboard
3. Deploy both environments

#### Symbol Coverage

- **Stocks/ETFs**: All ~200+ symbols in `SECTOR_MAP` (worker `index.js` and `worker/sector-mapping.js`)
- **Crypto**: BTC/USD, ETH/USD via separate `/v1beta3/crypto/us/bars` endpoint
- **Futures**: Not available via Alpaca -- sourced from TradingView webhooks (ES1!, NQ1!, GC1!, SI1!)
- **Adding tickers**: Use Ticker Management page or `POST /timed/watchlist/add`

### D. Other

#### Discord

- Webhook URL is a secret. To get a new one: Discord Server --> Channel Settings --> Integrations --> Webhooks --> Copy URL
- Set via `npx wrangler secret put DISCORD_WEBHOOK_URL`
- Toggle on/off via `DISCORD_ENABLE` env var in `wrangler.toml`

#### OpenAI

- Model configurable via `OPENAI_MODEL` env var (default: `gpt-3.5-turbo`)
- To use GPT-4o: update the env var in `wrangler.toml` and redeploy
- Key rotation: `npx wrangler secret put OPENAI_API_KEY`

#### Finnhub

- Free tier has 60 calls/min limit -- currently uses only ~2 calls/day
- Key rotation: `npx wrangler secret put FINNHUB_API_KEY`

#### Domain / DNS

- Custom domain: `timed-trading.com`
- DNS managed via Cloudflare
- Worker route: `/timed/*` --> `timed-trading-ingest` worker
- All other routes: Cloudflare Pages (static files)
- WebSocket: `wss://timed-trading-ingest.shashant.workers.dev/timed/ws` (bypasses CF Access)

---

## Appendix -- VAPID Setup for Browser Push Notifications

> **Status**: The service worker, subscription storage, and frontend registration are all implemented. The missing piece is generating VAPID keys and implementing push sending.

### Step 1: Generate VAPID Key Pair

Run this on your local machine (one-time):

```bash
npx web-push generate-vapid-keys
```

Output:
```
=======================================
Public Key:  BPxyz...long-base64url-string...
Private Key: abc...shorter-base64url-string...
=======================================
```

Save both keys securely.

### Step 2: Store Secrets on the Worker

```bash
cd worker

# Private key (both envs)
npx wrangler secret put VAPID_PRIVATE_KEY --env production
# Paste the private key when prompted
npx wrangler secret put VAPID_PRIVATE_KEY

# Subject identifier (both envs)
npx wrangler secret put VAPID_SUBJECT --env production
# Paste: mailto:legal@timed-trading.com
npx wrangler secret put VAPID_SUBJECT
```

### Step 3: Set the Public Key in the Frontend

Add this line to `react-app/auth-gate.js` near the top of the IIFE (before `registerPushNotifications`):

```javascript
window.__TIMED_VAPID_PUBLIC_KEY = "BPxyz...your-public-key-here...";
```

This is read by the existing `registerPushNotifications()` function at line 1640.

### Step 4: Implement Push Sending (Code Change Required)

The worker currently stores subscriptions but does not send push notifications. A `sendWebPush()` function needs to be added that:

1. Queries `push_subscriptions` table for the target user's email
2. For each subscription, constructs a VAPID-signed JWT and encrypts the payload using ECDH (Web Push protocol)
3. POSTs the encrypted payload to the subscription endpoint
4. Handles 410 Gone responses by deleting stale subscriptions

This function would be called from `d1InsertNotification()` (which already fires on trade ENTRY, EXIT, TRIM, and daily brief generation).

**Note:** Standard `web-push` npm library does not work in Cloudflare Workers. Use a Workers-compatible implementation (e.g., `web-push-cloudflare-workers` or a manual VAPID + ECDH implementation using the Web Crypto API).

### What Already Works

| Component | Status | Location |
|-----------|--------|----------|
| Service worker | Done | `react-app/service-worker.js` |
| Push subscription storage | Done | `POST /timed/push/subscribe`, D1 `push_subscriptions` table |
| Frontend registration | Done | `auth-gate.js` lines 1624-1655 (triggers after 3rd page visit) |
| In-app notification bell | Done | `NotificationCenter` component in `auth-gate.js` |
| Notification creation | Done | `d1InsertNotification()` called on trades + briefs |
| VAPID keys | Not configured | See steps above |
| Push sending | Not implemented | Needs `sendWebPush()` in worker |
