# Email Plan: Sending and Receiving Emails for Timed Trading

This document outlines a plan to enable **sending emails to users** (welcome, reminders, transactional/alerts) and **receiving emails** (support, legal, inbound handling) in a way that fits the current stack (Cloudflare Workers, D1, no dedicated mail server).

---

## 1. Current State

- **Contact addresses** (already in use):
  - **support@timed-trading.com** — linked in nav/footer, FAQ, auth-gate, terms.
  - **legal@timed-trading.com** — Terms §17, VAPID subject.
- **No outbound email** today: no welcome email, no reminders, no transactional emails.
- **No inbound handling** beyond humans reading support@/legal@ in a mailbox (no ticketing, no parsing into the app).

---

## 2. Goals

1. **Send emails to users**
   - Welcome email (on signup / subscription start).
   - Reminder emails (e.g. re-engagement, unused features).
   - Transactional / alert notifications (e.g. trade alerts, system notices, subscription events).
2. **Receive emails**
   - support@ and legal@ remain the canonical addresses.
   - Optional: parse inbound (e.g. reply-to support) into tickets or notifications; or keep human-only.

---

## 3. Sending Emails

### 3.1 Options (high level)

| Approach | Pros | Cons |
|----------|------|------|
| **Resend / SendGrid / Mailgun / Postmark** | Simple API, good deliverability, templates, logs. | Cost at scale; API key in env. |
| **Cloudflare Email Workers (Email Routing + Workers)** | Same platform, no extra vendor for basic send. | Workers email API is limited (e.g. no templates in-product). |
| **SES (AWS)** | Cheap, reliable. | Another cloud; need AWS account and SDK. |

**Recommendation:** Use a **transactional email API** (Resend, SendGrid, or Postmark) from the Worker for all outbound. Store API key in Worker env (e.g. `RESEND_API_KEY`). Keep support@/legal@ as *reply-to* or *from* where appropriate so replies go to your mailbox.

### 3.2 Implementation outline (sending)

1. **Env**
   - Add `RESEND_API_KEY` (or chosen provider) and optionally `EMAIL_FROM` (e.g. `Timed Trading <notifications@timed-trading.com>`).

2. **Worker module**
   - New module e.g. `worker/email.js`:
     - `sendEmail({ to, subject, html, text, replyTo? })` → call Resend/SendGrid API.
     - Optional: `sendWelcomeEmail(user)`, `sendReminderEmail(user, type)`, `sendAlertEmail(user, payload)`.

3. **Triggers**
   - **Welcome:** On first signup (after Terms accept) or on subscription start (Stripe `checkout.session.completed` / `customer.subscription.created`). Look up user email from D1, call `sendWelcomeEmail(user)`.
   - **Reminders:** Cron (e.g. weekly) that queries users by last_login_at or feature_usage, then calls `sendReminderEmail` for chosen segment (e.g. inactive 14d, never used Daily Brief).
   - **Transactional / alerts:** From existing flows (e.g. after `d1InsertNotification` for subscription issues, or when you add “email this alert”): call `sendAlertEmail` with user email and content.

4. **Templates**
   - Prefer **HTML + plain-text** for deliverability. Store templates as strings in code or in KV (e.g. `timed:email:templates:welcome`) to avoid external dependency. Keep branding minimal (logo, support link, unsubscribe link for non-transactional).

5. **Compliance**
   - Include physical address in footer (required for commercial email in many jurisdictions).
   - For non-transactional (reminders, marketing): honor opt-out; store `users.email_opt_out` or similar and skip sending.

---

## 4. Receiving Emails

### 4.1 Current (no change required)

- support@ and legal@ point to your mailboxes (e.g. Google Workspace, Fastmail). Humans read and reply. No code change needed for “receive” unless you want automation.

### 4.2 Optional: Inbound parsing

If you want **replies to support** to create tickets or show in-app:

- **Cloudflare Email Workers** (Email Routing): Route inbound to a Worker, parse raw email, extract from/reply-to/body, then e.g. insert into D1 `support_tickets` or post to Discord.
- **Provider-specific inbound** (SendGrid Inbound Parse, Mailgun Routes, etc.): POST to your Worker URL when an email hits support@; Worker parses JSON and stores or notifies.

**Recommendation:** Start with **human-only** support@/legal@. Add inbound parsing only if you need tickets or automation later.

---

## 5. Suggested order of work

1. **Contact consistency** (quick)
   - Audit all surfaces for support@/legal@; ensure one source of truth (e.g. env or config) if you want to change domains later.
2. **Send infrastructure**
   - Pick provider (e.g. Resend), add env, implement `worker/email.js` and `sendEmail()`.
   - Add **welcome email** trigger (signup or subscription start).
3. **Transactional / alerts**
   - Add “email” path alongside existing in-app/push notifications for critical events (e.g. subscription failed, trade alert if user preference says “email”).
4. **Reminder emails**
   - Define segments (e.g. inactive 7d, 14d), add cron, add templates and opt-out check.
5. **Inbound (optional)**
   - Only if needed: configure Email Routing or provider inbound → Worker → D1 or Discord.

---

## 6. Security and ops

- **Secrets:** API keys only in Worker env (or secrets); never in client or repo.
- **Rate limiting:** Limit outbound sends per user per day to avoid abuse (e.g. 1 welcome, 1 reminder per week, transactional as needed).
- **Bounces:** Use webhook from provider (e.g. Resend “bounce” event) to mark bad addresses or back off.
- **Logging:** Log send attempts (user id/email, template, success/fail) for debugging and compliance; avoid logging full body.

---

## 7. Backlog reference

- Contact emails (support, legal) — already in place; centralize if desired.
- Welcome email — trigger on signup/subscription.
- Reminder emails — re-engagement, inactive users.
- Transactional / alert notifications — email delivery for trade alerts and system notifications.

This plan can be refined when you choose a provider and implement the first trigger (e.g. welcome).
