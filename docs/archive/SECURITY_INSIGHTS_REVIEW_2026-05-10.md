# Security Insights Review — 2026-05-10

> **Final resolution status: 2026-05-10 23:35 UTC.** All findings actioned.
> 1 finding remains as accepted false-positive (paid-SaaS architecture).
> See "Final state" section at the bottom.

Triage of Cloudflare Security Insights for `timed-trading.com` and
`timed-trading.ai`. Each finding is rated by **real impact** (not Cloudflare's
generic severity) and assigned an owner, action, and ETA bucket.

## TL;DR

| # | Finding | Real impact | Status |
|---|---------|-------------|--------|
| 1 | **Critical: Overprovisioned Access Policies on screener.html** | Real | ✅ **Done** — Admin Pages app with `Emails: shashant@gmail.com` policy + PR #95 backend gate. Incognito-tested. |
| — | New Critical: Overprovisioned on `index-react.html` (post-fix scan) | False positive | ⚠️ **Accepted risk** — see Final state section. Paid-SaaS public-dashboard pattern; the Stripe subscription check is the actual paywall. |
| 2 | DMARC Record missing | Real (email spoofing risk) | ✅ **Done** — `v=DMARC1; p=none;` live; ramp to `p=reject` calendared for +4 weeks |
| 3 | "Always Use HTTPS" / HSTS / TLS missing on 60099094.* and url2336.* | False alarm (SendGrid tracking subs) | ✅ **Dismissed** — confirmed CNAMEs to `sendgrid.net` |
| 4 | Bot Fight Mode not enabled (.com + .ai) | Low | ✅ **Done** by user (2026-05-10) |
| 5 | Block AI bots not enabled (.com + .ai) | Low (revenue protection) | ✅ **Done** by user (2026-05-10) |
| 6 | Security.txt not configured | Low | ✅ **Done** in PR #93 — `/.well-known/security.txt` live |
| 7 | AI Labyrinth not enabled (.ai) | Optional | Skip — wait for actual scraping pressure |
| 8 | Turnstile not enabled (account-wide) | Low | Skip until we add a public form |
| 9 | MFA missing on shashant@gmail.com | **High** (account takeover) | ✅ **Done** — 2FA enabled (2026-05-10) |
| — | SPF didn't include SendGrid (discovered during DMARC setup) | Real (DKIM-only auth) | ✅ **Done** — SPF now `include:_spf.mx.cloudflare.net include:sendgrid.net ~all` |

---

## 1. CRITICAL — Overprovisioned Access Policies on `timed-trading.com/screener.html`

**What it means.** The Cloudflare Access policy on `/screener.html` allows
broader access than the page warrants. Today the page is meant for the admin
only (`shashant@gmail.com`), but the Access policy probably allows any
authenticated SSO user (or worse, no Access policy at all).

**Code-side observation.** The page uses CSS to hide nav links from non-admin
users (`body:not([data-user-role="admin"]) a[data-admin-only]` selector), but
**hiding a link is not access control.** Anyone who knows the URL can fetch
the HTML. The data behind the page comes from `/timed/screener/candidates`
which has its own auth check on the worker, so the actual data exposure is
limited — but the page renders empty/error and reveals the existence of
the admin tool.

**Status.**

a) ✅ **Backend defense in depth — DONE in P0.7.127.** The Pages
   `_worker.js` now intercepts GETs for known admin-only HTML paths and
   calls `/timed/me` to confirm the requester is admin. Non-admins get a
   403 page (no React, no asset deps, just a plain "Admin only" message)
   instead of the actual tool's HTML. Pages currently gated:

   ```
   /admin-clients.html
   /screener.html
   /system-intelligence.html
   /ticker-management.html
   /trade-autopsy.html
   /debug-dashboard.html
   /model-dashboard.html
   /brand-kit.html
   ```

   Worker's API endpoints (`/timed/admin/*`, `/timed/screener/*`) were
   already protected by `requireKeyOrAdmin` (125+ call sites). Nothing
   changed there. This new gate stops anonymous URL discovery of the
   admin surface — not just the data behind it.

