# Current Tasks

> **Workflow:** Plan first → commit before testing → push every iteration →
> open/update the PR → update lessons after any user correction.
> See [AGENTS.md](../AGENTS.md) for the full onboarding.
>
> **Skills first:** Before inventing a new method, check [`../skills/`](../skills/).
> If you do something new that's reusable, write a skill before exiting.

---

## Completed programs (do not reopen)

- **Jul→Apr recovery (2025-07 → 2026-04)** — Backtest validation and
  promotion to live are **done**. Historical plans live in
  [`archive/2026-pre-may/`](archive/2026-pre-may/README.md). Only start a
  new replay lane if you intentionally define a fresh contract in this file.

---

## Open work — Mission Control + Today + UX polish

### Active

- [x] **Investor Accumulate lane polish — tighter default + Sim-eligible
      filter.** Bumped `accumulate_strong_score_min` default 65 → 70 in
      `worker/investor.js` (the in-zone path stays permissive). Added a
      "Sim-eligible" filter chip to the Investor lane + bubble map that
      narrows Actionable to the cohort the simulator would actually buy
      (Monthly ST bullish + ≥2/3 of D/W/M ST bullish — matches
      `worker/index.js:36692-36698` exactly). Scoring cron pre-computes
      `simEligible` + `_stDirD/W/M` on each `/timed/investor/scores`
      row so the filter is a single boolean read on the client. Operator
      override (`deep_audit_investor_accumulate_strong_score_min`)
      unchanged; can flip back to 60-65 for wider Forensic-style cohort.
- [x] **Discord DM as a bonus user notification channel.**
      New `discordDmUser(env, discordUserId, payload)` helper in
      `worker/alerts.js` — two-step bot API flow (open DM channel →
      post message). Wired into the bridge-notify drain handler:
      when `BROKER_NOTIFY_DM_USER=true` and the user has linked
      Discord (`users.discord_id` from existing OAuth), the drain
      ALSO DMs them with the same compact embed alongside the email.
      Lookup is bounded (one D1 SELECT per unique email, cached in
      the drain handler). Failures (DMs disabled, no link, bot
      issues) never block the email send. Default OFF — operator
      opts in once they've verified DMs land. The drain response
      reports `dm_enabled`, `dm_sent`, `dm_skipped_no_link`,
      `dm_failed` so MC can surface DM health alongside email
      counts. Replaces / supplements the per-environment
      `BROKER_OPERATOR_DISCORD_WEBHOOK_URL` (operator can keep
      using that AS WELL for cross-team visibility, but it's no
      longer the only escalation path).
- [x] **Trade-aware mirror sync Phase E — drift notifications + MC
      Mirror Sync panel + Daily Owner Email cron.**
      New `worker-bridge/bridge-notifications.js`:
      `shouldDispatchDriftNotification()` (severity-tier dedup with
      escalation escape hatch), `buildDriftEmailContent()` /
      `postOperatorDiscord()` / `emitDriftNotification()` (queue +
      stamp manifest), `buildDailyOwnerDigest()` /
      `renderDailyOwnerDigestEmail()`, `drainNotifyQueue()`.
      Reconciler now calls `emitDriftNotification()` on warn/critical
      drift; bridge enqueues to `BRIDGE_KV` `bridge:notify:queue:*`,
      main worker `*/5` cron drains via
      `POST /timed/admin/broker-bridge/notify/drain { send: true }`
      and forwards through `sendEmail()`. New bridge cron
      `30 21 * * *` (21:30 UTC = 4:30pm ET) builds daily digests.
      New operator endpoints: `POST /bridge/manifest/action` with
      actions `suppress|unsuppress|mark_manual|mark_closed|
      force_resync_from_broker`; `POST /bridge/notify/drain`;
      `POST /bridge/notify/daily-digest`. Matching proxy routes
      on the main worker. MC manifest table extended with per-row
      action buttons (↻ resync, ⛔ Suppress / ✓ Unsuppress, ✕
      Mark Closed, ⊘ Mark Manual) + "📧 Preview daily digest"
      button in the section header. All operator actions include
      consequence text in their confirm dialogs.
