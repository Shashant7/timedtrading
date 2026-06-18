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

node scripts/analyze-tv-reference-exports.mjs \
  --input="TV Exports/indicator-parity/extracted" \
  --report="TV Exports/indicator-parity/reference-analysis-report.json" \
  --sample-rows=40
```

---

## Initial result summary

### Updated SPY/IWM/QQQ parity-export rerun

After re-exporting SPY/IWM/QQQ with the updated
`TimedTrading_Indicator_Parity_Export.pine`, the 10,3 parity run across the
updated subset was:

```text
9 files checked (SPY/IWM/QQQ x D/W/60)
6 / 9 files clean
only mismatch fields: fvg_in_bull = 3, fvg_in_bear = 1
```

The updated export includes Lux-aligned TD lead-up columns and rolling VWAP
columns. No aggregate mismatches appeared for TD, Phase, SuperTrend 10,3,
rolling VWAP, liquidity high/low proxy, RSI, ATR, EMA, squeeze, PDZ, or RSI
divergence in this subset.

Remaining edge cases:

| Ticker | TF | Field | Timestamp |
|---|---|---|---:|
| IWM | D | `fvg_in_bull` | 1774877400000 |
| IWM | D | `fvg_in_bear` | 1776173400000 |
| QQQ | 60 | `fvg_in_bull` | 1780687800000 |
| SPY | 60 | `fvg_in_bull` | 1780687800000 |

### Direct reference-indicator checks

Additional comparisons were run against the independent TradingView indicator
columns included in the raw CSV exports.

| Reference | Checked | Result | Caveat |
|---|---:|---|---|
| LuxAlgo Sequencer preparation counts | 1,200 sampled rows | **Matched** bullish and bearish prep counts exactly | Added `tradingview/LuxAlgo-Sequencer-Export.pine` so the next export can include lead-up/countdown columns. |
| LuxAlgo Sequencer lead-up counts | 400 sampled rows from SPY/IWM/QQQ Lux companion exports | **Matched after worker alignment** | Worker TD lead-up now starts at `1` on preparation completion and persists/increments LuxAlgo-style. Re-export `TimedTrading_Indicator_Parity_Export.pine` before accepting `td13_*` fixture columns generated before this alignment. |
| MTF Phase Oscillator `Phase (Chart TF)` | 1,200 sampled rows | **Matched** `saty_phase_value` exactly | Also matched leaving-accumulation and leaving-distribution markers. |
| ATR Levels plotted bands | 1,200 sampled rows | **Internally consistent** | Confirms exported ATR bands obey their own `prev_close ± ATR * fib` math. Worker now derives 3M/12M anchor bundles from monthly candles when enough history exists; full parity still needs anchor-TF fixtures/exports. |

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
| `fvg_in_bear` | 1 | Single structural edge case. |

After switching liquidity parity to the requested high/low proxy and making
rolling VWAP the future canonical export target, the 10,3 run is:

```text
29 / 30 files clean
only mismatch field: fvg_in_bear = 1
```

VWAP is skipped for current exports because they do not yet include
`vwap_rolling20` / `vwap_rolling20_dist_pct`. Re-export with the updated
`TimedTrading_Indicator_Parity_Export.pine` when VWAP parity is ready to be
accepted.

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
  - TD9 booleans
  - TD prep counts
  - LuxAlgo lead-up after worker alignment (companion export)
  - phase value / zone
  - Saty phase value
  - phase leaving accumulation/distribution
  - squeeze on/release
- Worker SuperTrend matches the exporter when using the same 10,3 settings.

The remaining gaps are now narrow and explicit:

1. **FVG:** one bearish in-gap edge mismatch should be inspected manually:
   `USO D`, timestamp `1778765400000`, `fvg_in_bear`.
2. **LuxAlgo lead-up:** fixed. Prep and lead-up now match the Lux companion
   export on the sampled SPY/IWM/QQQ rows. The original parity CSV `td13_*`
   columns predate this alignment and should be re-exported before acceptance.
3. **ATR Levels:** exported bands are internally consistent. Worker anchor
   mapping now follows Saty rules, including derived 3M/12M anchor bundles from
   monthly candles when enough history exists. Full worker-vs-reference parity
   still needs anchor-TF fixtures/exports.
4. **SuperTrend 5,3 vs 10,3:** now parameter-aware; do not classify as formula
   mismatch.

---

## Next actions

1. Re-export with `TimedTrading_Indicator_Parity_Export.pine` to include
   rolling VWAP columns and Lux-aligned TD lead-up / TD13 columns.
2. Inspect the single FVG mismatch:
   - `USO D`, timestamp `1778765400000`, `fvg_in_bear`.
3. Add ATR anchor exports / anchor TF fixtures for Saty ATR level parity,
   especially Monthly/Quarterly/Yearly anchors.
4. Convert accepted CSV fields into committed fixture JSON only after the above
   definitions are accepted.
5. If SuperTrend 5,3 is the desired production signal, run a deliberate
   change proposal; do not mix it into the current 10,3 worker parity silently.

