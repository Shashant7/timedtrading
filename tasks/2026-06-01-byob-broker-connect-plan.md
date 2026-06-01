# BYOB — Bring Your Own Broker Plan

**Created:** 2026-06-01 · **Owner:** TBD · **Status:** Draft

The broker bridge (Phase 1, 2026-05-29) was scaffolded multi-user from
day one — per-user storage, per-user OAuth, per-user encrypted tokens,
per-user risk caps, per-user audit log. But it ships today with one
connected user (`operator`) hard-wired via the bridge's env-var IBKR
creds. This plan documents how we go from operator-only to BYOB — Pro
users connect their own broker and auto-mirror runs on their account.

---

## Today's state (Phase 1, shipped)

| Capability | Status | Where |
|---|---|---|
| Per-user KV storage | ✅ | `worker-bridge/bridge-storage.js` → `readUser` / `writeUser` |
| Per-user OAuth start/callback/disconnect endpoints | ✅ | `worker-bridge/bridge-auth.js` |
| Per-user IBKR connect endpoint | ✅ | `POST /bridge/ibkr/connect` |
| Per-user encrypted token storage (AES-256-GCM) | ✅ | `bridge-crypto.js` → `_decryptPrepend` |
| Per-user risk caps (`max_per_order_usd`, `max_orders_per_day`, `max_account_pct`) | ✅ | `bridge-guards.js → resolveUserCaps`; editable from MC (PR #406) |
| Per-user `broker_integration_enabled` toggle | ✅ | MC toggle (PR #406) |
| Per-user audit log | ✅ | `/bridge/audit?user_id=X` |
| Global kill switch | ✅ | `/bridge/killswitch` |
| Options auto-mirror per-user prefs | ✅ | `worker/options-auto-mirror.js` → KV `timed:options:auto-mirror:<email>` |
| AI CIO pre-execution veto | ✅ | shipped Phase 5 |
| **Connected users today** | **1 (`operator`)** | env-var-based IBKR creds on the bridge worker |

The architecture supports BYOB. What's missing is mostly user-facing UI
and the second half of each broker's OAuth flow.

---

## Roadmap — 4 phases

### Phase 1 — Connect-Broker UI scaffold (frontend-only, ~3-5 days)

**Goal:** ship the user-facing `/account/brokers` page that lists
connected brokers, their balance/positions, and a `+ Connect <broker>`
button per supported broker. NO new broker integration yet — the
button calls the EXISTING operator endpoints. We're testing the
whole user-facing flow against the operator's already-connected IBKR.

**Tasks:**

- [ ] **Route**: `/account/brokers.html` (or tab inside `/portfolio.html`)
- [ ] **AuthGate**: `requiredTier="pro"` so only paying users see it
- [ ] **List endpoint**: re-use `GET /timed/admin/broker-bridge/portfolio`
      but gate to "show me only MY user_id" (currently lists all users
      — needs a `?for_self=true` flag that maps to the auth'd user's
      email)
- [ ] **Per-broker cards**: same shape as MC's "Account Balance &
      Positions" block but scoped to the user's own row
- [ ] **Caps editor**: same controls as MC's "Edit caps" / "Apply
      small-account defaults ⚡", but the `apply_to_self` write path
      auto-fills `user_id` from the auth'd user
- [ ] **Connect buttons**: stubbed — clicking opens a `<dialog>` that
      says "Coming soon: IBKR / Robinhood / Coinbase connect flow"
- [ ] **Disconnect button**: calls existing `POST /bridge/oauth/disconnect`
- [ ] **Empty state**: when user has no brokers connected, large
      "Connect a broker to enable auto-trading" CTA

**Acceptance:**
- Pro user navigates to `/account/brokers` → sees the page
- If they're the operator, their existing IBKR card shows with live balance
- All other Pro users see the empty state with disabled connect buttons
- "Edit caps" works for the auth'd user only — operator-only enforcement removed for self-edit (still enforced for other-user edit)

**Risk:** low — no new backend, no new credentials.

---

### Phase 2 — Robinhood connect flow (~3 days)

**Goal:** the first end-to-end BYOB broker. Robinhood is the easier
path because its OAuth is standard OAuth 2.0 with a hosted consent
page.

**Tasks:**

- [ ] Register a TT app with Robinhood developer portal:
      - `client_id`, `client_secret` → bridge env vars
      - Redirect URI: `https://timed-trading.com/bridge/oauth/callback?broker=robinhood`
      - Required scopes: `read`, `trade`, `funding` (read-only for funding)
- [ ] Wire `handleOauthStart(env, req, "robinhood")` in `bridge-auth.js`:
      - Generate state nonce, store in KV with 10-minute TTL
      - Redirect to `https://api.robinhood.com/oauth2/authorize?...`
- [ ] Wire `handleOauthCallback(env, req)`:
      - Validate state nonce
      - POST to `https://api.robinhood.com/oauth2/token` with `code` + `client_secret`
      - Receive `access_token`, `refresh_token`, `expires_in`
      - Encrypt tokens via `_encryptPrepend` (new helper — mirror of `_decryptPrepend`)
      - Write to `user.robinhood_tokens` via `writeUser`
      - Mark `user.status = "connected"`, `user.broker = "robinhood"`
      - Redirect back to `/account/brokers?connected=robinhood`
- [ ] Wire `bridge-robinhood.js`:
      - `placeOrder(env, user, order)` — POST `/api/orders/` with bearer token
      - `getPortfolio(env, user)` — GET `/api/accounts/{accountId}/`
      - `getEquityPositions(env, user)` — GET `/api/positions/`
      - `_refreshTokenIfExpiring(env, user)` — auto-refresh < 24h before expiry
- [ ] Daily cron: `refreshBrokerTokens(env)` walks all connected users with `broker=robinhood`, refreshes any token < 7 days from expiry
- [ ] UI: connect-Robinhood button in Phase 1's `/account/brokers` page
- [ ] Test: full flow from anonymous user → sign up → pay → connect → place a $5 mock order through bridge → see in audit log

**Acceptance:**
- New Pro user can connect Robinhood in < 60 seconds
- Their account balance + positions appear in `/account/brokers`
- Auto-mirror is OFF by default; user must explicitly enable
- Daily token-refresh cron prevents expiry-related lockouts

**Risk:** medium — depends on Robinhood's app approval (can take 1-2 weeks).

---

### Phase 3 — IBKR per-user wizard (~5-7 days)

**Goal:** the highest-value broker for serious traders. IBKR's auth is
3 different things depending on which API tier you use:

| Option | What it is | UX | Cloud-compatible | Verdict |
|---|---|---|---|---|
| A | Client Portal Gateway (Java client run locally) | terrible (user runs a daemon) | ❌ requires localhost | rejected |
| B | OAuth 1.0a Extended (what operator uses today) | painful but workable | ✅ | **Phase 3a** |
| C | Web API OAuth 2.0 (IBKR's new flow, rolling out 2026) | one-click | ✅ | **Phase 3b — when GA** |

**Phase 3a — OAuth 1.0a Extended wizard**

The operator already proved this works end-to-end. For a real user
it's painful but achievable: they generate three pieces in IBKR's
developer portal and paste them into our wizard.

- [ ] Wizard page: `/account/brokers/connect/ibkr-oauth1.html`
- [ ] Step 1: "Open IBKR Developer Portal" — deep link to https://www.interactivebrokers.com/sso/Login (with copy of where to click)
- [ ] Step 2: "Generate a consumer key" — screenshot from IBKR portal
- [ ] Step 3: "Generate DH params locally":
      ```bash
      openssl dhparam -out dh.pem 2048
      openssl dhparam -in dh.pem -text -noout | grep -A 20 'prime:' \
        | grep -v 'generator' | tr -d ' :\n'
      ```
      Show this command with a "Copy" button. Warning: paste the hex
      prime ONLY, not the whole openssl output (this was the operator
      bug in PR #375 — `_extractDHPrimeHex` now slices defensively).
- [ ] Step 4: Three text fields:
      - **Consumer Key** (text input)
      - **DH Prime (hex)** (textarea, monospace, with length validator: 256/384/512 bytes)
      - **RSA Private Key (PEM)** (textarea, with `-----BEGIN`/`-----END` validator)
- [ ] "Test Connection" button → calls a new `POST /bridge/ibkr/connect-byob`:
      - Validates DH prime length
      - Encrypts the three values via `_encryptPrepend`
      - Stores at `user.ibkr_creds = { consumer_key_enc, dh_prime_enc, private_key_enc }`
      - Calls `_exchangeLst` to fetch a Live Session Token
      - Calls `/portfolio/accounts` to fetch the IBKR account number
      - Returns `{ ok, account_id: 'U12345678', equity: 12450 }`
- [ ] Step 5: Success screen showing the discovered account + equity, "Connected ✓", with Enable Live Trading toggle

**Phase 3b — IBKR Web API OAuth 2.0 (when GA)**

When IBKR finishes their OAuth 2.0 rollout (their docs say "in beta"
as of mid-2026), replace 3a with a standard one-click flow:

- [ ] Register TT as an IBKR OAuth 2.0 client
- [ ] Add `?broker=ibkr` branch to `handleOauthStart` / `handleOauthCallback`
- [ ] Migrate existing Phase 3a users by emailing them to re-connect
- [ ] Sunset Phase 3a wizard 60 days after 3b ships

**Acceptance (3a):**
- Operator can re-connect their existing IBKR via the wizard (vs env vars) and the bridge keeps working
- A new test user can paste their own IBKR creds and see their account balance within 5 minutes of starting

**Risk:** medium — user has to do real work in IBKR's portal. Conversion will be lower than Robinhood. Worth investing in the wizard polish.

---

### Phase 4 — Compliance + observability (parallel, ~1-2 weeks)

Most teams underestimate this. None of it blocks shipping Phase 1-3
to operator's own account, but ALL of it blocks shipping to a real
third user.

#### Legal / compliance

- [ ] **Terms of Use addendum** — broker-specific section. Key clauses:
      - "User authorizes Timed Trading to place orders on User's broker account on User's behalf, based on signals generated by the Timed Trading model."
      - "User remains solely responsible for trading decisions and outcomes."
      - "Timed Trading does not hold funds, take discretion over funds, or guarantee outcomes."
      - "User may disconnect their broker or pause auto-trading at any time."
      - Per-jurisdiction disclaimers (US, CA, EU at minimum)
- [ ] **Securities-attorney 30-minute review** — the framing above keeps TT in the "tool / alert service" category vs "registered investment adviser." Discord groups + signal services like TrendSpider operate this way. A quick attorney call before going public removes any ambiguity.
- [ ] **First-connect modal** — user MUST type "I understand" + check terms box before `broker_integration_enabled` can flip to `true` for them. Default state is OFF.
- [ ] **Per-user usage email + monthly statement** — weekly digest "you placed N trades worth $X via TT this week"; monthly summary. Required for "the user is in the loop" framing.

#### Risk controls

- [ ] **Mandatory cap acceptance** — on first connect, force the small-account defaults (or user-set values). UI: "We've set $X/order based on your equity. You can lower this. Raising it requires confirming the higher risk. Cap of raise: 25% of equity per order, max."
- [ ] **Global per-user max** — even if user tries to set caps higher, the bridge enforces a server-side absolute max (e.g. $10,000/order regardless of user setting, until they pass an additional verification step)
- [ ] **Daily P&L tripwire** — if user's account drops >20% in a day, auto-disable their `broker_integration_enabled` + email them. Operator can re-enable after review.
- [ ] **Per-broker max % of account** — already in `user.user_caps.max_account_pct` (default 25%). Enforce server-side.

#### Operational

- [ ] **Connection health dashboard** — daily cron pings every connected user's broker, marks `last_health_check_ok` / `last_health_check_failed_at`, alerts user if their token's about to expire
- [ ] **Token refresh cron** — for Robinhood (90-day expiry) auto-refresh + email user 7 days before expiry; for IBKR (90-day DH session) prompt re-auth
- [ ] **Per-user audit export** — UI button on `/account/brokers` to download CSV of all the user's auto-mirror orders (compliance + their own records)
- [ ] **Operator override (MC)** — admin can force-disable any user (already exists via `POST /bridge/enable`); add a force-disable + reason field for audit
- [ ] **Connection state webhook** — when a user disconnects, fires a `tt-broker-disconnected` event that suppresses any pending auto-mirror orders for that user in-flight

#### Monitoring

- [ ] **Bridge health metrics**: orders/day, rejects/day broken down by `reject_reason`, p95 order latency, per-broker uptime
- [ ] **Per-user metrics in Mission Control**: top connected users, biggest accounts, recent disconnects
- [ ] **Daily ops digest**: emailed to operator with yesterday's bridge stats

**Acceptance:**
- Terms attorney review complete + signed off
- First-connect modal forces explicit consent
- Daily-P&L tripwire firing in shadow mode for at least 14 days before going live
- Operator-facing dashboard shows real-time health

**Risk:** legal review is the long pole. Start it in parallel with Phase 1.

---

## Sequencing + dependencies

```
Week 1-2:  Phase 1 (Connect-Broker UI scaffold)
              + Phase 4 legal review kicked off in parallel
Week 2-3:  Phase 2 (Robinhood) — needs RH app approval pending
              + Phase 4 risk controls (small-account defaults already in)
Week 3-4:  Phase 3a (IBKR OAuth 1.0a wizard)
              + Phase 4 ops cron jobs
Week 4-5:  Beta — invite 3-5 trusted users to BYOB on their own accounts
Week 6+:   Public launch when terms + tripwires + observability all green
Later:     Phase 3b (IBKR OAuth 2.0) when IBKR GA'd
```

## Out of scope (intentionally deferred)

- **Options auto-mirror BYOB** — equity first. Options is technically the same flow (we route to the same broker, just with options contracts) but the risk profile + compliance posture is materially different. Add to Phase 5 once equity BYOB has proven out.
- **Multi-broker per-user** — one user with both IBKR + Robinhood connected. Architecture supports it (`user.broker` is the active one), but UX is confusing. Defer until at least 3 users ask for it.
- **Crypto brokers (Coinbase / Kraken)** — different regulatory regime (crypto exchanges aren't broker-dealers), different volatility, different cap shape. Defer to a dedicated v2.
- **Tax-lot accounting export** — useful but not blocking. Coordinate with operator's existing position-reporting in `/portfolio`.

## Reference docs

- `tasks/2026-05-29-broker-bridge-phase1-plan.md` — original bridge architecture
- `tasks/2026-05-28-robinhood-agentic-trading-research.md` — RH MCP research
- `tasks/2026-05-30-ibkr-auto-execution-plan.md` — current operator-only IBKR setup
- `skills/broker-bridge.md` — operator playbook (where this should be expanded post-BYOB)
- `skills/user-state-matrix.md` — per-user state and Pro-gating

## How to track progress

This file is the plan. Status updates land in `tasks/todo.md` under
the BYOB section as each phase lands. Phase-completion writeups go
into `tasks/lessons.md` with the same date-stamped format as other
features.
