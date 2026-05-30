---
title: Handoff to Next Agent — Investor-Mode WR + Full Jul→May Backtest + Live Seed
created: 2026-05-10
from-agent: phase-c-preprod-recovery + th-wiring + DO-spike (multi-day session, context-saturated)
to-agent: fresh
---

# Handoff: Improve Investor-Mode WR + Run Full Backtest + Seed Live

You are starting fresh. Prior agent's context is saturated — this doc is everything you need. Read it in full before touching anything.

---

## TL;DR — what the user wants

Three deliverables, in order:

1. **Improve win rate of Investor Mode.** Current preprod backtest in flight (phase-c-stage2-th-do-v3-jul2025-may2026) is producing a 19% WR on July trades — far worse than the live Phase C trader run's 52.3% WR. The user explicitly called this out: *"Win Rate looks pretty bad for July. The Active Trader July Performance was much better."* The mode label is ambiguous (the running backtest is actually trader-mode-with-TH-flag-on, not pure investor mode), but the GOAL is to make whichever-strategy-we-promote-to-live actually deliver edge.

2. **Complete a full Jul 2025 → May 2026 backtest end-to-end.** Once the WR issue is understood and fixed, run the full 220-session window on pre-prod. Generate a verdict comparing trader-baseline vs the candidate strategy. SNDK / BE / MU / SOXL / GOOGL hard-pass criteria per `tasks/phase-c/PHASE_3_RUNBOOK.md` Step 4.

3. **Seed live with the validated trades + model/config/logic.** Once the backtest passes the SNDK pass criterion AND March-2026 regression guard, promote the run via the safe-promote workflow — not direct live mutation. The `seed-from-promoted` endpoint is the canonical restore/seed path (already proven during the May 9 incident recovery).

---

## What's running RIGHT NOW

A backtest is in flight on **pre-prod** (NOT live):

```
run_id: phase-c-stage2-th-do-v3-jul2025-may2026
worker:  https://timed-trading-ingest-preprod.shashant.workers.dev
driver:  BacktestRunner Durable Object (alarm-driven)
mode:    --trader-only --low-write --interval 5m --tickerBatch 30
flags:   deep_audit_trend_hold_enabled=true (Trend-Hold module wired)
started: 2026-05-10T16:39 UTC
```

Watch live progress at:
> **https://timed-trading-ingest-preprod.shashant.workers.dev/backtest-monitor?key=YOUR_API_KEY&run_id=phase-c-stage2-th-do-v3-jul2025-may2026**

(The monitor page is deployed on both live and preprod; banner auto-detects env from hostname. **PREPROD = blue banner, LIVE = red banner — always confirm.**)

As of last check: 25 trades, **4W/17L = 19% WR**, Σ pnl% +1.66, 2 MFE≥5% candidates, 0 TH promotions. ETA ~13 hours from start (~05:30 UTC Mon, 8h before market open). It's free to either **let it complete** and analyze, or **kill** if your investigation suggests rerun with different parameters is faster. Cancel via:
```bash
curl -X POST "https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/backtests/cancel?key=$TIMED_TRADING_API_KEY" -H "content-type: application/json" -d '{"run_id":"phase-c-stage2-th-do-v3-jul2025-may2026"}'
```

---

## CRITICAL DO-NOTS (these will burn the live system)

These are not theoretical — they ALL got tested by the prior agent the hard way:

1. **DO NOT run anything destructive against the live worker.**
   - Live URL: `https://timed-trading-ingest.shashant.workers.dev`
   - Pre-prod URL: `https://timed-trading-ingest-preprod.shashant.workers.dev`
   - Always **confirm `API_BASE` in your terminal before every destructive curl**. The prior agent caused a live trader-account wipe by trusting the script's env override; turned out the script had a hardcoded `API_BASE` that overrode the env. Now fixed (commit `0237a13`), but defense-in-depth: read the URL on screen before pressing enter.

