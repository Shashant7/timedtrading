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

---

## 6. Discord alerts (Enter Now and beyond)

Discord notifications fire when a ticker **transitions** into one of these lanes:

| Lane | Alert type | When |
|------|------------|------|
| **Enter Now** | KANBAN_ENTER_NOW | Ticker meets one of the 5 Enter Now paths (momentum + quality gates) |
| **Hold** | KANBAN_HOLD | Position is active, no trim/defend/exit signals |
| **Defend** | KANBAN_DEFEND | Position has WARNING (e.g. adverse move), completion &lt; 60%, phase &lt; 65% |
| **Trim** | KANBAN_TRIM | Completion ≥ 60%, phase 65%+ with WARNING, or adverse_move_warning |
| **Exit** | KANBAN_EXIT | CRITICAL, left_entry_corridor, large_adverse_move, or sl_breached |

- **Deduplication:** One alert per ticker per lane per 15-minute bucket (1h TTL).
- **Lifecycle gate:** Hold/Defend/Trim/Exit require the ticker to have passed through Enter Now first (same trigger+side cycle).
- **Config:** `DISCORD_ENABLE=true`, `DISCORD_WEBHOOK_URL` set. In critical mode, all Kanban transitions are allowed.

---

## 7. Enter Now trust & validation

**Why Enter Now is trustworthy:**

1. **No score-only path** – Every path requires score + at least one other signal (corridor, thesis, HTF/LTF strength, squeeze release, or 1H EMA cross).
2. **Entry decision gate** – If `entry_decision.ok === false`, the ticker goes to Watch instead of Enter Now.
3. **Lifecycle gate** – Management lanes (Hold, Defend, Trim, Exit) only apply after Enter Now for the same trigger+side cycle.
4. **Five distinct paths** – Diversified entry logic reduces over-reliance on any single signal.

**Validation checklist:**

- [x] Hard gate: `edAction === "ENTRY" && !edOk` → Watch (never Enter Now).
- [x] Path 1: Top tier (score ≥ 75 or position ≤ 20) requires `in_corridor`.
- [x] Path 2: Thesis/Momentum Elite requires score ≥ 60.
- [x] Path 3: Strong HTF/LTF requires htfAbs ≥ 40, ltfAbs ≥ 20, score ≥ 70.
- [x] Path 4: Squeeze release requires corridor + sq30_release + score ≥ 70.
- [x] Path 5: 1H 13/48 EMA Cross requires corridor + flag + score ≥ 68.

**Transition stability:** Tickers are kept in Enter Now until they move to Hold (position opened) or regress (entry blocked). The previous-lane marker (`prev_kanban_stage`) helps the UI show transition context.

**Hold vs Watch (critical fix):** Tickers with an active position must show in Hold, not Watch. We merge `entry_ts` and `entry_price` from the previous ingest (and from the ledger’s open trade if missing) into the payload before `classifyKanbanStage`, so `computeMoveStatus` sees `hasEntered` and returns ACTIVE. Without this, tickers that should be in Hold would incorrectly land in Watch.

**Enter Now → Exit:** A ticker showing "came from Enter Now" but now in Exit can happen when `entry_ts`/`entry_price` exist (from a previous position or merged from ledger) and the move has invalidated (left corridor, SL breach, large adverse move). That is correct if there was an actual open position. To avoid phantom lanes when **re-running reprocess**, use `resetTrades=1` so trades and entry state are cleared before reprocessing; entries are then rebuilt from scratch from Enter Now transitions.

---

## 8. Reprocess Kanban (admin)

`POST /timed/admin/reprocess-kanban` re-runs Kanban classification and trade simulation for all tickers. Use `scripts/reprocess-kanban.sh` to batch automatically.

| Param | Description |
|-------|-------------|
| `resetTrades=1` | Purge **all** trades (open + closed) for batch tickers in the from/to window and clear `entry_ts`/`entry_price` before reprocess. Gives a clean slate for re-runs. **Default in script.** |
| `from=YYYY-MM-DD` | (With resetTrades) Only purge trades with `entry_ts` on or after this day (ET). |
| `to=YYYY-MM-DD` | (With resetTrades) Only purge trades with `entry_ts` on or before this day (ET). |
| `limit`, `offset` | Batch size and pagination (default limit=15). |

**Example:**  
`RESET_TRADES=1 TIMED_API_KEY=x ./scripts/reprocess-kanban.sh` — full reprocess with trade reset.  
`RESET_TRADES=0 TIMED_API_KEY=x ./scripts/reprocess-kanban.sh` — keep existing trades.

### Replay Day (chronological ingest replay)

`POST /timed/admin/replay-day` replays today's (or a given date's) `timed_trail` ingests in chronological order. Trades for the day are reset, then each ingest is processed as if it arrived live — Kanban classification and trade simulation. Use `scripts/replay-day.sh`.

| Param | Description |
|-------|-------------|
| `date=YYYY-MM-DD` | Replay this day (default: today ET). |
| `limit`, `offset` | Batch size and pagination (default limit=50). |

Replay purges **all** trades (open + closed) whose `entry_ts` falls within the replay day, so you get a clean slate for "today as first day" re-runs.

**Example:**  
`TIMED_API_KEY=x ./scripts/replay-day.sh` — replay today's ingests.  
`DATE=2025-02-02 TIMED_API_KEY=x ./scripts/replay-day.sh` — replay a specific day.

---

## 9. Quick checklist

- [x] Enter Now uses score + position (no score-only path).
- [x] 1H 13/48 EMA Cross path added for pivot + pullback setups.
- [x] Trigger weights bumped (EMA Cross, Buyable Dip).
- [x] score/position added to /timed/all responses (backward compat with rank/rank_position).
- [x] Discord alerts for Enter Now, Hold, Defend, Trim, Exit lane transitions.
