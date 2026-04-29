# Phase C — Design: Rank-All-Take-Top-N Entry Selection

**Date:** 2026-04-29  
**Goal:** Replace greedy first-come-first-served entry execution with a per-bar ranked selection process. Eliminate the slot-fill cascade that has killed three previous entry-side filter attempts.

## Problem statement

Today's engine enters trades greedily as it iterates tickers. When a high-quality candidate gets blocked by a quality filter, the freed slot fills with a lower-quality alternative — the next ticker in iteration order that passes the gate. This is the **slot-fill cascade** documented in `tasks/2026-04-29-cascade-lessons.md`.

**The fix is structural**: defer entry commits to end-of-bar, score every eligible candidate with a composite quality score, and take only the top N up to remaining capacity. Anything below the cutoff is simply rejected for this bar (re-evaluated next bar).

## Scope of change

This is a focused refactor of the **entry execution path** in two execution contexts:

1. **Replay** (`worker/replay-candle-batches.js` + `worker/replay-interval-step.js` + `worker/index.js processTradeSimulation`)
2. **Live** (`worker/index.js` `[KANBAN CRON]` execution loop)

It does NOT change:
- Score/rank/conviction/divergence computation (already happens upstream)
- Position management (still per-ticker per-bar)
- Exit logic (untouched)
- Smart gates that should remain hard (late-day block, replay lock, weekend, outsideRTH, position-cap saturation)

## Architecture: candidate buffer + batch commit

### Per-bar lifecycle (replay path)

```
For each interval `intervalTs` in batch:
  candidateBuffer = []           ← NEW: collect candidates here
  
  For each ticker in batchTickers:
    result = build tickerData / scores / classify  (UNCHANGED)
    
    If stage is enter-eligible:
      ┌─ NEW PATH ─────────────────────────────┐
      │ Run hard gates (lateDay, weekend,      │
      │   replayLock, outsideRTH, etc.)        │
      │ If hard-blocked → record diagnostic,   │
      │   no candidate, skip                   │
      │                                         │
      │ Otherwise compute composite quality    │
      │   score for THIS bar                    │
      │ Push to candidateBuffer                │
      └─────────────────────────────────────────┘
    Else:
      processTradeSimulation as today           (manage existing position
                                                 OR run setup-state logic
                                                 — no entry path)
  
  ┌─ END OF BAR (NEW) ─────────────────────────────┐
  │ Sort candidateBuffer by quality_score DESC     │
  │ remainingCap = MAX_OPEN_POSITIONS - openCount  │
  │ topN = candidateBuffer[0..min(N, remainingCap)] │
  │ For each winner in topN:                        │
  │   processTradeSimulation with __force_enter=true│
  │     (skip re-running gates we already passed,   │
  │      commit the entry)                          │
  │ For each loser:                                 │
  │   record reject diagnostic in replayCtx         │
  └─────────────────────────────────────────────────┘
```

### Per-cron-cycle lifecycle (live path)

The live system already has TWO passes:
1. **Scoring pass** (parallel batches of 15) — writes `timed:latest:${ticker}` in KV
2. **Execution pass** (`[KANBAN CRON]`, sequential `for` over `executionTickers`) — calls `processTradeSimulation`

The execution pass is where we insert the candidate buffer. Currently:

```
for (sym of executionTickers):
  latest = read KV
  processTradeSimulation(...)  ← may enter, may manage
```

Becomes:

```
candidateBuffer = []
manageList = []

# First pass: classify + buffer
for (sym of executionTickers):
  latest = read KV
  if existing open position:
    manageList.push({sym, latest})
  elif latest.kanban_stage in [in_review, enter, enter_now]:
    if hard_gates_pass(latest):
      score = composite_quality(latest)
      candidateBuffer.push({sym, latest, score})

# Second pass: manage existing positions (no cap concern)
for ({sym, latest} of manageList):
  processTradeSimulation(KV, sym, latest, null, env)

# Third pass: rank + commit top N entries  
candidateBuffer.sort(score desc)
remainingCap = MAX_OPEN_POSITIONS - openCount  # recompute after manage pass
winners = candidateBuffer.slice(0, min(N_PER_CYCLE, remainingCap))
for (winner of winners):
  processTradeSimulation(KV, winner.sym, winner.latest, null, env, {forceEnter: true})

# Diagnostic: record rejected candidates for forensics
for (loser of candidateBuffer.slice(winners.length)):
  log/persist "rejected: {sym} score={x} reason=below_topN"
```

