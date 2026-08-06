# Context-First Scoring — Plan (2026-08-05)

Operator intent, in the engine's language:

1. **History as immutable facts at scoring time.** The scorer should know,
   per ticker, what already happened — entries, exits, why, which structural
   levels were tested and whether they held — not rediscover the world from a
   candle window every 5 minutes.
2. **Frames, not a frame.** The model should carry the movie leading up to
   the present — a lookback window tuned per ticker by Move Discovery
   (default ~30 days), not a fixed snapshot.
3. **Anticipate, then act.** Each scoring cycle should arrive with playbooks
   already armed (trigger levels, invalidation, sizing) and spend the cycle
   *checking triggers*, not doing a limited fresh analysis and then deciding.

No new score until tomorrow's open — tonight is for building the context from
data we already have.

---

## 1. Where the gap is today (verified against code)

**The 5-min cycle is stateless-ish.** `scoreTicker` (worker/index.js ~104158)
loads the prior `timed:latest:<T>`, batch-fetches candles (D1 + CandleChain DO
for LTF), recomputes `computeServerSideScores` → `assembleTickerData`, writes
back. Cross-cycle memory is thin: `_confirm_count` (2-cycle entry confirm),
`_journey.recent` (≤48 keyframes), kanban stage, `setup_sequences`, regime run
length, and a few armed state machines on investor notes (`_inv_movie`,
`_failed_reclaim`).

**The history exists but is off the hot path:**

| Store | What it knows | Fed into scoring? |
|---|---|---|
| D1 `score_keyframes` + payload `_journey` | score film ~45d | partially (journey features) |
| D1 `timed_trail` → `trail_5m_facts` | 5m score snapshots → aggregated facts | no (research only) |
| D1 `trades`, `investor_lots`, `investor_positions` | full position history + reasons | no (only re-entry cooldown reads closes) |
| D1 `decision_records` | version-pinned ENTRY/TRIM/EXIT provenance | no |
| D1 `calibration_trade_autopsy` | MFE/MAE/verdicts per closed trade | no (calibration only) |
| KV `timed:move-discovery`, `timed:discovery:weekly-move-autopsy` | move size/duration/capture per ticker | no |
| D1 `ticker_profiles.learning_json` | personality, entry_params, runtime_policy | yes (trader lane) — but no event history |
| `INVESTOR_STRUCTURAL_ANCHORS` | hand-stamped memory (ANET Daily 21, CAT weekly retest) | yes — but manual, per-incident |

**Anticipation is fragmentary.** Confirm counts, kanban `enter_now`, sequences
`entry_ready`, investor `act_now/ready`, sticky `primaryInvalidation`, and the
armed SMs each solve one case with its own storage and lifecycle. There is no
single "here is what would make me act next cycle" object.

The ANET and CAT autopsies are both instances of the same root: **frame-by-frame
analysis with no durable memory of the tests that held.** CAT's week-low retest
was invisible because the only lens was live-print proximity; ANET's wick exit
fired because one frame breached; the CAT re-entry never happened because
nothing remembered the franchise history after the book went flat.

---

## 2. Design — four building blocks

### A. Ticker Context Ledger — immutable facts (`worker/context-ledger.js`)

Append-only D1 table + compact per-ticker rollup that rides the hot path.

```sql
CREATE TABLE ticker_context_facts (
  fact_id TEXT PRIMARY KEY,        -- <ticker>:<kind>:<ts>
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,              -- position_event | structural_test | move | autopsy_verdict | operator_note
  ts INTEGER NOT NULL,             -- when the fact HAPPENED (not when recorded)
  payload_json TEXT NOT NULL,
  source TEXT,                     -- trades | investor_lots | decision_records | autopsy | discovery | operator
  supersedes TEXT,                 -- corrections are new facts, never edits
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ctx_facts_ticker_ts ON ticker_context_facts (ticker, ts);
```

Fact kinds:
- **position_event** — every entry/trim/exit with price, reason, outcome
  (CAT: BUY 6/24 @987.85 score 83; SELL 7/7 @917.31 invalidation, −7.1%).
- **structural_test** — anchor (Weekly EMA21 / Weekly ST / Daily 21 / Monthly
  ST / prior breakout level) tested → held or failed, with the resolution
  (reclaim within N sessions). Derived from daily/weekly candles + indicator
  levels — computable tonight from `ticker_candles`.
