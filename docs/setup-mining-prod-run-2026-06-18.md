# Setup Sequence Mining — Production Execution (2026-06-18)

**Yes — production has data.** The first mining attempts joined against raw
`timed_trail` (~48h retention). Historical analysis must use **`trail_5m_facts`**
(~4.4M rows, Jun 2025 – Jun 2026) or **`rank_trace_json`** on archived trades
(4,813 rows).

---

## Commands

```bash
# Archived backtest lane (50 most recent closed trades)
node scripts/mine-setup-sequences.mjs \
  --wrangler-d1 production \
  --trail-source 5m \
  --limit 50 \
  --out-dir data/setup-mining/prod-archived-5m

# Live closed trades (610 total in D1)
node scripts/mine-setup-sequences.mjs \
  --wrangler-d1 production \
  --trail-source 5m \
  --live \
  --limit 50 \
  --out-dir data/setup-mining/prod-live-5m
```

**Artifacts:** `data/setup-mining/prod-{archived,live}-5m/summary.{json,md}`

---

## Production data inventory

| Source | Rows / count | Date range | Notes |
|---|---|---|---|
| `trail_5m_facts` | 4,453,820 | 2025-06-17 → 2026-06-16 | Primary analysis trail |
| `trail_5m_facts` with PDZ zone | 2,356,660 | same | `pdz_zone != 'unknown'` |
| `timed_trail` (raw) | 51,960 | 2026-06-15 → 2026-06-17 | ~48h retention only |
| `timed_trail.payload_json` | **0** | — | Phase-I purge |
| Live closed trades (`trades`) | 610 | 2025-07-01 → 2026-06-05 | All within 5m-facts window |
| Archived closed trades | 19,265 | 2025-06-30 → 2026-04-30 | All within 5m-facts window |
| `rank_trace_json` on archived | 4,813 | — | Richer pre-entry context (not yet wired into miner) |

**Why the first prod run looked empty:** raw `timed_trail` ends Jun 17 while the
latest live trade entered Jun 5 — zero temporal overlap on the wrong table.

---

## Results (shadow mining, `trail_5m_facts`)

### Archived sample (50 trades)

| Metric | Value |
|---|---|
| Trades with pre-entry diagnostics window | **50 / 50** |
| Avg snapshots per trade (48h lookback) | ~100–140 (5m buckets) |
| Derived setup events | **0** (5m facts lack TD/RSI/EMA stacks) |
| Active mean-reversion sequence at entry | **0** |
| Baseline win rate | **44%** (22W / 28L), avg PnL +0.44% |

### Live sample (50 trades)

| Metric | Value |
|---|---|
| Trades with diagnostics window | **49 / 50** |
| Active sequence at entry | **0** |
| Baseline win rate | **32%** (16W / 34L), avg PnL −1.15% |

---

## What this proves

1. **The analysis exercise works on prod** — trades join cleanly to
   `trail_5m_facts` for state / phase / kanban context.
2. **Sequence stage correlation is blocked on signal depth**, not trade count:
   - no `payload_json` anywhere;
   - 5m aggregates omit TD sequential, per-TF RSI/EMA, and most SMC detail
     needed for stages 1–7;
   - `rank_trace_json` (4,813 trades) is the next data source to wire in.
3. **Baseline reliability tables are still useful** — we now have shadow
   join coverage metrics and win-rate baselines per ticker cohort.

---

## Next analysis steps (still shadow-only)

1. Wire **`rank_trace_json`** from `backtest_run_trades` / `direction_accuracy`
   into the miner for trades that have it.
2. Optionally enrich 5m snapshots with **`flags_json`-equivalent fields** once
   the light-agg cron populates `pdz_zone` / FVG counts consistently on recent
   buckets.
3. **`payload_json` backfill** for fixture tickers — required for full stage 5–7
   sequence reliability tables per the hardening plan.
