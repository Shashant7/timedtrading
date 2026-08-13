# Onboarding a Partner to Broker Connections

**WHEN to use:** A second person (not the operator) wants to connect their
own Webull login, mirror the model into their own accounts, and receive
email about their accounts only. Also use to verify tenant isolation
after touching `/timed/broker/*`, `worker-bridge/bridge-storage.js`, or
`bridge-notifications.js`.

---

## How isolation works (read once)

There are two layers. Understanding which one enforces what prevents a
whole class of mistakes.

| Layer | Enforces |
|---|---|
| **Main worker** (`worker/index.js`, the `_isBrokerRoute` block) | Identity. Every `/timed/broker/*` call overwrites `owner` with the **session user's email**, and `_ownsAccount()` rejects account ids outside `{email}` / `{email}#…`. This is what keeps partners apart. |
| **Bridge worker** (`worker-bridge/`) | Data shape. It has **no end-user auth** — one shared `BRIDGE_OPERATOR_KEY`. Owner-scoped routes require an `owner` param; several operator routes (`/bridge/status`, `/bridge/portfolio`) are deliberately cross-tenant. |

**Consequence:** never let a browser reach the bridge directly, and never
add a `/timed/broker/*` route that takes `owner` from the request body or
query. Take it from the session, always.

Account rows are keyed `{owner_email}#webull#{slug}` in KV
(`bridge:user:*`), with `owner_email` stamped on every row.

---

## Prerequisites

| Item | Where | Notes |
|---|---|---|
| Partner has an account + is signed in | D1 `users` | Must be able to reach `/today` |
| `broker_connections_enabled = 1` | D1 `users` | Set from the Clients page — see step 1 |
| Partner's own Webull App Key + Secret | Partner's Webull dev portal | Never reuse the operator's |
| `BRIDGE_ADMIN_NOTIFY_EMAIL` | Bridge worker secret | **Decide before onboarding** — see "Email routing" |
| `SENDGRID_API_KEY` | Main worker | Owns all outbound mail |

---

## Step 1 — Provision the partner (operator, ~1 min)

Admin → **Clients** page → find the partner → tick **Broker**.

That calls `POST /timed/admin/users/${PARTNER_EMAIL}/broker-connections?enabled=true`
and sets `users.broker_connections_enabled = 1`.

Verify:

```bash
curl -s "https://timed-trading.com/timed/me" -H "Cookie: ${PARTNER_SESSION}" \
  | jq '{email, tier, broker_connections_enabled}'
```

Without the flag the partner gets `403 broker_connections_not_provisioned`
on every broker route, and the nav entry stays hidden.

> Grant **Pro** at the same time. The backend gates broker routes on the
> flag alone, but live prices and scores are Pro/VIP/Admin-only, so a
> non-Pro partner sees a half-empty page.

## Step 2 — Partner connects Webull (partner)

Partner → **Broker Connections** → paste **their own** App Key + Secret.

The worker forwards `user_id = partner_email` and `partner_email` to
`/bridge/webull/oauth/start`, which:

- creates one row per Webull sub-account, `partner@…#webull#{slug}`
- wraps the partner's keys onto each row (`webull_app_key_wrap`)
- stamps `notify_emails: [partner_email]`
- sets `broker_integration_enabled: false` — **mirroring starts OFF**

If the partner's Webull account is already linked under another owner the
connect fails `409 webull_account_already_connected`
(`findCrossOwnerWebullClash`). That is correct: one brokerage account, one
owner.

