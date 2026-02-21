# Current Tasks

_No active tasks._

## Backlog

### Emails
- [ ] **Contact Emails** — Centralize support@timed-trading.com, legal@timed-trading.com, and any others (Terms §17, VAPID subject, footer/nav). Ensure consistency across all surfaces.
- [ ] **Welcome Email** — Trigger on signup/subscription.
- [ ] **Reminder Emails** — Re-engagement (e.g., unused features, inactive users).
- [ ] **Transactional / Alert Notifications** — Email delivery for trade alerts, system notifications, etc.
- **Plan:** See `tasks/EMAIL_PLAN.md` for sending (Resend/SendGrid/etc.) and receiving (support/legal + optional inbound parsing).

### Reports & Metrics
- [x] **Usage by Feature by User Report** [2026-02-20] — D1 `feature_usage` table; POST /timed/usage (auth); GET /timed/admin/usage-report (admin). Admin Clients page has “Usage by Feature” tab. Frontend records usage on load (daily-brief, admin-clients; others can add).
- [x] **Active User metrics fix** [2026-02-20] — Status payload now includes `activeUsers30d` (distinct users with last_login_at in last 30 days) and `scoringUserAddedTickers` (renamed from scoringUserAdded) so “active users” vs “user-added tickers” are unambiguous.

### Daily Brief
- [x] **Friday / Holiday awareness** [2026-02-20] — `gatherDailyBriefData` now loads calendar, sets `calendar: { dayOfWeekLabel, isFriday, isHoliday, isEarlyClose }`; morning/evening prompts include calendar context so the brief acknowledges Friday, early close, or market holiday.
- [ ] **News feed** — Extend beyond `fetchAlpacaEconNews` (economic/macro); add general market news section or broader news source for brief enrichment.

---

## Recently Completed
- **Model Calibration Pipeline** [2026-02-19] — Three-artifact calibration system (Move Atlas, Trade Autopsy, Calibration Report) with WFO, SQN, MFE/MAE, IC, Kelly frameworks. `scripts/calibrate.js` + worker endpoints + `calibration.html` UI.
- **Enrich Consensus + Weekly Card Background** [2026-02-19] — see `archive/todo-enrich-consensus-weekly-cards-20260219.md`