b) ⏳ **Tighten the Access policy** in Cloudflare Dashboard (still your
   action):
   - Zero Trust → Access → Applications
   - Find the `timed-trading.com/screener.html` application (or the
     wildcard `*.timed-trading.com/admin/*` if one exists)
   - Edit the policy to require `Emails: shashant@gmail.com` (or an
     `Admins` group) as the only "Allow" rule.
   - Optionally add a separate "Bypass" rule for the API key path
     `/timed/ingest` if needed (already documented in
     `docs/CLOUDFLARE_ACCESS_SETUP.md`).

   Even with the new backend gate, the CF Access policy still matters
   because it stops requests before they hit our infrastructure
   (saves bandwidth + invocations, and prevents pre-auth recon). Both
   gates together = real defense in depth.

This same admin-page list (the 8 pages above) should be in the Access
application policy. The frontend nav already hides them via
`data-admin-only`, but the gate is what enforces it.

Suggested CF Access "Admin" application policy:
```
Application path:  *.timed-trading.com/screener.html
                   *.timed-trading.com/admin-clients.html
                   *.timed-trading.com/system-intelligence.html
                   *.timed-trading.com/trade-autopsy.html
                   *.timed-trading.com/ticker-management.html
                   *.timed-trading.com/debug-dashboard.html
                   *.timed-trading.com/model-dashboard.html
                   *.timed-trading.com/brand-kit.html
Policy: Allow if Emails == [shashant@gmail.com]
```

---

## 2. DMARC Record Error (Low severity, real impact)

**What it means.** Without a DMARC TXT record at `_dmarc.timed-trading.com`,
attackers can spoof emails appearing to come from `@timed-trading.com`
addresses. Customers who receive a spoofed email may have it land in their
inbox (legitimate-looking) or have legitimate trade alerts marked as spam.

**Recommended fix.** Add this DNS TXT record on Cloudflare:

```
Name:  _dmarc.timed-trading.com
Type:  TXT
Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@timed-trading.com; ruf=mailto:dmarc-reports@timed-trading.com; fo=1; aspf=r; adkim=r
```

Start with `p=none` (monitor only). After 2-4 weeks of receiving DMARC
reports and confirming no false-positives on legit SendGrid traffic,
upgrade to `p=quarantine` then eventually `p=reject`.

You'll also want a SendGrid mailbox (`dmarc-reports@`) to receive the
aggregate reports — or pipe them to a service like dmarcian or Postmark.

**Verify SPF + DKIM are already correct.** SendGrid's setup wizard usually
adds these; check:

```
dig +short TXT timed-trading.com  # should include "v=spf1 include:sendgrid.net ~all"
dig +short TXT s1._domainkey.timed-trading.com  # SendGrid CNAME → DKIM
dig +short TXT s2._domainkey.timed-trading.com  # SendGrid CNAME → DKIM
```

If SPF or DKIM is missing, fix those first — DMARC checks both.

---

## 3. TLS/HTTPS/HSTS missing on `60099094.timed-trading.com` and `url2336.timed-trading.com`

**What these are.** Both are SendGrid email-tracking subdomains (CNAME'd to
`sendgrid.net` for click tracking and unsubscribe links). The naming pattern
(`<numeric-id>.<domain>` and `urlNNNN.<domain>`) is SendGrid's standard.

**Real impact: zero.** SendGrid's tracking infrastructure does support HTTPS
on its own — what Cloudflare is observing is that *port 80 reachability* on
the CNAME target doesn't redirect to HTTPS at the Cloudflare edge because
these subdomains are likely **Cloudflare DNS-only (orange cloud OFF)**.

**Recommended action — pick ONE:**

