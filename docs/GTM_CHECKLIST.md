# Timed Trading -- Go-to-Market Checklist

> Organized, annotated, and prioritized. Each item marked with current status and a recommended action.
>
> **Priority key:** P0 = must-have before first paying user, P1 = should-have within first month, P2 = nice-to-have / growth

---

## 1. Legal & Compliance

| # | Item | Status | Priority | Notes / Action |
|---|------|--------|----------|----------------|
| 1.1 | **Terms of Use** | Done | P0 | Full Terms at `/terms.html` with disclaimer, liability limits, subscription terms, IP, device provisions, and contact info. Accepted via in-app terms gate (audit-logged in D1 `terms_acceptance` table). |
| 1.2 | **"Not Financial Advice" disclaimer** | Done | P0 | Present in Terms (§2), splash page footer, and auth-gate during terms acceptance. Clear statement: "for entertainment and educational purposes only." |
| 1.3 | **Limitation of Liability** | Done | P0 | Terms §9 covers limitation of liability (no liability for trading losses, system outages, data inaccuracies). |
| 1.4 | **Privacy Policy** | Needs work | P0 | Currently embedded in Terms §13 (data collection, no sale of personal data, Cloudflare infrastructure). **Action:** Extract into a standalone Privacy Policy page for better discoverability and GDPR/CCPA compliance. Add cookie/analytics disclosure if applicable. |
| 1.5 | **Device / session limits** | Not started | P2 | Terms §4 mentions "reasonable number of authorized devices" but no server-side enforcement. **Action:** Consider adding concurrent session limits if abuse becomes an issue. Low priority for launch. |
| 1.6 | **SEC/FINRA compliance** | Needs review | P0 | "Not a registered investment advisor" disclaimer is present. **Action:** Confirm with a lawyer that the simulation-only model (no real money traded through the platform) keeps us outside SEC/FINRA registration requirements. |

---

## 2. Billing & Accounting

| # | Item | Status | Priority | Notes / Action |
|---|------|--------|----------|----------------|
| 2.1 | **Stripe integration** | Done | P0 | Checkout, webhooks, customer portal all wired up. Subscription: $60/month with 30-day free trial. |
| 2.2 | **Subscription lifecycle** | Done | P0 | Handles `checkout.session.completed`, `subscription.updated`, `subscription.deleted`, `invoice.payment_failed`. Tier automatically set/reverted based on Stripe events. |
| 2.3 | **Admin panel (client management)** | Done | P0 | `/admin-clients.html` -- client table with search, sort, CSV export, manual tier override (Pro without Stripe). |
| 2.4 | **Manual Pro upgrade** | Done | P0 | Admin can set `tier=pro` with `subscription_status=manual` bypassing Stripe. Clearly marked with `*` in admin table. |
| 2.5 | **Subscription tracking** | Done | P1 | `users` table tracks `tier`, `subscription_status`, `stripe_customer_id`, `expires_at`. Admin table shows all. |
| 2.6 | **Revenue reporting (MRR/ARR)** | Not started | P1 | No internal revenue dashboard. **Action:** Use Stripe Dashboard for now (Revenue tab, MRR chart). Consider building an admin revenue widget once at 20+ subscribers. |
| 2.7 | **Refund / cancellation flow** | Done | P1 | Customer Portal (accessible via "My Account" button) allows users to cancel. Stripe webhook reverts tier. For refunds, use Stripe Dashboard directly. |
| 2.8 | **Tax / invoicing** | Not started | P2 | Stripe handles receipts automatically. **Action:** Enable Stripe Tax if selling to international customers. Set up Stripe Invoicing if B2B invoices needed. |

---

## 3. Customer Experience

