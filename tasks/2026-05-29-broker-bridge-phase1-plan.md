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
- Operator's RH Agentic account ($500-$1000) connected via OAuth
- One end-to-end paper-mode order flows: TT decision → bridge → mock RH call → audit log
- Operator manually verifies their first real ENTRY: see the bridge audit log show ORDER_IN → REVIEW (no warnings) → PLACE_OK → FILL_PUSH
- All hard caps enforced (verified by trying to exceed them — bridge rejects)
- Kill switch verified (flip → next ENTRY rejected)

When all six are green for one operator's account across one trading week, we promote to Phase 2 (Pro-tier preview, 5-10 customers).
