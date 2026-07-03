# 2026-07-03 — Holiday-Weekend Stabilization Plan

Operator directive (2026-07-03): stop the loop of one-off fixes. Use the
July 4 long weekend (market closed Fri Jul 3 – Sun Jul 5) to fix the system
end to end so the constant regressions stop. Three objectives, worked in
order, each with a verification gate before moving on.

This document is the single plan of record for that effort. Each phase
below ships as its own PR(s); progress is tracked by checkboxes here, not
in `tasks/todo.md` (PR-conflict hygiene per CONTEXT.md).

---

## The pattern behind the regressions (read this first)

The last month of incidents — stale 10/15/30m candles (Jun 12, Jun 15,
Jul 2), the NVDA missed stop-loss, split-day phantom movers, the
`investor_compute_stale_candles` pages — are not independent bugs. They
share one structural cause:

**The same real-world fact is computed in more than one place, and the
copies disagree.**

Concrete instances found so far:

| Fact | Copies | Incident it caused |
|---|---|---|
| "Is the market open right now?" | `worker/market-calendar.js` (static fallback + Alpaca), `worker/foundation/trading-calendar.js`, `react-app/shared-price-utils.js`, a local copy in `today.html`, `approxNyRegularMarketOpen` in `worker/freshness.js` | **Jul 2 stale-candle incident** (see RCA below); Bug 1 (holiday state) |
| "What is this ticker's daily change?" | `getDailyChange()` (canonical) vs. raw `dailyChgPct` / inline math (mostly eradicated, still re-appears) | Split-day phantom -75% CRWD mover |
| "What is the current stop-loss?" | KV trade row, D1 `getOpenPositionAsTrade` (drops `sl_price`), entry-history resolution | NVDA SL breach not acted on |
| "Which candles feed scoring?" | Legacy D1 reads vs. candle-chain DO, per-worker binding differences | Jun 15 93-95% investor exclusion |

The stabilization strategy is therefore NOT "fix each symptom" but
"collapse each duplicated fact to one source of truth, and add a CI
guard that fails when a copy drifts."

---

## RCA: Jul 2 `investor_compute_stale_candles` pages (34% → 76%)

Root cause found 2026-07-03, fix ships with this plan's Phase A PR.

1. `worker/market-calendar.js` `EQUITY_EARLY_CLOSE_FALLBACK` wrongly
   listed **2026-07-02** as a 1 PM ET equity early close. That date is the
   SIFMA *bond market* early-close recommendation; NYSE/Nasdaq equities
   traded a full session (verified against NYSE calendar + press).
2. The live `/timed/market-calendar` is serving `source: "static"`,
   `fetched_at: 0` — the Alpaca dynamic calendar fetch is failing, so the
   wrong static fallback is what production actually uses.
3. At 13:00 ET on Jul 2, `isNyRegularMarketOpen(cal)` flipped false on
   the feed worker → `syncLivePricesToChartCandles` stopped patching the
   forming 10/15/30/60m bars (`skipped: "market_closed"`).
4. The freshness grader anchors on the OTHER calendar
   (`worker/foundation/trading-calendar.js`), which correctly has no
   Jul 2 early close → it kept the strict RTH SLOs (10m ≤ 30 min soft,
   60 min hard).
5. 13:00 + 60 min hard SLO = **14:00 ET: 10m TF went STALE across the
   universe.** Investor hourly compute at 14:02 excluded 99/291 (34%),
   the next invocation 221/291 (76%). Both paged because the alert dedup
   treats a changed count as a new error signature.
6. Overnight, the out-of-session SLO (96h) took over — that's why
   freshness self-recovered to 299/299 FRESH by the evening without a fix.

Same-class incident to remember: Juneteenth (Jun 19) false-open, noted in
`today.html` comments. Calendar divergence is a repeat offender.

---

## Bug 1 — holiday state (ships with this plan)

