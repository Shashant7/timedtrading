# Indicator Parity — TradingView Export Phase 2 (2026-06-19)

**Source CSVs:** `tradingview/Parity-BATS_{USO,GLD,XLE,NVDA,TSLA,UNH,MSTR}, {1D,1W,60}_*.csv`  
**Pine script:** `tradingview/TimedTrading_Indicator_Parity_Export.pine` (ST 10, factor 3.0)

---

## Results

| Check | Result |
|---|---|
| Parity harness (80 sampled rows × 21 files) | **21 / 21 clean** — zero mismatches |
| Accepted fixtures committed | `data/indicator-fixtures/v1/accepted/tv-phase2/` |

Combined with Phase 1 (SPY/QQQ/IWM): **30 / 30** TV export fixtures clean.

### Worker fix applied

Initial run was **19 / 21** — two isolated `fvg_in_bear` mismatches on USO D and NVDA 60.
Root cause: worker `detectFVGs()` filtered gaps smaller than 10% ATR; the Pine export script does not.
Removed the ATR size filter so worker FVG detection matches the TV benchmark. Phase 1 re-run still **9 / 9**.

---

## Reproduce locally

```bash
mkdir -p "TV Exports/indicator-parity/parity-phase2-jun19"
cp tradingview/Parity-BATS_{USO,GLD,XLE,NVDA,TSLA,UNH,MSTR}*.csv \
  "TV Exports/indicator-parity/parity-phase2-jun19/"

node scripts/build-indicator-fixtures.mjs \
  --input="TV Exports/indicator-parity/parity-phase2-jun19" \
  --out="TV Exports/indicator-parity/generated-fixtures-phase2-jun19" \
  --report="TV Exports/indicator-parity/parity-report-phase2-jun19.json" \
  --sample-rows=80 \
  --supertrend=10,3

node scripts/run-setup-parity-gate.mjs \
  --fixtures data/indicator-fixtures/v1/accepted/tv-phase2
```

---

## Promotion gate status

| Gate | Status |
|---|---|
| L1 indicator parity (Phase 1: SPY/QQQ/IWM) | **Passed** |
| L1 indicator parity (Phase 2: USO/GLD/XLE/NVDA/TSLA/UNH/MSTR) | **Passed** |
| L2 live setup_events vs re-derive | In progress (forward cron accumulating) |
| Sequence promotion to signaling | Blocked until L2 passes per ticker |
