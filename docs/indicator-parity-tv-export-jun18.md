# Indicator Parity — TradingView Export (2026-06-18)

**Source CSVs:** `tradingview/Parity-BATS_{SPY,QQQ,IWM}, {1D,1W,60}_*.csv`  
**LuxAlgo companion:** `tradingview/Sequencer-BATS_*.csv`  
**Pine script:** `tradingview/TimedTrading_Indicator_Parity_Export.pine` (ST 10, factor 3.0)

---

## Results

| Check | Result |
|---|---|
| Parity harness (80 sampled rows × 9 files) | **9 / 9 clean** — zero mismatches |
| LuxAlgo sequencer prep + lead-up | **0 mismatches** (800 sampled rows) |
| Accepted fixtures committed | `data/indicator-fixtures/v1/accepted/tv-jun18/` |

### Fields verified (exact or numeric tolerance)

SuperTrend 10,3 · TD9/TD13 · TD prep/lead-up counts · Phase + Saty phase · Phase leaving accum/distrib · Squeeze · VWAP rolling20 · RVOL · PDZ zone · FVG in bull/bear · Liquidity proxy · RSI · EMA21/200 · ATR14 · RSI divergence flags

---

## Reproduce locally

```bash
mkdir -p "TV Exports/indicator-parity/parity-spy-iwm-qqq-jun18"
cp tradingview/Parity-BATS_*.csv "TV Exports/indicator-parity/parity-spy-iwm-qqq-jun18/"

node scripts/build-indicator-fixtures.mjs \
  --input="TV Exports/indicator-parity/parity-spy-iwm-qqq-jun18" \
  --out="TV Exports/indicator-parity/generated-fixtures-jun18" \
  --report="TV Exports/indicator-parity/parity-report-jun18.json" \
  --sample-rows=80 \
  --supertrend=10,3

node scripts/run-setup-parity-gate.mjs \
  --fixtures data/indicator-fixtures/v1/accepted/tv-jun18
```

LuxAlgo:

```bash
mkdir -p "TV Exports/indicator-parity/lux-sequencer-jun18"
cp tradingview/Sequencer-BATS_*.csv "TV Exports/indicator-parity/lux-sequencer-jun18/"
node scripts/analyze-lux-sequencer-exports.mjs \
  --input="TV Exports/indicator-parity/lux-sequencer-jun18" \
  --report="TV Exports/indicator-parity/lux-sequencer-report-jun18.json"
```

---

## Promotion gate status

| Gate | Status |
|---|---|
| L1 indicator parity (SPY/QQQ/IWM) | **Passed** on TV export |
| L2 live setup_events vs re-derive | In progress (forward cron accumulating) |
| Sequence promotion to signaling | Blocked until L2 passes per ticker |

---

## Phase 2 (complete)

USO, GLD, XLE, NVDA, TSLA, UNH, MSTR — D + W + 60 each.

**Done** — see [indicator-parity-tv-export-phase2.md](indicator-parity-tv-export-phase2.md) (21/21 clean, `tv-phase2/` fixtures).
