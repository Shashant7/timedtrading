# IBKR Test + Auto-Execution Mirror Plan [2026-05-30]

> Account: ~$1,500 USD · Mirror scale: 1/100 of model portfolio · Phase 1: shares only · Phase 2: options

## Where we are right now

| Surface | Status |
|---|---|
| Bridge worker `worker-bridge/` | ✅ Deployed at `tt-broker-bridge.shashant.workers.dev`, `mock_mode: false`, `kill_switch: off` |
| IBKR OAuth 1.0a Extended LST exchange | ✅ Live (`prepend_decrypt_ok: True`, `lst_exchange_ok: True`) |
| Main worker → bridge `BROKER_BRIDGE_URL` | ✅ Set in `worker/wrangler.toml` (PR #380, deployed) |
| Main worker → bridge `BROKER_BRIDGE_OPERATOR_KEY` | ❌ **OPERATOR ACTION REQUIRED** — see step 1 below |
| Stock-side `placeOrder` | ✅ Coded in `worker-bridge/bridge-ibkr.js` (single-leg + combo) |
| Options-side `placeOptionsOrder` | ✅ Coded in `worker-bridge/bridge-ibkr.js` |
| Auto-mirror engine | ✅ Coded (`worker/options-auto-mirror.js`) — gated to operator email |
| Auto-mirror operator prefs | ⚠️ Default `enabled: false` — must be set via `PUT /timed/options/auto-mirror` |
| Shares-mode auto-mirror | ❌ Not wired yet — only options auto-mirror exists. Phase 1 below adds it. |
| Mission Control bridge UI | ✅ Will show `LIVE` after operator key is set + Pages picks up the rebuild |

## Step 1 — One-time operator setup (5 minutes)

These are commands the operator runs **locally** from a machine that has `wrangler login`:

```bash
# 1a. Set the bridge operator key on the MAIN worker (so Mission Control can proxy
#     /bridge/status, /bridge/audit, /bridge/recent through the main domain).
#     The value is the SAME operator key used in worker-bridge/wrangler.toml
#     OPERATOR_KEYS (a 32-char random string; check the existing bridge secret).
cd worker
wrangler secret put BROKER_BRIDGE_OPERATOR_KEY              # default env
wrangler secret put BROKER_BRIDGE_OPERATOR_KEY --env production

# 1b. Verify it's there
wrangler secret list                                         # should include BROKER_BRIDGE_OPERATOR_KEY
wrangler secret list --env production                        # same
```

After this, hard-refresh Mission Control. The Broker Bridge section should flip
from `NOT LINKED` → `LIVE` (or `MOCK MODE` if the bridge worker is still in mock).

## Step 2 — Bridge smoke tests (5 minutes)

Run from any shell with `curl`:

```bash
OP_KEY="<the same operator key>"
BRIDGE="https://tt-broker-bridge.shashant.workers.dev"

# 2a. Bridge is up and operator key validates
curl -s "$BRIDGE/bridge/status" -H "Authorization: Bearer $OP_KEY" | jq .

# Expected: { "ok": true, "mock_mode": false, "kill_switch": "off", "users_count": 1, "ts": ... }

# 2b. IBKR Live Session Token handshake
curl -sX POST "$BRIDGE/bridge/test/rh-call" \
  -H "Authorization: Bearer $OP_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"operator","tool":"_lst_debug"}' | jq '{prepend_decrypt_ok, lst_exchange_ok}'

# Expected: { "prepend_decrypt_ok": true, "lst_exchange_ok": true }

# 2c. Pull current account positions from IBKR (verifies LST works end-to-end)
curl -sX POST "$BRIDGE/bridge/test/rh-call" \
  -H "Authorization: Bearer $OP_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"operator","tool":"list_positions"}' | jq .

# 2d. Get the current account value (drives the 1/100 sizing)
curl -sX POST "$BRIDGE/bridge/test/rh-call" \
  -H "Authorization: Bearer $OP_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"operator","tool":"account_summary"}' | jq .
```

If any of these return non-200 or `ok: false`, stop and inspect the bridge audit
log before going further.

## Step 3 — Manual single-order test (10 minutes)

Before flipping auto-mirror, place ONE manual order through the bridge to confirm
the round-trip end-to-end. Use a small, liquid name and a far-from-market limit
price so the order rests on the book and we can cancel it.

```bash
# 3a. Place a $5 limit BUY for 1 share of SPY (well below market — will not fill)
curl -sX POST "$BRIDGE/bridge/equity/order" \
  -H "Authorization: Bearer $OP_KEY" -H "Content-Type: application/json" \
  -d '{
    "user_id": "operator",
    "ticker": "SPY",
    "side": "BUY",
    "qty": 1,
    "order_type": "LMT",
    "limit_price": 5.00,
    "time_in_force": "DAY",
    "client_order_id": "tt-smoke-1"
  }' | jq .

# Expected: { "ok": true, "broker_order_id": "...", ... }

# 3b. Check the audit log to see the round-trip recorded
curl -s "$BRIDGE/bridge/audit?limit=5" -H "Authorization: Bearer $OP_KEY" | jq '.rows[0]'

# 3c. Cancel the resting order (use the broker_order_id from step 3a)
curl -sX POST "$BRIDGE/bridge/equity/cancel" \
  -H "Authorization: Bearer $OP_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"operator","broker_order_id":"<from 3a>"}' | jq .
```

If the order shows in IBKR's trading platform and the audit log, the wiring is
healthy.

## Phase 1 — Share auto-mirror (target: this week)

### Goal

When the model opens an Active Trader position (e.g. BUY 100 NVDA @ 145), the
bridge automatically places **BUY 1 NVDA @ market** in the operator's IBKR
account (1/100 scale, rounded to the nearest whole share, minimum 1).

### Gating rules

| Rule | Reason |
|---|---|
| Only LONG entries | Phase 1 is shares-only; no shorting |
| Only `setup_tier ∈ {Prime, Premium}` and `confidence_score ≥ 60` | Skip low-conviction noise |
| Account value floor: $1,000 | Don't trade if the operator account drops below $1k |
| Max 1 mirror per ticker per day | Prevent ladder spam |
| Max 5 mirrors per day total | Cap blast radius |
| Daily PnL stop: −5% on operator account | Auto-pause mirror for the rest of the day |
| Notional ceiling: 25% of operator account per single order | Protects against rounding-up to a huge share size on $1k+ names like NVDA at $1,000 → 1 share is already 67% of account |
| Min notional: $5 (≈ minimum trade size) | Skip if 1/100 scaled order is too small |
| Skip if no live quote, IV crush risk, or bid-ask > 5% | Liquidity guard |

### Implementation status

The options-mirror engine (`worker/options-auto-mirror.js`) is the template. A
shares-mode parallel needs to be added:

- **`worker/shares-auto-mirror.js`** (new) — same shape as options-auto-mirror,
  but emits an equity order via `POST $BRIDGE/bridge/equity/order` instead of
  the options webhook.
- **`worker/index.js` `processTradeSimulation` ENTRY block** — call
  `maybeSharesMirror(env, trade, contract)` after a new trade is opened, only
  when `env._isReplay` is false (so backtests don't fire orders).
- **Mission Control "Auto-Mirror" panel** (extend existing) — add a "Shares" tab
  alongside the "Options" tab. Operator can:
  - Enable/disable per-leg-type independently
  - Edit gating rules without redeploying
  - See today's mirror history (which trades fired, which were blocked + why)
- **Bridge audit** — every mirror order goes through the existing audit log so
  Mission Control's Broker Bridge section shows the round-trip.

Until shares auto-mirror ships, the operator can run a manual sweep via:

```bash
# Pull today's new model entries and place 1/100 shares for each LONG Prime/Premium
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?status=open&limit=50" \
  -H "Authorization: Bearer <session cookie>" | jq '.trades[] | select(.direction == "LONG" and (.setup_tier | IN("Prime","Premium")))'
```

…then for each result, place a corresponding 1-share BUY via step 3a above.

## Phase 2 — Options auto-mirror

Already coded in `worker/options-auto-mirror.js` and `worker-bridge/bridge-ibkr.js`.
Activation requires:

1. Operator sets `PUT /timed/options/auto-mirror` body:
   ```json
   {
     "enabled": true,
     "allowed_archetypes": ["long_call", "long_put", "vertical_spread"],
     "allowed_modes": ["RIDE", "READY"],
     "daily_cap": 3,
     "daily_loss_cap_pct": 5,
     "min_st_freshness": "FRESH_OR_RECENT",
     "max_notional_per_order_usd": 250,
     "ticker_blocklist": ["TSLA", "MSTR"]
   }
   ```

2. Cron tick fires the auto-mirror evaluation on every new Trader contract that
   yields a confluence-boosted primary play.

3. Operator can pause via `PUT /timed/options/auto-mirror {enabled: false}`
   without losing the gating config (kill switch).

### Sizing for $1,500 account, options leg

- **Long Call / Long Put**: 1 contract minimum (assume 1/100 scale already
  rounds to 1 contract for ATM strikes on $50-$200 underlyings).
- **Vertical Spread**: 1 spread (defined-risk).
- **Cash-Secured Put**: skip in Phase 2 (locks too much buying power).
- **Covered Call**: skip in Phase 2 (requires owning 100 shares first).
- **Moonshot**: 1 contract per fired moonshot. Cap to 1 per day; this is the
  multi-bagger lotto leg.

### Daily $-at-risk for $1,500 account

| Profile | Per-trade $ risk | Per-day $ risk | Plays/day cap |
|---|---|---|---|
| Conservative | $15 (1%) | $30 (2%) | 2 |
| Moderate | $25 (1.7%) | $50 (3.3%) | 3 |
| Aggressive | $50 (3.3%) | $100 (6.7%) | 4 |
| Speculator | $75 (5%) | $150 (10%) | 5 |

Pick **Moderate** for the first 2 weeks of live mirror, then graduate to
Aggressive if the P&L curve is positive.

## Phase 3 — Performance attribution + auto-snapback (out of scope for now)

Once Phase 1 + 2 have 30 days of live data, compare operator account P&L vs
model paper P&L. If the mirror underperforms by >2× the spread (proxy for
execution drag), auto-snapback to mock mode + alert operator via Discord. That's
the AI CIO `D_operator.autosnap_safeguard` gate.

## Quick-reference URLs

- **Bridge worker**: https://tt-broker-bridge.shashant.workers.dev
- **Mission Control Broker Bridge section** (after operator setup):
  https://timed-trading.com/mission-control.html#broker-bridge
- **Bridge audit dashboard**: https://timed-trading.com/bridge-audit.html
- **Options auto-mirror prefs**:
  `GET/PUT https://timed-trading-ingest.shashant.workers.dev/timed/options/auto-mirror`
  (session auth, operator email only)