a) **Easiest (recommended):** In Cloudflare DNS, find the CNAME records
   `60099094` and `url2336`, hover the DNS-only/Proxied toggle. If they
   are DNS-only (gray cloud), leave them as-is and **dismiss the
   insight in CF Dashboard** — these are out of our control.

b) If you ever rotate to a new sender or stop using SendGrid click
   tracking, **delete the CNAME records** entirely. The insights will
   clear automatically.

c) Do not try to enable "Always Use HTTPS" for these — Cloudflare can't
   redirect traffic that isn't passing through it.

---

## 4. Bot Fight Mode not enabled (.com + .ai)

**Recommended action.** Enable in CF Dashboard → Security → Bots →
Bot Fight Mode = On. **Cost: $0.** Catches obvious scrapers + low-effort
bots. No false-positive risk for our human users.

---

## 5. Block AI bots / AI Labyrinth (.com + .ai)

**Why it matters.** Our backtest results, FAQ, and Daily Brief copy are
non-trivial product IP. We don't need GPT-Bot, ClaudeBot, Perplexity-Bot,
etc. crawling and reproducing it inside their training data.

**Recommended action.**
- Enable **Block AI bots** in CF Dashboard → Security → Bots → AI Bots
  on both `timed-trading.com` and `timed-trading.ai`. Cost $0.
- **AI Labyrinth** is a more aggressive trap that wastes compute of bots
  that ignore robots.txt. Optional — skip for now (tiny edge cost may
  apply at scale).

Belt and suspenders: add this to `react-app/robots.txt` (does not exist
today — should add):

```
# react-app/robots.txt
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: cohere-ai
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: *
Allow: /
Disallow: /admin*
Disallow: /screener*
Disallow: /trade-autopsy*

Sitemap: https://timed-trading.com/sitemap.xml
```

---

## 6. Security.txt not configured — DONE

`react-app/.well-known/security.txt` published in this commit (mirrored to
`react-app-dist/.well-known/security.txt`). Includes contact email,
expiry date (2027-05-10), in-scope / out-of-scope statement, and
canonical URL.

After deploy, verify with:

```
curl https://timed-trading.com/.well-known/security.txt
```

The CF insight should clear within 24 hours of being published.

---

## 7. AI Labyrinth (.ai) — skip

Optional anti-AI-bot trap. Adds latency for humans on bot-suspect requests.
Wait until we see actual scraping pressure in CF analytics before enabling.

---

## 8. Turnstile (account-wide) — skip for now

Turnstile is Cloudflare's CAPTCHA replacement. We don't have a public form
right now (the only signup path is Stripe Checkout, which has its own bot
protection). When we add a contact form or open registration, enable
Turnstile then.

---

## 9. MFA missing on shashant@gmail.com — HIGH PRIORITY

**This is the most important item on the list, despite Cloudflare rating
it "Moderate".** A compromised account on the Cloudflare dashboard means
total system takeover (DNS + Pages + Workers + secrets + KV + D1). With
SSO into Google enabled, an attacker who phishes the Google password but
not the second factor still gets blocked.

**Recommended action — do this today, takes 2 minutes:**

1. Cloudflare Dashboard → My Profile (top-right) → Authentication
2. Two-Factor Authentication → **Enable**
3. Set up Google Authenticator (or 1Password's authenticator) — preferred
4. Save the 8 recovery codes in 1Password
5. **Test by signing out and back in with the new 2FA**

After enabling, also flip on the account-level requirement:

- Manage Account → Members → Account Configuration → "Require members to
  set up 2FA" = ON. (Effectively no-op while you're the only member, but
  prevents accidentally adding a member without 2FA.)

---

## What's been shipped (cumulative)

### PR #93 (merged)
1. `react-app/.well-known/security.txt` — RFC 9116 disclosure policy
2. `react-app/robots.txt` — block 13 AI crawlers + admin paths
3. This review document

### P0.7.127 (this commit)
4. `react-app/_worker.js` — admin-page server-side gate. 8 admin-only HTML
   paths now require an admin role on `/timed/me` before the static asset
   is served. Non-admins see a clean 403 page. Defense in depth for the
   CF Access policy.