- [x] **Trade-aware mirror sync Phase D — options + LEAPs + Investor + OCO.**
      Options leg-aware reconcile via `classifyOptionsDrift()`:
      canonical contract key `TICKER:YYYY-MM-DD:STRIKE.SS:[CP]`,
      per-leg expected vs broker comparison, spread leg-gap escalates
      severity to `critical`. New cadence routing: Trader equity 5min /
      Investor equity 60min / Trader & Investor options 60min / LEAPs
      daily — eligibility checked per-row via `_cadenceEligible()` so
      the 5-min cron throttles itself appropriately. LEAPs within T-30
      and other options within T-1 day get an "approaching expiration"
      note appended (Phase E will route to user notifications + emit
      auto-close once enabled). DCA tranche aggregation via
      `aggregateDcaTranches()` surfaces `N/M filled, K pending` in
      `sync_note`. New `worker-bridge/bridge-oco.js` exports
      `orchestrateOcoForReducer()` returning a structured cancel +
      replace plan for SL/TP orders; bridge audits the plan when
      `BROKER_OCO_ENABLED=true` (default off — actual cancel/place
      dispatch lands in Phase E).
- [x] **Trade-aware mirror sync Phase C — reconciler cron.**
      New `worker-bridge/bridge-reconciler.js` with
      `reconcileUser(env, user, adapter, opts)` + top-level
      `reconcileAllUsers(env, userListFn, adapterForUser, opts)`.
      `scheduled()` cron handler in bridge worker fires every 5 min
      (configurable via wrangler.toml triggers.crons), gates on NY
      regular-hours unless `BROKER_RECONCILE_24_7=true`. Compares
      `manifest.broker_remaining_qty` (fallback `model_intended_qty`)
      vs broker `getEquityPositions[ticker]` per §5.1 cadence and
      §6 mismatch taxonomy. Drift classifications: in_sync /
      partial_fill / broker_orphan (model CLOSED + broker holds) /
      mothership_orphan (model OPEN + broker = 0) / reconcile_error.
      Auto-suppress after 3+ chronic drift cycles with explicit
      `auto_suppressed_after_N_drifts:<state>` reason. Operator
      on-demand: `POST /bridge/reconcile` (single user or all) +
      `POST /timed/admin/broker-bridge/reconcile` proxy. MC "Force
      reconcile" button below the manifest table. `BROKER_RECONCILE_
      DRY_RUN` env supports observe-only mode for the first week.
- [x] **Trade-aware mirror sync Phase B — manifest-aware reducer.**
      `preflightOrder` now reads the `mirror_trade_manifest` BEFORE
      the portfolio check on every TRIM/EXIT. Decision matrix per
      §4.1: PROCEED when sync_state ∈ {in_sync, partial_fill,
      broker_orphan, untracked (close only)}; REJECT with explicit
      `no_manifest_for_trade` / `mirror_suppressed:<reason>` /
      `reducer_blocked_by_sync_state:<state>` /
      `reducer_missing_trade_id_for_manifest_lookup`. Partial-fill
      scaling supported via `BROKER_PARTIAL_FILL_MODE=scale`.
      `markManifestModelClosed()` wired on successful EXIT.
      Gated by `BROKER_MANIFEST_ENFORCE` env (on / log / off);
      starts in `log` mode in prod for a week of shadow-mode
      observation, then flips to `on`. Fail-OPEN on D1 read error
      so a degraded manifest doesn't lock the operator out
      (portfolio guard + reconciler are last-line defense).
- [x] **Trade-aware mirror sync Phase A — manifest writer.**
      New `worker-bridge/bridge-manifest.js` with `mirror_trade_manifest`
      D1 table (matches §3.1 schema exactly), `writeEntryManifest()`
      writer (called on every successful place after preflight),
      `writeRejectedEntry()` (called when preflight rejects an entry so
      Phase B can return `mirror_suppressed` on follow-on TRIM/EXIT),
      `recentManifestRows()` + `readManifestRow()` for inspector use.
      `ensureMirrorManifestSchema()` runs via `ensureBridgeSchema()` —
      idempotent + in-process cached. New `GET /bridge/manifest` +
      `GET /timed/admin/broker-bridge/manifest` operator-only endpoints.
      Mission Control renders a per-sync_state count strip + 50-row
      scrolling table with ⛔ icons on suppressed rows. Writer is
      best-effort — a manifest write failure does NOT undo a placed
      order; the reconciler (Phase C) reconstructs from the broker side.
- [x] **Options engine emits LEAPs for long-direction tickers (Investor
      primary, Trader alternative).** New `leap_call` archetype +
      `pickLeapExpiration()` (~540 DTE, snapped to 3rd Friday, floored at
      365 DTE for true LEAP status) + `buildLeapCall()` baked with the full
      stock-replacement framework (deep-ITM 0.80Δ default, PMCC follow-on
      suggestion, T-180 day roll discipline, IV-aware entry caveat,
      capital-efficiency floor warning, LEAP-aware liquidity tolerance).
      `buildOptionsLadder()` always inserts a LEAP into the long-side
      ladder for any long-direction ticker — `_investor_boost` pins it
      primary only on Investor stage; Trader stage keeps Long Call as
      primary with LEAP as an alternative below.
- [x] **Right-rail Options tab: Horizon toggle (Trader / Investor LEAP).**
      `/timed/options/ticker?mode=investor` forces `stage='investor'` +
      `direction='LONG'` so the engine pins the LEAP as primary. The
      in-panel toggle auto-detects from the host URL on mount
      (investor.html → investor) and is operator-overridable. LEAP
      metadata (roll target, PMCC suggestion, capital efficiency, IV
      assessment) renders through the existing primary-play card + notes
      bullet list — no further UI work was needed beyond the toggle.
- [x] **Trader + Investor entry alerts include the recommended options play.**
      New shared formatters `compactOptionsPlay()`, `optionsPlayDiscordField()`
      (Discord 1024-char-safe), and `optionsPlayEmailHtml()` in
      `worker/options-plays.js`. Trader entry path (kanban + trade-sim) and
      Investor entry path each call `buildEntryOptionsPlay()` which routes
      through the right mode → ladder primary, then attaches a single Discord
      field and an `options_play` payload to `sendTradeAlertEmail()`. Email
      renders a new "Options Play" section between Setup and Signals. Sample
      fixtures (`/timed/admin/send-sample-emails`) now include `trade_entry`
      (Trader long-call) and `investor_entry_leap` (Investor LEAP).
- [ ] **Investigate CF error 1042 on broker-bridge subrequests.** Worker-to-worker
      HTTPS fetch to `tt-broker-bridge.shashant.workers.dev` returns
      404 + `error code: 1042` (Cloudflare loopback rejection). Migrate
      to **Service Bindings** in `worker/wrangler.toml` per
      [skills/broker-bridge.md](../skills/broker-bridge.md) → "Cloudflare
      error 1042". Symptom: Mission Control bridge tile shows
      `bridge_responded_404` even though the bridge worker is up.
- [x] **FAQ ↔ Learn content alignment.** Rewrote `/faq.html` end-to-end
      so its 24 Q&A pairs align with `/learn.html` and the current
      product. New sections: Getting Started · Active Strategy &
      Universe · Daily Brief, AI CIO & Two Modes · Options & LEAPs ·
      Performance & Proof · Pricing & Subscription · Alerts, Community
      & Technical. Fixed: nav Sign-In → `/today.html` (was
      `/index-react.html`), Founding-member pricing terminology
      (was "Charter"), accurate Active Trader lanes (Watch → Setup →
      Enter → Hold → Defend → Trim → Exit) + Investor 4-action /
      3-research lane split, performance defers to live `/proof.html`
      instead of static backtest numbers, new questions for AI CIO,
      Active Strategy ON/OFF-THESIS, Options + LEAPs, entry-alert
      options play, sign-out-after-admin-removal flow, data sources
      (Twelve Data + Alpaca).

### Watch

- [ ] **Mission Control AI CIO Decision Review** — inline feedback now in place
      (PR after 2026-05-30). Confirm with operator that buttons feel responsive.
- [ ] **Broker bridge console noise** — `/status` + `/audit` now return 200
      with structured `error_kind` (same PR). Confirm DevTools is clean.

### Planned

- [ ] **Trade-Aware Mirror Sync (v2 design).** Manifest table +
      reconciler keeping mothership (model trade state) in lockstep
      with each spawn (user broker account). Drift detection +
      user notification + per-trade kill switch + per-vehicle
      toggles + daily owner email + user-modification handling.
      Plan: [2026-06-01-trade-aware-mirror-sync-design.md](2026-06-01-trade-aware-mirror-sync-design.md)
      (v2). **Scope:** Trader + Investor × Shares + Options
      (incl. LEAPs as 2nd-most-popular vehicle), 6 simulation
      actions mapped per cell, every action mapped to explicit
      IBKR Client Portal API calls including OCO order lifecycle
      (cancel-before-trim, modify-SL, TP/SL fill detection). **No
      naked shorts** — equity SHORT, options selling-to-open,
      cash-secured puts, covered calls all deferred to a separate
      risk-reviewed workstream. **Per-vehicle toggles**: equity_long
      defaults ON; every option archetype (long_call, long_put,
      vertical_spread, leaps, straddle, moonshot) defaults OFF.
      **Daily owner email**: per-broker-account digest (trades,
      positions, day P&L, tomorrow's outlook). **User-mod handling**:
      revert SL/TP changes by default, accept user-initiated closes.
      **Prerequisite for BYOB** — must ship before third-party
      users connect their own broker. 7 phases (A→G), ~18 days
      total before BYOB launch; Phase G polish post-launch.

- [ ] **BYOB — Bring Your Own Broker.** Multi-user broker connect flow
      (Robinhood + IBKR per-user). Plan:
      [2026-06-01-byob-broker-connect-plan.md](2026-06-01-byob-broker-connect-plan.md).
      Bridge architecture is already multi-user-ready (per-user storage,
      OAuth, encrypted tokens, risk caps, audit log all live). What's
      missing: user-facing Connect-Broker UI, Robinhood OAuth wiring,
      IBKR per-user wizard, compliance + risk controls. **Depends on
      Trade-Aware Mirror Sync (above)** — letting third-party users
      connect their own broker requires lock-tight trade-level
      isolation. 4-phase rollout estimated 4-6 weeks of focused work
      + parallel legal review.

---

## Strategic plans (one-shot, recently shipped)

| Plan | Status |
|---|---|
| [2026-05-30-ibkr-auto-execution-plan.md](2026-05-30-ibkr-auto-execution-plan.md) | Shipped (IBKR live; auto-mirror policy + audit live) |
| [2026-05-29-broker-bridge-phase1-plan.md](2026-05-29-broker-bridge-phase1-plan.md) | Phase 1 shipped |
| [2026-05-29-session-handoff.md](2026-05-29-session-handoff.md) | Historical reference |
| [2026-05-28-today-page-redesign.md](2026-05-28-today-page-redesign.md) | Shipped + refined through 2026-05-30 |
| [2026-05-28-cio-signal-enrichment-plan.md](2026-05-28-cio-signal-enrichment-plan.md) | Shipped |
| [2026-05-28-opportunity-surface-plan.md](2026-05-28-opportunity-surface-plan.md) | Shipped |
| [2026-05-28-right-rail-catalysts-tab-plan.md](2026-05-28-right-rail-catalysts-tab-plan.md) | Shipped |
| [2026-05-28-discovery-phases-2-3-4a-5-plan.md](2026-05-28-discovery-phases-2-3-4a-5-plan.md) | Shipped |
| [2026-05-28-cio-shadow-to-live-audit.md](2026-05-28-cio-shadow-to-live-audit.md) | Shipped (live + replay separation in `ai_cio_decisions`) |
| [2026-05-28-admin-nav-cleanup-plan.md](2026-05-28-admin-nav-cleanup-plan.md) | Shipped |
| [2026-05-28-dmarc-runbook.md](2026-05-28-dmarc-runbook.md) | Operational runbook (keep) |
| [2026-05-28-dell-stale-and-earnings-radar-miss.md](2026-05-28-dell-stale-and-earnings-radar-miss.md) | Fixed + lesson logged |
| [2026-05-28-robinhood-agentic-trading-research.md](2026-05-28-robinhood-agentic-trading-research.md) | Research; feeds bridge-phase2 |
| [2026-05-27-cio-candles-shortrank-plan.md](2026-05-27-cio-candles-shortrank-plan.md) | Shipped |
| [2026-05-27-three-week-live-review.md](2026-05-27-three-week-live-review.md) | Historical reference |

---

## Backlog (pull from here when current work clears)

### Operability

- [ ] Migrate main → bridge fetch to Service Bindings (resolves CF 1042 above).
- [ ] Add a "worst stale ticker" alert that wakes someone if it exceeds 24h
      (currently only surfaced in Mission Control on visit).

### Strategy

- [ ] Multi-leg combo orders end-to-end in IBKR live (currently single-leg
      autopilot; combos defined in `worker/options-plays.js` but not
      auto-mirrored yet).
- [ ] Robinhood Agentic execution as bridge target #2 (research in
      `2026-05-28-robinhood-agentic-trading-research.md`).

### UX

- [ ] Investor email digest cadence — current is per-zone-enter; consider
      morning summary roll-up.
- [ ] Replace the alert() prompts that remain in `mission-control.html`
      (auto-flipped-gate banner) with the same inline-toast pattern used
      for review feedback.

---

## How to add a new task here

1. Use the **outermost section** (Open work / Strategic plans / Backlog).
2. Active items go under "Active" with a `[ ]` checkbox.
3. Shipped one-shots get moved into the "Strategic plans" table with a
   status, not deleted (they remain useful reference).
4. When a task ships AND is fully validated by the user, mark it `[x]`
   then move to the Strategic-plans table on the next session sweep.
