# `tt-broker-bridge` — Phase 1 MVP Plan (2026-05-29)

Follow-up to `tasks/2026-05-28-robinhood-agentic-trading-research.md` (PR #340, merged). User: *"I would like to proceed with the Sidecar bridge, Option C approach."*

## Scope of Phase 1

Phase 1 = **operator-only**, single funded Robinhood Agentic account, end-to-end mechanical proof. We're shipping a **deployable skeleton** that compiles, has full security guards in place, and has the real RH MCP wire-up stubbed behind a `BROKER_BRIDGE_MOCK=true` env flag so the operator can iterate on the actual RH connection without breaking deploys.

The skeleton is enough to:
1. Be deployed live to a `tt-broker-bridge` Cloudflare Worker
2. Accept OAuth callbacks from Robinhood once the operator wires the RH OAuth client
3. Receive order webhooks from the TT main worker
4. Encrypt + store per-user RH tokens
5. Enforce all hard caps (max $5k/order, 3 orders/day, account-wide budget, kill switch)
6. Log every decision + simulated response to D1 for review
7. Show status in Mission Control

What's stubbed (waiting on operator hands-on testing of actual RH MCP):
- The real `place_equity_order` / `review_equity_order` HTTP call shape
- OAuth start/refresh URLs (RH hasn't published them in public docs)
- Rate-limit retry policy
- Settlement / cash-mode quirks

## Architecture

```
TT main worker (timed-trading-ingest)
     │
     │  on processTradeSimulation decision (ENTRY/TRIM/EXIT)
     │  AND user.broker_integration_enabled === true:
     │    ctx.waitUntil(fetch(BROKER_BRIDGE_URL + "/bridge/order", {
     │      method: "POST",
     │      headers: { Authorization: "Bearer " + INTERNAL_KEY },
     │      body: { user_id, ticker, side, qty, sl, tp, trade_id, ... }
     │    }))
     │
     ▼
tt-broker-bridge (NEW separate worker)
  Endpoints:
    POST /bridge/order            — inbound order from TT main worker
    POST /bridge/oauth/start      — initiate per-user RH OAuth
    GET  /bridge/oauth/callback   — RH OAuth redirect lands here
    POST /bridge/oauth/disconnect — operator revokes a user's link
    GET  /bridge/health           — readiness check
    GET  /bridge/status           — per-user connection + caps + recent fills
    GET  /bridge/audit            — recent audit log entries
    POST /bridge/killswitch       — global kill switch flip (operator only)
    POST /bridge/test/rh-call     — manual MCP probe for operator testing
  Storage:
    BRIDGE_KV     — per-user encrypted tokens, killswitch flag, daily counters
    BRIDGE_DB     — audit log (every order in / RH response out / errors)
  Secrets:
    BRIDGE_ENCRYPTION_KEY     — AES-256 key for token wrap (32 bytes b64)
    BRIDGE_INTERNAL_HMAC_KEY  — HMAC for verifying inbound webhooks from TT
    ROBINHOOD_OAUTH_CLIENT_ID + SECRET (filled in once RH provides)
     │
     ▼
Robinhood MCP — https://agent.robinhood.com/mcp/trading  (per user OAuth)
     │
     ▼
Fill → RH push to user phone
```

## Security model

| Concern | Mitigation |
| --- | --- |
| Inbound webhook spoofing | HMAC-SHA256 signature on every `POST /bridge/order` using `BRIDGE_INTERNAL_HMAC_KEY`. Main worker signs, bridge verifies. |
| Token theft from KV | All RH tokens encrypted with WebCrypto AES-256-GCM. Encryption key in CF secrets, never in KV or D1. |
| Encryption key rotation | KV row format: `{ alg, key_version, iv_b64, ciphertext_b64 }`. Multiple key versions can coexist; rotation = decrypt with old, re-encrypt with new. |
| Operator account hijack | OAuth state param (random 32 bytes) bound to user_id + 10-min TTL. Callback rejected if state missing/expired/wrong-user. |
| Runaway agent | Hard caps enforced PRE-CALL: max $5k/order, 3 orders/day/user, account budget % cap from RH `get_portfolio`. Global kill switch. |
| SHORT signals | Bridge rejects with `unsupported_side: "short_not_supported_by_robinhood"` and logs to audit. TT main worker continues running shorts in simulation only. |
| Pre-trade error | `review_equity_order` MUST succeed and return no critical warnings before `place_equity_order` fires. If warnings, bridge logs and refuses. |
| Disconnect mid-trade | If user disconnects (token invalidated), bridge marks user as `disconnected` in KV and refuses further orders. Open positions stay open under RH UI control. |

## Per-user state in KV

Key: `bridge:user:{user_id}`
Value:
```json
{
  "user_id": "...",
  "status": "connected" | "disconnected" | "pending_oauth",
  "connected_at": 1780000000000,
  "rh_account_number": "...",
  "rh_token_wrap": { "alg":"A256GCM", "iv_b64":"...", "ct_b64":"..." },
  "rh_refresh_wrap": { ... },
  "rh_token_expires_at": ...,
  "broker_integration_enabled": true,
  "daily_order_count": 0,
  "daily_order_count_date": "2026-05-29",
  "total_orders_lifetime": 0,
  "last_order_at": ...,
  "user_caps": { "max_per_order_usd": 5000, "max_orders_per_day": 3 }
}
```

Key: `bridge:killswitch_global` — `"on"` or `"off"`

## D1 audit schema

```sql
CREATE TABLE bridge_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  user_id         TEXT,
  trade_id        TEXT,
  ticker          TEXT,
  action          TEXT,         -- 'order_in' | 'review' | 'place' | 'reject' | 'fill_push'
  side            TEXT,
  qty             REAL,
  price_target    REAL,
  sl              REAL,
  tp              REAL,
  estimated_value REAL,
  rh_order_id     TEXT,
  rh_response     TEXT,         -- JSON
  status          TEXT,         -- 'ok' | 'rejected' | 'error'
  reject_reason   TEXT,
  request_json    TEXT,
  response_json   TEXT,
  latency_ms      INTEGER
);
CREATE INDEX idx_audit_user_ts ON bridge_audit(user_id, ts DESC);
CREATE INDEX idx_audit_ticker_ts ON bridge_audit(ticker, ts DESC);
```

## TT main worker hook

In `processTradeSimulation`, where ENTRY/TRIM/EXIT is decided, add:

```js
// 2026-05-29 — Phase 1 broker bridge wiring. Fire-and-forget so the
// trade decision is not blocked on bridge latency. Gated by per-user
// feature flag + global kill switch read from bridge.
if (env?.BROKER_BRIDGE_URL && user?.broker_integration_enabled) {
  ctx.waitUntil(maybeForwardOrderToBridge(env, {
    user_id, trade_id, ticker, side, qty,
    entry, sl, tp, decision_reason,
  }).catch(() => {}));
}
```

Where `maybeForwardOrderToBridge` is implemented in a new module
`worker/broker-bridge-client.js` and:
1. Signs the payload with HMAC-SHA256 using `BROKER_BRIDGE_HMAC_KEY`
2. POSTs to `BROKER_BRIDGE_URL/bridge/order` with timeout=4s
3. Records to a small KV ring buffer for ops visibility

## Mission Control UI

New section `8. Broker Bridge` with:
- Bridge URL + last health probe time
- Kill switch toggle
- For each user: status (Connected / Disconnected / Pending), last order time, today's order count vs cap, total lifetime orders, "Disconnect" button
- Audit log recent 20 entries
- "Test RH MCP" button (operator-only) — fires `POST /bridge/test/rh-call`

## Open questions to answer during Phase 1 testing

(Carried over from PR #340 — answers feed back into the bridge code)

1. GTC support on `place_equity_order` — if day-only, bridge re-submits SL each session
2. Stop / stop_limit order types — if unsupported, bridge tracks SL itself
3. Rate limits — wire retry/backoff once known
4. Fractional support per symbol — already computed by TT, just pass through
5. Settlement / cash mode — adjust sizing if T+1 settled cash
6. Disconnect behavior — what happens to open positions
7. OAuth refresh cadence + failure modes

The `POST /bridge/test/rh-call` endpoint lets the operator iterate on these without redeploys.

## Phase 1 success criteria

- Bridge worker deployed and healthy
- Operator's RH Agentic OR IBKR account ($500-$1000) connected
- One end-to-end paper-mode order flows: TT decision → bridge → mock broker call → audit log
- Operator manually verifies their first real ENTRY: see the bridge audit log show ORDER_IN → REVIEW (no warnings) → PLACE_OK → FILL_PUSH
- All hard caps enforced (verified by trying to exceed them — bridge rejects)
- Kill switch verified (flip → next ENTRY rejected)

When all six are green for one operator's account across one trading week, we promote to Phase 2 (Pro-tier preview, 5-10 customers).

---

## IBKR (Interactive Brokers) adapter — 2026-05-29

IBKR is now a first-class adapter alongside Robinhood. **For users with an existing IBKR account, this is the recommended broker** because:

| Capability | Robinhood Agentic | IBKR |
| --- | --- | --- |
| Long equities | ✓ | ✓ |
| **Short equities** | ✗ (blocker for TT SHORT mode) | **✓** |
| Options | ✗ | ✓ (future TT feature) |
| Margin / portfolio margin | limited | ✓ |
| Stop-loss / stop-limit orders | unclear (open Q) | ✓ |
| GTC orders | unclear (open Q) | ✓ |
| API maturity | new MCP, evolving | 10+ year-old REST + WS |
| Cost | free | $10/mo (Pro plan for OAuth) |

### IBKR auth flow — fundamentally different from RH OAuth

IBKR uses **Self-Service OAuth 1.0a** with operator-generated credentials. There's no "click connect" handshake; the operator mints their own token pair in IBKR Account Management and POSTs it to the bridge once.

### Per-user IBKR setup (one-time)

1. Log into **IBKR Account Management** (clientportal.ibkr.com)
2. Go to **Settings → API → OAuth**
3. Click **Generate New Pair**
4. Save the four values: `account_id` (e.g. `U1234567`), `consumer_key`, `access_token`, `access_token_secret`
5. POST to the bridge:
   ```bash
   curl -X POST $BROKER_BRIDGE_URL/bridge/ibkr/connect \
     -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "user_id": "operator@email",
       "ibkr_account_id": "U1234567",
       "ibkr_consumer_key": "TIMEDTRADING",
       "ibkr_oauth_token": "<access token>",
       "ibkr_oauth_token_secret": "<access token secret>"
     }'
   ```
6. Bridge encrypts the token + secret (AES-256-GCM) and stores under `bridge:user:{user_id}` with `broker: "ibkr"`
7. Flip `broker_integration_enabled` to true when ready to send live orders

### IBKR module

`worker-bridge/bridge-ibkr.js` mirrors `bridge-robinhood.js`:
- `reviewOrder(env, user, order)` — POST `/iserver/account/{id}/orders?preview=true`
- `placeOrder(env, user, order)` — POST `/iserver/account/{id}/orders`
- `cancelOrder(env, user, orderId)` — DELETE `/iserver/account/{id}/order/{orderId}`
- `getPortfolio(env, user)` — GET `/portfolio/{id}/summary`
- `getEquityPositions(env, user)` — GET `/portfolio/{id}/positions/0`

Conid (IBKR's internal contract ID) is resolved once per ticker via `/trsrv/secdef/search` and cached 24h in `bridge:ibkr:conid:{ticker}` KV.

### What still needs operator hands-on for IBKR live mode

The OAuth 1.0a HMAC signing helper in `bridge-ibkr.js → signRequest()` ships as a stub. Real OAuth 1.0a requires careful percent-encoding of the request base string. Finalize once the operator has IBKR creds in hand and we can test against IBKR's `/sso/validate` echo endpoint. Mock mode keeps the bridge functional in the meantime.

---

## Quick-start runbook (any broker)

This is the canonical sequence to take the bridge from a fresh clone to live operator testing. Paste the commands as-is; substitute your own secret values.

### Step 1 — Worker KV namespace

```bash
cd worker-bridge
npx wrangler kv:namespace create BRIDGE_KV
# Copy the printed id into wrangler.toml under [[kv_namespaces]]
```

(The shipped `wrangler.toml` reuses the main worker's KV ID — that's fine if you want shared storage. Use a separate namespace for full isolation.)

### Step 2 — Secrets

```bash
# AES-256 encryption key for per-user broker tokens (32 random bytes base64)
openssl rand -base64 32 | npx wrangler secret put BRIDGE_ENCRYPTION_KEY

# HMAC key for verifying inbound webhooks from the main TT worker
openssl rand -base64 32 | npx wrangler secret put BRIDGE_INTERNAL_HMAC_KEY

# Operator API key (separate from the HMAC — protects status/audit/killswitch routes)
openssl rand -base64 24 | npx wrangler secret put BRIDGE_OPERATOR_KEY

# Robinhood OAuth credentials (only if using RH adapter)
echo -n "<RH client id>"     | npx wrangler secret put ROBINHOOD_OAUTH_CLIENT_ID
echo -n "<RH client secret>" | npx wrangler secret put ROBINHOOD_OAUTH_CLIENT_SECRET
```

### Step 3 — Deploy the bridge worker

```bash
cd worker-bridge
npx wrangler deploy --env=''
# Note the printed URL — that's your BROKER_BRIDGE_URL
```

### Step 4 — Wire the main TT worker

```bash
cd ../worker
# Add to the main worker so it can forward orders + read bridge status
npx wrangler secret put BROKER_BRIDGE_URL          # paste bridge URL from Step 3
npx wrangler secret put BROKER_BRIDGE_HMAC_KEY     # same value as Step 2's BRIDGE_INTERNAL_HMAC_KEY
npx wrangler secret put BROKER_BRIDGE_OPERATOR_KEY # same value as Step 2's BRIDGE_OPERATOR_KEY

npx wrangler deploy --env=''
```

### Step 5 — Connect your broker account

**Robinhood Agentic:**
```bash
curl -X POST $BROKER_BRIDGE_URL/bridge/oauth/start \
  -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email"}'
# Returns { authorize_url }. Open in browser, complete RH OAuth.
# Callback lands on /bridge/oauth/callback → bridge encrypts + stores tokens.
```

**IBKR:**
```bash
# Mint OAuth pair in IBKR Account Management → Settings → API → OAuth
curl -X POST $BROKER_BRIDGE_URL/bridge/ibkr/connect \
  -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"operator@email",
    "ibkr_account_id":"U1234567",
    "ibkr_consumer_key":"<consumer key>",
    "ibkr_oauth_token":"<access token>",
    "ibkr_oauth_token_secret":"<access token secret>"
  }'
```

### Step 6 — Verify the bridge is alive

```bash
# Health probe
curl $BROKER_BRIDGE_URL/bridge/health

# Status (lists connected users + caps + kill switch state)
curl -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  $BROKER_BRIDGE_URL/bridge/status

# Mock RH/IBKR call test
curl -X POST $BROKER_BRIDGE_URL/bridge/test/rh-call \
  -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email","tool":"get_portfolio"}'
```

### Step 7 — Enable live trading for your user

```bash
# First operator turns it ON for their own user
curl -X POST $BROKER_BRIDGE_URL/bridge/enable \
  -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email","enable":true}'
```

By default the bridge is in **mock mode** (`BROKER_BRIDGE_MOCK=true` in wrangler.toml). Every order is logged to `bridge_audit` D1 table but no real broker call fires. Flip to live by editing `wrangler.toml`:
```toml
BROKER_BRIDGE_MOCK = "false"
```
and redeploying.

### Step 8 — Watch it work

- **Mission Control → Section 8 — Broker Bridge** shows live status, per-user audit log, kill switch
- **Discord system lane** posts every order_in / review / place / reject event
- **D1 `bridge_audit` table** has the full trail with latency, response bodies, reject reasons

### Emergency kill switch

```bash
curl -X POST $BROKER_BRIDGE_URL/bridge/killswitch \
  -H "Authorization: Bearer $BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state":"on"}'
# Every subsequent order is rejected immediately with reject_reason=global_kill_switch_on.
# Flip "off" to resume.
```
