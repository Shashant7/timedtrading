---
title: Pre-Production Environment — Build & Operations Runbook
created: 2026-05-09
phase: 3.7 (P0.7.118)
status: in-progress (needs D1 creation + deploy)
---

# Pre-Prod Environment Runbook

Isolated environment for destructive backtests, calibration testing, and schema migration validation. Has its OWN D1 database + KV namespace so anything that runs here NEVER touches live trader state.

> Built in response to Phase 3 hitting an architectural wall trying to A/B Trend-Hold against the live D1 — the replay engine treats trades as global-scope at the entry-decision layer, so an additive backtest with existing trades produces 0 new entries. The proper fix is environmental isolation (this).

---

## Topology

| env | worker name | URL | D1 database | KV namespace |
|---|---|---|---|---|
| Live (prod) | `timed-trading-ingest` | `timed-trading-ingest.shashant.workers.dev` | `timed-trading-ledger` (id `99fae5d6-…`) | `KV_TIMED` (id `e48593af3ef74bf986b2592909ed40cb`) |
| **Pre-prod** | `timed-trading-ingest-preprod` | `timed-trading-ingest-preprod.shashant.workers.dev` | `timed-trading-ledger-preprod` (id TBD) | `KV_TIMED_PREPROD` (id `246f397779e44e6bb8853585b74200ff`) |

Pre-prod has **NO crons**. All activity is request-driven (replay endpoints, admin endpoints). The live cron logic depends on fresh ingest data which only exists in production. This matches the "additive backtest" semantics — you push trades into pre-prod via replay, never via auto-ingest.

---

## One-time setup (operator)

### Step 1 — Create the pre-prod D1 database

The `CLOUDFLARE_TOKEN` attached to this cloud agent has Workers + KV edit permissions but NOT D1 edit. Two options:

**Option A — Dashboard (easiest):**
1. https://dash.cloudflare.com → Workers & Pages → D1 → Create database
2. Name: `timed-trading-ledger-preprod`
3. Copy the resulting `database_id`
4. Edit `worker/wrangler.toml`, find the `[env.preprod.d1_databases]` block, replace `PLACEHOLDER_TO_BE_FILLED_IN_BY_OPERATOR` with the actual id.

**Option B — Update token scope, then `wrangler d1 create`:**
1. https://dash.cloudflare.com/profile/api-tokens → edit the token used as `CLOUDFLARE_TOKEN` in this agent's secrets
2. Add permission: **Account → D1 → Edit**
3. Save (token value unchanged)
4. From this repo:
   ```bash
   cd worker && npx wrangler d1 create timed-trading-ledger-preprod
   ```
5. Update `worker/wrangler.toml` with the returned id.

### Step 2 — Deploy the worker to pre-prod

```bash
npm run deploy:preprod
```

This runs `wrangler deploy --env=preprod` from `worker/`. Effect:
- Worker `timed-trading-ingest-preprod` deploys with the `[env.preprod]` config
- Bindings: `DB` → preprod D1; `KV_TIMED` → preprod KV
- Vars: `EXECUTION_MODE=simulation`, `DISCORD_ENABLE=false`, `EMAIL_ENABLED=false`, `ALPACA_ENABLED=false`, `ENVIRONMENT_LABEL=preprod`
- NO scheduled triggers
- URL: `https://timed-trading-ingest-preprod.shashant.workers.dev`

### Step 3 — Apply schema + clone live config

```bash
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
PREPROD_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
  bash scripts/clone-live-to-preprod.sh
```

What it does:
1. Sanity-checks both environments are reachable.
2. Calls `/timed/admin/ensure-trend-hold-schema` on preprod to bootstrap the `trades` table + 7 trend_hold_* columns.
3. Clones a curated list of `model_config` keys (the daCfg flags + risk maps + AI CIO settings) from live → preprod.
4. Mirrors all `timed:replay:daystate:*` KV blobs (218 trading days from Phase C) so the investor-replay path can run on preprod without re-replaying from raw candles.

Total wall time: ~5-10 min.

