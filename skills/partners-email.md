# partners@timed-trading.com (outbound + inbound)

**WHEN to use:** Partner onboarding mail (Webull Connect registration), vendor
API requests, or any external correspondence that should look official and keep
replies on a dedicated alias.

Timed Trading separates **outbound** (SendGrid) from **inbound** (Cloudflare
Email Routing). Both must be set up for `partners@` to send and receive.

---

## Architecture

```
Outbound (you → Webull)
  scripts/send-webull-registration.mjs
    → SendGrid API (DKIM signed as @timed-trading.com)
    → From + Reply-To: partners@timed-trading.com

Inbound (Webull → you)
  Webull reply to partners@timed-trading.com
    → MX: Cloudflare Email Routing
    → Forward rule → operator Gmail (or other inbox)
```

SendGrid sends mail **out** only. It does **not** receive replies. Replies
require a Cloudflare Email Routing alias that forwards to an inbox the operator
reads daily.

---

## Step 1 — Create the inbound alias (Cloudflare)

Do this **before** sending the registration email so Webull's reply does not
bounce.

1. Cloudflare dashboard → **Email** → **Email Routing** → domain
   `timed-trading.com`
2. **Routing rules** → **Create address**
3. Custom address: `partners`
4. Action: **Send to** → the operator's primary inbox (same destination as
   `support@` / `legal@` is fine)
5. Save

Verify MX is active (should already be for other aliases):

```bash
dig +short MX timed-trading.com
```

Optional Gmail polish — reply from `partners@` in the same thread:

1. Gmail → Settings → **Accounts** → **Send mail as** → Add `partners@timed-trading.com`
2. When asked how to send, choose **Send through Gmail** (alias) — **NOT** "Send through
   timed-trading.com SMTP servers"
3. Gmail sends a verification message to `partners@` → arrives via Email Routing
   → click the link or enter the code
4. Future replies to Webull can stay on-brand from `partners@`

> **Do not use Cloudflare MX as SMTP.** `route2.mx.cloudflare.net` is inbound-only.
> Email Routing has no SMTP username/password. If Gmail prompts for an SMTP password,
> cancel and re-add the address using **Send through Gmail** instead.

---

## Step 2 — Send the Webull registration email

SendGrid domain authentication for `timed-trading.com` must be **Verified**
(SendGrid → Settings → Sender Authentication). Any `@timed-trading.com` From
address works once domain auth is verified — no per-address SendGrid setup.

```bash
# Preview payload (no send)
node scripts/send-webull-registration.mjs --dry-run

# Send (uses wrangler secret or export locally)
SENDGRID_API_KEY=... node scripts/send-webull-registration.mjs
```

Defaults:

| Field | Value |
|---|---|
| From | `partners@timed-trading.com` |
| Reply-To | `partners@timed-trading.com` |
| To | `connect.api@webull-us.com` |
| Redirect URI | `https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/callback` |
| Scope | `user:trade:wr` |

Overrides:

```bash
REDIRECT_URI=https://... TO_EMAIL=test@example.com SENDGRID_API_KEY=... \
  node scripts/send-webull-registration.mjs
```

Sanity-check SendGrid key:

```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/sendgrid-health?key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool
```

---

## Step 3 — Receive Webull's reply

When Webull replies, the message goes to **`partners@timed-trading.com`**, not
SendGrid. Cloudflare Email Routing forwards it to the operator inbox configured
in Step 1.

**Where to look in Gmail:**

- **To:** `partners@timed-trading.com` (may show as the primary recipient)
- **Subject:** often `Re: Webull Connect API registration — Timed Trading`
- Sometimes lands in **Promotions** or **Updates** — check spam once if missing

**Recommended Gmail filter** (optional):

- To: `partners@timed-trading.com` → Label: `Webull` / `Partners`

**If no reply arrives within a few days:**

1. Confirm the routing rule exists (Step 1)
2. Send a test: from a personal account, email `partners@timed-trading.com` and
   confirm it forwards
3. Check SendGrid Activity — outbound should show `202 Accepted`; inbound is
   unrelated to SendGrid

**Continuing the thread:** Reply from Gmail. If "Send mail as" is configured for
`partners@`, the operator can keep the whole thread on the domain address.
Otherwise replies may come from a personal `@gmail.com` address (works, but less
polished).

---

## Credentials in Webull's reply

Webull typically returns (UAT first):

- `WEBULL_CONNECT_CLIENT_ID` / `WEBULL_CONNECT_CLIENT_SECRET`
- `WEBULL_APP_KEY` / `WEBULL_APP_SECRET`

Store these **only** on the bridge worker (`cd worker-bridge && wrangler secret put ...`).
See broker-bridge skill when Webull scaffold is merged.

---

## Troubleshooting

### Bounce: `550 5.1.1 Address does not exist` from `route2.mx.cloudflare.net`

Cloudflare returns this when **no active routing rule** exists for that local part
at the moment the message arrives.

| Cause | Fix |
|---|---|
| Test sent **before** the `partners` rule was created | Create/enable the rule, wait ~1 min, **send a new test** |
| Rule exists but toggle is off | Enable the rule in **Routing rules** |
| Typo in address | Must be exactly `partners@timed-trading.com` |

After the rule is **Active**, check **Activity Log** — a good test shows
**Forwarded**, not **Delivery failed**. An old bounce in the inbox does not mean
the rule is broken today; retry from a different account (not the forward
destination if possible).

### Gmail "Send mail as" asks for SMTP password

Wrong path. Cloudflare Email Routing forwards inbound mail only; it does not offer
outbound SMTP credentials.

**Fix:** Remove the broken `partners@` send-as entry. Re-add it and pick
**Send through Gmail**. Verification mail lands in the forward inbox (`shashant@gmail.com`
via the routing rule).

**For the Webull registration email:** Gmail send-as is optional. Use SendGrid
(Step 2 below) — no Gmail SMTP setup required.

### DMARC report floods to `dmarc-reports@` showing "Delivery failed"

Separate issue — Gmail rate-limits forwarded DMARC XML reports. Does **not** block
`partners@` or Webull replies. See `tasks/2026-05-28-dmarc-runbook.md`.

---

## Related

- Outbound transactional mail: `worker/email.js` (`notifications@`, reply-to `support@`)
- SendGrid smoke test: `scripts/sendgrid-verify.js`
- DMARC: `tasks/2026-05-28-dmarc-runbook.md` — SendGrid + Email Routing must stay aligned