2. **DO NOT pass `cleanSlate=1` without verifying the URL is preprod.** The worker's P0.7.106 hard guard requires `confirm_clean_slate=YES_DESTROY` AND a non-set `phase-c:cron-mute` to allow the wipe. Preprod has no protection — wipes preprod's empty tables, no big deal. But the same flag against live would wipe trades + ledger + positions. (Recovered May 9 via `seed-from-promoted` from canonical 587-trade promoted dataset; full incident timeline in `tasks/phase-c/INCIDENT_2026-05-09_LIVE_WIPE.md` — not yet written, prior agent ran out of context. Write it as one of your first tasks.)

3. **DO NOT touch the live SNDK / APD / NFLX trades again.** They were wiped May 9, the live cron rebuilt from fresh ingest after auto-mute expired. Live trader is at $140,086 cash, $40,086 realized — match exactly the pre-incident state.

4. **DO NOT enable `deep_audit_trend_hold_enabled = "true"` on live model_config until the preprod backtest validates SNDK pass criterion.** Live has it set to `"false"` right now. Verify before changing:
```bash
curl -X POST .../timed/admin/model-config?key=... \
  -d '{"updates":[{"key":"deep_audit_trend_hold_enabled","value":"true",...}]}'
```

5. **DO NOT remove the `run_id IS NULL` filter from `d1LoadTradesForSimulation` in worker/index.js.** That filter is the only thing preventing zombie-trade resurrection. Was set after the May 7 mystery wipes.

6. **DO NOT trust `system-intelligence.html` for monitoring** — it lives on Cloudflare Pages with relative API_BASE, so on the live page it hits live worker even if you're trying to watch a preprod run. Use `/backtest-monitor` instead.

---

## START HERE — required reading, in order

1. **`tasks/phase-c/HANDOFF_NEW_AGENT.md`** — original Phase 1-4 master plan. Phase 1 (cohort + forensics) and Phase 2 (Trend-Hold module) are DONE. Phase 3 is what you're picking up.

2. **`tasks/phase-c/INVESTOR_BACKTEST_AND_TREND_HOLD_PLAN.md`** — master plan for the work this handoff covers.

3. **`tasks/phase-c/accumulation-trend-deep-dive.md`** — the Phase 1.2 forensic deliverable (1695 lines). Contains:
   - 50 TH-candidate tickers (8 CLEAN_TREND + 42 RESILIENT_TREND)
   - Per-inflection signal snapshots for each
   - Capture-summary: live trader extracted only **2.1% of oracle return** across the cohort (Σ 9234% oracle vs Σ 193% extracted)
   - Tuning recommendations for the Trend-Hold module
   - **The strategy hypothesis:** suppress 5 premature-exit doctrines on trades that pass close-discipline trend filters, ride them longer.

4. **`tasks/phase-c/PHASE_3_RUNBOOK.md`** — operational procedure with SNDK pass criteria.

5. **`tasks/phase-c/PRE_PROD_ENV_RUNBOOK.md`** — the pre-prod environment design. Worker, D1 (`85a9ee08-…`), KV (`246f397779e44e6bb8853585b74200ff`) all created. Schema applied (67 tables + 7 trend_hold_* cols). 9.75M ticker_candles imported. 204 day-state KV blobs cloned.

---

## What's actually deployed (verify each before changing)

### Live worker (production)
- `deep_audit_trend_hold_enabled = "false"` ← MUST stay false until backtest validates
- `deep_audit_trend_hold_max_positions = 6`
- 7 trend_hold_* columns on `trades` table
- 7 trend_hold_* columns on `backtest_run_trades` (added Phase 2.10)
- `d1UpdateTradeTrendHoldState` fans out UPDATE to both tables
- `POST /timed/admin/ensure-trend-hold-schema` endpoint
- `POST /timed/admin/trend-hold-evaluate?ticker=X&commit=0` endpoint
- `POST /timed/admin/kv/put` endpoint (with protected-namespace guard)
- `GET /backtest-monitor` HTML page
- Phase 2.6/2.7/2.9 latent bug fixes (Pine convention + nested EMA shape + monthly null tolerance) — IN MAIN ✓

