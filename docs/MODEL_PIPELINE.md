# Model Pipeline & Config Knobs

This doc describes the ML model pipeline, labeling (target/stop at horizons), feature set, and config knobs for TP levels and horizon buckets.

---

## 1. ML pipeline (ml_v1)

### Overview
- **Storage:** KV key `timed:model:ml_v1` (weights + metadata). D1 table `ml_v1_queue` for labeling queue.
- **Flow:** On ingest (and on backfill), snapshots are enqueued with `(ticker, ts, entry_price, features_json, horizon_ms, label_due_ts)`. After `label_due_ts`, a scheduled job (cron every 6h) labels each row using the **exit price** at that time, then runs online SGD to update the model.
- **Label (y):** Binary. At `label_due_ts` we get the nearest close price; `y = 1` if the move is in the direction of the trade (LONG: exit > entry, SHORT: exit < entry), else `y = 0`. There is no explicit “target” or “stop” in the label—it’s “did price move in our favor by horizon?”
- **Training:** Online logistic regression (sigmoid, L2). One update per labeled row; weights stored in KV.

### Horizons
- **Used when enqueueing:** `[4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]` → **4h** and **24h** (1 day) in milliseconds.
- **label_due_ts** = `ts + horizon_ms`. Label is computed using the exit price at or after `label_due_ts` (nearest close from `timed_trail` or `ticker_candles`).

### Features (mlV1ExtractX)
Feature vector `x` (normalized where noted):

| Index | Name / source        | Normalization / notes                          |
|-------|----------------------|-------------------------------------------------|
| 0     | bias                 | 1                                               |
| 1     | rank_n               | `(rank - 50) / 50` (rank 0–100)                 |
| 2     | rr_n                 | `min(4, rr) / 4` (risk:reward cap 4)            |
| 3     | completion           | 0–1                                             |
| 4     | phase                | phase_pct 0–1                                   |
| 5     | abs_htf_n            | `min(1, abs(htf_score)/100)`                     |
| 6     | abs_ltf_n            | `min(1, abs(ltf_score)/100)`                    |
| 7     | aligned              | 1 if state HTF_BULL_LTF_BULL or HTF_BEAR_LTF_BEAR |
| 8     | setup                | 1 if state HTF_*_LTF_PULLBACK                   |
| 9     | sq30_release         | 1 if flag `sq30_release`                         |
| 10    | inCorridor           | 1 if entry type corridor                        |
| 11    | momentum_elite       | 1 if flag `momentum_elite`                       |

### Config knobs (model)
- **Learning rate (lr):** default `0.05` (in code).
- **L2:** default `0.001`.
- **Batch size for training run:** up to 75 rows per run (250 max when forced). Cron: `0 */6 * * *` (every 6 hours).

---

## 2. Horizon buckets (TP / hold-intent)

Used for **TP levels**, **trim levels**, and **distance thresholds** (not for ml_v1 features directly). Derived from **eta_days** (expected days to target).

### horizonBucketFromEtaDays(etaDays)
- **eta ≤ 7** → `SHORT_TERM`
- **7 < eta ≤ 30** → `SWING`
- **eta > 30** → `POSITIONAL`
- Invalid/unknown → `UNKNOWN` (falls back to SWING in TP logic)

### horizonConfigMap (worker)

| Bucket        | minDistancePct | sweetMin–sweetMax | okMin–okMax | tooFarPct | minDistanceBetweenTPs | maxTPs | trimLevels              | fallbackMultipliers |
|---------------|----------------|-------------------|-------------|-----------|------------------------|--------|--------------------------|---------------------|
| SHORT_TERM    | 0.03           | 0.05–0.12         | 0.03–0.18   | 0.25      | 0.03                   | 3      | [0.2, 0.5, 1.0]          | [0.7, 1.0, 1.4]      |
| SWING         | 0.04           | 0.08–0.2          | 0.05–0.3    | 0.45      | 0.05                   | 4      | [0.1, 0.25, 0.5, 1.0]    | [0.6, 1.0, 1.6]      |
| POSITIONAL    | 0.06           | 0.15–0.4          | 0.1–0.6     | 0.8       | 0.08                   | 4      | [0.1, 0.25, 0.5, 1.0]    | [0.5, 1.0, 1.8]      |

- **minDistancePct:** Minimum distance (as fraction of price) for a TP level from entry; TPs closer than this are filtered out.
- **trimLevels:** Fractions of “way to target” for trim (e.g. 0.25 = first trim at 25% of the move).
- **fallbackMultipliers:** Used when building TP array from ATR if no explicit levels (e.g. 0.6×, 1×, 1.6× ATR).

---

## 3. Target / stop (trading logic, not ML label)

- **TP (target):** From payload `tp`, `tp_target_price`, or intelligent TP array (ATR-based, horizon-aware). Primary TP is attached to ticker latest; multiple TP levels with trim percentages come from `buildIntelligentTPArray` (see horizon config above).
- **SL (stop):** From payload `sl`; used for risk, RR, and breach logic. “Stop breached” is an explicit Kanban exit trigger.
- **ML label** does **not** use TP or SL levels; it only uses **entry price**, **direction**, and **exit price at horizon** to set `y` (win/loss).

---

## 4. Scripts & backfill

- **Backfill labeled data:** Scripts (e.g. `scripts/ml-queue-backfill.js` or similar) can populate `ml_v1_queue` from historical trail/candles; then training (scheduled or manual) labels and updates the model.
- **Train from queue:** Worker cron runs `mlV1TrainFromQueue` every 6h; it selects rows with `y IS NULL` and `label_due_ts <= now`, gets exit price via `d1NearestClose`, computes `y`, then one SGD step per row and writes updated weights to KV.

---

## 5. Quick reference

| What              | Where / key                          |
|-------------------|--------------------------------------|
| Model weights     | KV `timed:model:ml_v1`               |
| Labeling queue    | D1 `ml_v1_queue`                     |
| Horizons          | 4h, 24h (ms) when enqueueing         |
| Label             | Binary win/loss at horizon (exit vs entry) |
| Features          | 12-dim vector (see table above)      |
| Horizon buckets   | SHORT_TERM / SWING / POSITIONAL from eta_days |
| TP/trim config    | `horizonConfigMap` in worker (minDistancePct, trimLevels, etc.) |