### Done by you on the Cloudflare Dashboard
5. Bot Fight Mode enabled (both zones) — 2026-05-10
6. Block AI bots enabled (both zones) — 2026-05-10

## Final state — 2026-05-10 23:35 UTC

All findings actioned. Cloudflare Dashboard work completed:

### Cloudflare Access — split into two apps

- **`Timed Trading - User Pages`** — destinations: `/index-react.html`,
  `/simulation-dashboard.html`, `/daily-brief.html`, `/alerts.html`,
  `/investor-dashboard.html`. Policy `Allow users` with
  `Include: Everyone` (any user authenticated via Google SSO). This is
  the paid-user gate; the actual subscription check happens in the
  worker via Stripe.
- **`Timed Trading - Admin Pages`** — single regex destination matching
  the 8 admin HTML files. Policy `Admin Only` with
  `Include: Emails: shashant@gmail.com`. Confirmed via incognito test:
  non-admin Google user → "You don't have access to this resource";
  admin → page loads.

### Email auth (anti-spoofing)

```
SPF:   v=spf1 include:_spf.mx.cloudflare.net include:sendgrid.net ~all
DKIM:  s1._domainkey + s2._domainkey CNAMEs to u60099094.wl095.sendgrid.net
DMARC: v=DMARC1; p=none;
```

DMARC reporting addresses (`rua/ruf`) intentionally omitted — the user
opted out of inbound report parsing. Calendar reminders set for the
ramp:

| +2 weeks | DMARC `p=none` → `p=quarantine; pct=25` |
| +3 weeks | DMARC → `p=quarantine` (100%) |
| +4 weeks | DMARC → `p=reject` — full anti-spoofing |
| +12 weeks | Re-run CF Security Insights scan |
| Annually | Renew `Expires:` date in `/.well-known/security.txt` |

### Other dashboard items completed

- 2FA enabled on `shashant@gmail.com` ✅
- Bot Fight Mode enabled on `timed-trading.com` + `timed-trading.ai` ✅
- Block AI bots enabled on both zones ✅
- SendGrid subdomain TLS/HSTS/HTTPS warnings dismissed
  (false positives — SendGrid CNAMEs are DNS-only, out of CF's edge) ✅

## Accepted false positive (1 finding remains)

**Critical: Overprovisioned Access Policies on
`timed-trading.com/index-react.html`.**

This fires because the `Allow users` policy on the User Pages app uses
`Include: Everyone` (any user authenticated via Google SSO). Cloudflare's
automated scanner treats `Include: Everyone` as overprovisioned by default.

**Why we accept it:** `index-react.html` is the public dashboard for a
paid SaaS product. Anyone with a Google account *should* be able to load
the page and sign in — that's the signup funnel. The actual access
control is the Stripe subscription check in the worker (per-feature),
not at CF Access. Restricting to a fixed email list would break signups.

Defense in depth on this page is layered:
1. CF Access — identifies the user (Google SSO)
2. Worker `requireKeyOrAdmin` / Stripe subscription check — gates Pro features
3. Worker auth middleware — gates raw data API endpoints
4. PR #95 backend gate — extra layer for admin-only HTML

**Workarounds attempted:** changing `Include: Everyone` →
`Include: Login Methods: Google` was tried as a more-specific rule, but
the scanner's heuristic still flagged it. Functionally equivalent.
Cloudflare doesn't permit hand-dismissing automated infra-security
findings, so this Critical will continue to surface in scans.

**Action: monitor only.** If Cloudflare ever surfaces additional
context (e.g. an actual exposed admin endpoint behind this policy),
revisit. Until then this is accepted-risk and documented here.

## Things shipped to repo

- PR #93: `security.txt` + `robots.txt` + this review doc
- PR #95: `_worker.js` admin-page gate (defense in depth on 8 admin pages)
- PR #97 (this commit): final-state update to this doc
