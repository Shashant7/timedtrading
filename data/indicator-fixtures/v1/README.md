# Indicator Fixture Contract v1

This directory is reserved for immutable indicator-parity fixtures used by the
Active Trader information-hardening plan.

Do **not** place live exports here until they have been reviewed as benchmark
truth. The current implementation adds only the contract and test harness.

## Fixture purpose

Fixtures prove that worker indicators match accepted benchmark outputs before
any sequence detector, weight calibration, or broker automation can trust them.

Benchmarks:

- TradingView exports for complex/custom indicators:
  - SuperTrend
  - TD Sequential / DeMark
  - Phase / Saty oscillator
  - FVG / liquidity / ORB / PDZ structural labels where exported
- TwelveData where available for standard indicators:
  - EMA / SMA
  - RSI
  - ATR

## Session-clip policy

Every fixture must declare `session_clip`.

| TF | Required session_clip |
|---|---|
| `1`, `5`, `10`, `15`, `30` | `extended` |
| `60`, `240` | `rth` |
| `D`, `W`, `M` | `exchange` |
| ORB rows | RTH-only by definition |

This mirrors the live/replay candle-chain basis. A fixture with the wrong
session clip is invalid even if all formulas match the export.

## JSON shape

```json
{
  "fixture_version": 1,
  "source": "tradingview_export",
  "ticker": "USO",
  "tf": "D",
  "session_clip": "exchange",
  "range": {"start": "2025-01-01", "end": "2026-06-15"},
  "candles_source": "twelvedata|alpaca|tradingview",
  "candles": [
    {"ts": 1781553600000, "o": 121.21, "h": 121.48, "l": 113.31, "c": 115.47, "v": 1000000}
  ],
  "rows": [
    {
      "ts": 1781553600000,
      "expected": {
        "close": 115.47,
        "ema21": 133.03,
        "ema200": 100.74,
        "rsi14": 33.3,
        "atr14": 6.12,
        "supertrend_dir": -1,
        "td9_bull": false,
        "td9_bear": false,
        "td_bull_prep_count": 7,
        "td_bear_prep_count": 0,
        "phase_value": -65.9,
        "phase_zone": "EXTREME",
        "saty_phase_value": -81.0,
        "saty_phase_zone": "HIGH",
        "phase_leaving_accum": false,
        "phase_leaving_distribution": false,
        "pdz_zone": "discount_approach",
        "fvg_in_bull": false,
        "fvg_in_bear": false,
        "liq_nearest_ss_dist_atr": 0.3,
        "sq_on": false,
        "sq_release": false,
        "vwap": 116.2,
        "vwap_dist_pct": -0.6,
        "rvol": 1.35
      }
    }
  ]
}
```

## Harness

The shadow harness lives at:

- `worker/foundation/indicator-parity.js`
- `worker/foundation/indicator-parity.test.js`

Run:

```bash
npx vitest run worker/foundation/indicator-parity.test.js
```

The harness validates fixture shape, enforces session-clip policy, computes
the worker indicator row for each fixture timestamp, and reports numeric or
exact-field mismatches.