> **Credential note:** a row with no wrapped keys and no `webull_creds_env`
> falls back to the worker-level `WEBULL_APP_KEY` (the operator's). The
> self-service form always sends keys, so this only bites if someone
> creates a partner row through the admin proxy without them. If a
> partner's calls fail auth, check for the missing wrap first.

## Step 3 — Partner enables mirroring per account

Broker Connections → each account card → toggle mirror on.

This posts `/timed/broker/account/enable` with `_ownsAccount` enforced,
and sets both `broker_integration_enabled: true` and
`mirror_participant: true`.

**`mirror_participant` is the opt-in that puts the account into model
dispatch.** Model orders are sent to the bridge under the operator's
`user_id`; `handleOrderWebhook` then calls `listMirrorParticipants(env, owner)`
and fans the same signal out to every *other* owner's opted-in account
(`bridge-index.js` — the dispatcher). Sizing is relational: the partner's
qty scales by `partner_equity / model_book_usd`.

Disabling (toggle off, or **Pause all mirroring**) clears both flags via
`pauseOwnerAccounts` and leaves the connection intact, so re-enabling is
one click. Credentials are only removed by **Disconnect Webull**.

## Step 4 — Verify isolation (operator, do not skip)

Run as the **partner's** session:

```bash
for r in accounts positions equity-curve day-actions; do
  echo "── $r"
  curl -s "https://timed-trading.com/timed/broker/$r" -H "Cookie: ${PARTNER_SESSION}" \
    | jq -r '.accounts[]?.account_id // .accounts[]?.user_id' | sort -u
done
```

Every id must start with the partner's email. Any `op@…` id is a leak —
stop and fix before going further.

Then confirm the partner cannot touch the operator's accounts:

```bash
curl -s -X POST "https://timed-trading.com/timed/broker/account/enable" \
  -H "Cookie: ${PARTNER_SESSION}" -H "Content-Type: application/json" \
  -d '{"account_id":"'"${OPERATOR_EMAIL}"'#webull#roth-ira","enable":false}'
# expect: {"ok":false,"error":"account_not_owned"} (403)
```

## Step 5 — Email routing

Two mails reach an account holder, both addressed from
`resolveNotifyRecipients(env, row)`:

| Mail | Producer | Queue key |
|---|---|---|
| **Mirror Sync digest** (drift: partial fill, orphan, reconcile error) | `emitDriftNotification` | `bridge:notify:queue:*` |
| **Daily owner digest** (executed actions, positions, day P&L) 21:30 UTC | bridge cron | `bridge:notify:daily:*` |

The main worker drains **both** prefixes every 5 min via
`POST /timed/admin/broker-bridge/notify/drain` and sends through SendGrid.
Daily items ship pre-rendered; drift items coalesce into one digest per
recipient.

Recipient resolution, in order: `notify_emails` → row owner
(`email` / `owner_email` / `user_id` prefix) → `null`. **If
`BRIDGE_ADMIN_NOTIFY_EMAIL` is set, the admin is added to every
recipient list, including the partner's.** Decide deliberately:

- Want admin oversight of partner accounts → leave it set.
- Want the partner's account mail to stay private → unset it, or the
  partner's P&L and sync detail land in the operator's inbox.

Preview without consuming the queue:

```bash
curl -s -X POST "https://timed-trading.com/timed/admin/broker-bridge/notify/drain" \
  -H "Authorization: Bearer ${ADMIN_KEY}" -H "Content-Type: application/json" \
  -d '{"send":false,"limit":50}' | jq '.items[] | {user_id, user_email, kind}'
```

Force a digest for one account:

```bash
curl -s -X POST "https://timed-trading.com/timed/admin/broker-bridge/daily-digest" \
  -H "Authorization: Bearer ${ADMIN_KEY}" -H "Content-Type: application/json" \
  -d '{"user_id":"'"${PARTNER_EMAIL}"'#webull#individual-cash","dry_run":true}' | jq .
```

A quiet day (no fills, no positions) is skipped unless the row sets
`daily_digest_always_send: true`.

---

## Known limitations

- **Options auto-mirror is operator-only.** `/bridge/options/order` places
  on a single resolved account and does not fan out to participants, so a
  partner mirrors equity/ETF trades only.
- **Bridge-internal routes are cross-tenant by design** (`/bridge/status`,
  `/bridge/portfolio`, unfiltered `/bridge/account-ledger`). They need the
  operator key; never expose them to a session-authed path.
- **The 5-min reconciler iterates every tenant.** Expected — each row is
  reconciled with its own credentials.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 broker_connections_not_provisioned` | Step 1 not done |
| Page renders but no prices/scores | Partner is not Pro |
| `409 webull_account_already_connected` | That Webull account belongs to another owner |
| Partner accounts show `$0.00` | Equity snapshot missing — `bridge-equity-sync.js` stamps on positions/equity-curve; redeploy the bridge |
| Model trades not reaching partner | `mirror_participant` false — re-toggle the account |
| No daily email | Quiet-day skip, no `SENDGRID_API_KEY`, or the drain cron is not running |
