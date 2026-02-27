# Current Tasks

## Active: Investor Mode UI Alignment [2026-02-26] ✅
- [x] Refactor Investor lanes to KanbanColumn-like structure (horizontal scroll, icon, count, color strip)
- [x] Create Investor cards matching CompactCard styling (280px, glass, consistent layout)
- [x] Align Investor Right Rail with Active Trader (fixed overlay, 450px, slide-in, same chrome)

## Backlog

### Emails
- [ ] **Contact Emails** — Centralize support@timed-trading.com, legal@timed-trading.com, and any others (Terms §17, VAPID subject, footer/nav). Ensure consistency across all surfaces.
- [ ] **Welcome Email** — Trigger on signup/subscription.
- [ ] **Reminder Emails** — Re-engagement (e.g., unused features, inactive users).
- [ ] **Transactional / Alert Notifications** — Email delivery for trade alerts, system notifications, etc.
- **Plan:** See `tasks/EMAIL_PLAN.md` for sending (Resend/SendGrid/etc.) and receiving (support/legal + optional inbound parsing).

### Daily Brief
- [ ] **News feed** — Extend beyond `fetchAlpacaEconNews` (economic/macro); add general market news section or broader news source for brief enrichment.

---

## Recently Completed
- **Guide & Tour Overhaul** [2026-02-25] — Investor first-visit guide (6-step modal + 5-step coachmarks tour), Active Trader guide refresh with platform philosophy and mode distinction, simulation portfolio review guidance, voice rules applied across all onboarding.
- **Investor Dashboard Overhaul** [2026-02-25] — Full approachability redesign: plain-English labels with pro terms in tooltips, generated summary sentences in Right Rail, color-coded score verdicts (Strong/Mixed/Weak), verdict dots on score breakdown, inline education instead of hidden legends, no "you/your" voice. Bubble Chart legend (Active Trader) collapsed to single line.
- **Right Rail Tabs Polish** [2026-02-25] — Interpretive Technicals, contextual Journey descriptions, fixed Model tab data source, Scoring Timeline collapsed into milestone groups.
- **Bubble Chart Legend & Timeline** [2026-02-25] — Redesigned legend with visual examples, collapsed Scoring Timeline into grouped milestones with transition dividers.
- **Price Consistency Overhaul** [2026-02-25] — Day-roll preservation, frontend merge paths for all price fields, getDailyChange() as single source of truth across all pages (Cards, Right Rail, Trades, Investor Dashboard).
- **Card Layout Refresh** [2026-02-25] — Improved readability of daily change %, TT badge prominence, SHORT/LONG badge placement, emoji line separation.
- **Model Calibration Pipeline** [2026-02-19] — Three-artifact calibration system (Move Atlas, Trade Autopsy, Calibration Report) with WFO, SQN, MFE/MAE, IC, Kelly frameworks.
- **Enrich Consensus + Weekly Card Background** [2026-02-19] — see `archive/todo-enrich-consensus-weekly-cards-20260219.md`
- **Usage by Feature by User Report** [2026-02-20] — D1 `feature_usage` table; POST /timed/usage; GET /timed/admin/usage-report.
- **Friday / Holiday awareness in Daily Brief** [2026-02-20] — Calendar context in morning/evening prompts.