- **move** — from Move Discovery: start/end, magnitude, duration, capture
  label (TOUCHED/PARTIAL/MISSED) and miss reason.
- **autopsy_verdict** — operator/autopsy gradings (bad entry, late exit,
  wick-vs-close). Today these die in tasks/*.md; make them data.
- **operator_note** — the Aug 1 "Breakout retest Caterpillar Play" class of
  note, stamped with ts.

Rollup (small, hot-path safe — a few KB): written to
`ticker_profiles.learning_json.context` + mirrored on the score payload as
`_context`. Contains: last position summary, derived anchors (below), window
stats, capture record, open operator notes.

**Derived anchors replace hand-stamping.** `INVESTOR_STRUCTURAL_ANCHORS` (ANET,
CAT) becomes the seed/override layer; the ledger derives the same shape from
facts: "Weekly EMA21: 3 tests, 3 held → `weekly_ema21_respect: true`". New
respect memory appears automatically after the second held test — no PR per
incident.

### B. Frame digest — the movie into the score (`worker/frames.js`)

At scoring time attach `td._frames`: a fixed, cheap feature set distilled from
the lookback window (source: `score_keyframes` + daily candles + ledger facts):

- score slope / stage dwell (extends existing journey features)
- anchor-distance **trajectory** (approaching / tested / reclaiming — not just
  current distance; this is exactly what CAT needed)
- structural tests inside the window with resolution
- prior cycle deltas (what changed since the model last looked)
- position-history overlay (are we re-approaching a level we were stopped at?)

Consumers: `computeInvestorScore` gains a **context component** (movie confirms
vs single frame; respect memory bonus; failed-anchor penalty), and
`detectAccumulationZone`/kanban read trajectory instead of only live proximity.

### C. Optimal window from Move Discovery (`worker/discovery/optimal-window.js`)

Per ticker, from `timed:move-discovery` (60d ATR-scaled moves) + weekly
autopsy: median move duration, lead-in frames (setup start → trigger), typical
retrace depth. Emit `context.window_days` (clamp 10–60, default 30) and
`context.leadin_days`. The frame digest and structural-test derivation use this
window instead of a hardcoded 30. Refresh in the tt-research 22:00 UTC nightly
batch. Completed moves only — no lookahead.

### D. Armed playbooks — anticipate, then act (`worker/playbooks.js`)

One first-class per-ticker array, persisted on the payload and in
`timed:investor:scores`:

```js
_armed_playbooks: [{
  playbook: "weekly_breakout_retest",       // named, from a small registry
  direction: "LONG",
  trigger: { kind: "reclaim_hold", level: 808, band_pct: 1.0, confirm: "close_or_2_cycles" },
  invalidation: { level: 776, kind: "weekly_close_below" },
  sizing_hint: { lane: "investor", alloc_pct: 3 },
  confidence: 72,
  source_facts: ["CAT:structural_test:...", "CAT:position_event:..."],
  armed_ts, expires_ts, armed_by: "nightly|hourly|cycle"
}]
```

- **Armed by**: nightly close analysis (primary), hourly investor compute,
  and the 5-min scorer when proximity develops intra-day.
- **The 5-min cycle flips its shape**: evaluate armed triggers FIRST (cheap
  price-vs-level checks + confirm counters) → act path; the full snapshot
  re-analysis runs after, to re-arm/expire playbooks — not to make the
  decision. This is the "anticipate each scoring cycle" ask.
- Existing SMs (`_inv_movie`, `_failed_reclaim`, sticky invalidation, confirm
  counts) keep working unchanged; playbooks are additive and subsume them
  over time.

---

## Status (2026-08-06)

**Phase 0 SHIPPED + backfilled**: `worker/context-ledger.js` +
`worker/discovery/optimal-window.js` + admin routes
(`POST /timed/admin/context/backfill`, `GET /timed/admin/context/:ticker`).
Production `ticker_context_facts` holds **9,826 facts across 309 tickers**
(4,648 moves / 4,458 structural tests / 720 position events). Rollups stamped
to `learning_json.context` + KV `timed:context:<T>`. Verified: CAT shows
entry 987.85 → invalidation exit 917.31 and the week-of-Jul-27 low-776 test
of Weekly ST 813.59 resolved HELD; derived anchors give CAT + ANET their
respect memory from data (ANET D_EMA21 15/15 held). Investor mid-position
sells labeled TRIM (PLTR open position shows no false exit).
**Next**: Phase 1 shadow — `worker/frames.js` digest + `worker/playbooks.js`
arming, stamped by the scorer behind `deep_audit_context_scoring_shadow`.

## 3. Tonight — use the data we already have (no new scores needed)

Order matters; all read-only against live behavior:

1. **Backfill the ledger.** Admin route `POST /timed/admin/context/backfill`
   (batched per ticker, jittered — respect the 2026-07-31 D1-storm lesson):
   position_events from `trades`+`investor_lots`+`decision_records`;
   structural_tests from D/W candles vs EMA21/ST/EMA200 levels over the last
   ~90 days; moves from discovery KV; autopsy_verdicts from
   `calibration_trade_autopsy` + the July LT autopsy docs (ANET, CAT, MTZ, MU,
   NBIS, AMD, IESC as seed operator_note facts).
2. **Compute windows.** Run optimal-window over the universe; stamp
   `learning_json.context.window_days`.
3. **Arm tonight's playbooks.** `timed:latest:*` already holds today's close
   state. Run the arming pass so tomorrow's FIRST cycle opens with playbooks
   ready (CAT weekly-retest continuation, any name near a respected anchor).
4. **Verify with known cases** (the acceptance test for the backfill):
   - CAT ledger shows: 6/24 entry 987.85 / 7/7 invalidation exit 917.31 /
     Aug week-low 804.57 held Weekly 21+ST → structural_test held → derived
     `weekly_ema21_respect`.
   - ANET shows Jul 6–16 movie + Daily 21 held test.
   - PLTR shows the held-through-earnings path.

## 4. Rollout phases (after tonight)

| Phase | Scope | Gate |
|---|---|---|
| 0 (tonight) | Ledger backfill, windows, first arming — artifacts only | admin route, no behavior change |
| 1 (shadow, 3–5 sessions) | Scorer stamps `_frames` + `_armed_playbooks` + hypothetical act/no-act each cycle; nightly compare vs actual entries/exits and vs Move Discovery capture | `deep_audit_context_scoring_shadow=true` |
| 2 (investor live) | `computeInvestorScore` context component; accum zone reads trajectory; playbook trigger → `act_now` admit | `deep_audit_context_scoring_investor_enabled` |
| 3 (trader live) | Kanban/entry gates consume frames + playbooks | separate knob; after Phase 2 report |

Shadow report card: for each armed playbook — did it trigger, did the model
act (or would it have), what happened after (join Move Discovery). Promotion
requires the shadow beating the current lane on capture-rate without new
losses (same discipline as July replay promotions).

## 5. Constraints and risks

- **D1 load**: nightly backfill/refresh must batch with jitter (COO
  calibration D1-storm lesson). Rollups keep the hot path on KV/payload.
- **Payload size**: `_context` + `_frames` + `_armed_playbooks` must stay
  compact (short keys, capped arrays) — `timed:latest` already has minimal-
  mode pressure.
- **Replay parity**: facts carry event `ts`; any replay filters
  `ts <= replay_now`. Never let a replay see facts from its future.
- **No lookahead in windows**: window stats from completed moves only.
- **Immutability**: append-only; corrections are new facts with `supersedes`.
  Provenance via `source` + `source_facts` on playbooks so every action can
  answer "which facts armed this."

## 6. Deliverables map

| File | Content |
|---|---|
| `worker/context-ledger.js` | fact schema, append/read, rollup, `deriveStructuralAnchors` |
| `worker/frames.js` | frame digest builder (`buildFrameDigest(td, ledger, windowDays)`) |
| `worker/discovery/optimal-window.js` | per-ticker window from move stats |
| `worker/playbooks.js` | registry, `armPlaybooks`, `evaluateArmedTriggers` |
| `worker/index.js` | scoreTicker: trigger-first evaluation + `_frames`/`_context` attach; investor compute wiring; nightly batch job; admin backfill route |
| tests | ledger rollup, anchor derivation, CAT/ANET fixtures as regression cases, playbook trigger/expiry |
