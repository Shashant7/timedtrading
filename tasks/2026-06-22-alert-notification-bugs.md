# Verified bugs — alerts, notifications, Kanban alignment (2026-06-22)

Operator report + code audit. Each item includes **verified root cause** (or best current hypothesis), **evidence in code**, and **fix direction**.

External context: possible internet-wide SaaS outages today (SendGrid, OpenAI, Discord) may have amplified delivery failures — treat infra as a confounder until KV/cron snapshots confirm.

---

## P0 — User-facing delivery / trust

### 1. Morning Daily Brief email not received (9:00 AM ET)

| | |
|---|---|
| **Symptom** | No morning Daily Brief email at 9 AM ET. |
| **Verified cause** | Brief generation runs on the **hourly cron** (`0 * * * *`) when ET hour === 9, gated by virtual cron `0 14 * * 1-5`. After worker decomposition, this lane runs on **tt-research** when `RESEARCH_SLOTS_EXTERNAL=true`. Email dispatch in `dispatchDailyBriefNotifications()` (`worker/daily-brief.js`) calls `sendEmail()` which **requires `SENDGRID_API_KEY` on the worker that runs the cron**. tt-research wrangler comment explicitly notes: *"SENDGRID_API_KEY missing = brief emails silently skipped"*. |
| **Secondary causes** | (a) OpenAI failure → brief stub / no send; (b) isolate exits before SendGrid completes (partially fixed by `await dispatchDailyBriefNotifications`); (c) zero opted-in users; (d) SaaS outage. |
| **Verify** | KV `timed:email:daily_brief:lastrun:morning`; `/timed/admin/email-diagnostic`; tt-research logs `[DAILY BRIEF] … emails skipped`. |
| **Fix direction** | Ensure SendGrid on tt-research **or** relay email through monolith API worker (WIP: `sendEmail` relay in `worker/email.js`). Add cron failure alert if `_emailReport.reason !== ok`. |

---

### 2. Active Trader Discord alerts fire but no matching email

| | |
|---|---|
| **Symptom** | Trade entry Discord received; no email. |
| **Verified causes (two independent paths)** | **A) Role worker missing SendGrid:** `dispatchTradeAlertEmails()` (`worker/index.js` ~32207) historically bailed when `!env.SENDGRID_API_KEY`. tt-engine runs */5 scoring + alerts; engine wrangler notes *"SENDGRID_API_KEY missing = trade-signal emails silently skipped"*. Discord webhooks ARE on tt-engine → Discord works, email does not. **B) Legacy TRADE SIM entry path:** `processTradeSimulation()` block ~28215 sends Discord via `createTradeEntryEmbed` + `notifyDiscord` but **never calls `dispatchTradeAlertEmails`**. Kanban `KANBAN_ENTER_NOW` path ~25661 does await email dispatch. |
| **Verify** | Check trade `source` in KV/D1 (`KANBAN_ENTER_NOW` vs sim path). Engine logs `[EMAIL] Trade alert skipped … no_sendgrid_key`. |
| **Fix direction** | (1) Email relay fallback on role workers; (2) wire TRADE SIM entry path to same `dispatchTradeAlertEmails` payload as kanban path; (3) remove early return on missing SendGrid when relay enabled. |

---

### 3. Kanban lane vs Discord exit signal misalignment (GS, GRNJ) — **NEW**

| | |
|---|---|
| **Symptom** | **GS:** Kanban flickered Defend → Exit → Defend within minutes. **GRNJ:** Discord showed an Exit signal; Kanban still shows Defend; SL not hit. |
| **Verified cause** | **Exit Discord ≠ exit lane persistence.** When `classifyKanbanStage` returns `exit` but the trade is still open (CIO block, RTH gate, min-age, stale-tick defer, pullback shield), code at `worker/index.js` ~22551–22612 fires a **`TRADE_EXIT_SIGNAL` / `KANBAN_EXIT` Discord embed** with footer *"Exit recommended — position still open until filled"*. That alert is **deduped 24h** per trade. **Kanban stage is recomputed every */5 tick** with no hysteresis — if the next scoring pass downgrades exit → defend (e.g. soft fuse deferred, cloud expanding, pullback shield, `_force_defend_stage`), the **UI lane reverts** while Discord already sent a one-shot exit recommendation. Discord title/embed does not say "ACTIVE TRADER" vs lane name clearly; raw `exitReasonRaw` may show in embed (e.g. `ripster_*`) without jargon scrub on EXIT_SIGNAL path. |
| **Why GS flickers** | Transient exit classification on one bar/tick, then defend logic wins on the next (debounce on ripster cloud exits, soft-fuse deferral, HTF context). Expected with current architecture unless stage is sticky. |
| **Why GRNJ Discord Exit + Defend lane** | Discord fired on the tick `isExit === true`; subsequent tick classified `defend` before `closeTradeAtPrice` ran (or exit was deferred entirely). User sees stale Discord relative to current lane. |
| **Verify** | D1 `alerts` / activity feed for `TRADE_EXIT_SIGNAL` on GRNJ; compare `timed:latest` kanban_stage history for GS/GRNJ across */5 snapshots; check whether `closeTradeAtPrice` ran vs only signal path. |
| **Fix direction** | (1) **Stage hysteresis:** require N consecutive */5 ticks in `exit` before lane UI shows Exit (or before EXIT_SIGNAL Discord). (2) **Discord copy:** label as `ACTIVE TRADER · Exit Recommended (position open)`; never send full exit alert when suppression gates would block close. (3) **Lane-signal coupling:** when EXIT_SIGNAL fires, stamp KV `timed:kanban:exit-signal:<ticker>` until trade closes or stage stable 3 ticks — UI reads sticky exit-advisory state. (4) Scrub `exitReasonRaw` on EXIT_SIGNAL embed (same as trim/exit embed maps). (5) Email parity for EXIT_SIGNAL (currently Discord-only advisory). |

