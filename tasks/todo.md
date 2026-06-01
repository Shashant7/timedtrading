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

- [ ] **Trade-Aware Mirror Sync.** Manifest table + reconciler so the
      mothership (model trade state) stays in lockstep with each
      spawn (user's broker account). Drift detection + user
      notification + per-trade kill switch. Plan:
      [2026-06-01-trade-aware-mirror-sync-design.md](2026-06-01-trade-aware-mirror-sync-design.md).
      Builds ON the portfolio-aware guard from PR #409 with trade-
      level identity (per `trade_id`) so a TSLA trim doesn't
      accidentally touch user's manual TSLA shares. **Full scope:**
      Trader + Investor × Shares + Options, with all 6 simulation
      actions (entry / trim / update SL / TP hit / SL hit / exit)
      mapped per cell of the matrix. **Prerequisite for BYOB** —
      must ship before letting third-party users connect their own
      broker. 5 phases (A→E), ~14 days total work; Phase F polish
      is post-launch.

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
