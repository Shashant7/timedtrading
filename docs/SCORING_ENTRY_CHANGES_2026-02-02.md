# Scoring & Entry Logic Changes — 2026-02-02

## Context

- Market was up; many trades should have been taken
- Only 3 trades today (WDC, MNST, STRL); 2 losses
- Top movers: AGQ +10%, SLV +6.5%, IBRX +5.9%, ONDS +5.7%, BE +3.1%, etc.
- Common blockers: completion_high, no_fresh_pullback, corridor, RR null

## Changes Applied

### 1. Corridor Widened
- **LONG**: ltf -8..12 → -10..12 (captures SLV at -9.93, etc.)
- **SHORT**: ltf -12..8 → -12..10

### 2. Entry Decision Relaxed (buildEntryDecision)
- **baseMinRR**: 1.5 → 1.2
- **baseMaxComp**: 0.4 → 0.5
- **baseMaxPhase**: 0.6 → 0.65
- **maxComp** for flip_watch or sq30_release: up to 0.6
- **no_fresh_pullback**: flip_watch now satisfies (enter as flip approaches)
- **RR when null**: accept when we have valid sl/tp/entry (don't block on missing RR calc)
- **sl/tp fallbacks**: use sl_price, stop_loss, tp_max_price, tp_target from payload

### 3. New Enter Now Paths (classifyKanbanStage)
- **flip_watch + corridor + score ≥70** (or thesis/momentum_elite + score ≥60) → enter_now
- **setup + sq30_release + corridor + score ≥70** → enter_now (catch move from setup)
- **just_flipped**: now falls through to Enter Now paths (can qualify)

### 4. processTradeSimulation
- **sl/tp fallbacks**: sl_price, stop_loss, tp_max_price, tp_target, computeTpMaxFromLevels

## Expected Impact

- More entries on flip_watch (before momentum) and squeeze_release from setup
- Fewer blocks on completion/phase for quality setups
- Tickers just outside corridor (e.g. LTF -9) now qualify
- RR null no longer blocks when sl/tp present

## Follow-up Fixes (BE not in lanes, no trades)

### 1. BE / momentum tickers not in any lane
- **Cause**: Catch-all in `classifyKanbanStage` required `!isMomentum` — momentum tickers outside corridor fell through to `return null`.
- **Fix**: Catch-all now returns `"watch"` for any valid ticker that isn't late-cycle (removed `!isMomentum`).

### 2. No trades created during replay
- **Cause**: `shouldTriggerTradeSimulation` used old corridor (-8..12 LONG) and lacked flip_watch / relaxed thresholds.
- **Fix**:
  - Corridor in `shouldTriggerTradeSimulation`: LONG -10..22, SHORT -12..10.
  - Added flip_watch to `freshPullbackOk`, `shouldConsiderAlert`, `momentumEliteTrigger`.
  - Relaxed thresholds (baseMinRR 1.2, baseMaxComp 0.5, maxComp for flip_watch/sq_release up to 0.6).
  - SL/TP fallbacks (sl_price, stop_loss, tp_max_price, etc.) for level validation.

### 3. Corridor alignment
- All corridor usages now consistent: LONG ltf -10..22, SHORT ltf -12..10.

## Full Re-run

After deploy, run:
```bash
CLEAN_SLATE=1 DATE=2026-02-02 DELAY_MS=400 TIMED_API_KEY=... node scripts/replay-ingest.js
```