| # | Item | Status | Priority | Notes / Action |
|---|------|--------|----------|----------------|
| 3.1 | **Splash / landing page** | Done | P0 | `/splash.html` with hero, features, pricing, and CTA. |
| 3.2 | **Terms acceptance gate** | Done | P0 | In-app terms modal blocks access until accepted. Audit trail in D1. |
| 3.3 | **Welcome tour / onboarding** | Done | P0 | `DashboardWelcomeModal` and coachmarks tour on first visit (Active Trader + Simulation dashboards). Guide/Tour buttons available in nav for repeat access. |
| 3.4 | **Paywall / upgrade flow** | Done | P0 | Free users see upgrade prompt. "Upgrade to Pro" button triggers Stripe Checkout. |
| 3.5 | **Contact / support channel** | Needs work | P0 | `legal@timed-trading.com` listed in Terms §17 for legal inquiries. Auth-gate says "contact support" on Stripe errors but doesn't link anywhere. **Action:** Create a `support@timed-trading.com` email. Add a visible "Help" or "Contact" link in the footer/nav of all pages. Consider a simple feedback form or link to a Discord community channel. |
| 3.6 | **FAQ / Help Center** | Not started | P1 | No FAQ page exists. **Action:** Create a `/faq.html` page covering: What is Timed Trading? How does scoring work? How do I read the Kanban board? What does my subscription include? How do I cancel? Is this financial advice? Gather questions from early users. |
| 3.7 | **Email communications** | Not started | P1 | No transactional or marketing email system. No SendGrid/Postmark/Mailchannels. **Action:** Set up a transactional email provider for: welcome email on signup, subscription confirmation, daily brief email digest (optional). Start with Cloudflare Email Workers or Resend.com (free tier). |
| 3.8 | **In-app notifications** | Done | P1 | Notification bell icon with unread count. Notifications created on trade events (ENTRY/EXIT/TRIM) and daily briefs. |
| 3.9 | **Browser push notifications** | Partial | P1 | Service worker, subscription storage, and registration flow all implemented. **Missing:** VAPID keys and push sending function. See Runbook Appendix for setup instructions. |
| 3.10 | **Mobile experience** | Needs work | P2 | Responsive CSS via Tailwind. Works on mobile browsers but not optimized (small tap targets, horizontal scroll on some tables). **Action:** Test all pages on iPhone/Android. Fix critical usability issues before launch. |

---

## 4. Marketing & Growth

| # | Item | Status | Priority | Notes / Action |
|---|------|--------|----------|----------------|
| 4.1 | **X / Twitter profile** | Not started | P0 | **Action:** Create `@TimedTrading` (or similar) X account. Post: product screenshots, daily brief summaries, trade highlights, market commentary. Pin a "What is Timed Trading?" explainer tweet. |
| 4.2 | **Social sharing (from app)** | Partial | P1 | Web Share API implemented for "Share this ticker" in the right rail. Works on mobile (native share sheet) and some desktop browsers. **Action:** Add platform-specific share buttons (X/Twitter, copy link) as fallbacks for browsers without Web Share API. Add "Share your trade" button on completed trades. |
| 4.3 | **SEO / organic discovery** | Not started | P1 | Splash page exists but has minimal SEO. **Action:** Add meta tags (title, description, og:image) to splash.html. Create a `robots.txt` and `sitemap.xml`. Write 2-3 blog-style pages targeting "multi-timeframe trading", "automated trade scoring", "kanban trading system". |
| 4.4 | **Referral / invite system** | Not started | P2 | **Action:** Build a simple referral link system: each user gets a unique invite URL. Referred users get an extended trial (60 days). Referrer gets a month free. Track via `users.referred_by` column. |
| 4.5 | **Advertising** | Not started | P2 | **Action:** Start with organic/word-of-mouth. Once at 20+ users with good retention, test Twitter Ads targeting trading/fintech audiences. Budget: $500/month test. |
| 4.6 | **Product Hunt / communities** | Not started | P2 | **Action:** Prepare a Product Hunt launch page. Post in relevant communities: r/algotrading, r/daytrading, fintwit, Discord trading servers. Timing: after 10+ users validate the product. |
| 4.7 | **Demo / free preview** | Not started | P2 | **Action:** Consider a read-only demo mode that shows delayed data for one ticker (e.g., SPY). Lets prospects see the Kanban board and scoring in action without signing up. |

---

## Launch Readiness Summary

### P0 -- Must Complete Before First Paying User

| Item | Status |
|------|--------|
| Terms of Use | Done |
| Disclaimers (not financial advice, liability) | Done |
| Stripe billing | Done |
| Splash page | Done |
| Terms gate | Done |
| Welcome tour | Done |
| Paywall | Done |
| Admin client management | Done |
| **Privacy Policy (standalone page)** | **Needs work** |
| **Contact / support channel** | **Needs work** |
| **SEC/FINRA compliance review** | **Needs review** |
| **X / Twitter profile** | **Not started** |

### P1 -- Should Complete Within First Month

| Item | Status |
|------|--------|
| FAQ / Help Center | Not started |
| Email communications | Not started |
| Browser push notifications (VAPID) | Partial |
| Social sharing improvements | Partial |
| SEO basics | Not started |
| Revenue reporting | Not started (use Stripe Dashboard) |

### P2 -- Nice-to-Have / Growth Phase

| Item | Status |
|------|--------|
| Device/session limits | Not started |
| Referral system | Not started |
| Advertising | Not started |
| Product Hunt launch | Not started |
| Demo mode | Not started |
| Tax/invoicing | Not started |
| Mobile optimization | Needs work |