Note: the `kv/put` admin endpoint added in Phase 3.7 (P0.7.118) is what makes this clone possible. It refuses writes to protected namespaces (`timed:trades:`, `account_ledger:`, etc.) when called against production — only the preprod env's `ENVIRONMENT_LABEL=preprod` var bypasses the guard.

### Step 4 — Verify

```bash
# 1. preprod responsive
curl https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/replay-lock?key=$TIMED_TRADING_API_KEY

# 2. preprod schema
curl -X POST https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/ensure-trend-hold-schema?key=$TIMED_TRADING_API_KEY
# expect: { ok: true, present: 7 cols, missing: 0 }

# 3. preprod day-state KV mirror landed
curl https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/kv/get?k=timed:replay:daystate:2025-10-01&key=$TIMED_TRADING_API_KEY
# expect: { ok: true, value: { AAPL: {...}, MSFT: {...}, ... } }

# 4. preprod model_config has the TH flag
# (no direct read endpoint yet — verify via trend-hold-evaluate)
curl -X POST https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/trend-hold-evaluate?ticker=AAPL&autoFallback=1&commit=0&key=$TIMED_TRADING_API_KEY
# expect: { ok: true/false, flag_enabled: true, ... }
```

---

## Operating mode — running a destructive backtest on pre-prod

Once preprod is live and seeded, the Phase 3 full backtest can run end-to-end without any risk to live trader state.

```bash
API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  bash scripts/full-backtest.sh \
    --label=phase-c-stage2-th-jul2025-may2026 \
    --keep-open-at-end \
    2025-07-01 2026-05-08 20
```

The script's destructive behavior is now SAFE because preprod's D1 is isolated. The `cleanSlate=1` first-batch wipe will:
- Delete preprod's (empty) trades table → no-op
- Reset preprod's account_ledger → no-op (nothing was there)

The replay then accumulates fresh trades into preprod D1 with the new run_id.

After completion:

```bash
# 1. Run investor backfill on preprod against the freshly-rich day-state.
API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  bash scripts/investor-backfill-jul-may.sh 2025-07-01 2026-05-08

# 2. Generate per-month verdicts comparing this run's output against the
#    canonical phase-c-stage1 trader run (which lives on LIVE D1; the
#    verdict generator reads both via /admin/backtests/run-trades).
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  bash scripts/build-all-investor-verdicts.sh \
    --trader-run-id phase-c-stage1-jul2025-may2026 \
    --th-run-id     <run_id from step 1's output> \
    --api-base      https://timed-trading-ingest-preprod.shashant.workers.dev
```

> The verdict generator will need a small enhancement to read trader-run from one base + th-run from another, since they live on different D1s. Phase 3.8 follow-up.

### Validation pass criteria (HARD PASS for live promote)

Per `tasks/phase-c/PHASE_3_RUNBOOK.md` Step 4:

- SNDK trade count ≤ 4 in the new run (was 11 in `phase-c-stage1`)
- ≥ 1 SNDK trade has `trend_hold_state='active'` at exit AND `pnl_pct ≥ 50%`
- Σ SNDK pnl% ≥ 200% (was 32.9%; 6× capture lift)
- No SNDK trade closes via a suppressed reason (HARD_FUSE_RSI_EXTREME / PROFIT_GIVEBACK_* / SMART_RUNNER_SUPPORT_BREAK_CLOUD / mfe_decay_structural_flatten / ST_FLIP_4H_CLOSE)
- Same checks for BE, MU, SOXL, LITE — at least 3 of 5 must HARD PASS
- **March 2026 regression guard**: `trader_th_mar` realized_pnl_pct must NOT be < `trader_only_mar - 1.0%`

If HARD PASS → flip `deep_audit_trend_hold_enabled = "true"` in **production** model_config, deploy, monitor live SNDK promotion on next cron tick.

If FAIL → keep flag off in production, iterate on pre-prod (tune thresholds, rerun specific monthly legs).

---

## Maintenance

### Refreshing pre-prod from live

The day-state KV gets stale as new live trading days accumulate. Re-run the clone script monthly (or before each backtest cycle):