### Pre-prod worker
- All of the above + `ENVIRONMENT_LABEL=preprod` env var
- Vars: `EXECUTION_MODE=simulation`, `ALPACA_ENABLED=false`, `DISCORD_ENABLE=false`, `EMAIL_ENABLED=false`
- No scheduled crons (request-driven only)
- `deep_audit_trend_hold_enabled = "true"` in preprod model_config
- BacktestRunner DO with **alarm-driven batch pagination** (commit `7643032` Phase 3.8) — prior agent's discovery that the original DO loop blocked too long

### investor.js convention fixes (Phase 3.4)
10 inverted `monthly_bundle.supertrend_dir` comparisons fixed (Pine convention `-1=bull`, NOT standard `+1=bull`). Was producing investor-mode `opened=0` for every day in the original Jul→May window. Now investor-replay generates real positions. Committed in PR #78 (merged) — verified on live.

---

## The actual problem you're solving (the WR)

The running preprod backtest at session 25 has 4W/17L = 19% WR. Live Phase C trader baseline at the equivalent point had ~50% WR. **Why is THIS run worse?** Three hypotheses, ordered by my confidence:

### Hypothesis A: The 0.85 trim cap is loose enough to start promoting bad runners
Phase 3.8 raised `promote_max_trimmed_pct` from 0.5 → 0.85 because the existing TP ladder trims trades to 50%+ before TH eval can run. With the looser cap, TH might now start promoting trades that look TH-eligible at +5% MFE but were destined to give back. Verify by checking each TH-promoted trade's outcome (currently 0 in the run, but watch as it progresses).

**Test:** when TH starts promoting, do those trades outperform the trader baseline on the same tickers? If TH drags down WR, the cap is wrong.

### Hypothesis B: TH eval still runs after the TP ladder, so the suppression list never has effect
Even with the looser cap, the 5 suppressed doctrines (HARD_FUSE_RSI_EXTREME, PROFIT_GIVEBACK_*, SMART_RUNNER_SUPPORT_BREAK_CLOUD, ST_FLIP_4H_CLOSE, mfe_decay_structural_flatten) fire BEFORE TH gets a chance to flip `trend_hold_state = 'active'`, so they exit anyway. The TH module's value is suppressing those — if the timing is wrong, TH delivers nothing positive but the module's decision overhead may negatively interact with management.

**Real fix:** move the TH lifecycle eval block in `worker/index.js processTradeSimulation` from after-MFE-update to BEFORE-TP-trim. The current order is:
```
MFE update → TH lifecycle eval (line ~17194) → exit doctrine → TP/trim ladder → other exits
```
Should be:
```
MFE update → TH lifecycle eval → IF promote: stamp + suppress checks active → exit doctrine → TP ladder
```
Specifically the trim-eligibility checks need to read `isTrendHoldActive(openTrade)` and bail if active.

### Hypothesis C: The run is using --live-config but live config has drifted
The script flag `--live-config` makes the run use live model_config snapshots. If live has been auto-tuned by some calibration loop since the original Phase C trader run, the gates are different than the canonical 52.3%-WR run. Compare:
```bash
# Look at the run's pinned config
wrangler d1 execute timed-trading-ledger-preprod --remote --command="SELECT config_key, config_value FROM backtest_run_config WHERE run_id='phase-c-stage2-th-do-v3-jul2025-may2026' AND config_key LIKE 'deep_audit_%' ORDER BY config_key"
# Compare to phase-c-stage1
wrangler d1 execute timed-trading-ledger --remote --command="SELECT config_key, config_value FROM backtest_run_config WHERE run_id='phase-c-stage1-jul2025-may2026' AND config_key LIKE 'deep_audit_%' ORDER BY config_key"
```
A diff between these reveals what's changed since.

---

## Architectural debts (file these into Phase 3.9)

1. **TH eval timing** — runs after TP-trim ladder. Should run before. ~30 LOC reorder in worker/index.js. Highest leverage fix per Hypothesis B above.