`react-app/shared-price-utils.js` `isNyRegularMarketOpen()` was
weekday+time only. On Fri Jul 3 (holiday) during 9:30–16:00 ET, every
consumer (cards, movers, right rail, `getDailyChange`, `getHeadlinePrice`,
`getExtChange`, EXT row suppression, the 10-min price-freshness window)
behaved as if RTH were open. The Today page's session pill was already
calendar-aware (server correctly reports `is_holiday_today: true`,
"Independence Day") — the gap was the shared price utils every page uses.

Fix (PR with this doc):

- [x] `shared-price-utils.js`: embed the NYSE holiday + 13:00-ET
      early-close tables (2025–2028, maintained annually, same contract as
      the worker calendars) so `isNyRegularMarketOpen()` is
      holiday/half-day aware everywhere the frontend computes session
      state.
- [x] `worker/market-calendar.js`: remove bogus equity early closes
      (2026-07-02, 2027-07-02, 2027-12-23, 2028-12-22 — all bond-market
      recommendations or non-events per NYSE precedent). Keep the real
      ones (day after Thanksgiving, Christmas Eve when a weekday,
      2028-07-03).
- [x] `worker/foundation/trading-calendar.js`: extend HOLIDAYS/HALF_DAYS
      through 2028 so the two worker calendars can't diverge at a year
      boundary.
- [x] Cross-calendar parity test: a single vitest that asserts the
      market-calendar static fallback, the foundation calendar, and the
      frontend table agree on every holiday + early close 2025–2028.
      Drift = red CI.

---

## Objective 1 — Source-to-execution correctness

Goal: latest price, correct anchors (Daily % vs EXT %), latest score,
correct bias/plan, on every surface, always — and when an input IS stale,
it is quarantined loudly (already the doctrine) rather than rendered.

The chain, and what owns each link:

```
TwelveData/Alpaca → tt-feed */1 (timed:prices KV, live-candle sync 10/15/30/60 → D1)
                  → monolith */5 bar cron (REST bars → D1, chain DO ingest)
                  → tt-engine */5 scoring (chain reads, _freshness stamp, timed:latest)
                  → investor hourly compute / trader lifecycle (quarantine-aware)
                  → /timed/all + WS → frontend (shared-price-utils anchors)
```

### Phase A — close the known holes (this weekend)

- [x] **A1. Calendar unification (Bug 1 PR, above).** One truth for
      "is the market open", verified by CI parity test.
      **DONE — PR #962 (merged).**
- [x] **A2. Dynamic calendar fetch is failing — diagnose + alarm.**
      **DONE — PR #963, deployed + verified.** Root cause: the dynamic
      fetch ran ONLY in the 4 AM UTC nightly lane with no retry and no
      alerting; one failure left the fleet on the static table all day.
      Now: every static fallback carries a `fallback_reason`; 401/403
      retries the alternate Alpaca host; any cron tick on the static
      calendar self-heals (hourly KV lock) and records a
      `market_calendar_dynamic_fetch` tombstone;
      `POST /timed/admin/market-calendar/refresh` returns diagnostics.
      Prod verified serving `source: alpaca` (Independence Day flagged).
- [x] **A3. Binding-parity CI guard** (planned in
      `tasks/2026-06-15-freshness-rca-and-build-plan.md`, never built).
      **DONE — PR #964.** `tests/wrangler-binding-parity.test.js`:
      21 assertions across the four wrangler.tomls (role-worker DO/service
      /var requirements, DO stubs point at the monolith, KV/D1 id parity,
      tt-engine candle-source flags, monolith default==production).
      Mutation-tested against the Jun 15 incident class.
- [ ] **A4. Feed → freshness same-calendar invariant.** The feed's
      market-open gate and the freshness SLO selection must come from the
      SAME calendar call. Plumb the session answer into
      `computeFreshnessBlock` callers from `market-calendar.js` (or move
      both onto the foundation calendar) so a calendar disagreement can
      never again mean "feed off, SLO strict". Residual risk is much
      smaller post-A1/A2 (tables corrected + dynamic self-heal): the
      remaining exposure is a dynamic-calendar vs static-table disagreement
      (e.g. unscheduled closure). Do this as a careful standalone PR — it
      touches the scoring hot path.
