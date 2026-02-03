# Entry Rules and Analysis — Why Entry May Not Fire

Reference for comparing **timed_trail** data against worker logic when entry never fires for AAPL, AMD, etc.

---

## 1. Trade creation gate: `shouldTriggerTradeSimulation(ticker, payload, prevData)`

A trade is created **only when**:

1. **Not futures** — ticker not in FUTURES_TICKERS.
2. **Levels** — `price`, `sl` (or sl_price, stop_loss), `tp` (or tp_max_price, tp_target_price, tp_target) present and finite, sl/tp > 0.
3. **Corridor** — HTF/LTF in corridor:
   - LONG: `h > 0` and `l >= -10` and `l <= 22`
   - SHORT: `h < 0` and `l >= -12` and `l <= 10`
4. **Corridor aligned** — state matches corridor side (LONG corridor → HTF_BULL_LTF_BULL; SHORT → HTF_BEAR_LTF_BEAR).
5. **Trigger** — one of: justEnteredCorridor, enteredAligned, trigOk (trigger_reason includes EMA_CROSS or SQUEEZE_RELEASE), sqRelease (sq30_release), flipWatch.
6. **Rank** — `rank` (or rank_position, position) ≥ 70 (or ≥ 60 if momentum_elite).
7. **RR** — `rr` ≥ 1.2 (or ≥ 1.08 if momentum_elite).
8. **Completion** — completion (to TP max when tp_levels/tp_max present, else payload.completion) ≤ 0.5 (or ≤ 0.6 for flip/squeeze, ≤ 0.55 for momentum_elite).
9. **Phase** — `phase_pct` ≤ 0.65 (or ≤ 0.75 for momentum_elite).
10. **Move status** — not INVALIDATED or COMPLETED.
11. **Regime** — dailyEmaRegimeOk, ichimokuRegimeOk (when data present).
12. **Late cycle** — if late cycle (phase zone HIGH/EXTREME or phase ≥ 0.7 or completion ≥ 0.95), must be momentum_elite.
13. **Fresh trigger** — one of: enteredFromPullback, sqRelease, trigger_reason SQUEEZE_RELEASE or EMA_CROSS, flipWatch, justEnteredCorridor.

**Common blockers (from `getEntryBlockers`):**

- `missing_levels` — no sl/tp or invalid.
- `not_in_corridor` — HTF/LTF outside corridor bands.
- `corridor_misaligned` — in corridor but state not aligned (e.g. SHORT corridor but HTF_BULL_LTF_BULL).
- `rank_below_min(50<70)` — rank below 70 (or 60 if momentum_elite).
- `rr_below_min(0.05<1.2)` — rr below 1.2.
- `completion_high(80%>50%)` — completion above threshold.
- `phase_high(70%>65%)` — phase above threshold.
- `no_fresh_pullback` — no trigger type (entered aligned, squeeze, EMA cross, flip_watch, just entered corridor).
- `no_enhanced_trigger` — shouldConsiderAlert false (corridor + aligned + one of the trigger conditions).

---

## 2. Kanban stage: `classifyKanbanStage(payload)`

Stage is computed from **current payload only** (no prevData in this function). Order of checks:

1. **Archive** — move_status INVALIDATED or COMPLETED → archive.
2. **Open position (hold/trim/exit/just_entered)** — hasMoveStatus && isActive (move ACTIVE):
   - severity CRITICAL or reasons (left_entry_corridor, large_adverse_move, sl_breached) → **exit**
   - completion ≥ 0.6 or phase ≥ 0.65 + WARNING → **trim**
   - WARNING but completion < 0.6, phase < 0.65 → **hold**
   - entry within last 15 min → **just_entered**
   - else → **hold**
3. **Flip watch** — flags.flip_watch → flip_watch (or enter_now if corridor + score ≥ 70 / thesis/momentum_elite + score ≥ 60).
4. **Just flipped** — isMomentum && seq.corridorEntry_60m → fall through to Enter Now paths.
5. **Enter Now** — isMomentum and one of:
   - Path 1: (score ≥ 75 or position 1–20) and inCorridor
   - Path 2: (thesis_match or momentum_elite) and score ≥ 60
   - Path 3: |htf| ≥ 40, |ltf| ≥ 20, score ≥ 70
   - Path 4: inCorridor and sq30_release and score ≥ 70
   - Path 5: inCorridor and (ema_cross_1h_13_48 or buyable_dip_1h_13_48) and score ≥ 68
   - If edAction === "ENTRY" && !edOk → **watch** (never show enter_now when entry decision blocked).
   - If action ENTRY and !ok and hasMeaningfulBlocker → **watch**.
