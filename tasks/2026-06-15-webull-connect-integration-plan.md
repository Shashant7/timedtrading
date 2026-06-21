# Webull Connect Integration Plan

**Created:** 2026-06-15 · **Status:** Scaffold shipped — blocked on Connect credentials  
**Owner:** Operator  
**Related:** `skills/broker-bridge.md`, `tasks/2026-06-01-byob-broker-connect-plan.md`

---

## Goal

Add Webull as a third broker adapter on `tt-broker-bridge`, using **Webull Connect API**
(OAuth 2.0 + signed REST), so Timed Trading can mirror ENTRY/TRIM/EXIT orders to Webull
accounts once partner credentials are issued.

**Agentic/MCP** (`api.webull.com/mcp`) is for AI assistants (Cursor, Claude). **Connect API**
is the correct path for a hosted platform executing trades server-side on behalf of users.

---

## Current state (this PR)

| Item | Status |
|------|--------|
| Integration plan (this doc) | Done |
| `bridge-webull-config.js` — env + URL resolution | Done |
| `bridge-webull-sign.js` — HMAC-SHA1 request signing | Done |
| `bridge-webull-api.js` — OAuth token + signed REST client | Done |
| `bridge-webull.js` — adapter (`reviewOrder`, `placeOrder`, …) | Done (mock + live paths) |
| `bridge-webull-auth.js` — OAuth start/callback/disconnect | Done |
| `bridge-webull-tokens.js` — proactive token refresh cron | Done |
| `bridge-brokers.js` — capability registry | Done |
| `bridge-index.js` routing + `/bridge/test/webull-call` | Done |
| Main worker proxies (`/timed/admin/broker-bridge/webull/*`) | Done |
| Mission Control Connect Brokers panel | Done |
| `account-brokers.html` + `broker-connect-shared.js` | Done |
| `scripts/test-webull-sign.mjs` signing smoke test | Done |
| `wrangler.toml` vars + secrets checklist | Done |
| `skills/broker-bridge.md` runbook section | Done |

### Pre-credential validation (no Webull account needed)

1. Set `BROKER_BRIDGE_MOCK=true` on bridge worker (local or staging).
2. Mission Control → Broker Bridge → **Connect Webull** with operator email.
3. Confirm user row: `broker=webull`, `status=connected`, `mock_mode=true`.
4. **Test portfolio** → mock balance response.
5. Enable live trading toggle → fire a tiny mirror order in shadow/log mode.
6. Check `/bridge/audit` for preview/place rows.

When Connect credentials arrive, flip `BROKER_BRIDGE_MOCK=false`, set secrets, repeat with real OAuth URL.

**Blocked on external input:**

- Email `connect.api@webull-us.com` with company name + redirect URL  
  `https://tt-broker-bridge.<account>.workers.dev/bridge/webull/oauth/callback`  
  (or production custom domain once set)
- Receive: `client_id`, `client_secret`, `app_key`, `app_secret`, approved `scope`
- UAT testing → production approval

---

## Architecture

```text
Main worker                         Bridge worker
───────────                         ─────────────
forwardOrderToBridge ──HMAC──► POST /bridge/order
                                       │
                                       ▼
                                 preflightOrder (guards + manifest)
                                       │
                                       ▼
                                 brokerAdapterFor(user)
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                      IBKR         Robinhood       Webull
                    (live)       (MCP scaffold)  (Connect REST)
```

Webull user record (KV `bridge:user:{email}`):

```json
{
  "broker": "webull",
  "status": "connected",
  "webull_account_id": "...",
  "webull_token_wrap": "<encrypted>",
  "webull_refresh_wrap": "<encrypted>",
  "webull_token_expires_at": 1710000000000,
  "webull_refresh_expires_at": 1710000000000,
  "broker_integration_enabled": false
}
```

---

## Webull Connect API reference

| Step | Method | Path | Notes |
|------|--------|------|-------|
| Authorize (browser) | GET | `/oauth2/authenticate/login` | Query: `response_type=code`, `client_id`, `scope`, `state`, `redirect_uri` |
| Exchange / refresh token | POST | `/openapi/oauth2/token` | Form body; signed headers + `x-access-token` |
| Account list | GET | `/oauth-openapi/account/list` | Bearer + signed headers |
| Balance | GET | `/openapi/assets/balance?account_id=` | |
| Positions | GET | `/openapi/assets/positions?account_id=` | |
| Preview order | POST | `/openapi/trade/order/preview` | JSON body |
| Place order | POST | `/openapi/trade/order/place` | JSON body |
| Cancel order | POST | `/openapi/trade/order/cancel` | JSON body |