- [x] **A5. NVDA-class execution persistence closeout (PR #961
      follow-up).** **DONE — PR #967, deployed + verified live.** Root
      cause was NOT the adapter: the `DIRECTION_MISMATCH` entry gate in
      `processTradeSimulation` returned BEFORE the open-trade lookup, so
      an open trade whose state flipped against the position (NVDA LONG +
      HTF_BEAR_LTF_BEAR) skipped ALL management every pass — SL nets,
      trims, exits, and the PR #961 feed hard close all died there. Gate
      now defers until after the lookup and blocks entries only. NVDA
      zombie closed live: `sl_breached @ $194.83 (-7.18%)`, Discord +
      email alerts delivered. Post-merge follow-up: audit other open
      trades for stale `updated_at` gaps (same freeze class).
- [x] **A6. Alert dedup for escalating counts.** **DONE — PR #965.**
      `cronErrorSignature()` (digits stripped) + `cronErrorSeverityBand()`
      (25/50/75%); pages on first failure, shape change, or band
      escalation only.
- [x] **A7. Anchor contract tests.** **DONE — PR #966.**
      `tests/shared-price-utils-session-matrix.test.js`: 26 tests across
      RTH / pre / post / weekend / holiday-during-RTH-hours / early-close,
      covering `getHeadlinePrice`, `getDailyChange`, `getExtChange`, and
      the session-aware feed-freshness window.

**Gate for Objective 1:** five consecutive RTH days with
`/timed/health → freshness.slo_ok: true` all session, zero
`investor_compute_stale_candles` pages, zero operator interventions.
Watch Mon Jul 6 open explicitly (first session after the fix).

### Phase B — make it stay fixed

- [ ] **B1. Session-state consolidation in the worker.** `worker/index.js`
      has `isNyRegularMarketOpen` + `approxNyRegularMarketOpen`
      (freshness.js) + per-module copies. Collapse onto
      `market-calendar.js` (dynamic) with the foundation calendar as the
      grid/anchor engine. One exported `getMarketSession(env, now)` used
      by feed, bar cron, scoring, freshness, movers, and the API.
- [ ] **B2. E2E smoke as CI/cron.** A scheduled check (extend
      `watchdog.yml`) that walks the chain for 3 sentinel tickers:
      `timed:prices` age → newest 10m/30m D1 bar age → `timed:latest`
      `_freshness` → `/timed/all` overlay price. Alarms name the LINK that
      broke, not the symptom downstream.
- [ ] **B3. `maxTickers` audit on live-candle sync.** Universe is 299+;
      sync caps at 280 with open-position priority. Either raise the cap
      or make the remainder rotate so no ticker starves >2 ticks.

---

## Objective 2 — From snapshot to story (temporal context)

Goal: scoring/decisions consume the JOURNEY (preceding price action,
aging overlays, corridor transitions), not just the latest frame. The
bubble-map "corridor travel" idea, generalized to every input.

What already exists to build on (do NOT rebuild):

- Trade trajectories: `TradeTrajectories.backfillTradeTrajectories`
  builds bubble-map cell sequences for closed trades (S1.5).
- Setup sequences: `SETUP_SHADOW_STAMP` (`setup_sequences`,
  `setup_shadow_posture`) already emits ordered event chains per ticker.
- HMM latent state, sector RS ranks, FSD holdings map
  (`loadETFWeightMap`), CIO memory cache — all loaded per compute today
  but only as point-in-time values.
- `timed:capture:latest:<TICKER>` ingest snapshots.

### Phase C — the snapshot chain