6. **Late cycle** — not momentum and (phase HIGH/EXTREME or phase ≥ 0.7 or completion ≥ 0.95) → **archive**.
7. **Setup + squeeze** — !isMomentum and corridor and sq30_release and score ≥ 70 → **enter_now**.
8. **Setup watch** — !isMomentum and corridor → **setup_watch**.
9. **Catch-all** — valid data and !late → **watch**.

So **enter_now** requires: momentum state (HTF_BULL_LTF_BULL or HTF_BEAR_LTF_BEAR), in corridor, and one of the paths above, and **entry_decision not blocking** (if present).

---

## 3. Lane transition rules (why we force Watch or Enter Now)

After `classifyKanbanStage` we get **stage**. Then we apply:

1. **Recycle from archive** — if prevStage === "archive" and stage is hold/just_entered/trim/exit → **finalStage = watch** (recycled_from_archive).
2. **Management lanes (hold/trim/just_entered/exit)** require:
   - **Trigger** — payload.trigger_ts present and > 0. Else → **finalStage = watch** (forced_watch_missing_trigger).
   - **Cycle** — we have a previous “cycle” (kanban_cycle_enter_now_ts, same trigger_ts, same side). Else → **finalStage = enter_now** (forced_enter_now_gate).
3. **First-bar-of-day bridge** — if existing state is from **before today 9:30am** and current bar is **at/after 9:30am** and stage is hold/trim/just_entered/exit, we **accept** that stage (no force). We set cycle from this bar (first_bar_of_day_bridge).

So even when the **bar** would classify as hold/trim (move already in progress), we can force:
- **Watch** — when there’s no trigger_ts (we don’t allow “in move” without a trigger).
- **Enter Now** — when there’s trigger_ts but no previous cycle (we require “passed through enter_now” in our system).

That’s why AAPL/AMD can show as Watch or Enter Now instead of Hold/Trim: the **first** bar we see at 9:31am has no prior cycle, so we force enter_now (or watch if no trigger_ts).

---

## 4. What to check in replay analysis

When entry never fires:

1. **Any Enter Now moments?** — If analysis shows `enterNowCount === 0`, either:
   - No row ever classified as enter_now (check state, score, corridor, entry_decision blockers), or
   - Rows were forced to watch/enter_now by lane rules (check forcedWatchCount, forcedEnterNowCount).
2. **Enter Now but shouldTrigger false** — For each row with finalStage === "enter_now", look at `blockers`. Common: rank_below_min, rr_below_min, completion_high, no_enhanced_trigger, no_fresh_pullback.
3. **Forced to Watch** — forced_watch_missing_trigger means the bar would have been hold/trim but we had no trigger_ts; we put it in Watch.
4. **Forced to Enter Now** — forced_enter_now_gate means the bar would have been hold/trim but we had no prior “cycle”; we put it in Enter Now. Trade can still be created if shouldTriggerTradeSimulation passes on that bar.
5. **First-bar-of-day bridge** — If we see first_bar_of_day_bridge, we accepted hold/trim on the first bar after the gap; no force. If you still see no trade, the bar may have failed shouldTrigger (e.g. rank, rr, completion).

---

## 5. Running full replay + analysis

```bash
# Single ticker with debug (see analysis in stdout)
TIMED_API_KEY=... DATE=2026-02-02 DEBUG=1 TICKER=AAPL node scripts/replay-ticker-d1.js

# Multiple tickers, report to stdout (or redirect to file)
TIMED_API_KEY=... DATE=2026-02-02 TICKERS=AAPL,AMD,AMZN node scripts/replay-analyze-day.js

# Write report to doc
TIMED_API_KEY=... DATE=2026-02-02 TICKERS=AAPL,AMD node scripts/replay-analyze-day.js > docs/REPLAY_ANALYSIS_2026-02-02.md
```

Worker returns `analysis.rows` when `debug=1` is passed to `/timed/admin/replay-ticker-d1`. Each row includes: ts, stage, finalStage, shouldTrigger, blockers, forcedReason, rank, rr, comp, phase, state, trigger_reason.