```bash
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
PREPROD_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
  bash scripts/clone-live-to-preprod.sh
```

The script is idempotent — re-running upserts day-state KV blobs and model_config rows; no duplicates.

### Reset pre-prod

```bash
# Wipe pre-prod D1 trades / positions / ledger so the next backtest starts clean:
curl -X POST "https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/reset?resetLedger=1&replayOnly=1&key=$TIMED_TRADING_API_KEY"
```

This is safe on pre-prod. Uses the same `/admin/reset` endpoint that's gated on production with confirm flags — but pre-prod's `ENVIRONMENT_LABEL=preprod` skips the protection (the worker auto-allows destructive ops on the preprod env).

> Future enhancement: add an `ENVIRONMENT_LABEL` check to the `cleanSlate=1` hard-guard and `/admin/reset` endpoint so the warning text reflects "OK to wipe preprod" vs "STOP, this is production".

### Decommissioning

If the pre-prod env needs to go away:

```bash
cd worker && npx wrangler delete --env=preprod
# Then in dashboard: delete D1 database, KV namespace
```

D1 idle cost: ~$0.50/mo. KV is free at this scale.

---

## Known follow-ups (Phase 3.8+)

1. **Candle data clone (next-session blocker for the actual backtest)** — preprod has 67 tables but `ticker_candles` is empty. Live's `ticker_candles` has 10M rows / 5.5 GB. The candle-replay endpoint can't drive scoring without raw candles. See "Next-session start" below for the exact commands.
2. **Verdict generator multi-base support** — currently reads run-trades from a single API_BASE. Should accept `--trader-api-base` and `--th-api-base` separately so the trader baseline run on live and the TH run on preprod can be compared in one verdict markdown.
3. **`/admin/model-config?action=list` GET endpoint** — for full bidirectional clone of `model_config` (currently the clone script enumerates a hardcoded key list).
4. **Phase 2.10 — wire `shouldDcaTrendHold` into the execution loop** — the predicate exists and tests pass but it's never called by `processTradeSimulation`. Add the per-tick eval + actual buy execution. Required for full TH semantics ("ride and add to dip" is half of TH's value, not just "ride").
5. **`backtest-runner-do.js` integration** — the BacktestRunner DO has an isolated execution context that may give us per-run scope isolation without needing a separate environment. Worth investigating as Phase 3.9 — would let some backtests run on live D1 with stronger isolation than the additive-mode attempt that failed.

---

## Next-session start

Pre-prod is functionally complete except for the `ticker_candles` table. **Before running the destructive Phase 3 backtest on preprod**, this is the exact sequence:

### Step 1 — Export Jul 2025+ candles from live, import to preprod (~30-60 min)

```bash
cd worker && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN"

# Live ticker_candles is 10M rows / 5.5 GB total. Filter to the Phase C
# window (Jul 1 2025 = 1719792000000 ms) to keep the export to ~3-4 GB.
# wrangler d1 export streams via R2; tolerates large datasets.
npx wrangler d1 export timed-trading-ledger --remote \
  --table ticker_candles \
  --output /tmp/live-candles-jul2025plus.sql

# Filter the SQL to keep only INSERT rows for ts >= 2025-07-01 cutoff:
python3 -c "
import re
cutoff_ms = 1719792000000  # 2025-07-01 UTC
kept = 0; skipped = 0
with open('/tmp/live-candles-jul2025plus.sql') as fi, \
     open('/tmp/preprod-candles-import.sql', 'w') as fo:
    for line in fi:
        if line.startswith('INSERT INTO ticker_candles'):
            # Look for ts column; assume position-based parse.
            # Format: INSERT INTO ticker_candles VALUES('TICKER', tf, ts, ...)
            m = re.search(r\"VALUES\\('[^']+',\\s*'?[^,]+,\\s*(\\d+),\", line)
            if m and int(m.group(1)) >= cutoff_ms:
                fo.write(line); kept += 1
            else: skipped += 1
        else:
            fo.write(line)
print(f'kept INSERTs: {kept}, skipped: {skipped}')
"

# Import filtered candles to preprod (~5-15 min)
npx wrangler d1 execute timed-trading-ledger-preprod --remote \
  --file /tmp/preprod-candles-import.sql
```

