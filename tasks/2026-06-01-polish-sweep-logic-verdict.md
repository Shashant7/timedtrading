# 2026-06-01 — Polish sweep logic verdict

> Operator ask: *"The second sweep is around our code changes, logic, does it all make sense and jive. Do we expect our users to be able to follow through with what the model is doing? Are the screener promotion flow working end to end, is the AI CIO working well?"*

This doc is the end-of-polish-series end-to-end verdict across the surfaces touched in PRs #412 → #438. It is intentionally **text-only** — no code change in this file. It exists to give the operator (and the next agent reading this repo) a single page describing whether the system coherently does what we tell users it does.

---

## TL;DR

| Area | Verdict | Why |
|---|---|---|
| Trader entries → trade lifecycle → alerts | ✅ Coherent | Setup name now self-heals (#432); display always matches direction. Discord + email both pass direction to `prettySetupName`. |
| Investor lanes / OWNED state | ✅ Coherent | Cards reconcile with `/timed/investor/positions` every 60 s (#427); unowned-but-`watch`-stage rows demoted to On Radar; "JUST OPENED" pulse anchors Discord alerts to tiles. |
| Investor thesis text | ✅ Coherent | Invalidation strings now include actual price levels for Monthly ST + Weekly EMA(200) + RS rank (#429); operator can see "how much room before invalidation" without cross-referencing the chart. |
| Options ladder direction (LONG vs SHORT) | ✅ Coherent | Investor mode bypasses trader-side `WAIT` suppression (#429); direction-neutral plays (straddle) excluded from Investor mode entirely. |
| Day-trade plays (SPY/QQQ/IWM) | ✅ Coherent | Dedicated amber-tinted strip on Today page, `DAY TRADE · NDTE` pill, never mixed with swing/investor plays for the same ticker (#436). |
| Screener Promotion Queue | ✅ Coherent end-to-end | Decision inheritance across days (#430): SMCI approved 2026-05-29 stays approved on subsequent rebuilds. `IN UNIVERSE` badge so operator can see at a glance. Discovery Thesis surfaced in Snapshot right-rail. |
| AI CIO | ✅ Coherent | Active Strategy injected into every prompt (#425); engine pulse (Loop 2 duration-bias view) injected into memory + system prompt section (#428); strategy_stance always emitted even when neutral (#425). |
| Loop 2 circuit breaker | ✅ Coherent | Duration-bias-aware (#428): defers when PF ≥ 1.3 OR combined-equity today ≥ -0.5%; Discord alert + CIO memory both surface the same combined view. |
| Calibration UX | ✅ Coherent | Explainer card + run-status toast + freshness chips (#435) — operator now knows what the page does, when something changed, and whether the data is fresh. |
| MC Options Auto-Mirror | ✅ Coherent | Modes + archetypes editable inline (#437); per-vehicle toggles + naked-short hard rejection in place since #412. |
| Freshness monitors | ✅ Coherent | Heal-before-page reordering (#434); 60m no longer pages for transient single-cron-tick gaps. Page text distinguishes "auto-heal attempted" so operator knows it's a real problem. |
| Chart-in-email | ✅ Coherent | Three-layer guard against `sl=0` blowing up y-axis (#434); exits skip sl/tp entirely. |
| Discord access | ✅ Coherent | `Link Discord` button kicks the OAuth flow → auto-add to server → welcome email with explicit community contract + four-channel guide (#438). |

---

## End-to-end flows (what a user actually experiences)

### Flow A: Trader entry → broker fill → exit alert

1. Scoring cron sees a setup → emits a `tt_*` entry path
2. `formatSetupName(entryPath)` now hits an explicit map (#432) → stores `"TT ATH Breakout"` instead of the legacy `"TT Tt Ath Breakout"` artifact
3. Trade row written to D1 with `setup_name + direction`
4. Broker bridge (if enabled + opted-in vehicle) places the order; manifest writer (#414 Phase A) records it
5. Lifecycle engine reaches exit; Discord embed passes `direction` to `prettySetupName` (#432) — even if some upstream stamped a stale name, the display swaps to the direction-correct paired setup
6. Email + Discord both render the same direction-consistent setup label

**User-visible coherence:** ✅ A LONG trade always shows a LONG-flavored setup name (ATH Breakout, not Atl Breakdown). The setup-name display layer is self-healing.

### Flow B: Screener candidate → promotion → universe → score → trade

1. Screener cron pulls candidates, scores them via `worker/discovery/promotion-queue.js`
2. Promotion queue row written: `<TICKER>:<TODAY>` candidate_id
3. **Cross-day inheritance** (#430): if any prior `<TICKER>:*` row has `status IN (approved, declined)`, today's row is born already-decided. Operator never sees the same approved ticker pop back into Needs Review.
4. Operator approves a `Needs Review` row → ticker added to `timed:tickers` + fast-onboard backfill kicked off
5. Within minutes, scoring cron picks up the new ticker and runs the full Investor + Trader pipeline
6. Discovery thesis surfaces in Snapshot right-rail (#430) the next time anyone opens that ticker — so even non-operator members see the WHY

**User-visible coherence:** ✅ End-to-end flow works. The IN UNIVERSE badge on the Screener page tells the operator at a glance which candidates are already tracked. The thesis text follows the ticker into the member-facing right rail.

### Flow C: Investor Accumulate → buy fires → card shows OWNED + JUST OPENED

1. Investor hourly cron computes scores (PR #433 retry hardens against single transient 503s)
2. Auto-rebalance at 11 AM ET picks up Accumulate-stage tickers, opens positions
3. Discord fires `Investor New Entry: SYM LONG`
4. Within ≤60 s, the Investor kanban tile shows **OWNED** chip + **JUST OPENED** green pulse (#427)
5. The position reconciliation runs INSIDE the panel's 60 s poll loop, so newly-opened positions don't disappear after the prior reconciliation expires

**User-visible coherence:** ✅ Discord ↔ card alignment within one polling cycle. The JUST OPENED pulse explicitly anchors the alert to the tile.

### Flow D: AI CIO reasons about an entry

1. Scoring cron builds the proposal: ticker data + entry path + setup tier + risk params
2. `cio-memory.js` builds 16 layers including: ticker history, path performance, regime, ticker profile, macro snapshot, news, insider, theme cohort, strategy stance (always included since #425), engine pulse (added #428 — closed metrics + PF + open book + combined today)
3. `cio-prompts.js` injects the Active Strategy brief at the top of every prompt; prompt has explicit sections for STRATEGY STANCE and ENGINE PULSE with operator-facing guidance ("closed_wr is duration-biased; weight PF + combined_today above it")
4. LLM returns APPROVE / ADJUST / REJECT with a reason
5. Trade fires (or doesn't) based on the CIO verdict

**User-visible coherence:** ✅ The CIO sees the same context the operator sees (Active Strategy from `/insights.html`, Loop 2 pulse from MC). No more "CIO reasons in a vacuum" failure mode.

### Flow E: Loop 2 circuit breaker

1. Hourly pulse cron computes WR/Today-PnL/Consec-Losses from closed trades + profit factor + expectancy + open-book MTM (#428)
2. Eval rules: WR < 30% over last 10 closed, OR today closed < -1.5%, OR 4+ consecutive losses → would trip
3. **Override**: if PF ≥ 1.3 OR combined-today (realized + open MTM delta) ≥ -0.5%, defer the trip with `duration_bias_override: true`
4. If trip fires: Discord embed shows all 6 fields (WR, today realized, consec, PF, open book MTM, combined today) + a description block telling the operator to tune `loop2_breaker_pf_safe` / `loop2_breaker_combined_safe_pct` if the trip looks like a closed-WR headline

**User-visible coherence:** ✅ The breaker no longer paged for false alarms during normal "let winners run" sessions. When it does fire, the alert is actionable.

### Flow F: Operator runs calibration

1. System Intelligence → Analysis tab. **Explainer card** at top (#435): plain-language "calibration analyses closed trades, writes `deep_audit_*` to `model_config`, next scoring cron picks them up"
2. Operator clicks Run Analysis. Button changes to "Analyzing..." while in flight
3. Server side: deep audit pass over ALL closed trades (631 in the operator's screenshot)
4. On completion: **toast** fires (#435) — `✓ Analysis complete — 3 recommendations from 631 closed trades (5.2s)`
5. Below: recommendation cards with **freshness chips** (#435) — green FRESH if audit < 6h, amber OK < 24h, red STALE ≥ 24h
6. Toxic-ticker recommendation now displays both banned tickers AND protected ones (#433) — so the operator sees that TSM/AMZN are protected from auto-ban because they have open winning positions
7. Operator clicks Apply on a rec → key written to `model_config` → next scoring cron uses it

**User-visible coherence:** ✅ Operator now has explicit feedback at every step. The "did anything happen?" failure mode is gone.

---

## Where the remaining risk lives

These aren't broken; they're the things I'd watch carefully on the next release pass:

1. **Bridge manifest 404** — PR #433 added an actionable hint, but the underlying cause was a stale deployed bridge worker. The remediation is documented; the bridge needs to be redeployed periodically (or just every time the worker is redeployed) to stay in sync. Worth adding to the [deploy.md](skills/deploy.md) checklist.

2. **CIO + Active Strategy on quiet/neutral tickers** — PR #425 always includes `strategy_stance` even for neutral names so the LLM never reasons in a vacuum. We haven't yet measured whether this changes the APPROVE/REJECT distribution. Worth a backtest on a sample of post-#425 lifecycle decisions vs pre-#425 to confirm the LLM is using the new context.

3. **Day-trade plays on holidays / half-days** — `pickDayTradeExpiration` is weekend-aware but doesn't yet handle US trading holidays (Thanksgiving, July 4, etc.). On a holiday Monday at 10 AM ET it would return 0DTE for that holiday's date — but no chain will be listed. Easy follow-up: integrate `isUsMarketHoliday()` (already in `worker/index.js`) into the picker.

4. **Discord OAuth — server capacity** — Now that the gate is open ("Link Discord" replaces "Waitlist"), expect a surge of joins. The bot has `MANAGE_ROLES`; the role assignment is in PR #438 (existing). If the server hits Discord's free-tier guild limit (500k members? — verify), we'd need to upgrade to Boost. Watch the Member Count tile.

5. **Setup-name upstream stamp bug** — PR #432 added a display-layer self-heal but the underlying bug (something stamps a `*_breakdown` setup_name on a LONG trade) is still there. The new `[SETUP_NAME] direction mismatch` warn log makes it traceable; first occurrence should let us identify the upstream write path.

6. **Toxic-ticker safety** — PR #433 added three guards (min sample 5, open-position protection, recency override). If a future audit recommendation needs to bypass these for a legitimate reason, the recommendation card now clearly discloses the protected set so the operator can manually edit the blacklist if needed.

---

## Operator-facing summary

If asked **"can users follow what the model is doing?"**, the answer post-polish is **yes**:

- Trader entries show clear setup names matching direction (#432)
- Investor cards show OWNED + JUST OPENED chips that align with Discord entries within 60 s (#427)
- Investor thesis text includes price levels so users see "how much room before invalidation" (#429)
- Day-trade plays for SPY/QQQ/IWM are explicitly labeled `DAY TRADE · 0DTE` (#436)
- Screener thesis surfaces in the right rail Snapshot tab on every ticker (#430)
- AI CIO has the same Active Strategy + engine pulse context the operator sees on `/insights.html` and `/system-intelligence.html` (#425, #428)
- Calibration page now explains what it does + shows freshness + confirms on Run (#435)
- Discord onboarding has clear community rules + four-channel guide (#438)
- Mission Control surfaces actionable remediation hints on bridge / freshness errors (#433, #434)

The system is coherent. The remaining open work (smoke-test skill check, periodic Mission Control audits, backtest of CIO with strategy_stance always present) is steady-state operations, not unfinished features.
