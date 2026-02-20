# Enrich Consensus + Weekly Card Background

## Tasks
- [x] 1. Multi-signal TF bias: Replace binary EMA cross in `computeSwingConsensus` with weighted composite (SuperTrend, emaStructure, emaDepth, RSI, EMA cross)
- [x] 2. Signal snapshot logging: Add `signal_snapshot_json` column to `direction_accuracy`, log per-signal breakdown at trade entry
- [x] 3. Signal accuracy retrospective: Extend retrospective to compute per-signal accuracy, update `consensus_signal_weights` in model_config
- [x] 4. Weekly change backend: Compute `weekly_change_pct` from D1 candles, add to `/timed/all` payload
- [x] 5. Weekly change frontend: Switch `getCardSkin()` from daily to weekly change, adjust intensity ranges

## Implementation Summary

### 1. Multi-signal TF Bias (`worker/indicators.js`)
- Added `computeTfBias(b, signalW)` — continuous -1 to +1 bias per TF using 5 signals:
  - `ema_cross` (w=0.15): EMA 13/48 cross direction
  - `supertrend` (w=0.25): SuperTrend structural signal
  - `ema_structure` (w=0.25): Long-EMA macro trend
  - `ema_depth` (w=0.20): How many EMAs price is above (0-10)
  - `rsi` (w=0.15): RSI zone lean
- `computeSwingConsensus` now:
  - Computes per-TF `biasScore` instead of binary bull/bear
  - Uses weighted average of TF biases for direction (>0.3 LONG, <-0.3 SHORT)
  - Returns `avgBias` and per-TF `signals` in `tfStack`
  - Accepts optional `signalWeights` for learned weight overrides
  - 4th param `signalWeights` loaded from `model_config` key `consensus_signal_weights`

### 2. Signal Snapshot Logging (`worker/index.js`)
- Added `signal_snapshot_json TEXT` column to `direction_accuracy` (CREATE TABLE + ALTER TABLE fallback)
- Both `d1LogDirectionEntry` and `d1LogDirectionAccuracy` now build and store signal snapshots
- Snapshot format: `{ avg_bias, tf: { "10m": { bias, signals: { ema_cross, supertrend, ... } }, ... } }`

### 3. Signal Accuracy Retrospective (`worker/index.js`)
- Added `updateSignalWeights(env)` — reads closed trades with `signal_snapshot_json`, computes per-signal accuracy
- Accuracy converted to normalized weights (sum=1.0), clamped 0.05-0.50
- Writes `consensus_signal_weights` to `model_config`
- Added `getLearnedSignalWeights(env)` with 15-min TTL cache
- Wired into weekly retrospective cron (Fridays 9:15 PM UTC)
- Signal weights loaded at scoring cron start and injected into `assembleTickerData` opts

### 4. Weekly Change Backend (`worker/index.js`)
- Added weekly change enrichment to both KV snapshot and D1 fallback paths in `/timed/all`
- Queries last 7 deduped daily candles per ticker
- Computes `weekly_change_pct` and `weekly_change` from 5-trading-day-ago close vs current price
- Added to ticker payload as `weekly_change_pct` / `weekly_change`

### 5. Weekly Change Frontend (`react-app/index-react.html`)
- `getCardSkin()` now uses `weekly_change_pct` for background intensity (fallback to daily)
- Adjusted ranges for weekly-scale moves:
  - 0-2%: subtle
  - 2-5%: moderate
  - 5-8%: strong
  - 8-15%: vivid
  - 15%+: pulse
- Returns `weeklyPct` alongside `dayPct`/`dayChg`