2. **Investor-Mode separate path** — `runInvestorDailyReplay` (worker/index.js + worker/investor.js) is its OWN strategy with separate scoring. The "Investor Mode" the user keeps mentioning is THIS. The current preprod backtest is `--trader-only` so it bypasses this entirely. To validate Investor Mode specifically:
   ```bash
   API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
   TIMED_API_KEY=$TIMED_TRADING_API_KEY \
     bash scripts/investor-backfill-jul-may.sh 2025-07-01 2026-05-04
   ```
   This reads day-state KV + runs investor scoring per day. Requires day-state to have monthly_bundle.supertrend_dir populated for at least the major tickers — it does, after the candle replay re-populated it.

3. **DO ticker pagination** is alarm-driven (commit `7643032`) — works but ~3.7 min/session × 220 = ~13.5h. Slow because each batch is one alarm cycle (~100ms reschedule + 15-25s execution). Could be sped up by either:
   - Batching multiple `executeCandleReplayStep` calls per alarm with a wall-time budget (e.g. up to 25s of work per alarm before yielding) — cuts ~50% of overhead
   - Running multiple parallel DO instances (one per ticker shard) — much harder, requires sharding logic

4. **promoted_trades vs backtest_run_trades schema drift** — both have trend_hold_* columns now (Phase 2.10), but the promote pipeline (`promoted-trades/promote`) might not copy these. Check before relying on them post-promote.

5. **scripts/full-backtest.sh hardcoded `live_config_slot=1`** in the runs/register payload (line ~390). Doesn't matter for replay scoping but confusing if you're trying to track active experiment vs canon.

---

## Concrete next-action plan

### Step 1 — Investigate the WR (1 hour)
Open the monitor at the URL above. Wait for run to reach session 50-60 (~1 hour from your start). Then:

```bash
# Top-15 losing trades — what's killing them?
wrangler d1 execute timed-trading-ledger-preprod --remote --json --command="SELECT ticker, status, ROUND(pnl_pct,2) AS pnl_pct, ROUND(max_favorable_excursion,2) AS mfe, ROUND(max_adverse_excursion,2) AS mae, exit_reason, trend_hold_state FROM backtest_run_trades WHERE run_id='phase-c-stage2-th-do-v3-jul2025-may2026' AND status='LOSS' ORDER BY pnl_pct ASC LIMIT 15"

# Distribution of exit reasons
wrangler d1 execute timed-trading-ledger-preprod --remote --json --command="SELECT exit_reason, COUNT(*) AS n, ROUND(AVG(pnl_pct),2) AS avg_pnl, ROUND(AVG(max_favorable_excursion-pnl_pct),2) AS avg_giveback FROM backtest_run_trades WHERE run_id='phase-c-stage2-th-do-v3-jul2025-may2026' AND status IN ('WIN','LOSS','FLAT') GROUP BY exit_reason ORDER BY n DESC LIMIT 20"

# Compare to live trader baseline (phase-c-stage1)
wrangler d1 execute timed-trading-ledger --remote --json --command="SELECT exit_reason, COUNT(*) AS n, ROUND(AVG(pnl_pct),2) AS avg_pnl FROM backtest_run_trades WHERE run_id='phase-c-stage1-jul2025-may2026' AND status='LOSS' GROUP BY exit_reason ORDER BY n DESC LIMIT 20"
```

The diff reveals which exit reasons fire MORE in the preprod run vs the canonical trader run. Likely culprits: HARD_LOSS_CAP, max_loss, doctrine_force_exit, atr_day_adverse_382_cut.

### Step 2 — Decide the strategy
Given findings, choose:
- (a) Tune TH gates (raise/lower trim cap, MFE threshold, weekly TD9 cap)
- (b) Reorder TH eval before TP ladder (Hypothesis B fix)
- (c) Disable TH and run pure trader to confirm baseline still produces ~52% WR on preprod (sanity check that preprod env reproduces live results)
- (d) Run Investor Mode pipeline (separate from current run) and compare its WR to baseline

(c) is the highest-leverage first move — it tells you whether the env itself is causing the WR drop, or whether TH is.

