# Indicator Parity Initial Run — 2026-06-17

**Status:** first pass from TradingView CSV exports  
**Scope:** Phase 1 signal truth hardening  
**Raw data location:** local gitignored export cache (`TV Exports/indicator-parity/`)  
**Committed fixtures:** none yet; raw/generated files are not benchmark truth yet.

---

## Inputs received

TradingView ZIP exports were found for all requested tickers:

```text
GLD, IWM, MSTR, NVDA, QQQ, SPY, TSLA, UNH, USO, XLE
```

Each ticker included:

```text
1D, 1W, 60
```

Total CSVs inspected: **30**.

All 30 CSVs contained the expected parity columns from
`tradingview/TimedTrading_Indicator_Parity_Export.pine`.

---

## Tooling added / used

- `scripts/build-indicator-fixtures.mjs`
- `worker/foundation/indicator-parity.js`
- `worker/foundation/indicator-parity.test.js`
- `data/indicator-fixtures/v1/README.md`

The converter writes generated fixture JSON and reports into the local
gitignored export cache by default. This avoids committing large or unreviewed
benchmark files.

Commands run:

```bash
node scripts/build-indicator-fixtures.mjs \
  --input="TV Exports/indicator-parity/extracted" \
  --out="TV Exports/indicator-parity/generated-fixtures-st10" \
  --report="TV Exports/indicator-parity/parity-report-st10.json" \
  --sample-rows=40 \
  --supertrend=10,3

node scripts/build-indicator-fixtures.mjs \
  --input="TV Exports/indicator-parity/extracted" \
  --out="TV Exports/indicator-parity/generated-fixtures-st5" \
  --report="TV Exports/indicator-parity/parity-report-st5.json" \
  --sample-rows=40 \
  --supertrend=5,3
```

---

## Initial result summary

### SuperTrend 10,3 baseline

Clean aggregate fields:

```text
close, ema21, ema200, rsi14, atr14,
supertrend_dir,
td9_bull, td9_bear, td13_bull, td13_bear,
td_bull_prep_count, td_bear_prep_count, td_tv_count, td_tv_side,
phase_value, phase_zone, saty_phase_value,
phase_leaving_accum, phase_leaving_distribution,
sq_on, sq_release, rvol,
pdz_position, pdz_zone,
fvg_in_bull,
rsi_bull_divergence, rsi_bear_divergence
```

Mismatch fields:

| Field | Count | Interpretation |
|---|---:|---|
| `liq_nearest_ss_dist_atr` | 1168 | Structural detector mismatch / definition mismatch likely. |
| `vwap` | 440 | VWAP basis mismatch likely (cumulative vs session/visible-history anchor). |
| `vwap_dist_pct` | 440 | Follows VWAP mismatch. |
| `fvg_in_bear` | 1 | Single structural edge case. |

Worst files were dominated by the same three fields:

```text
GLD 60, MSTR 60, NVDA 60, QQQ 60, SPY D, SPY 60,
TSLA 60, UNH 60, USO 60
```

### SuperTrend 5,3 comparison

The 5,3 run added:

| Field | Count |
|---|---:|
| `supertrend_dir` | 51 |

This is expected because the parity export columns appear to have been
generated from the exporter SuperTrend setting, while the separate chart
reference was noted as 5,3. The harness now supports fixture-specific
SuperTrend params, so the next pass can compare the correct reference once the
CSV-to-fixture mapping is explicit.

---

## Important interpretation

This first pass is encouraging:

- Standard numeric indicators passed at aggregate level:
  - EMA21 / EMA200
  - RSI14
  - ATR14
  - RVOL
- Exhaustion / reversal primitives passed at aggregate level:
  - TD9 / TD13 booleans
  - TD prep counts
  - phase value / zone
  - Saty phase value
  - phase leaving accumulation/distribution
  - squeeze on/release
- Worker SuperTrend matches the exporter when using the same 10,3 settings.

The remaining mismatches are not surprising formula failures. They are
definition/basis questions:

1. **VWAP:** worker and export likely use different anchoring windows.
   Decide whether parity should compare cumulative, rolling 20-bar, or
   session-anchored VWAP.
2. **Liquidity distance:** current export uses a recent high/low proxy, while
   worker liquidity uses pivot clustering. These are not the same detector.
3. **FVG:** one bearish in-gap edge mismatch should be inspected manually.
4. **SuperTrend 5,3 vs 10,3:** now parameter-aware; do not classify as formula
   mismatch.

---

## Next actions

1. Decide canonical VWAP parity target:
   - cumulative,
   - rolling 20-bar,
   - session-anchored.
2. Decide whether liquidity parity should benchmark:
   - worker pivot-cluster liquidity,
   - TradingView liquidity indicator columns,
   - or both as separate families.
3. Inspect the single FVG mismatch:
   - `USO D`, timestamp `1778765400000`, `fvg_in_bear`.
4. Convert accepted CSV fields into committed fixture JSON only after the above
   definitions are accepted.
5. If SuperTrend 5,3 is the desired production signal, run a deliberate
   change proposal; do not mix it into the current 10,3 worker parity silently.

