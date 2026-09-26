# E*TRADE Broker Mirror — Integration Plan

**Created:** 2026-09-26 · **Status:** Scaffold shipped — blocked on consumer keys + OAuth 1.0a signing  
**Owner:** Operator  
**Related:** `skills/broker-bridge.md`, `tasks/2026-06-15-webull-connect-integration-plan.md`

---

## Goal

Add **E*TRADE** (Morgan Stanley Developer Platform) as a fourth broker
adapter on `tt-broker-bridge`, so Timed Trading can mirror ENTRY/TRIM/EXIT
to an E*TRADE account the same way it mirrors IBKR / Webull today.

---

## Why this is harder than Webull

| Topic | Webull Connect | E*TRADE |
|---|---|---|
| Auth | OAuth 2.0 + refresh (~15d) | **OAuth 1.0a** (HMAC-SHA1) |
| Access token life | ~30 min refreshable | **Expires midnight ET**; inactive after **~2h idle** |
| Renew | Refresh token | `POST /oauth/renew_access_token` required for unattended mirror |
| Sandbox | UAT host | `https://apisb.etrade.com` |
| Production | `us-oauth-open-api.webull.com` | `https://api.etrade.com` |

Unattended overnight mirror is **not safe** until a renew cron is proven
(renew before midnight ET + on any 2h idle gap).

---

## Current state (this PR)

| Item | Status |
|------|--------|
| Integration plan (this doc) | Done |
| `bridge-etrade-config.js` — sandbox/prod hosts + flags | Done |
| `bridge-etrade.js` — mock adapter (`review`/`place`/`portfolio`/`positions`/`cancel`/`listOrders`) | Done |
| `bridge-etrade-auth.js` — mock `POST /bridge/etrade/connect` + OAuth start/callback stubs (501 until signing) | Done |
| `bridge-brokers.js` — `etrade` capability registry | Done |
| `bridge-index.js` — adapter router + routes | Done |
| `broker-connect-shared.js` — UI catalog entry (coming soon / scaffold) | Done |
| Unit tests (`bridge-etrade.test.js` + order-plan) | Done |
| Live OAuth 1.0a HMAC-SHA1 signing | **Not yet** |
| Live place/cancel/positions REST | **Not yet** |
| Midnight / idle renew cron | **Not yet** |
| Main-worker admin proxies + MC connect button | Deferred to live slice |

### Pre-credential validation (no E*TRADE account needed)

1. Keep `BROKER_BRIDGE_MOCK=true` on bridge (or call connect with `mock:true`).
2. `POST /bridge/etrade/connect` `{ "user_id": "operator@…", "etrade_account_id": "MOCK_ETRADE" }`.
3. Confirm user row: `broker=etrade`, `status=connected`, `mock_mode=true`.
4. Fire a mock `/bridge/order` against that user → audit shows preview/place.
5. `GET /bridge/health` → `supported_brokers` includes `etrade` with `equity_market: true`.

### Blocked on external input

1. Create / use an E*TRADE account at developer.etrade.com.
2. Complete API Developer Agreement → sandbox **consumer key + secret**.
3. Register callback URL:  
   `https://tt-broker-bridge.<account>.workers.dev/bridge/etrade/oauth/callback`
4. Set secrets on `tt-broker-bridge`:
   - `ETRADE_CONSUMER_KEY`
   - `ETRADE_CONSUMER_SECRET`
   - optional `ETRADE_OAUTH_CALLBACK_URL`, `ETRADE_SANDBOX=true`
5. Next engineering slice: OAuth 1.0a request/access token exchange + renew cron, then live equity market place against sandbox.

---

## Architecture

```text
Main worker                         Bridge worker
───────────                         ─────────────
forwardOrderToBridge ──HMAC──► POST /bridge/order
                                       │
                                       ▼
                                 brokerAdapterFor(user)
                                       │
              ┌────────────┬───────────┼───────────┬──────────┐
              ▼            ▼           ▼           ▼          ▼
            IBKR       Robinhood     Webull     E*TRADE    (future)
           (live)     (MCP pending) (live)     (scaffold)
```

User record (KV `bridge:user:{email}`):

```json
{
  "broker": "etrade",
  "status": "connected",
  "etrade_account_id": "…",
  "etrade_access_token_wrap": "<encrypted>",
  "etrade_access_token_secret_wrap": "<encrypted>",
  "etrade_token_obtained_at": 1710000000000,
  "etrade_auth_mode": "oauth1a",
  "broker_integration_enabled": false
}
```

---

## API reference (live slice)

| Step | Method | Path |
|------|--------|------|
| Request token | GET | `/oauth/request_token` |
| Authorize (browser) | GET | `https://us.etrade.com/e/t/etws/authorize?key=&token=` |
| Access token | GET | `/oauth/access_token` |
| Renew token | POST | `/oauth/renew_access_token` |
| Account list | GET | `/v1/accounts/list` |
| Balance | GET | `/v1/accounts/{accountIdKey}/balance` |
| Positions | GET | `/v1/accounts/{accountIdKey}/portfolio` |
| Preview equity | POST | `/v1/accounts/{accountIdKey}/orders/preview` |
| Place equity | POST | `/v1/accounts/{accountIdKey}/orders/place` |
| Cancel | PUT | `/v1/accounts/{accountIdKey}/orders/cancel` |

Docs: https://developer.etrade.com/getting-started/developer-guides

---

## Non-goals (this PR)

- Live money orders
- Options / shorts / OCO
- BYOB self-serve UI for subscribers
- Claiming E*TRADE in FAQ as available