### Composite quality score

The score combines existing rank/conviction with the newly-captured signals as quality CONTRIBUTORS (not blocks):

```
composite_quality(t) =
    w_rank       * normalize(t.rank, 0..100)            # primary
  + w_conviction * normalize(t.__focus_conviction_score) # secondary
  + w_divergence * divergence_modifier(t)               # NEW
  + w_pdz        * pdz_modifier(t)                      # NEW
  + w_td         * td_exhaustion_modifier(t)            # NEW
  + w_personality* personality_modifier(t)              # ties to Phase 1

Where:
  divergence_modifier:
    -25 if F4 (BOTH adv RSI + adv phase active)
    -10 if adv phase strongest TF in [10m, 30m]
     +5 if no adverse divergence at all
      0 otherwise
  
  pdz_modifier (LONG only — flip sign for SHORT):
    +10 if D & 4h both 'premium' (78% WR / 93% on stack)
     +5 if D 'premium'
      0 otherwise
  
  td_exhaustion_modifier (LONG only — flip for SHORT):
    -10 if D td9_bear fired or D bear_prep >= 8
     +5 if D bull_prep is fresh
      0 otherwise

  personality_modifier (Phase 1 ties in here):
     +5 if explosive personality
      0 if balanced
     -5 if mean-reverter
```

All weights DA-keyed for tunability. Defaults from this session's empirical findings.

### Hard gates vs soft scoring

**Hard gates (still binary block):**
- `lateDayEntryBlocked` (15:30-16:00 ET)
- `weekendNow`, `outsideRTH`
- Replay lock active
- Open trade exists for same ticker+direction
- Daily entry count cap exceeded
- Smart gates (sector limit, correlation, direction balance — these were already binary)

