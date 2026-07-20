# Broker Bridge (IBKR + Robinhood + Webull)

**WHEN to use:** Anything involving live order execution, IBKR LST / OAuth,
the operator audit log, or the `tt-broker-bridge` worker.

> **🚧 In progress — Trade-Aware Mirror Sync v2:**
>
> | Phase | Status | What it adds |
> |---|---|---|
> | Pre-1.5 (PR #409) | ✅ shipped | Portfolio-aware lock-tight guard (catches naked-short risk at the position level) |
> | §1.5 (PR #412) | ✅ shipped | Hard naked-short deferral + per-vehicle toggle (engine + bridge + MC UI) |
> | Phase A (PR #414) | ✅ shipped | `mirror_trade_manifest` D1 writer + Mission Control debug view |
> | Phase B (PR #415) | ✅ shipped | Manifest-aware reducer — `preflightOrder` reads the manifest before the portfolio check; TRIM/EXIT on a `no_manifest_for_trade` or `mirror_suppressed` trade is rejected with an explicit reason |
> | Phase C (PR #416) | ✅ shipped | Reconciler cron (5 min RTH, configurable) + drift classification + auto-suppress after 3 drifts + on-demand `POST /bridge/reconcile` + MC "Force reconcile" button |
> | Phase D (PR #417) | ✅ shipped | Options leg-aware reconciliation + cadence routing (Trader 5min / Investor 60min / LEAPs daily) + LEAP T-30 + Options T-1 day approaching-expiration warnings + DCA tranche aggregation + OCO cancel-then-replace plan (logs only) |
> | **Phase E (this PR)** | ✅ shipped | Drift notifications (severity tiers + dedup with escalation) + MC Mirror Sync panel with operator actions (Suppress / Unsuppress / Mark Closed / Mark Manual / Force Re-Sync) + Daily Owner Email cron at 21:30 UTC + main-worker drain via `*/5` cron |
>
> Full design: [`../tasks/2026-06-01-trade-aware-mirror-sync-design.md`](../tasks/2026-06-01-trade-aware-mirror-sync-design.md).
>
> **Rollout safety:** Phase B is gated by `BROKER_MANIFEST_ENFORCE`:
> - `on` (default) — reject per the §4.1 decision matrix
> - `log` — shadow mode: log "would_reject" but allow the order
> - `off` — skip the manifest check entirely (back-compat)
>
> Start in `log` for the first week to gather data; flip to `on` once the
> log shows no false-positive rejects.

**Architecture:**

```
Main worker (timed-trading-ingest)
   ↓ HTTP / Authorization: Bearer <op key>
Bridge worker (tt-broker-bridge)
   ↓ broker-specific protocol
IBKR Client Portal / Robinhood Agentic / Webull Connect REST
```

The main worker is the **operator + audit layer**. The bridge worker is
the **broker-specific protocol shim** (OAuth, signing, retries). They're
deployed as separate Cloudflare Workers.

---

## Broker-agnostic layer (2026-07-20)

One model signal → any broker, respecting each broker's order-type support.

- **Capability registry** — `bridge-brokers.js` `BROKER_REGISTRY[<id>].capabilities`
  with two tiers: `native` (what the broker API can do — the roadmap) and
  `adapter` (what our code sends TODAY). Read via `brokerCapabilities(id, tier)`.
  Today every equity adapter is **market-only**; IBKR/Webull do options limit.
- **Order planner** — `bridge-order-plan.js`: `normalizeOrderIntent(payload)` →
  `planBrokerOrder(brokerId, intent)`. Translates market/limit and plans
  protection as **`native_bracket`** (IBKR native) → **`oco_children`** →
  **`synthetic_engine`** (engine-managed SL/TP + plain close when hit). Every
  downgrade is recorded in the `order_plan` audit row so a dropped broker-side
  stop is never silent. When adapters gain limit/bracket sends, flip the
  planner to `tier:"native"` — no caller changes.
- **Agnostic account id** — `resolveBrokerAccountId(user)` (includes
  `webull_account_id`, which the old manifest/audit chain dropped to
  `"default"`). Use it everywhere an account id is needed.

## Per-account ledger + sync (the model book vs each real account)

The main worker keeps ONE model book. Each REAL account (owner runs 5 Webull
+ 1 IBKR) now has its own ledger, in the bridge DB:

- `broker_account_ledger` — one row per real fill/close/reject, tied to
  `broker_account_id` (`bridge-account-ledger.js`).
- `broker_account_snapshot` — latest positions + cash + drift per account,
  written every reconcile cycle (broker truth for sync).
- Reads (operator-authed): `GET /bridge/account-ledger?broker_account_id=…` and
  `GET /bridge/account-snapshots?owner_id=…`.

**Order → account binding:** `handleOrderWebhook` resolves the account via
`resolveBridgeUser` (or an explicit `broker_account_id` in the payload),
computes+audits the plan, places the order, and records the fill to that
account's ledger. Manifest rows key on the real account id.

### Order-type sending (2026-07-20 — wired)
Adapters now send more than market. `GET /bridge/health` → `supported_brokers[].sends`
shows the live matrix:
- **IBKR:** market + **limit** (`buildIbkrLeg`) + **native bracket**
  (`placeBracketOrder` = parent + STP(SL) + LMT(TP) GTC children as one OCA group).
- **Webull:** market + **limit** (`buildOrderBody` LIMIT + `limit_price`).
- **Robinhood:** market only (agentic API limit unconfirmed).
The handler applies the plan's `order_type`/`tif` to the sent order and calls
`placeBracketOrder` when `plan.protection.mode === "native_bracket"` and the
adapter supports it. A limit with no valid price degrades to market.

### Multi-account fan-out (2026-07-20 — wired, flag-gated)
`BROKER_FANOUT_ENABLED` (default `"false"`). When `"true"`, one model signal
mirrors to **every** connected+enabled account for the owner
(`resolveBridgeAccounts` — the 5 Webull + 1 IBKR), each with its own
per-account idempotency key (`tt-<action>-<trade>-<accountId>`) and ledger row.
An explicit `broker_account_id` on the order always targets one account. Flip
the flag only after verifying per-account manifests + ledger look right in `log`.

### Remaining (next)
- **Webull/RH native brackets + OCO cancel-then-replace** (IBKR bracket done;
  Webull/RH protection stays `synthetic_engine`).
- **Fill webhooks** back into the model book (reconciler snapshot is the
  periodic truth today).

---

## Webull — personal Trading API (operator account)

Use this path when the operator has an **App Key + App Secret** from the
[Webull Open API portal](https://www.webull.com/open-api) (API Keys Management).
No Connect partner credentials required.

**Worker:** `tt-broker-bridge` only. The main worker (`timed-trading-ingest`) does
**not** store Webull keys.

**Vars** (`worker-bridge/wrangler.toml`):

| Var | Value |
|---|---|
| `WEBULL_AUTH_MODE` | `personal` |
| `WEBULL_ENVIRONMENT` | `prod` (live keys) or `uat` (sandbox) |

**Secrets** (Cloudflare Dashboard → Workers → **tt-broker-bridge** → Settings →
Variables and Secrets → Secrets):

| Secret | Source |
|---|---|
| `WEBULL_APP_KEY` | Open API portal → Generate Key |
| `WEBULL_APP_SECRET` | Shown once at key generation |

Leave **2FA unchecked** on the Webull key application for headless bridge use.

After pasting real values, redeploy the bridge (push to `main` or
`cd worker-bridge && wrangler deploy`).

**Connect operator account:**

```bash
curl -s -X POST "https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/start" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"shashant@gmail.com"}' | python3 -m json.tool
```

Personal mode returns `personal: true` and `webull_account_id` immediately (no browser redirect).

---

## Webull Connect (partner OAuth — BYOB path)

Full plan: [`../tasks/2026-06-15-webull-connect-integration-plan.md`](../tasks/2026-06-15-webull-connect-integration-plan.md)

**Registration (blocking):** email `connect.api@webull-us.com` with company
name + redirect URL:

```text
https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/callback
```

Set `WEBULL_AUTH_MODE=connect`, then add all four bridge secrets:

```bash
cd worker-bridge
wrangler secret put WEBULL_CONNECT_CLIENT_ID
wrangler secret put WEBULL_CONNECT_CLIENT_SECRET
wrangler secret put WEBULL_APP_KEY
wrangler secret put WEBULL_APP_SECRET
wrangler deploy
```

**Connect flow (operator):**

```bash
# Start OAuth (returns authorize_url when creds configured)
curl -s -X POST "https://tt-broker-bridge.../bridge/webull/oauth/start" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email.com"}' | python3 -m json.tool

# Probe read path after connect
curl -s -X POST ".../bridge/test/webull-call" \
  -H "Authorization: Bearer $BROKER_BRIDGE_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"operator@email.com","action":"get_portfolio"}' | python3 -m json.tool
```

**Mock testing without creds:** set `BROKER_BRIDGE_MOCK=true` in
`worker-bridge/wrangler.toml`, then `POST /bridge/webull/oauth/start`
finalizes a mock `broker=webull` user instantly.

**Key modules:** `bridge-webull.js`, `bridge-webull-api.js`,
`bridge-webull-auth.js`, `bridge-webull-sign.js`, `bridge-webull-tokens.js`

Vars: `WEBULL_AUTH_MODE` (`personal`|`connect`), `WEBULL_ENVIRONMENT` (`uat`|`prod`)

---

## Repo layout

| Path | Purpose |
|---|---|
| `worker/broker-bridge-client.js` | Client that calls the bridge from the main worker; manages local audit ring buffer in KV |
| `worker/options-auto-mirror.js` | Options auto-execution policy + dispatch |
| `worker-bridge/` | Bridge worker source — separate Wrangler project |
| `worker-bridge/bridge-ibkr.js` | IBKR LST flow (DH + RSA + HMAC) |
| `worker-bridge/bridge-robinhood.js` | Robinhood Agentic flow |
| `worker-bridge/bridge-webull.js` | Webull Connect REST adapter |
| `worker-bridge/bridge-webull-auth.js` | Webull OAuth start/callback/disconnect |
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
| `BROKER_NOTIFY_DM_USER` | `worker/wrangler.toml [vars]` | `"true"` to DM users directly via the existing TT Discord bot (in addition to email) when bridge drift notifications fire. Default `"false"`. Requires the user to have linked Discord via OAuth (`users.discord_id` populated) and have DMs-from-server-members enabled. |
| `BROKER_OPERATOR_DISCORD_WEBHOOK_URL` | Bridge worker secret (optional) | Per-channel webhook for cross-team critical-tier visibility. Operator-only side channel — the user-facing path is `BROKER_NOTIFY_DM_USER` above. |

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
- `worker-bridge/bridge-webull.js` + `tasks/2026-06-15-webull-connect-integration-plan.md`
- `worker/options-auto-mirror.js` (dispatch policy)
- `worker/broker-bridge-client.js` (HTTP client + audit ring)
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → IBKR LST entries

## Webull Connect registration (before credentials)

Partner onboarding mail goes **from and reply-to** `partners@timed-trading.com`.
Outbound uses SendGrid; **inbound replies** use Cloudflare Email Routing to the
operator inbox — SendGrid does not receive mail.

Full runbook + send script: [`partners-email.md`](partners-email.md)

```bash
SENDGRID_API_KEY=... node scripts/send-webull-registration.mjs
```

---

## Future: BYOB (Bring Your Own Broker)

The bridge is operator-only today (one connected user — operator's
own IBKR via env vars). Going multi-user (Pro users connect their
own broker) is a planned product expansion. Architecture is mostly
there — see [`../tasks/2026-06-01-byob-broker-connect-plan.md`](../tasks/2026-06-01-byob-broker-connect-plan.md)
for the 4-phase rollout (Connect-Broker UI → Robinhood OAuth →
IBKR per-user wizard → compliance + observability).
