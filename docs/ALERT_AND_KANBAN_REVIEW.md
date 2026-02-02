# Alert & Kanban Lane Review

Quick reference for alert thresholds, Kanban lane logic, and refinements.

---

## Terminology

- **Score** (0–100): Composite quality from `computeRank()`. Higher = better setup. Stored as `rank` in DB; exposed as `score` in API.
- **Position** (1-based): Ordinal after sorting by score. 1 = best in watchlist. Aliased as `rank_position`.

---

## 1. Alert thresholds (Discord / trade simulation)

| Setting | wrangler.toml (env) | Code | Notes |
|--------|----------------------|------|--------|
| **RR** | ALERT_MIN_RR = 1.5 | Uses env; ME: ≥1.2 | OK |
| **Completion** | ALERT_MAX_COMPLETION = 0.4 | Uses env; ME: ≤0.5 | OK |
| **Phase** | ALERT_MAX_PHASE = 0.6 | Uses env; ME: ≤0.7 | OK |
| **Score** | ALERT_MIN_RANK = 70 | **70 (ME: 60)** in trade sim + entry decision | Aligned |

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
| **enter_now** | momentum + entry not blocked + one of 5 paths (see below) |
| **watch** | momentum but entry blocked by meaningful blocker |
| **setup_watch** | setup state (PULLBACK) + in corridor — waiting for momentum flip |

### Enter Now paths (score + other signals; no score-only)

| Path | Condition |
|------|-----------|
| 1. Top tier + corridor | (score ≥ 75 OR position ≤ 20) AND in_corridor |
| 2. Thesis / Momentum Elite | (thesis_match OR momentum_elite) AND score ≥ 60 |
| 3. Strong HTF/LTF | htfAbs ≥ 40 AND ltfAbs ≥ 20 AND score ≥ 70 |
| 4. Corridor + Squeeze | in_corridor AND sq30_release AND score ≥ 70 |
| 5. 1H 13/48 EMA Cross | in_corridor AND (ema_cross_1h_13_48 OR buyable_dip_1h_13_48) AND score ≥ 68 |

- **Trim:** 60% completion; phase 65% + WARNING; or adverse_move_warning.
- **Exit:** large_adverse_move (≥10% adverse), sl_breached, left_entry_corridor, or severity CRITICAL.

### Trigger score contributions (1H 13/48 EMA Cross)

- 1H 13/48 EMA Cross: +5 (flag) / +6 (triggers)
- Buyable Dip 1H 13/48: +7

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

- [x] Enter Now uses score + position (no score-only path).
- [x] 1H 13/48 EMA Cross path added for pivot + pullback setups.
- [x] Trigger weights bumped (EMA Cross, Buyable Dip).
- [x] score/position added to /timed/all responses (backward compat with rank/rank_position).