**Base URLs**

| Environment | Host |
|-------------|------|
| UAT | `us-oauth-open-api.uat.webullbroker.com` |
| Production | `us-oauth-open-api.webull.com` |

**Token lifetimes:** access ~30 min · refresh ~15 days · auth code ~60 sec (single use)

**Signing:** HMAC-SHA1 over sorted params + optional body MD5 — see `bridge-webull-sign.js`

Docs: https://developer.webull.com/apis/docs/connect-api/about-connect-api/

---

## Bridge secrets (set after registration)

```bash
cd worker-bridge
wrangler secret put WEBULL_CONNECT_CLIENT_ID
wrangler secret put WEBULL_CONNECT_CLIENT_SECRET
wrangler secret put WEBULL_APP_KEY
wrangler secret put WEBULL_APP_SECRET
# Optional override:
# wrangler secret put WEBULL_OAUTH_REDIRECT_URI
```

**Vars** (already in `wrangler.toml`):

| Var | Default | Purpose |
|-----|---------|---------|
| `WEBULL_ENVIRONMENT` | `uat` | `uat` or `prod` |
| `WEBULL_CONNECT_SCOPE` | `user:trade:wr` | OAuth scope from Webull |
| `WEBULL_TOKEN_REFRESH_SKEW_MS` | `300000` | Refresh 5 min before expiry |

---

## Operator runbook (once creds arrive)

### 1. Register redirect URI with Webull

Must exactly match:

```text
https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/callback
```

Or set `WEBULL_OAUTH_REDIRECT_URI` to a custom value and register that with Webull.

### 2. Set secrets + deploy bridge

```bash
cd worker-bridge
# set secrets (above)
wrangler deploy
```

### 3. Connect operator account (UAT first)

```bash
curl -s -X POST "https://tt-broker-bridge.../bridge/webull/oauth/start" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email.com"}' | python3 -m json.tool
```

Open `authorize_url` in browser → approve in Webull app → callback lands on bridge.

### 4. Verify read path

```bash
curl -s -X POST ".../bridge/test/webull-call" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email.com","action":"get_portfolio"}' | python3 -m json.tool
```

### 5. Enable mirror (explicit)

```bash
curl -s -X POST ".../bridge/enable" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email.com","enable":true}'
```

### 6. Dry-run order path

With `BROKER_BRIDGE_MOCK=true` or a sandbox account, fire a small ENTRY from MC / replay.
Check `/bridge/audit?user_id=...`.

### 7. Production cutover

- Flip `WEBULL_ENVIRONMENT=prod` in `wrangler.toml`
- Re-register redirect on production Connect app
- Re-run OAuth connect (tokens are env-specific)

---

## Acceptance criteria (UAT sign-off)

- [ ] OAuth connect completes; user row shows `broker=webull`, `status=connected`
- [ ] `/bridge/portfolio` returns equity + cash for connected user
- [ ] Positions reconcile against manifest (no false drift on empty account)
- [ ] Preview + place market DAY order for 1 share (sandbox)
- [ ] Token refresh cron runs without user re-auth for 7+ days
- [ ] TRIM/EXIT rejected when manifest says `mirror_suppressed` (existing guard)
- [ ] Audit log captures request/response JSON (tokens redacted)

---

## Follow-on (post-credentials)

| Phase | Work |
|-------|------|
| BYOB UI | "Connect Webull" button on `/account/brokers` (BYOB Phase 1+) |
| Options | Route `/bridge/options/order` by broker; Webull option preview/place APIs exist |
| Adapter registry | Optional `bridge-brokers.js` capability matrix |
| Production hardening | Rate-limit backoff, Webull error_code mapping, alert on refresh failure |

---

## Registration email template

```text
To: connect.api@webull-us.com
Subject: Timed Trading — Connect API partner registration

Company: Timed Trading
Product: AI-assisted trading platform with optional auto-mirror to connected brokerage accounts
Redirect URL (UAT): https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/callback
Requested scopes: user:trade:wr (read accounts/positions, preview and place equity orders)
Environment: UAT first, then production after sign-off

Contact: [operator email]
```
