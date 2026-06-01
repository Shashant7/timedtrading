# User State Matrix

**WHEN to use:** Before touching paywall, auth-gate, Stripe webhook, or
any UI that conditionally renders Pro features (activity strip, bell,
right rail data, etc.). This is the canonical map of every state a user
can be in and what each surface must do.

---

## Identity states

| # | Identity | Has D1 row? | Has CF Access cookie? | Lands on | Notes |
|---|---|---|---|---|---|
| 1 | New user, never seen TT | no | no | `/splash.html` | Hero case. Browses public funnel (`splash` / `learn` / `proof` / `faq`). |
| 2 | Returning anonymous | no | no | `/splash.html` | Same as #1 — local cache empty, no cookie. |
| 3 | Authenticated, never paid | yes (auto-provisioned on first SSO) | yes | `today.html` → `PaywallScreen` | Sees public chrome; chrome strips below disabled. |
| 4 | Authenticated, trialing | yes | yes | Full Pro UI | Trial countdown chip in footer (`X days left in trial`). |
| 5 | Authenticated, trial expired (auto, no payment) | yes | yes | `PaywallScreen` | Stripe doesn't fire `subscription.deleted` for never-paid trials — the trial just ends. `subscription_status` becomes `canceled` or `incomplete_expired`. |
| 6 | Authenticated, trial expired, CC fail | yes | yes | Pro UI for 3 days then `PaywallScreen` | Stripe sends `invoice.payment_failed` → `subscription_status='past_due'`, `expires_at=now+3d`. Email + Discord notification fired. |
| 7 | Authenticated, paid sub active | yes | yes | Full Pro UI | `tier='pro', subscription_status='active'`. |
| 8 | Authenticated, paid sub canceled (mid-period) | yes | yes | Full Pro UI until period_end | Stripe `subscription.updated` with `cancel_at_period_end=true` → `subscription_status='canceling'`, `expires_at=period_end`. |
| 9 | Authenticated, paid sub fully ended | yes | yes | `PaywallScreen` | Stripe `subscription.deleted` → `tier='free', subscription_status='canceled'`. Discord role removed, farewell email, email prefs downgraded. |
| 10 | Admin-removed user, re-logs in | yes (status='removed') | yes (new SSO) | **Auto-reactivated** → `PaywallScreen` (new user trial flow) | Implemented 2026-05-31. Reset to `status='active', tier='free', subscription/trial/terms cleared, reactivated_at` stamped. Fix for benjasani repro. |
| 11 | Admin-blocked user | yes (status='blocked') | yes | "Account suspended" screen | Implemented 2026-05-31. No Sign In button, support contact link. |
| 12 | Admin (any source) | yes (role='admin' OR tier='admin') | yes | Full app + admin pages | `_ttIsAdmin === true`. |

---

## The `isPro` predicate (canonical)

Used by: `requiredTier="pro"` gating in `AuthGate`, `body.dataset.isPro`,
`window._ttIsPro`, the activity strip gate, the notifications bell gate,
and Right Rail Pro features. **Must match between worker and frontend.**

```js
const subStatus = user.subscription_status;
const isPastDueInGrace =
  subStatus === "past_due" &&
  Number.isFinite(Number(user.expires_at)) &&
  Number(user.expires_at) > Date.now();
const isPro =
  isAdmin ||
  user.tier === "pro" ||
  user.tier === "vip" ||
  subStatus === "active" ||
  subStatus === "trialing" ||
  subStatus === "manual" ||
  subStatus === "canceling" ||   // post-cancel, still in paid period
  isPastDueInGrace;              // CC failed but inside 3-day grace
```

**Anything else (`free` + status `null` / `canceled` / `incomplete` / `past_due` past grace) → not Pro → PaywallScreen.**

---

## Subscription status values (Stripe)

| Status | Set by | What it means | Pro? |
|---|---|---|---|
| `null` / unset | first login | Never started trial | No |
| `trialing` | `customer.subscription.created` with trial | In free trial | **Yes** |
| `active` | `customer.subscription.updated` after trial OR direct paid | Paying | **Yes** |
| `canceling` | `customer.subscription.updated` with `cancel_at_period_end=true` | User canceled, access until `expires_at` | **Yes** (until expires_at) |
| `canceled` | `customer.subscription.deleted` | Fully terminated | No |
| `past_due` | `invoice.payment_failed` | CC failed, 3-day grace via `expires_at` | **Yes** until grace expires |
| `incomplete` / `incomplete_expired` | Stripe Checkout abandoned | Never finalized | No |
| `manual` | Admin grant | Free Pro (VIP, comped) | **Yes** |

