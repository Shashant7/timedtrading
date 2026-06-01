# Broker Bridge (IBKR + Robinhood)

**WHEN to use:** Anything involving live order execution, IBKR LST / OAuth,
the operator audit log, or the `tt-broker-bridge` worker.

**Architecture:**

```
Main worker (timed-trading-ingest)
   ↓ HTTP / Authorization: Bearer <op key>
Bridge worker (tt-broker-bridge)
   ↓ broker-specific protocol
IBKR Client Portal / Robinhood Agentic
```

The main worker is the **operator + audit layer**. The bridge worker is
the **broker-specific protocol shim** (OAuth, signing, retries). They're
deployed as separate Cloudflare Workers.

---

## Repo layout

| Path | Purpose |
|---|---|
| `worker/broker-bridge-client.js` | Client that calls the bridge from the main worker; manages local audit ring buffer in KV |
| `worker/options-auto-mirror.js` | Options auto-execution policy + dispatch |
| `worker-bridge/` | Bridge worker source — separate Wrangler project |
| `worker-bridge/bridge-ibkr.js` | IBKR LST flow (DH + RSA + HMAC) |
| `worker-bridge/bridge-robinhood.js` | Robinhood Agentic flow |
| `worker-bridge/wrangler.toml` | Bridge worker config (separate from main) |
| `react-app/bridge-audit.html` | Operator audit UI |

---

## Config

| Var | Where | Notes |
|---|---|---|
| `BROKER_BRIDGE_URL` | `worker/wrangler.toml [vars]` and `[env.production.vars]` | Public URL of the bridge worker |
| `BROKER_BRIDGE_OPERATOR_KEY` | `wrangler secret put` (both envs) | Shared secret; bridge accepts `Authorization: Bearer <this>` |
| `IBKR_CONSUMER_KEY` | Bridge worker secret | OAuth 1.0a consumer key from IBKR |
| `IBKR_DH_PRIME` | Bridge worker secret | **Hex prime ONLY** — NOT the full `openssl dhparam -text` output (see lessons) |
| `IBKR_DH_GENERATOR` | Bridge worker var | Almost always `2` |
| `IBKR_PRIVATE_KEY` | Bridge worker secret | RSA private key in PEM |

---

## Status check

```bash
# Through the main worker (preferred, this is what MC uses)
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/broker-bridge/status?key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool

# Direct to the bridge (operator-only)
curl -s "https://tt-broker-bridge.shashant.workers.dev/bridge/status" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" | python3 -m json.tool
```

Possible response shapes:

| `error_kind` | Meaning | Fix |
|---|---|---|
| (none, ok:true) | LIVE | nothing to do |
| `url_missing` | `BROKER_BRIDGE_URL` not in main worker | add to `worker/wrangler.toml`, redeploy |
| `key_missing` | `BROKER_BRIDGE_OPERATOR_KEY` not set OR wrong | `wrangler secret put BROKER_BRIDGE_OPERATOR_KEY --env production` |
| `unreachable` | Bridge worker is down OR loopback (CF 1042) | deploy bridge; or see Service Bindings note below |

> **As of PR after 2026-05-30**, both `/status` and `/audit` return HTTP
> 200 (not 4xx/503) with this structured payload so MC doesn't pollute
> the operator's console.

---

## IBKR LST onboarding (one-time per operator)

1. **Generate DH params** (operator does this on their own machine):
   ```bash
   openssl dhparam -out dhparams.pem 2048
   openssl dhparam -in dhparams.pem -text -noout > dhparams-text.txt
   ```
