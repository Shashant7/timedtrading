# Parity Input Audit

Generated: 2026-04-02

## 1. Engine Routing

- Live worker route is `tt_core` for both entry and management.
- This is active in production and in local recovery code.

Implication:
- Jul/Aug parity is not failing because the live system forgot to route into `tt_core`.

## 2. HTF Candle Coverage

Remote D1 coverage for key parity-sensitive names is present for Jul/Aug and the warmup window:

- `FIX`: `30`, `60`, `240`, `D` all populated
- `RBLX`: `30`, `60`, `240`, `D` all populated
- `PANW`: `30`, `60`, `240`, `D` all populated
- `GDX`: `30`, `60`, `240`, `D` all populated
- `AYI`: `30`, `60`, `240`, `D` all populated
- `IREN`: `30`, `60`, `240`, `D` all populated

Implication:
- The current production dataset is not missing 30m / 1H / 4H coverage for the names that repeatedly showed parity drift.
- We should stop treating HTF absence as the primary blocker for the current lane unless a specific replay query path is trimming the history window incorrectly.

## 3. Jul/Aug Earnings Event Coverage For Golden Tickers

Remote `market_events` query for the 21 golden tickers between `2025-07-01` and `2025-08-08` returned only:

- `RIOT` on `2025-07-31` (`event_type='earnings'`, sparse metadata, `status=null`)
- `SWK` on `2025-07-29` (`event_type='earnings'`, `event_key='EARNINGS'`, `status='resolved'`)

Implication:
- The historical event table driving replay does **not** look like a rich, frozen upcoming-earnings schedule for the Jul/Aug lane.
- Event-risk handling exists in live code, but historical parity cannot rely on the current `market_events` contents to reproduce the same pre-trade event awareness the old run may have used.

## 4. Golden Evidence Snapshot Payload Quality

`data/iter5-recovery/golden-julaug-evidence.json` preserves, for each trade:

- `signal_snapshot_json.avg_bias`
- `signal_snapshot_json.lineage`
- `signal_snapshot_json.tf`

For the sampled parity-sensitive trades (`FIX`, `PANW`, `GDX`, `AYI`, `IREN`):

- `rsi_divergence` is not preserved
- `td_sequential` is not preserved

All 24 trades do preserve `tf` data, but the normalized evidence pack does **not** currently carry the divergence / TD exhaustion context that we keep trying to match in replay.

Implication:
- The current normalized evidence pack is sufficient for basket/path/timestamp anchoring.
- It is **not** sufficient for exact divergence/exhaustion parity work by itself.
- Any further parity attempt that depends on divergence or TD exhaustion needs either:
  - raw archived autopsy snapshots with those fields preserved, or
  - a deterministic re-builder for those fields from the same raw candle context.

## 5. Recovery Consequence

The clean replay harness fixes the biggest contamination bug:

- `freshRun=1` disables stale archive trade rehydration
- runner scripts now refuse concurrent runs
- clean FIX probe re-entered exactly at the golden timestamp

But full Jul/Aug parity still cannot be assumed from that alone because two historical-state inputs remain under-frozen:

1. scheduled event state
2. divergence / TD exhaustion state

## 6. Recommended Next Action

Before the next full Jul/Aug validation run:

1. Extract raw autopsy snapshots for the 24 golden trades and verify whether divergence / TD fields exist there.
2. If missing, build a deterministic re-builder for divergence / TD / exhaustion from the raw candle history used at each golden entry timestamp.
3. Only then rerun the single clean Jul/Aug lane and diff against the golden evidence.