---

## P1 — Copy / differentiation / CIO

### 4. Discord shows raw "ripster" in user-facing copy (GRNJ)

| | |
|---|---|
| **Symptom** | Active Trader GRNJ alert contained "ripster". |
| **Verified cause** | Engine internal paths use `ripster_*` keys (`entry_path`, `__exit_reason`, trim/exit reasons). Display scrub exists in trim/exit embed maps and `prettySetupName`, but **gaps remain:** EXIT_SIGNAL embed uses raw `exitReasonRaw.replace(/_/g, " ")` (~22592); some setup keys not in `SETUP_DISPLAY_MAP`; exhaustion warning bullets used raw keys in Discord. |
| **Fix direction** | Central `scrubUserFacingJargon()` on all Discord/email alert formatters; extend `SETUP_DISPLAY_MAP`; humanize EXIT_SIGNAL reason field. |

---

### 5. Discord does not clearly distinguish Active Trader vs Investor signals

| | |
|---|---|
| **Symptom** | Hard to tell Trader vs Investor alerts in Discord. |
| **Verified cause** | Investor embeds prepend `INVESTOR · <ACTION>` in `createInvestorAlertEmbed()` (`worker/alerts.js`). Trader entry embed `createTradeEntryEmbed()` title was generic *"New Trade: TICKER …"* with no mode prefix. Exit/defend/trim stage embeds similarly unlabeled. |
| **Fix direction** | Prefix all trade-lane Discord titles: `ACTIVE TRADER · …` (entry/trim/exit/defend/EXIT_SIGNAL). Investor already has prefix — keep in lockstep. |

---

### 6. AI CIO guidance missing from Active Trader alerts and Investor emails

| | |
|---|---|
| **Symptom** | No AI CIO copy on Active Trader Discord/email; Investor signal emails lack CIO. |
| **Verified cause** | **Trader:** CIO fields appended only on kanban entry path when `_cioDecision` present (~25565). TRADE SIM path has no CIO embed/email. **Investor:** Discord/email loop sends alerts via `sendInvestorSignalsDigest()` only (~82452) — digest has no CIO. `cioRecordInvestorLaneChange` runs record-only in parallel but reasoning is **not attached** to alert payload. Per-alert `sendInvestorAlertEmails()` (richer template + chart) not called from scoring cron. |
| **Fix direction** | `consultInvestorSignalCio()` before investor alert dispatch; attach `cio_reasoning` to Discord + email; restore per-alert investor emails with CIO section. Trader: shared `appendCioFieldsToDiscordEmbed` + `fetchLatestEntryCioDecision` on all entry paths. |

---

## P2 — Informational / likely expected

### 7. Investor signal for GS at ~6:00 AM ET (Discord)

| | |
|---|---|
| **Symptom** | GS Investor accumulation/signal on Discord around 6 AM ET. |
| **Assessment** | **Likely expected**, not a bug. Investor scoring cron uses `investor-session` virtual cron (4 AM–8 PM ET hourly). Accumulation-zone alerts fire when `accumZone.inZone` newly true (`worker/index.js` ~82347). |
| **Action** | Confirm with operator whether timing is acceptable; optional: gate investor Discord to post-7 AM ET if desired. |

---

## Implementation status (agent branch `cursor/alert-email-cio-fixes-3692`)

Partial WIP (not merged):

- [ ] Email relay via `POST /timed/internal/relay-email` when role worker lacks SendGrid
- [ ] Remove SendGrid hard gate in `dispatchTradeAlertEmails` + daily brief dispatch
- [ ] `consultInvestorSignalCio` + investor embed/email CIO fields
- [ ] `ACTIVE TRADER ·` title prefix on entry embed; jargon scrub helpers
- [ ] TRADE SIM entry → email + CIO parity (**not started**)
- [ ] Kanban exit hysteresis / EXIT_SIGNAL-lane coupling (**not started** — item 3)

---

## Suggested fix order

1. **#3 Kanban ↔ Discord exit alignment** (GS/GRNJ trust issue — highest confusion)
2. **#2 Email delivery** (relay + TRADE SIM parity)
3. **#1 Daily Brief email** (relay + lastrun monitoring)
4. **#6 AI CIO** on all signal surfaces
5. **#4 / #5** copy polish (ripster scrub + ACTIVE TRADER / INVESTOR labels)
6. **#7** confirm with operator only

---

## Key files

| Area | Path |
|---|---|
| Exit signal vs lane | `worker/index.js` ~22551–22620, `classifyKanbanStage` |
| Trade email dispatch | `worker/index.js` `dispatchTradeAlertEmails`, ~28215 TRADE SIM gap |
| Daily Brief email | `worker/daily-brief.js` `dispatchDailyBriefNotifications` |
| Discord embeds | `worker/index.js` `createTradeEntryEmbed`, `createKanbanStageEmbed`; `worker/alerts.js` investor |
| Email send | `worker/email.js` `sendEmail`, `sendInvestorAlertEmails` |
| Worker topology | `skills/worker-topology.md`, `worker-engine/wrangler.toml`, `worker-research/wrangler.toml` |
