# Security Insights Review — 2026-05-10

Triage of Cloudflare Security Insights for `timed-trading.com` and
`timed-trading.ai`. Each finding is rated by **real impact** (not Cloudflare's
generic severity) and assigned an owner, action, and ETA bucket.

## TL;DR

| # | Finding | Real impact | Action |
|---|---------|-------------|--------|
| 1 | **Critical: Overprovisioned Access Policies on screener.html** | Real | Tighten in CF Dashboard + add belt-and-suspenders backend check |
| 2 | DMARC Record missing | Real (email spoofing risk) | Add DNS TXT record |
| 3 | "Always Use HTTPS" / HSTS / TLS missing on 60099094.* and url2336.* | False alarm (SendGrid tracking subs) | Verify origin = SendGrid, then dismiss or remove subdomain |
| 4 | Bot Fight Mode not enabled (.com + .ai) | Low | Enable in CF Dashboard |
| 5 | Block AI bots not enabled (.com + .ai) | Low (revenue protection) | Enable in CF Dashboard |
| 6 | Security.txt not configured | Low | **Done in this commit** — `/.well-known/security.txt` published |
| 7 | AI Labyrinth not enabled (.ai) | Optional | Skip for now |
| 8 | Turnstile not enabled (account-wide) | Low | Skip until we add a public form (signup is via Stripe Checkout already protected) |
| 9 | MFA missing on shashant@gmail.com | **High** (account takeover) | Enable Google Authenticator on the CF account today |

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

**Recommended fix (do both):**

a) **Tighten the Access policy** in Cloudflare Dashboard:
   - Zero Trust → Access → Applications
   - Find the `timed-trading.com/screener.html` application (or the
     wildcard `*.timed-trading.com/admin/*` if one exists)
   - Edit the policy to require `Emails: shashant@gmail.com` (or an
     `Admins` group) as the only "Allow" rule.
   - Optionally add a separate "Bypass" rule for the API key path
     `/timed/ingest` if needed (already documented in
     `docs/CLOUDFLARE_ACCESS_SETUP.md`).

b) **Add backend guard.** Even if the page loads, the worker should
   refuse to render screener-only routes when the JWT email is not
   admin. Open the worker's auth helper and confirm
   `requireAdmin(req, env)` is enforced on every `/timed/screener/*`
   route. If it's not, that's the next ticket.

This same review should cover the other admin-only pages:

- `system-intelligence.html`
- `ticker-management.html`
- `trade-autopsy.html`
- `admin-clients.html`
- `debug-dashboard.html`
- `model-dashboard.html`
- `brand-kit.html`

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

## What this commit ships

1. `react-app/.well-known/security.txt` (mirrored to `react-app-dist/`)
2. This review document at `docs/SECURITY_INSIGHTS_REVIEW_2026-05-10.md`

## What still needs you to log into Cloudflare Dashboard

| Action | Where | Time |
|--------|-------|------|
| **Enable 2FA on shashant@gmail.com** | My Profile → Authentication | 2 min |
| **Tighten Access policy on /screener.html** (and other admin pages) | Zero Trust → Access → Applications | 10 min |
| **Add DMARC TXT record** (`p=none` to start) | DNS → Records → Add TXT | 2 min |
| **Enable Bot Fight Mode** (both zones) | Security → Bots | 1 min |
| **Enable Block AI bots** (both zones) | Security → Bots | 1 min |
| Verify SendGrid subdomains are DNS-only and dismiss those insights | DNS → Records | 2 min |

Total dashboard time: ~20 minutes.

After you've completed the dashboard steps, re-run the Security Insights
scan from the CF Dashboard and the Critical + most Moderate items should
clear. The two SendGrid subdomain warnings will likely persist as
informational — that's expected.
