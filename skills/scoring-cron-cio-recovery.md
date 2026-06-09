# Scoring Cron + CIO Recovery

**WHEN to use:** Mission Control shows a wall of red `score_ticker_*` tombstones,
trims/SLs stop firing, or CIO Shadow Mode / Readiness verdict disagree. Run
after merging scoring-resilience or CIO lifecycle PRs, or when the operator
reports "cron tombstones" / "missed trims" / "CIO still in shadow".

**Prerequisites:**
- `TIMED_TRADING_API_KEY` (admin key)
- Worker deployed to **both** default + production (`skills/deploy.md`)
- `wrangler` at `node_modules/.bin/wrangler`

**Related skills:** [deploy.md](deploy.md), [rescore-ticker.md](rescore-ticker.md),
[backfill-candles.md](backfill-candles.md), [ai-cio-lifecycle.md](ai-cio-lifecycle.md),
[mc-holistic-smoke-test.md](mc-holistic-smoke-test.md)

---

## Symptom → root cause

| Symptom | Likely cause |
|---------|----------------|
| Red `score_ticker_*` tombstones (all tickers) | D1 candle bundles missing → scoring returns `insufficient_candle_data` |
| Trims/SL not firing despite price move | Scoring dead → `kanban_stage` stale; trade-mgmt runs on old snapshot |
| Shadow OFF + "STAY IN SHADOW" verdict | `ai_cio_shadow_mode=false` flipped without gates green |
| CIO HOLD blocking trims | Shadow OFF (LIVE) — CIO HOLD blocks engine; shadow ON logs only |
| ETHA on wrong ticker Catalysts | FSD cross-tag (fixed by `publicationMentionsTicker` filter) |

---

## Step 1 — Deploy worker (both envs)

```bash
cd /workspace/worker
../node_modules/.bin/wrangler deploy 2>&1 | tail -5
../node_modules/.bin/wrangler deploy --env production 2>&1 | tail -5
```

Verify:

```bash
curl -s https://timed-trading-ingest.shashant.workers.dev/timed/health | python3 -m json.tool | head -15
# Expect: ok=true, minutesSinceScoring < 10 during RTH
```

---

## Step 2 — Check cron tombstones

```bash
KEY="$TIMED_TRADING_API_KEY"
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/cron-status?key=$KEY" \
  | python3 -m json.tool | head -80
```

**Healthy:** `score_ticker_*` ops show `status: "HEALTHY"` or absent from failing list.

**If `score_ticker_*` still FAILING:**

1. Rescore one open-position ticker (proves D1 + assemble path):

```bash
curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rescore-ticker?ticker=AAPL&key=$KEY" \
  | python3 -m json.tool | head -30
# Expect: ok=true, summary.rank present, summary.has_W/has_M true
```

2. If rescore fails → backfill candles ([backfill-candles.md](backfill-candles.md)):

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/alpaca-backfill" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"ticker":"AAPL","days":10}'
```

3. Widespread failure → universe bootstrap:

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/wm-bootstrap" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY"
```

4. Wait one */5 scoring cycle (~5 min), then clear stale tombstones:

```bash
curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/cron-clear?op=all&key=$KEY" \
  | python3 -m json.tool
```

---

## Step 3 — Fix CIO config (full live)

**Blocking gates** (2026-06-06): only timeout-related — `fallback_rate`,
`entry_latency`, `lifecycle_latency`. Sample/edge/operator gates are
informational (backtest history pollutes counts).

Lifecycle gate default timeout is **8000ms** (was 2500ms — was timing out
>95% of gpt-5.4 calls). Entry API timeout defaults to **20000ms**
(`ai_cio_entry_timeout_ms`).

**Full live** (entries + lifecycle enforced):

```bash
curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/model-config?key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {"key": "ai_cio_shadow_mode", "value": "false"},
      {"key": "ai_cio_lifecycle_enforce", "value": "true"},
      {"key": "ai_cio_lifecycle_timeout_ms", "value": "8000"},
      {"key": "ai_cio_entry_timeout_ms", "value": "20000"}
    ]
  }' | python3 -m json.tool
```

Verify readiness (no config mismatch):

```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/ai-cio/go-live-readiness?key=$KEY" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
e=d.get('enforcement',{})
print('ready_for_live:', d.get('ready_for_live'))
print('config_mismatch:', e.get('config_mismatch'))
print('entry_enforced:', e.get('entry_enforced'))
print('lifecycle_enforced:', e.get('lifecycle_enforced'))
print('recommendation:', d.get('recommendation','')[:120])
"
# Expect: ready_for_live=True, config_mismatch=False, entry_enforced=True, lifecycle_enforced=True
```

**Lifecycle-only** (entries shadow, lifecycle enforced) — interim state only:

| Key | Value |
|-----|-------|
| `ai_cio_shadow_mode` | `true` |
| `ai_cio_lifecycle_enforce` | `true` |

---

## Step 4 — Rescore open positions

For each ticker with an open trader or investor position:

```bash
for T in AAPL XLI GS; do
  curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rescore-ticker?ticker=$T&key=$KEY" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ticker'), d.get('ok'), d.get('summary',{}).get('rank'))"
done
```

---

## Step 5 — Holistic pass

Run [mc-holistic-smoke-test.md](mc-holistic-smoke-test.md) sections 1–3. Minimum bar:

- `minutesSinceScoring` < 10
- `score_ticker_*` tombstones cleared
- `scoringCore` ≈ universe size (~256)
- CIO `config_mismatch: false`

---

## What the code does (post PR #531 / #532)

- **Scoring:** 15m TF fetch, D1 per-TF fallback, tombstone rate-limit (1/hr/ticker), degraded trade-mgmt on open positions when full score skips
- **CIO:** `ai_cio_lifecycle_enforce` decouples lifecycle enforcement from entry shadow
- **Trims:** Extension-watch bypasses 30-min trim guard when MFE ≥ 1.5%
- **SL:** RTH HTF cushion capped at 0.5% so sustained breaches exit
- **FSD Intel:** `publicationMentionsTicker()` drops cross-tagged articles

---

## Source files

- Scoring cron: `worker/index.js` (`scoreTicker`, ~89330)
- CIO shadow/lifecycle: `worker/index.js` (`_cioLifecycleEnforced`, trim/exit paths)
- Tombstones: `worker/alerts.js` (`recordCronFailure` / `recordCronSuccess`)
- Readiness: `GET /timed/admin/ai-cio/go-live-readiness`
- Clear tombstones: `POST /timed/admin/cron-clear?op=all`