### Step 2 — Single-day candle-replay smoke on preprod (~30 sec)

```bash
PRE="https://timed-trading-ingest-preprod.shashant.workers.dev"
curl -X POST "$PRE/timed/admin/candle-replay?date=2025-07-15&tickerOffset=0&tickerBatch=20&intervalMinutes=5&freshRun=1&disableReferenceExecution=1&key=$TIMED_TRADING_API_KEY" | python3 -m json.tool | head -20
```

**Pass criterion:** `scored > 0` (probably ~1500 = 20 tickers × 79 intervals). If `scored == 0` → candles still not landing for 2025-07-15; check the import.

### Step 3 — Full destructive backtest (~5-7 h, in tmux)

```bash
SESS="preprod-th-backtest"
tmux -f /exec-daemon/tmux.portal.conf has-session -t "=$SESS" 2>/dev/null \
  || tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESS" -c "$PWD" -- bash -l

tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESS:0.0" \
  "cd /workspace && API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev TIMED_API_KEY=$TIMED_TRADING_API_KEY bash scripts/full-backtest.sh --label=phase-c-stage2-th-jul2025-may2026 --keep-open-at-end 2025-07-01 2026-05-08 20 2>&1 | tee /tmp/preprod-backtest.log" C-m
```

**Note:** No `--no-clean-slate` flag this time. Preprod tables are empty so the destructive ops are no-ops. The replay accumulates fresh trades into preprod D1 with the new run_id.

### Step 4 — Investor backfill on preprod (~30 min)

```bash
API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  bash scripts/investor-backfill-jul-may.sh 2025-07-01 2026-05-08
```

Target: with rich monthly_bundle data on preprod (re-populated via the candle-replay) we should see 100-200 entries instead of the 25 we got with the live day-state KV.

### Step 5 — Per-month verdicts + SNDK validation (~5 min)

```bash
TIMED_API_KEY=$TIMED_TRADING_API_KEY \
  bash scripts/build-all-investor-verdicts.sh \
    --trader-run-id phase-c-stage1-jul2025-may2026 \
    --th-run-id     <run_id from Step 3 output> \
    --api-base      https://timed-trading-ingest-preprod.shashant.workers.dev
```

> Caveat: build-all-investor-verdicts.sh currently reads from one API_BASE. The trader-run lives on LIVE; the TH-run lives on PREPROD. Either:
> (a) Add `--trader-api-base` flag to the script (15 min code change), OR
> (b) Manually copy the `phase-c-stage1` run-trades JSON from live → preprod via a one-off curl, then run the verdict against preprod for both.
>
> Tracked as follow-up #2 above.

### Step 6 — Decide on live promote

Apply PHASE_3_RUNBOOK.md Step 4 hard-pass criteria. If pass → flip TH flag in production model_config + verify via Monday open's cron tick.

---

## Estimated next-session wall time

| step | time |
|---|---:|
| Candle export + import | 30-60 min |
| Smoke + full backtest | 5-7 h |
| Investor backfill + verdicts | 45 min |
| Validate + decide | 15 min |
| **Total** | **6.5-9 h** |

A weekend morning is the right window. **The backtest should NOT be kicked off less than ~7h before market open** to leave buffer for verdict review + flag-flip decision.

---

## Files this runbook references

- `worker/wrangler.toml` — `[env.preprod]` block (Phase 3.7)
- `worker/index.js` — `POST /timed/admin/kv/put` endpoint (P0.7.118)
- `scripts/clone-live-to-preprod.sh` — one-time data mirror (Phase 3.7)
- `package.json` — `npm run deploy:preprod` script
- `scripts/full-backtest.sh` — `--no-clean-slate` flag (Phase 3.5, mostly unused in preprod since destructive is fine there)
- `tasks/phase-c/PHASE_3_RUNBOOK.md` — full TH validation procedure (will execute against pre-prod URL)
