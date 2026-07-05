# 2026-07-05 — Answer-First UX Audit (Phase D1)

Deliverable for Phase D1 of
[the stabilization plan](2026-07-03-holiday-weekend-stabilization-plan.md)
(Objective 3: organize the chaos). Audits each journey page against the
three user questions, names the noise in front of the answer, and sets the
build direction. The data contract behind the direction (Phase D2's verdict
object) ships alongside this doc: `worker/verdict.js` +
`GET /timed/verdict`.

## The three questions (the ONLY yardstick)

1. **What should I buy right now to grow my account? Why?**
2. **Should I buy THIS ticker right now? When? At what price? Why?**
3. **Should I sell THIS ticker right now? When? At what price? Why?**

Everything else on every page is supporting evidence and belongs one
click/expand deeper. Some users want the proof; all users want the answer.

## Page-by-page audit

### Today (`/today`) — the entry point

| Question | Above the fold today? | Verdict |
|---|---|---|
| Q1 what to buy | ✗ — Market Pulse, greeting, regime line, Brief prose, Bubble Map come first; actionable names are buried inside Brief narrative or the movers strip | **Biggest gap.** The FIRST block after the greeting should be "Today's answers": the top `GET /timed/verdict` candidates (BUY / SETUP_FORMING), lane-labeled, each with price/stop/why |
| Q2/Q3 this ticker | Partially — search opens the right rail, but the verdict is implicit across tabs (plan, scores, charts) | Right rail needs the verdict block at the TOP (see component spec) |

Noise inventory: regime one-liner (keep, one line), Market Pulse strip
(keep), Brief (move below answers; it is commentary, not action), Bubble
Map (keep — it IS the journey visual, and now has `_journey` to annotate).

### Active Trader (`/active-trader`)

- Kanban lanes are the engine's internal state machine, not the user's
  question. A new user reads "in_review / defend / trim" as jargon.
- **Direction:** keep the kanban for power users, but each card leads with
  the verdict word (BUY/HOLD/TIGHTEN/SELL/WAIT) + one-line why from the
  contract. The setup lifecycle (D3) maps stages to plain progression:
  FORMING → READY → TRIGGERED → MANAGED → CLOSED.

### Investor (`/investor`)

- Zones (accumulate/watch/hold) are closer to answer-language already.
- Gap: no explicit "why now" and no timing. The investor verdict
  (`buildInvestorVerdict`) supplies both (`scale in`, `on zone entry`).
- Lane confusion fix: every investor card/alert carries the INVESTOR badge
  (see D4); trader signals never render on this page.

### Portfolio (`/portfolio`)

- Q3 surface. Today it reports positions; it should ANSWER: for each open
  position, the verdict (HOLD/TIGHTEN/SELL) + why + the level that changes
  the answer. `GET /timed/verdict?ticker=` provides it per holding.

### Right rail (all pages)

- The per-ticker answer surface. Current order: chart, tabs, plan sections.
- **Direction — the Verdict Block (D2 UI):** pinned at top:
  `VERDICT · lane badge · price · timing · why (one line) · [expand: proof]`
  with both lanes shown when both apply (trader BUY + investor WAIT is a
  legitimate, clarifying combination).

## The lane separation rule (D4)

Every signal-bearing element (card, alert, digest row, Discord embed,
email) carries exactly one lane tag: **TRADER** (days) or **INVESTOR**
(months). Rendering an untagged signal is a bug. Discord: separate webhooks
already exist per lane — audit templates so the lane is in the title, not
the body. User-level mute-a-lane preference is a fast follow.

## Trust ledger (D5, direction only)

The signal-outcomes ledger already tracks model calls. Surface: a compact
public "track record" strip (calls, hit rate, median lead time) on Today +
splash. No new computation — read the existing ledger.

## Build order (each its own PR, UI after operator sign-off on this doc)

1. **D2-UI** Right-rail Verdict Block reading `GET /timed/verdict` (contract
   is live as of this PR).
2. **Today answers module** — Q1 candidates above the Brief.
3. **D3 lifecycle labels** — map kanban/zone stages to FORMING → READY →
   TRIGGERED → MANAGED → CLOSED on cards (display-only re-labeling first).
4. **D4 lane badges + template audit** (server templates + UI chips).
5. **Portfolio verdict column**, then **D5 trust strip**.

Design constraints: DESIGN.md / Verda tokens; numerals in JetBrains Mono;
no "you/your" copy (compliance); mint is CTA-only. Verdict words map to
existing semantic tokens (BUY/SELL = `--tt-success`/`--tt-danger`; TIGHTEN =
warning; WAIT/HOLD = neutral).
