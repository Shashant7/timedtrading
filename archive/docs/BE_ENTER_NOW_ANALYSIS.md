# BE Enter Now / Missing Lane — Analysis

## Summary

BE currently has **kanban_stage: null** and does not appear in any lane. It briefly showed in Enter Now, then disappeared on refresh. Root cause: **BE is in setup state (PULLBACK), not momentum**, and the Kanban logic only assigns Enter Now / Just Flipped / Watch to momentum-aligned tickers. Setup-state tickers that aren’t late-cycle fall through to `null` and are excluded from all lanes.

---

## Current BE Snapshot (from /timed/all)

| Field | Value |
|-------|-------|
| **state** | HTF_BULL_LTF_PULLBACK |
| **score** | 79 |
| **position** | 4 |
| **kanban_stage** | **null** |
| **in corridor** | Yes (LTF -3.44 in LONG corridor -8 to 12) |
| **momentum_elite** | true |
| **seq.corridorEntry_60m** | true |
| **entry_decision.ok** | false |
| **entry_decision.blockers** | corridor_misaligned, no_trigger, no_fresh_pullback, completion_high |

---

## Why BE Gets `null` (No Lane)

### 1. State = PULLBACK, not momentum

- `isMomentum` = `state === "HTF_BULL_LTF_BULL"` or `"HTF_BEAR_LTF_BEAR"`
- BE state: `HTF_BULL_LTF_PULLBACK` → **isMomentum = false**

### 2. Enter Now / Just Flipped / Watch all require momentum

- Enter Now: `if (isMomentum)` → block never runs for BE
- Just Flipped: `if (isMomentum && seq.corridorEntry_60m)` → not momentum
- Watch: inside the same momentum block

### 3. Late-cycle check

- BE: phase 0.37, completion 0.05 → not late-cycle
- `!isMomentum && isLate` is false, so BE is not archived

### 4. Default path

- BE falls through to `return null` → **no stage, no lane**

---

## Why BE Might Have Appeared in Enter Now Before

Plausible explanations:

1. **State changed between loads**  
   - First view: `HTF_BULL_LTF_BULL` (momentum)  
   - Refresh: `HTF_BULL_LTF_PULLBACK` (setup)  
   - A new bar/ingest in between could flip LTF between BULL and PULLBACK.

2. **Different `entry_decision` presence**  
   - If `entry_decision` were missing, `edAction === "ENTRY"` would be false and the gate would not fire.  
   - With momentum + momentum_elite + score 79, BE would qualify for Enter Now via Path 2.  
   - When `entry_decision` is present and `ok: false`, the gate sends BE to `"watch"` instead.

3. **Caching / request timing**  
   - Different cache or request timing could expose different payloads (e.g. pre- vs post-ingest).

---

## Core Design Point: Setup Tickers Have No Lane

Tickers in setup state (HTF_BULL_LTF_PULLBACK, HTF_BEAR_LTF_PULLBACK) that are:

- in corridor
- not late-cycle
- not flip_watch

do **not** receive any lane. They end up with `kanban_stage: null` and are filtered out in the UI.

---

## Recommendations

### 1. Add a lane for setup-state tickers in corridor — **Implemented**

Added `setup_watch` lane for setup-state tickers in corridor (not late-cycle). Tickers like BE now appear in Setup Watch instead of falling through to null.

### 2. Clarify Enter Now vs “almost there” setups

- Enter Now: momentum + entry_decision ok (or relaxed logic).
- Setup tickers like BE are “almost there” but not yet momentum; a separate lane makes that explicit.

### 3. Diagnose flakiness

- Log or track `state`, `entry_decision`, and `kanban_stage` when BE (or similar tickers) moves between Enter Now and missing.
- Revisit `entry_decision` computation to ensure it’s always present and consistent across ingest and read paths.

---

## Quick Check for BE

To see if BE would qualify for Enter Now **if** it were momentum:

- Path 2 (Thesis / ME): momentum_elite ✓, score 79 ≥ 60 ✓
- Gate: `entry_decision.ok === false` → blocked; would go to `"watch"` if momentum.

So in the current logic, when BE is momentum it would go to `"watch"` (blocked), not Enter Now. The brief Enter Now view likely required either:

- No `entry_decision`, or  
- A different ingest/cache snapshot with different `entry_decision` or `state`.