**Soft scoring (Phase C):**
- Quality composite score → top N selection
- F4 divergence (was V4's binary block; now -25 score penalty)
- Late extension / dead-zone slope (V3's F1/F3; now -10 penalty)
- PDZ favorable (positive contribution)
- TD exhaustion (negative contribution)

### Capacity controls (DA-keyed)

- `deep_audit_max_entries_per_bar` (default 3) — top-N cap per bar
- `deep_audit_max_entries_per_cycle` (default 5) — live cron cycle cap
- `deep_audit_quality_score_min` (default -20) — absolute floor; below = reject even if in top N
- `deep_audit_phase_c_enabled` (default false initially) — kill switch

### Implementation plan

**Step 1: Helper module** — `worker/pipeline/entry-selector.js`
- `computeQualityScore(tickerData)` returns a number
- `bufferCandidate(buffer, ticker, tickerData, score)` 
- `selectTopN(buffer, capacity, opts)` returns winners + losers
- Pure functions, easy to unit test

**Step 2: Replay integration** — `worker/replay-candle-batches.js`
- Add candidate buffer in inner loop
- Split tickers into manage vs candidate pools
- Run manage pass first
- Score + sort candidate pool
- Run entry pass with `__phase_c_winner=true` flag for top-N
- Record diagnostics for rejected
- Behind `deep_audit_phase_c_enabled` flag — falls back to current behavior if off

**Step 3: processTradeSimulation tweaks** — `worker/index.js`
- Honor `__phase_c_winner` flag when set: skip soft-gate re-evaluation (since we already committed in selection step)
- Add `__phase_c_rejected` flag for skipped candidates (record but don't enter)
- These flags only apply when `deep_audit_phase_c_enabled=true`

**Step 4: Replay interval step parity** — `worker/replay-interval-step.js`
- Same buffer pattern (inner loop)

**Step 5: Live cron integration** — `worker/index.js` `[KANBAN CRON]`
- Two-pass: manage existing → buffer + select entries
- Replay logic identical to replay path

**Step 6: Diagnostics**
- New replayCtx field: `_phaseCRejected[]` for forensics
- KV/D1 logging of "near-miss" candidates so we can see what was scored second-place

### Side-effects to manage

The audit identified that `qualifiesForEnter` and `classifyKanbanStage` mutate `tickerData` with various `__entry_*` fields. For Phase C:
- We RUN these per-ticker as today (we need the scores)
- The MUTATIONS are fine — they describe the candidate's would-be entry, but we never commit unless selected
- KV downgrades (`in_review` → `setup`) for rejected candidates need consideration: should rejected candidates stay in `in_review` so they're considered next bar, or get downgraded to `setup`? Lean toward: keep in `in_review` so they're re-eligible (likely with similar score) on the next bar
- Replay state (`stateMap[ticker]`) gets the candidate's tickerData regardless — that's fine, no commit happened

### Validation gate

**July go/no-go smoke** at v16-fix4 + Phase C, F4 enabled as soft penalty (not hard block).

Pass criteria:
- WR ≥ 67% (matches clean baseline)
- PnL within ±10% of baseline (+427pp ± 43pp)
- **No top-15 winner regression** (LITE/AVGO/FN/BWXT/PLTR/PSTG/BK/AEHR/UTHR/U/GOOGL/JOBY/IREN/AMD/NVDA all preserved or improved)
- F4 cohort outcome better: trades that would've been F4 hits should be REJECTED in favor of better-scored alternatives (cohort WR > 50%)

If pass: launch full canonical Jul→Apr. If fail: investigate specific cohort then iterate weights.

### What enables future work

Phase C is the foundation. Once it's in place:
- **Phase 1** (per-ticker personality runner protection) plugs in via `personality_modifier` and exit-side modulators with no cascade risk
- **F4 divergence** can be re-enabled with confidence as a quality penalty
- **PDZ + TD signals** become first-class scoring inputs
- **GRNY/GRNJ Top-5 Core Ideas** (Phase 2) become a scoring boost
- Future entry refinements don't need cascade-aware design

## Open questions for review

1. **Initial quality weights**: empirically derived from this session's forensic. Worth a sensitivity sweep on July smoke before locking in?
2. **Capacity per bar** (default 3): is this right, or should it scale with total open capacity? E.g., if 15 slots are open, allow more entries per bar than if only 3 are open?
3. **Rejected diagnostic persistence**: KV-only, or also D1 for autopsy? D1 lets us aggregate "near-miss" stats over time.
4. **Live cron parallelism**: today's scoring pass is parallel; the entry-selector pass MUST be sequential after scoring completes. Do we add a barrier, or piggyback on the existing sequential `[KANBAN CRON]` execution loop? Leaning toward the latter (no new infra).
5. **Replay-mode determinism**: with sorted top-N selection, runs become more deterministic (great for reproducibility). But two trades with identical scores need a tiebreaker — alphabetical ticker? Insertion order? Random with seed?

## Risk assessment

- **HIGH**: `processTradeSimulation` is a 1500+ line function with many entry side-effects. Any change to the commit path needs careful preservation of: trade ID generation, KV upserts, D1 ledger entries, Discord alerts, just_entered transition, sizing/risk calculation, CIO integration. Mitigation: feature-flag everything; run side-by-side smoke (V3-style) where Phase C produces additional logs without changing behavior.

- **MEDIUM**: Live cron execution is sequential but scoring is parallel. We need to ensure the buffer captures the LATEST scored state per ticker for the cycle, not stale KV from a prior cycle. Mitigation: buffer construction reads from KV at execution-pass time, not scoring-pass time.

- **LOW**: Replay-mode batch boundaries. If a candidate is buffered in batch 1 but not selected, and batch 2 starts a new bar, the candidate is gone. This matches today's semantics (each bar is independent), so no change.

## What I want to confirm before implementing

This design is non-trivial. Before I cut code, please confirm:

1. **Architecture is right** (candidate buffer + end-of-bar batch commit, hard gates stay binary, soft scoring at selection)
2. **Quality score formula is roughly right** (rank/conviction primary, divergence/pdz/td/personality as modifiers)
3. **Capacity defaults** (max 3 entries per bar, max 5 per live cycle) are reasonable starting points
4. **Validation gate** (July smoke, ±10% PnL, no top-15 winner regression) is the right bar to clear

If you green-light, I'll start with Step 1 (helper module + unit tests), then Step 2 (replay integration with feature flag), then July smoke before touching live.