---

## Pro-gated UI surfaces (must gate on `isPro`)

- **Activity Strip** (`tt-activity-strip.js`) — gated on `_ttIsPro || _ttIsAdmin`. Free users: strip hidden entirely; no API polling.
- **Notifications Bell** (`tt-nav-extras.js → injectRightWidgets → "alerts" slot`) — gated on `_ttIsPro || _ttIsAdmin`. Free users: bell not mounted; alerts API not polled.
- **Right Rail live prices + scoring data** — gated server-side by `window._ttIsAdmin` (admin-only for now; pricing data licensing). Free users see ticker metadata only.
- **Today / Active Trader / Investor / Portfolio / Insights pages** — `<AuthGate requiredTier="pro">`. Free users: PaywallScreen.

## Public-only surfaces (never gate; must work without any auth)

- `/splash.html`, `/learn.html`, `/proof.html`, `/faq.html`, `/terms.html`, `/logout.html`
- These pages must NOT appear in the Cloudflare Access policy regex. They are the conversion funnel.

---

## Common mistakes (avoid)

- **Forgetting `canceling` in isPro.** Causes users who clicked "Cancel" but haven't reached period_end to lose access immediately — they bought a month, they should get the month.
- **Forgetting `past_due` grace.** The webhook + email tell the user "you have 3 days to fix your card." If the gate locks them out instantly, the promise is broken.
- **Returning `null` from `authenticateUser` for `status='removed'`.** Causes infinite SSO loop (fixed 2026-05-31 — soft-removed users auto-reactivate).
- **Returning `null` from `authenticateUser` for `status='blocked'`.** Same loop. Now returns `{_blocked:true}` and `/timed/me` surfaces `{authenticated:true, blocked:true}` so the frontend can render a dedicated screen.
- **Activity strip / bell mounting before auth bootstraps.** Now defaults hidden until `tt-auth-bootstrap-updated` fires.
- **Suppressing the FOOTER for free users.** Don't. Legal disclaimer + Twelve Data attribution must be visible on every page.

---

## ⚠️ Known issue: CF Access team session survives our logout

**Symptom:** user signs out via "Switch account", picks a different Google account, returns to TT — and is silently re-signed-in as the previous account.

**Why:** Cloudflare Access maintains a TEAM-LEVEL session (24h default lifetime) that persists across app-level `/cdn-cgi/access/logout` calls. There's no public endpoint to clear the team session from outside the CF Dashboard. Even after our top-level logout, CF Access uses the team session to silently re-issue the app cookie on the next visit, WITHOUT going through Google.

**User workaround (in-app guidance is on `/logout.html?switch=1`):**
- Use an Incognito / Private Browsing window for the new account, OR
- Manually clear cookies for `timed-trading.com` in browser settings.

**Permanent fix — operator action required (Cloudflare Dashboard):**

Pick ONE of these in the Cloudflare Zero Trust dashboard. The first is the cleanest:

1. **Force account picker on every sign-in** *(recommended)*
   - **Zero Trust → Settings → Authentication → Login methods**
   - Edit the Google IdP
   - Under **OAuth scopes & params**, add:
     - **Authentication parameter**: `prompt`
     - **Authentication value**: `select_account`
   - Save. Now every CF Access sign-in via Google will show the account picker, regardless of any cached session.

2. **Shorten the CF Access app session** *(blunter)*
   - **Zero Trust → Access → Applications → Timed Trading (or whatever app name)**
   - Set **Session duration** to `15 minutes` (or even `No duration` to force re-auth on every visit).
   - Trade-off: users have to re-auth more often. Combined with option 1, the picker shows every time.

3. **Enable per-IdP "Always re-prompt"** *(if available in your CF plan)*
   - Some plans expose a toggle for "Always re-authenticate" on the IdP configuration.

Either #1 alone OR #2 alone resolves the user-reported issue. Doing both is fine.

**Document this in the operator runbook** (`docs/2026-05-26-operator-runbook.md`) when this fix is applied so the next operator knows it was a conscious decision.

## Source

- `worker/api.js` → `authenticateUser` (D1 lookup + auto-provision + blocked/removed handling)
- `worker/index.js` → `/timed/me`, `/timed/stripe/webhook`
- `react-app/auth-gate.js` → `AuthGate`, paywall + blocked + access-denied screens, `_ttIsPro` setter
- `react-app/tt-activity-strip.js` → strip mount + `isProOrAdmin` gate
- `react-app/tt-nav-extras.js` → `injectRightWidgets` + `requiresPro` slot gate
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "2026-05-31" entries
