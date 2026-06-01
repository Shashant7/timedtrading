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

- [x] **Naked-short deferral hardened + per-vehicle auto-mirror toggles.**
      Engine: `NAKED_SHORT_ARCHETYPES` short-circuit in
      `decideAutoMirror()` before prefs are read. `VEHICLE_DEFAULTS`
      structure (equity_long ON; long_call / long_put / vertical_spread
      / leaps / straddle / moonshot all OFF) with per-vehicle
      `enabled / daily_cap / max_per_order_usd / max_loss_per_order_usd`.
      Per-vehicle daily counters via `checkAndBumpVehicleCounter()`.
      Bridge: `validateOrderShape` HARD-rejects short equity sides + any
      `vehicle` key in `NAKED_SHORT_VEHICLES` (no env override).
      `validateVehiclePrefs()` enforces per-user enable + cap.
      `POST /bridge/user/options-prefs` + `apply_small_account_defaults`
      preset. MC: new `VehicleTogglesCard` per connected user — 7-row
      editable table with "Apply small-account defaults" button. Naked-
      short vehicles intentionally absent from the UI.
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
- [ ] **FAQ ↔ Learn content alignment.** `/faq.html` Q&A pairs predate
      the May 2026 product rewrite (Today / Active Trader / Investor /
      Insights / journey-page split, fused-POV options, IBKR auto-mirror,
      AI CIO Decision Review). Rewrite each Q&A to match the language and
      claims in `/learn.html`. Specifically audit:
      - Pricing question (numbers must match `/splash.html#pricing`)
      - "What does the system trade?" (now multi-engine: investor + active
        trader + options + futures pairs)
      - "How does the AI work?" (mention AI CIO Decision Review, replay
        backtests, 8-layer Root Strategy fusion)
      - "What about live execution?" (IBKR live, Robinhood in research)
      - Add a "Why is my session signed out after admin removed me?"
        entry that points to the auto-reactivation flow (PR after #391).

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
