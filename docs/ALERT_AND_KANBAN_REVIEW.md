# Alert & Kanban Lane Review

Quick reference for **today’s** alert thresholds, Kanban lane logic, and refinements.

---

## Optimizations applied (for more movement when market moves)

1. **Rank:** Trade sim + entry decision use **70** (Momentum Elite **60**) instead of hardcoded 75 — more trades/enter_now when market moves.
2. **Fresh trigger:** **Just-entered-corridor** now counts as a valid trigger (in addition to pullback→re-align and squeeze release) so trades can fire when tickers move into corridor without a prior pullback.
3. **Enter Now lane:** **Rank ≤ 20** (was 10) and **HTF/LTF ≥ 40/20** (was 50/25) so more tickers show in Enter Now when conditions align.

---

## 1. Alert thresholds (Discord / trade simulation)

| Setting | wrangler.toml (env) | Code (after optimization) | Notes |
|--------|----------------------|---------------------------|--------|
| **RR** | ALERT_MIN_RR = 1.5 | Uses env; ME: ≥1.2 | OK |
| **Completion** | ALERT_MAX_COMPLETION = 0.4 | Uses env; ME: ≤0.5 | OK |
| **Phase** | ALERT_MAX_PHASE = 0.6 | Uses env; ME: ≤0.7 | OK |
| **Rank** | ALERT_MIN_RANK = 70 | **70 (ME: 60)** in trade sim + entry decision | Aligned |

---

## 2. Kanban lane movement (classifyKanbanStage)

| Lane | Condition (summary) |
|------|---------------------|
| **archive** | move_status INVALIDATED/COMPLETED, or late-cycle and not momentum |
| **exit** | ACTIVE + (CRITICAL \| left_entry_corridor \| large_adverse_move \| sl_breached) |
| **trim** | ACTIVE + (completion ≥ 0.6 \| (phase ≥ 0.65 & WARNING) \| adverse_move_warning) |
| **defend** | ACTIVE + WARNING, completion &lt; 0.6, phase &lt; 0.65 |
| **hold** | ACTIVE, none of the above |
| **flip_watch** | flags.flip_watch |
| **just_flipped** | momentum + corridorEntry_60m, unless enter_now wins |
| **enter_now** | momentum + (rank ≤ 10 \| thesis_match \| momentum_elite \| HTF/LTF strong \| corridor + sq30_release) and entry not blocked |
| **watch** | momentum but entry blocked by meaningful blocker |

- **Trim:** 60% completion (was 70%); phase 65% + WARNING; or adverse_move_warning.
- **Exit:** large_adverse_move (≥10% adverse), sl_breached, left_entry_corridor, or severity CRITICAL.
- **Refinement:** No change required unless you want trim earlier (e.g. 55%) or a different phase band; current values are consistent.

---

## 3. Move status (computeMoveStatus)

| Signal | Threshold |
|--------|-----------|
| Stale trigger | 14 days → no active move |
| Trigger breach (soft) | price vs anchor &gt; 5% wrong way → trigger_breached_5pct |
| SL breach | price ≤ SL (long) or ≥ SL (short) → sl_breached |
| Large adverse move | ≥ 10% (was 15%) → large_adverse_move → EXIT |
| Adverse warning | ≥ 5% → adverse_move_warning → can TRIM |
| Overextended | completion ≥ 95% → overextended |

- **Refinement:** Already tightened (10% exit, 60% trim). Optional: add env vars for these (e.g. TRIM_COMPLETION_PCT, EXIT_ADVERSE_PCT) if you want to tune without code changes.

---

## 4. Market open / timing

- **Crons:** 9:45 / 12:00 / 3:30 PM ET (AI); every 5 min (trades); every 15 min weekdays (alerts); every 6 h (ML).
- **Stale trigger:** 14 days so overnight/weekend doesn’t drop moves immediately.
- **Refinement:** If you want “market open”–specific behavior (e.g. relax rank in first 30 min), add a time-of-day check using ingest timestamp and ET market open (9:30); otherwise no change.

---

## 5. Recommended refinements (minimal)

1. **Rank from env (recommended)**  
   In `worker/index.js`, replace hardcoded `minRank = 75` with:
   - `const baseMinRank = Number(env.ALERT_MIN_RANK || "70");`
   - `const minRank = momentumElite ? Math.max(60, baseMinRank - 10) : baseMinRank;`  
   Use the same in both `shouldTriggerTradeSimulation` and `computeEntryDecision` (and pass `env` into the latter if needed).

2. **Optional:** Add env knobs for trim/exit (e.g. TRIM_COMPLETION_PCT=0.6, EXIT_ADVERSE_PCT=0.10) so you can tune from wrangler.toml.

3. **Optional:** Document “market open” rule in README or this doc if you later add a first-30-min relaxation.

---

## 6. Quick checklist

- [ ] Use ALERT_MIN_RANK from env (70) and ME override (e.g. 60) instead of hardcoded 75.
- [ ] Confirm Discord alert path also requires rank (entry decision already blocks; ensure ingest gate includes rank).
- [ ] No Kanban threshold change unless you want trim earlier or env-based tuning.