2. **Extract the hex prime** — slice out the `prime:` block. The hex
   must end at the `generator:` line.
   - **Common bug:** copy the entire `dhparams-text.txt` into the env
     var. The trailing `generator: 2 (0x2)` text leaks letters into the
     prime → wrong length → `lst_signature_mismatch`. (PR #375)
3. **Validate length** — should be 256 bytes (512 hex chars) for 2048-bit:
   ```bash
   echo "<your-hex>" | tr -d '\n :' | wc -c   # expect 512
   ```
4. **Paste as `IBKR_DH_PRIME` secret** in the bridge worker:
   ```bash
   cd worker-bridge
   ../node_modules/.bin/wrangler secret put IBKR_DH_PRIME
   ```
5. Repeat for `IBKR_CONSUMER_KEY`, `IBKR_PRIVATE_KEY`.
6. Test the LST exchange:
   ```bash
   curl -X POST "https://tt-broker-bridge.shashant.workers.dev/bridge/ibkr/lst" \
     -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
     -d '{"user_id":"operator"}'
   ```
   Expect `{"ok":true,"lst":"<base64-token>"}`. Anything else, check
   the worker tail logs and the lessons:
   [`tasks/lessons.md`](../tasks/lessons.md) → IBKR section.

---

## Operator audit log

The main worker keeps a ring buffer of the last N orders sent to the
bridge in KV (`broker:client:ring`). View via:

```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/broker-bridge/recent?key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool | head -40
```

This is useful even when the bridge is down — you can see what the main
worker tried to send. The bridge's own audit (`/bridge/audit`) is the
authoritative record of what was actually transmitted to IBKR.

---

## Cloudflare error 1042 (subrequest loopback)

If `broker_responded_404: error code: 1042` appears in the status
response, Cloudflare's loop detector is blocking the worker-to-worker
HTTP call (even though they're distinct workers on workers.dev).

**Mitigation:** Migrate the main → bridge call from `fetch()` over HTTPS
to a **Service Binding** in `worker/wrangler.toml`:

```toml
services = [
  { binding = "BROKER_BRIDGE", service = "tt-broker-bridge" }
]
```

Then in code, `env.BROKER_BRIDGE.fetch(request)` instead of
`fetch("https://tt-broker-bridge...")`. Service Bindings bypass the
zone routing entirely and don't trip the loop detector. This is a
planned refactor; see `tasks/2026-05-29-broker-bridge-phase1-plan.md`
for context.

## Source

- `worker-bridge/bridge-ibkr.js` (especially `_extractDHPrimeHex`)
- `worker/options-auto-mirror.js` (dispatch policy)
- `worker/broker-bridge-client.js` (HTTP client + audit ring)
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → IBKR LST entries

## Portfolio-aware safety (lock-tight guard)

**Critical rule (2026-06-01):** The bridge MUST reject any
position-reducing order (sell / trim / exit / close / sell_short)
for a ticker the user's broker account does NOT actually hold.
Otherwise the bridge would open a naked short for a model-only
position that never made it onto the real account (e.g. the
original entry was blocked by daily cap, $-cap, kill switch, or
auto-mirror disabled at entry time).

Implemented in `worker-bridge/bridge-guards.js → preflightOrder`:

- `REDUCING_SIDES = { trim, exit, sell, close, sell_short, short, sellshort }`
- For any reducing-side order, the bridge calls
  `brokerAdapter.getEquityPositions(env, user)` and looks up the
  ticker. Three failure modes:
  - **No position held** → reject with
    `no_open_position_for_<side>_on_<TICKER>_would_be_naked_short`
  - **Held qty < requested qty** → reject with
    `<side>_qty_<N>_exceeds_held_qty_<M>_on_<TICKER>`
    (or cap to held qty if `BROKER_POSITION_CHECK_MODE=cap`)
  - **Broker API failed** → **fail-closed**: reject with
    `position_lookup_failed_FAIL_CLOSED:<reason>`. Refusing a
    sell is far safer than placing one against unknown state.
- Modes (env var `BROKER_POSITION_CHECK_MODE`):
  - `reject` (default) — strict
  - `cap` — auto-cap qty to held qty for under-position case (no-position still rejects)
  - `off` — bypass (escape hatch; never use in production)

### Verifying

Send a fake sell order via curl with a ticker the user doesn't
own — should get a structured rejection in the bridge audit log
with `reject_reason: "no_open_position_for_sell_on_XYZ_would_be_naked_short"`.

## Future: BYOB (Bring Your Own Broker)

The bridge is operator-only today (one connected user — operator's
own IBKR via env vars). Going multi-user (Pro users connect their
own broker) is a planned product expansion. Architecture is mostly
there — see [`../tasks/2026-06-01-byob-broker-connect-plan.md`](../tasks/2026-06-01-byob-broker-connect-plan.md)
for the 4-phase rollout (Connect-Broker UI → Robinhood OAuth →
IBKR per-user wizard → compliance + observability).
