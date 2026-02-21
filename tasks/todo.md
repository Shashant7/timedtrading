# Current Tasks

_No active tasks._

## Backlog

### Emails
- [ ] **Contact Emails** — Centralize support@timed-trading.com, legal@timed-trading.com, and any others (Terms §17, VAPID subject, footer/nav). Ensure consistency across all surfaces.
- [ ] **Welcome Email** — Trigger on signup/subscription.
- [ ] **Reminder Emails** — Re-engagement (e.g., unused features, inactive users).
- [ ] **Transactional / Alert Notifications** — Email delivery for trade alerts, system notifications, etc.

### Reports & Metrics
- [ ] **Usage by Feature by User Report** — Track feature usage (Daily Brief views, Active Trader sessions, AI Ask, etc.) per user for product/engagement insights.
- [ ] **Active User metrics fix** — Investigate and correct. Note: `d1GetActiveUserTickers` returns user-added tickers (watchlist), not logged-in users; naming/implementation may be misaligned with intended “active users” metric.

### Daily Brief
- [ ] **Friday / Holiday awareness** — Pass `isFriday` and `isHoliday` (e.g. via `loadCalendar` / `isEquityHoliday`) into `gatherDailyBriefData` → `buildMorningPrompt` / `buildEveningPrompt` so the brief can acknowledge weekend/positioning day or market closure.
- [ ] **News feed** — Extend beyond `fetchAlpacaEconNews` (economic/macro); add general market news section or broader news source for brief enrichment.

---

## Recently Completed
- **Model Calibration Pipeline** [2026-02-19] — Three-artifact calibration system (Move Atlas, Trade Autopsy, Calibration Report) with WFO, SQN, MFE/MAE, IC, Kelly frameworks. `scripts/calibrate.js` + worker endpoints + `calibration.html` UI.
- **Enrich Consensus + Weekly Card Background** [2026-02-19] — see `archive/todo-enrich-consensus-weekly-cards-20260219.md`