### Step 3 — Run the full backtest (8-14h)
With the right strategy, kick off via DO:
```bash
curl -X POST "https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/backtests/start?key=$TIMED_TRADING_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "run_id": "phase-c-stage2-final-<your-version>",
    "label": "phase-c-stage2-final",
    "start_date": "2025-07-01",
    "end_date": "2026-05-04",
    "interval_min": 5,
    "ticker_batch": 30,
    "trader_only": true,
    "keep_open_at_end": true,
    "low_write": true,
    "clean_slate": false,
    "params": { "disable_reference_execution": true }
  }'
```
Watch via `/backtest-monitor`.

### Step 4 — Validate per RUNBOOK
SNDK trade count drops vs trader baseline, ≥1 SNDK trade with pnl≥50%, Σ SNDK pnl ≥200%, no SNDK closes via suppressed reasons. March 2026 regression: trader_th_mar pnl% must NOT be < trader_only_mar - 1.0%.

### Step 5 — Promote to live
```bash
curl -X POST "https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/promoted-trades/promote?run_id=<run>&seed_account_ledger=true&mode=trader&key=$TIMED_TRADING_API_KEY"
```
Then the corresponding endpoint on live to seed live trader from this dataset (or use the existing P0.7.70 seed pattern).

### Step 6 — Flip live flag
Only after validation:
```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/model-config?key=$TIMED_TRADING_API_KEY" \
  -H "content-type: application/json" \
  -d '{"updates":[{"key":"deep_audit_trend_hold_enabled","value":"true","description":"Phase 4: enabled after preprod validation"}]}'
```

---

## Useful endpoints (already deployed)

| endpoint | purpose |
|---|---|
| `GET  /backtest-monitor?key=<api>&run_id=<run>` | live progress UI |
| `POST /timed/admin/backtests/start` | DO-driven backtest |
| `GET  /timed/admin/backtests/status?run_id=<run>` | job state |
| `GET  /timed/admin/backtests/logs?run_id=<run>&limit=N` | DO log entries |
| `POST /timed/admin/backtests/cancel` | kill active job |
| `GET  /timed/admin/backtests/run-trades?run_id=<run>` | full trade list |
| `POST /timed/admin/ensure-trend-hold-schema` | apply TH columns to trades + backtest_run_trades |
| `POST /timed/admin/trend-hold-evaluate?ticker=X&commit=0` | dry-run TH gates against live ticker state |
| `POST /timed/admin/kv/put?k=<key>` | mirror KV blob (preprod-namespace-protected) |
| `POST /timed/admin/model-config` | write daCfg keys |
| `POST /timed/admin/account-ledger/seed-from-promoted` | rebuild ledger from promoted dataset (incident-recovery use) |
| `POST /timed/admin/replay-lock` | acquire / release replay lock |
| `POST /timed/admin/cron-mute?ttl_hours=N` | mute live cron (TTL'd; default 6h) |

---

## Live trader state at handoff time

- Cash: $140,786.44 (was $140,086.44 at incident-recovery; small drift from intraday cron activity)
- Realized PnL: +$40,020.26
- Unrealized: +$766.76
- Open trades: APD-1778247 OPEN, SNDK-1778077 TP_HIT_TRIM (+$185.61), APD-1778074 LOSS (closed -$251.79)
- Cron: unmuted, processing normally
- Setup grades + names + ledger entries: all restored
- Equity curve: smooth Jul→May progression, rebuilt from ledger via `seed-from-promoted`

---

## User interaction notes

- Technical, prefers concise updates with numbers + tables
- Don't bury findings in essays; lead with metrics
- "Live" = production worker; "Preprod" = backtest worker — confirm at every destructive op
- User is comfortable with multi-day async work; just don't surprise them with destructive operations on live
- Timezone seems Eastern (signs off late evening UTC)
- Today is May 10, 2026

---

Good luck. The pre-prod env works, the DO pagination works, the monitor UI works — focus is now purely on the strategy itself. Make the WR right.
