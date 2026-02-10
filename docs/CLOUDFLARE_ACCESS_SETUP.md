# Cloudflare Access + Google SSO Setup

## Overview

This guide sets up Google SSO authentication for the Timed Trading dashboards using Cloudflare Zero Trust (Access). After setup:

- **Dashboard users** → redirect to Google sign-in → back to dashboard
- **TradingView webhooks** → continue using `?key=API_KEY` (bypasses Access)
- **Cron triggers** → internal to Cloudflare (no HTTP, no Access)
- **Scripts** → use API key or Service Token

## Architecture

```
Browser → Cloudflare Access (Google SSO) → Worker (reads JWT → identifies user) → Dashboard
TradingView → Worker (API key in ?key= param, Access bypass rule) → Ingest
Cron → Worker (internal trigger, no HTTP involved) → Processing
```

## Prerequisites

- Cloudflare account with Workers
- Google Cloud Console access (for OAuth credentials)
- `wrangler` CLI installed

---

## Step 1: Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing)
3. Go to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth client ID**
5. Application type: **Web application**
6. Name: `Timed Trading SSO`
7. Authorized redirect URIs:
   ```
   https://<YOUR-TEAM-NAME>.cloudflareaccess.com/cdn-cgi/access/callback
   ```
   Replace `<YOUR-TEAM-NAME>` with your Cloudflare Zero Trust team name.
8. Click **Create** and save the **Client ID** and **Client Secret**

## Step 2: Configure Cloudflare Zero Trust

### 2a. Set Up Team (if first time)

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Select or create a team name (e.g., `timedtrading`)
3. Note this team name — it becomes `CF_ACCESS_TEAM_DOMAIN`

### 2b. Add Google as Identity Provider

1. In Zero Trust dashboard → **Settings → Authentication**
2. Click **Add new** under Login methods
3. Select **Google**
4. Enter the **Client ID** and **Client Secret** from Step 1
5. Click **Save**
6. Test the connection

### 2c. Create Access Application

1. Go to **Access → Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Application name**: `Timed Trading`
   - **Session Duration**: `24 hours` (or your preference)
   - **Application domain**: `timed-trading-ingest.shashant.workers.dev`
     - Or your custom domain if you have one
   - **Path**: leave empty (protects entire domain)
4. Click **Next**

### 2d. Create Access Policy

1. **Policy name**: `Allow Authorized Users`
2. **Action**: Allow
3. **Include rules**:
   - For yourself: **Emails** → `your-email@gmail.com`
   - For a team: **Emails ending in** → `@yourcompany.com`
   - Or **Everyone** (if you want to gate by tier only, not by email)
4. Click **Save**

### 2e. Create Bypass Rule for Webhooks

This ensures TradingView webhooks and API calls aren't blocked by Access.

1. In the same application, add another policy:
   - **Policy name**: `Bypass API Endpoints`
   - **Action**: Bypass
   - **Include rules**: **Everyone**
   - **Selector**: add path patterns:
     - Path starts with `/timed/ingest`
     - Path starts with `/timed/heartbeat`
     - Path starts with `/timed/ingest-capture`
     - Path starts with `/timed/ingest-candles`
2. Click **Save**

### 2f. Copy the Application Audience Tag

1. In the application settings, find the **Application Audience (AUD)** tag
2. Copy it — you'll need it for the next step

## Step 3: Configure Worker Secrets

```bash
# Set the audience tag (from Step 2f) as a secret
wrangler secret put CF_ACCESS_AUD --env production
# Paste the AUD tag when prompted

# Set your team domain in wrangler.toml (non-sensitive)
# Edit worker/wrangler.toml and uncomment/set:
# CF_ACCESS_TEAM_DOMAIN = "timedtrading"

# Set your admin email
# ADMIN_EMAIL = "your-email@gmail.com"
```

Then deploy:
```bash
cd worker
wrangler deploy --env production
```

## Step 4: Apply D1 Schema Migration

```bash
# Add the users table
wrangler d1 execute timed-trading-ledger --env production --command "
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users (tier);
"

# Seed your admin user
wrangler d1 execute timed-trading-ledger --env production --command "
INSERT OR REPLACE INTO users (email, display_name, role, tier, created_at, updated_at, last_login_at)
VALUES ('your-email@gmail.com', 'Your Name', 'admin', 'admin', $(date +%s)000, $(date +%s)000, $(date +%s)000);
"
```

## Step 5: Verify

1. Open your dashboard URL in an incognito window
2. You should be redirected to Google sign-in
3. After sign-in, you're redirected back to the dashboard
4. Test the `/timed/me` endpoint:
   ```bash
   curl https://timed-trading-ingest.shashant.workers.dev/timed/me
   # Should return { authenticated: true, user: { email: "...", role: "admin", tier: "admin" } }
   ```
5. Test that webhooks still work (no auth required):
   ```bash
   curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/ingest?key=YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"ticker":"TEST","price":100}'
   ```

---

## How It Works

### Authentication Flow

1. User opens dashboard → Cloudflare Access intercepts
2. Access redirects to Google sign-in
3. After Google auth, Access sets `CF-Access-JWT-Assertion` cookie/header
4. Worker's `authenticateUser()` reads this JWT, extracts email
5. User is auto-provisioned in D1 `users` table on first login
6. User identity available for personalization, tier gating, audit

### What's Protected vs. Bypassed

| Endpoint Pattern | Auth Method | Notes |
|---|---|---|
| Dashboard HTML pages | Cloudflare Access (Google SSO) | Protected by Access Application |
| `GET /timed/all`, `/timed/latest`, etc. | Cloudflare Access | Protected by Access Application |
| `POST /timed/ingest*` | API Key (`?key=`) | Bypassed in Access, checked in Worker |
| `POST /timed/heartbeat` | API Key (`?key=`) | Bypassed in Access, checked in Worker |
| `POST /timed/admin/*` | API Key OR Admin JWT | Works for both scripts and admin users |
| Cron triggers | N/A (internal) | No HTTP request, no Access |

### User Tiers

| Tier | Access Level |
|---|---|
| `free` | Basic dashboard, read-only views |
| `pro` | Full dashboard, screener, alerts |
| `admin` | Everything + admin endpoints + user management |

### Adding Users

Users are auto-provisioned on first Google sign-in. To upgrade a user's tier:

```bash
# Via API
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/users/user@email.com/tier?key=YOUR_KEY&tier=pro"

# Via D1 directly
wrangler d1 execute timed-trading-ledger --env production --command \
  "UPDATE users SET tier = 'pro', expires_at = 1738368000000 WHERE email = 'user@email.com'"
```

---

## Future: Stripe Integration (Phase 3)

When ready to monetize:

1. Set up Stripe Checkout with a webhook
2. Add `POST /timed/stripe/webhook` endpoint (bypassed in Access)
3. Stripe webhook updates user tier + `expires_at` in D1
4. Add a cron to downgrade expired subscriptions