- [ ] **C1. Keyframe store.** On each */5 scoring tick, append a compact
      keyframe per ticker (score, rank, bias, zone/stage, corridor cell,
      phase, extension, freshness grade) to a rolling per-ticker series
      (D1 table `score_keyframes` or a chain-DO stream; decide by write
      cost — D1 first, it's ~300 rows/5min). Retention ~30 trading days.
- [ ] **C2. Derived journey features.** From the keyframe chain compute:
      score slope (1h/1d), corridor transition events, rank momentum,
      time-in-zone. Stamp onto the scored payload (`_journey`) so
      `computeRank` / entry gates / the UI can consume without re-reading
      history.
- [ ] **C3. Overlay provenance + maturation.** Every advisory input (FSD
      tactical note, CRO research note, macro overlay, CIO memo) gets
      `issued_at`, `expires_at` (or a maturation condition), and a
      `status` (active/maturing/expired). Scoring and CIO prompts read
      only ACTIVE overlays; expiry is enforced centrally, not per
      consumer. Retires the "system quotes a stale semis note" failure
      mode.
- [ ] **C4. Thematic propagation → action.** When an active overlay calls
      a rotation (e.g. semis stall → Mag 7/software), map it to concrete
      book actions via the existing management hooks: tighten SL to
      BE/profit-lock on affected holdings, trim, or flag a hedge
      suggestion. Start shadow-mode (log the action it WOULD take + why),
      promote after a week of sane shadow output.
- [ ] **C5. Cross-ticker correlation (later).** Corridor-transition
      correlation across tickers/sectors/indexes. Explicitly out of scope
      until C1–C4 are live and trusted.

**Gate for Objective 2:** for a sample of 10 tickers, the right rail can
render "the story" (keyframe sparkline + active overlays with ages +
journey features) and at least one shadow-mode rotation action fires
correctly on a real FSD note.

---

## Objective 3 — Organize the chaos (answer-first UX)

The three user questions:

1. What should I buy right now to grow my account? Why?
2. Should I buy THIS ticker now? When? At what price? Why?
3. Should I sell THIS ticker now? When? At what price? Why?

Everything else is supporting evidence, and should be one click deeper.

### Phase D — design first, then build

- [ ] **D1. Answer-first audit.** For each journey page (Today, Active
      Trader, Investor, Portfolio), write down which of the 3 questions it
      answers ABOVE THE FOLD today, and what noise sits in front of the
      answer. Deliverable: one-page audit doc + mock direction. (Design
      constraints: DESIGN.md/Verda, no "you/your" copy.)
- [ ] **D2. Per-ticker verdict block.** One component (right rail top +
      ticker cards) that renders: verdict (BUY/HOLD/SELL/WAIT), the lane
      it belongs to (Trader vs Investor — visually unmissable), entry/exit
      price, timing ("now" / "on confirmation of X"), and a one-line why.
      Backed by the existing plan/scores; enriched by `_journey` (C2) so
      "when" can be "setup forming — 2 of 3 conditions met" instead of a
      surprise alert.
- [ ] **D3. Setup lifecycle surface.** Replace "random alert fired" with a
      visible progression: FORMING → READY → TRIGGERED → MANAGED →
      CLOSED, driven by setup_sequences + entry gates. Users watch a setup
      mature instead of reacting to a ping. Alerts become lifecycle
      transitions, each labeled Trader or Investor.
- [ ] **D4. Signal separation.** Every alert/digest/Discord message
      carries the lane tag; users can mute a lane. Audit alert templates
      for lane ambiguity (the "users become lost in the signals" report).
- [ ] **D5. Trust ledger surface.** The signal-outcomes ledger already
      tracks model timing. Surface a simple public track record (calls,
      hit rate, avg lead time) so BYOB users can verify timing skill
      before trusting funds.

**Gate for Objective 3:** a new user can answer all 3 questions for any
ticker in ≤2 clicks, and can tell Trader vs Investor guidance apart at a
glance. Operator walkthrough sign-off.

---

## Sequencing + working agreement

1. **Phase A this weekend** (market closed = safe deploy window). A1 is
   this PR; A2–A7 are each a small PR, tested, deployed, verified against
   prod before the next starts.
2. **Monday Jul 6 open is the Objective 1 gate test.** Watch
   `/timed/health` freshness through the first session; no new work until
   the open is green.
3. Phase B/C in the following week; Phase D design doc can proceed in
   parallel (no code).
4. Every regression fixed during this program MUST add: (a) the test that
   would have caught it, (b) a one-line lesson in `tasks/lessons.md`.
   No test, not merged.
5. One logical change per PR. No hot-patching prod outside the PR flow
   except live-site emergencies.
