---
title: Phase 3 Runbook — Investor Backtest + Trend-Hold Validation
created: 2026-05-08
owner: cloud-agent → user/admin
status: ready-to-execute
prereq: PR #74 (cursor/phase-c-trend-hold-module-676a) merged or deployed
---

# Phase 3 Runbook

This is the **operational procedure** for validating Trend-Hold via backtest replay and (separately) populating the Investor account ledger. It assumes Phase 2 (PR #74) is merged or its branch is deployed to **pre-prod**.

> **DO NOT RUN ANY OF THIS ON LIVE.** Every step below targets the pre-prod / staging worker + D1. Live cron stays unmuted. Live trader account ($140k, +$40k realized) is unaffected.

---

## Prereqs (one-time)

### 1. Apply schema migration on pre-prod D1

```bash
cd worker
wrangler d1 execute timed_trading_db \
  --file=migrations/add-trend-hold-columns.sql \
  --env preprod
```

Verifies (run from worker dir):
```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  PRAGMA table_info(trades);
" | grep trend_hold
```
Expect 7 rows: `trend_hold_state`, `trend_hold_promoted_at`, `trend_hold_demoted_at`, `trend_hold_max_mfe_pct`, `trend_hold_flavor`, `trend_hold_promote_reason`, `trend_hold_demote_reason`.

### 2. Enable the feature flag in pre-prod `model_config`

```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  INSERT INTO model_config (config_key, config_value, updated_at)
    VALUES ('deep_audit_trend_hold_enabled', '\"true\"', strftime('%s','now')*1000)
  ON CONFLICT(config_key) DO UPDATE SET
    config_value = excluded.config_value,
    updated_at   = excluded.updated_at;

  INSERT INTO model_config (config_key, config_value, updated_at)
    VALUES ('deep_audit_trend_hold_max_positions', '6', strftime('%s','now')*1000)
  ON CONFLICT(config_key) DO UPDATE SET
    config_value = excluded.config_value,
    updated_at   = excluded.updated_at;
"
```

The replay loader (`worker/replay-runtime-setup.js` REPLAY_DA_KEYS) will pick these up automatically once they're in model_config.

### 3. Mute the pre-prod cron during long backtests

```bash
curl -X POST "${PREPROD_BASE}/timed/admin/replay-lock?key=$TIMED_TRADING_API_KEY&reason=phase-3-backtest"
```

This prevents the cron from contending with replay writes. Unlock when done with the matching DELETE.

---

## Step 1 — Single-day smoke test (pre-flight, ~5 min)

Before kicking off 11 monthly legs, validate the harness with a single day. Purpose: catch any wiring/schema/flag issues before burning multi-hour replay time.

### 1a. Verify daCfg loads the flag in replay context

```bash
curl -sS "${PREPROD_BASE}/timed/admin/snapshot-replay?date=2025-07-01&key=$TIMED_TRADING_API_KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({k: d.get(k) for k in ['ok','date','intervals_processed','trades_opened','trades_closed','trend_hold_promotions','trend_hold_demotions']}, indent=2))"
```

Expected: `ok: true`, `intervals_processed > 0`, `trades_opened ≥ 0` (zero is fine if the day was thin).

> **Note**: the response object today doesn't surface `trend_hold_promotions` / `_demotions` — that's an enhancement worth adding to the replay handler. For now, query D1 directly:

```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  SELECT
    SUM(CASE WHEN trend_hold_state = 'active'  THEN 1 ELSE 0 END) AS th_active,
    SUM(CASE WHEN trend_hold_state = 'demoted' THEN 1 ELSE 0 END) AS th_demoted,
    COUNT(*)                                                       AS total_trades
  FROM trades
  WHERE entry_ts >= 1719792000000  -- 2025-07-01 UTC
    AND entry_ts <  1719878400000  -- 2025-07-02 UTC
    AND run_id IS NULL;            -- live + replay scope (replay writes run_id IS NULL on pre-prod
                                   -- unless explicit run_id passed)
"
```

### 1b. Verify SNDK promotion fires when MFE crosses +5%

The single most important pre-flight check. SNDK is in the data from late August 2025. Run a snapshot-replay for a date when SNDK was already in an open Active-Trader position with MFE > 5% (e.g. **2025-09-04** — the +30% inflection date per the Phase 1.2 deep dive):

```bash
curl -sS "${PREPROD_BASE}/timed/admin/snapshot-replay?date=2025-09-04&key=$TIMED_TRADING_API_KEY" | head -200
```

Then inspect:
```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  SELECT trade_id, ticker, status, max_favorable_excursion AS mfe,
         trend_hold_state, trend_hold_flavor, trend_hold_promote_reason
  FROM trades
  WHERE ticker = 'SNDK' AND status = 'OPEN'
  ORDER BY entry_ts DESC LIMIT 5;
"
```

Expected: at least one SNDK row with `trend_hold_state = 'active'`, `trend_hold_flavor = 'RESILIENT_TREND'`, and a `promote_reason` mentioning `wkEMA21↑ dEMA21↑ 4hEMA21↑ wkST=bull mST=bull`.

### 1c. Check audit log for the transition

```bash
curl -sS "${PREPROD_BASE}/timed/admin/data-audit-log?op=trend_hold_promote&limit=20&key=$TIMED_TRADING_API_KEY" | python3 -m json.tool | head -60
```

Expected: rows with `op = trend_hold_promote`, scope `trades:<trade_id>`, meta_json containing flavor + reason.

**Pass criterion:** at least 1 SNDK promotion fires + audit row written. If 0 promotions, see Troubleshooting below.

---

## Step 2 — Multi-leg execution (11 monthly legs, ~6-8 hours wall)

### 2a. Choose execution path

| Path | Scope | Risk | Output |
|---|---|---|---|
| **A. Investor-only** | Run `scripts/investor-backfill-jul-may.sh` against existing trader-Phase-C day-state | low — investor logic untouched, TH ride-along | populates `account_ledger mode='investor'` so Trades-page Investor column is alive |
| **B. Trader-with-TH** | Re-run trader replay with TH flag on, fresh `run_id=phase-c-stage2-trader-th-jul2025-may2026` | medium — produces a NEW promoted dataset that can OPTIONALLY supersede the existing trader account | validates the SNDK 11→1 collapse hypothesis directly |
| **C. Both, sequentially** | A then B in same window | medium | full A/B comparison material |

**Recommended: Path C.** Path A first (cheap, populates Investor column). Then Path B to validate Trend-Hold capture jump.

### 2b. Path A — Investor-only multi-leg

```bash
# This script is idempotent and skips weekends/holidays. Walks Jul 1 → May 4 day-by-day.
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
API_BASE=$PREPROD_BASE \
  bash scripts/investor-backfill-jul-may.sh 2025-07-01 2026-05-04
```

After completion, run the verdict generator (see Step 3).

### 2c. Path B — Trader-with-TH multi-leg

```bash
# Generates a new run_id; does NOT overwrite the live trader run.
RUN_ID="phase-c-stage2-trader-th-jul2025-may2026" \
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
API_BASE=$PREPROD_BASE \
  bash scripts/full-backtest.sh --trader-only \
    --start 2025-07-01 --end 2026-05-04 \
    --leg-name phase-c-stage2-th \
    --keep-lock
```

Each leg checkpoints after completion. Resume on failure with the same command (skips already-finished legs).

---

## Step 3 — Per-leg verdict review

After each monthly leg (or at the end of the multi-leg run), generate a verdict markdown that compares trader vs investor and surfaces TH promotions:

```bash
node scripts/build-investor-monthly-verdict.js \
  --month 2025-07 \
  --trader-run-id phase-c-stage1-jul2025-may2026 \
  --investor-mode investor \
  --th-run-id phase-c-stage2-trader-th-jul2025-may2026 \
  --out tasks/phase-c/monthly-verdicts/2025-07-investor.md
```

Each verdict markdown contains:

1. **Headline numbers** — leg WR, realized PnL, max DD, Sharpe, capture % vs oracle.
2. **TH promotions** — count, list of tickers, flavor breakdown, time-to-promotion histogram.
3. **TH demotions** — count, reason breakdown (which structural break fired most).
4. **Suppressed exits** — count of HARD_FUSE / PROFIT_GIVEBACK / SMART_RUNNER / ST_FLIP_4H / mfe_decay calls that were short-circuited (these are the giveback savings).
5. **SNDK case study** (and BE / MU / SOXL / GOOGL when present) — explicit "did 11 trades collapse to 1 ride?" check.
6. **A/B vs trader** — same trades on the same day, was the outcome better/worse, by how much?

---

## Step 4 — SNDK validation (the hard pass criterion)

This is the test that determines whether Trend-Hold can be flipped to live. Per the Phase 1.2 deep dive:

> SNDK case study: 11 trades on a 1948% underlying move → 32.9% Σ pnl% extracted = 1.7% capture. 8/11 closed via premature exits, dominant: HARD_FUSE_RSI_EXTREME (3/11).

### Pass criterion for Phase 4 (live promote)

After the trader-with-TH multi-leg completes, query SNDK's promoted trades for the new run:

```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  SELECT trade_id, entry_ts, exit_ts, status, pnl_pct, exit_reason,
         trend_hold_state, trend_hold_flavor, trend_hold_max_mfe_pct
  FROM backtest_run_trades
  WHERE run_id = 'phase-c-stage2-trader-th-jul2025-may2026'
    AND ticker = 'SNDK'
  ORDER BY entry_ts ASC;
"
```

**HARD PASS** (Trend-Hold validated, ready for Phase 4):
- ≤ 4 SNDK trades in the run (was 11; 11→4 represents collapse of round-trips into rides).
- At least 1 SNDK trade has `trend_hold_state = 'active'` at exit and `pnl_pct ≥ 50%`.
- Σ SNDK pnl% across the run ≥ 200% (was 32.9%; 6× capture lift).
- No SNDK trade closes via a suppressed reason (HARD_FUSE_RSI_EXTREME, PROFIT_GIVEBACK_*, SMART_RUNNER_*, ST_FLIP_4H_CLOSE, mfe_decay).

**SOFT PASS** (close, but tune thresholds):
- 5–8 SNDK trades.
- 100% ≤ Σ pnl% < 200%.
- Max single-trade pnl% in run ≥ 30%.
- ≤ 1 closed-via-suppressed-reason (indicates a wiring miss).

**FAIL** (do not promote to live; investigate):
- ≥ 9 SNDK trades (no behavior change).
- Σ pnl% < 100%.
- ≥ 2 trades closed via suppressed reasons (indicates promotion gate or suppression list is broken).

Repeat the same check for the other RESILIENT_TREND blueprints: **BE, MU, SOXL, LITE**. At least 3 of {SNDK, BE, MU, SOXL, LITE} must HARD PASS for Phase 4 promotion.

### Regression guard (the P0.7.63-65 lesson)

Run the same script for **March 2026** specifically — the rough month where the catastrophic-loss fixes were tuned. Trend-Hold's structural-only exit doctrine MUST NOT regress March performance vs the existing trader run:

```bash
wrangler d1 execute timed_trading_db --env preprod --command="
  SELECT
    (SELECT realized_pnl_pct FROM backtest_run_metrics
       WHERE run_id = 'phase-c-stage1-jul2025-may2026'
       AND month = '2026-03') AS trader_only_mar,
    (SELECT realized_pnl_pct FROM backtest_run_metrics
       WHERE run_id = 'phase-c-stage2-trader-th-jul2025-may2026'
       AND month = '2026-03') AS trader_th_mar;
"
```

**HARD STOP**: if `trader_th_mar < trader_only_mar - 1.0%` (TH made March meaningfully worse), DO NOT promote. Re-tune the demotion gates and re-run.

---

## Step 5 — Promote the result

Once the SNDK pass criterion is met AND March regression guard passes:

```bash
# Path A (Investor-only) result — populates Investor account_ledger
curl -X POST "${PREPROD_BASE}/timed/admin/promoted-trades/promote?run_id=phase-c-stage2-investor-jul2025-may2026&seed_account_ledger=true&mode=investor&key=$TIMED_TRADING_API_KEY"

# Path B (Trader-with-TH) result — only if user explicitly chooses to supersede current trader run
# DO NOT do this without explicit user confirmation.
# curl -X POST "${PREPROD_BASE}/timed/admin/promoted-trades/promote?run_id=phase-c-stage2-trader-th-jul2025-may2026&seed_account_ledger=true&mode=trader&key=$TIMED_TRADING_API_KEY"
```

Verify:
```bash
curl -sS "${PREPROD_BASE}/timed/admin/promoted-trades/datasets?key=$TIMED_TRADING_API_KEY" | python3 -m json.tool | head -40
```

Trades page Investor column should now have real numbers.

---

## Step 6 — Flip the flag in LIVE (Phase 4 entry point)

Only after Phase 3 sign-off:

```bash
wrangler d1 execute timed_trading_db --env production --command="
  INSERT INTO model_config (config_key, config_value, updated_at)
    VALUES ('deep_audit_trend_hold_enabled', '\"true\"', strftime('%s','now')*1000)
  ON CONFLICT(config_key) DO UPDATE SET
    config_value = excluded.config_value,
    updated_at   = excluded.updated_at;
"
```

Apply the schema migration on production D1 first:
```bash
wrangler d1 execute timed_trading_db --env production --file=worker/migrations/add-trend-hold-columns.sql
```

Tail logs for the first 24h:
```bash
wrangler tail timed-trading-ingest --env production --format pretty | grep -E "TREND_HOLD|trend_hold"
```

Watch for `[TREND_HOLD PROMOTE]` and `[TREND_HOLD DEMOTE]` lines + audit rows.

---

## Troubleshooting

### Smoke test shows 0 promotions

Most likely causes (in order of probability):

1. **Flag not loaded** — verify `model_config.deep_audit_trend_hold_enabled` is `"true"` (with quotes — JSON-encoded). The replay loader does `JSON.parse(config_value)`, so a bare `true` will not work.
2. **Day-state missing weekly tf_tech** — for the specific ticker on that date. `tt.W = {}` means the ticker had insufficient weekly history. Skip that ticker as a smoke target; pick AAPL / MSFT / SPY which always have full weekly data.
3. **Day-state missing monthly_bundle** — many tickers have `monthly_bundle = null` on early dates (pre-spinoff, recent IPO). Promotion gate `promote_require_monthly_supertrend_bull` will reject these. Pick a ticker known to have monthly_bundle from inspecting day-state KV.
4. **Trade hadn't reached MFE ≥ 5% yet** — the gate requires the trade has worked. Pick a date AFTER the +5% inflection per the Phase 1.2 deep dive.
5. **Pine convention bug regressed** — verify `worker/trend-hold.js` `bundleStDir()` calls `tfTechStDir()` (Phase 3.2 fix). If `bundleStDir` returns `+1` for `supertrend_dir = +1` instead of `-1`, the convention is broken.

### Smoke test promotes everything (false positive cohort)

If many tickers get promoted on the smoke date, the gate is too loose. Tighten one of:

- `promote_min_mfe_pct` from 5 → 8 (require the trade has REALLY worked, not just gotten lucky).
- `promote_max_weekly_td9_sell_count` from 8 → 6 (more conservative on exhaustion).
- Add `promote_require_4h_ema21_AND_daily_5_12_cloud_above` (currently only requires 4H EMA-21).

### Investor-replay returns `opened: 0` for every day (the original Phase 3 blocker)

Check whether `monthly_bundle.supertrend_dir` is populated for any candidate ticker on the date:

```bash
curl -sS "${PREPROD_BASE}/timed/admin/kv/get?k=timed:replay:daystate:2025-07-01&key=$TIMED_TRADING_API_KEY" \
  | python3 -c "
import sys, json
v = json.load(sys.stdin)['value']
mb_present = sum(1 for tk, s in v.items() if s.get('monthly_bundle') is not None)
print(f'tickers with monthly_bundle: {mb_present} / {len(v)}')
"
```

If < 50 tickers have `monthly_bundle`, the day-state needs to be re-replayed from raw candles (Option B in PHASE_3_DESIGN.md):

```bash
# This is the heavy path — re-runs the full candle pipeline for every day
# in the window, regenerating tf_tech and monthly_bundle from scratch.
RUN_ID="phase-c-stage2-rehydrate" \
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
API_BASE=$PREPROD_BASE \
  bash scripts/full-backtest.sh --trader-only --include-tech-fields \
    --start 2025-07-01 --end 2026-05-04
```

### Integrity guard auto-mutes the cron mid-replay

The P0.7.103 integrity guard mutes the cron if `trades` or `account_ledger` row counts drop > 50% in one cycle. Trend-Hold transitions write audit rows BEFORE the row updates so the guard sees the cause. If muted unexpectedly:

```bash
# Check audit log for the mute event
curl -sS "${PREPROD_BASE}/timed/admin/data-audit-log?limit=20&key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool | head -100

# Look for `op=cron_auto_mute` or large `rows_affected` deltas. If the cause
# was Trend-Hold related (`op=trend_hold_promote/demote`), confirm the
# transition was correct, then unmute:
curl -X DELETE "${PREPROD_BASE}/timed/admin/replay-lock?key=$TIMED_TRADING_API_KEY"
```

---

## Open design question for next agent / user

**Should Investor mode trades be eligible for Trend-Hold promotion / suppression?**

Phase 2 wires Trend-Hold into `processTradeSimulation` which only handles **Active Trader** trades. Investor trades go through `runInvestorDailyReplay` (worker/index.js) which has its OWN runner-management logic in `worker/investor.js`. They never hit the Trend-Hold module.

Implications:
- Phase 3 Path A (Investor-only) does NOT exercise Trend-Hold at all. The "with Trend-Hold enabled" framing in the original handoff implicitly assumed AT-vs-Investor were unified.
- Phase 3 Path B (Trader-with-TH) DOES exercise Trend-Hold. This is the actual capture-jump validation.

Two design options for next agent:
1. **Keep separate** — Investor and Trend-Hold are independent runner modes. Active Trader trades use TH; Investor trades use existing investor.js logic. Simpler. (Current design.)
2. **Unify** — Wire Trend-Hold into runInvestorDailyReplay too, so Investor trades also get the close-discipline gates and exit suppression. More invasive, but cleaner from a "ride the runner" perspective.

User's call. Recommended: ship (1) for Phase 4, evaluate (2) in Phase 5 alongside the AT-Lite work.

---

## Files this runbook references

- Schema: `worker/migrations/add-trend-hold-columns.sql`
- Module: `worker/trend-hold.js`
- DA-key reg: `worker/replay-runtime-setup.js` (REPLAY_DA_KEYS)
- Module wiring: `worker/index.js` (5 suppression call sites + lifecycle eval)
- Doctrine wiring: `worker/phase-c-exit-doctrine.js` (trendHoldActive shortcut)
- Smoke test: `scripts/test-trend-hold.js` (56/56 pass on land)
- Existing orchestrators: `scripts/investor-backfill-jul-may.sh`, `scripts/full-backtest.sh`, `scripts/continuous-slice.sh`
- Verdict generator: `scripts/build-investor-monthly-verdict.js` (Phase 3 — to be added)
