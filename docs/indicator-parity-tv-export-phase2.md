# Indicator Parity — TradingView Export Phase 2 (2026-06-19)

**Target tickers:** USO, GLD, XLE, NVDA, TSLA, UNH, MSTR (D + W + 60 each)  
**Pine script:** `tradingview/TimedTrading_Indicator_Parity_Export.pine` (ST 10, factor 3.0)

---

## Upload status (2026-06-19)

| Source on `main` | Found |
|---|---|
| `tradingview/Parity-BATS_{USO,GLD,...}*.csv` (Phase 1 layout) | **Not on main yet** |
| `tradingview/{TICKER}.zip` (older bulk export) | Present — 21 CSVs inside |

**Expected upload naming** (matches Phase 1 SPY/QQQ/IWM):

```
tradingview/Parity-BATS_USO, 1D_<hash>.csv
tradingview/Parity-BATS_USO, 1W_<hash>.csv
tradingview/Parity-BATS_USO, 60_<hash>.csv
… repeat for GLD, XLE, NVDA, TSLA, UNH, MSTR
```

Use **TimedTrading_Indicator_Parity_Export** on the chart (not the legacy bulk export). Phase 1 files include `td_bull_leadup_count`, `vwap_rolling20`, and Lux prep columns; zip extracts often omit these.

---

## Preliminary run (zip fallback)

Processed `tradingview/*.zip` extracts via `scripts/process-tv-parity-phase2.mjs`:

| Check | Result |
|---|---|
| Files | 21 (7 tickers × 3 TFs) |
| Parity harness clean | **5 / 21** |
| Dominant mismatches | `td13_bull`, `td13_bear` (31 rows), `fvg_in_bear` (2) |

### Clean files (zip source)

| Ticker | TF |
|---|---|
| MSTR | D, W |
| TSLA | W |
| UNH | 60 |
| XLE | D |

**Do not promote** zip-sourced fixtures to accepted until full Parity-BATS re-exports pass (Phase 1 bar: **9/9 clean**).

---

## Reproduce

```bash
# After Parity-BATS CSVs land in tradingview/
node scripts/process-tv-parity-phase2.mjs

# Promote only when ok_count == file_count
node scripts/process-tv-parity-phase2.mjs --promote

node scripts/run-setup-parity-gate.mjs \
  --fixtures data/indicator-fixtures/v1/accepted/tv-phase2
```

---

## Gate impact

| Gate | Phase 1 | Phase 2 |
|---|---|---|
| L1 TV parity | SPY/QQQ/IWM **passed** | Pending proper Parity-BATS uploads |
| L2 live vs re-derive | In progress | Unchanged |
| Sequence → signaling | Blocked | Blocked until L1+L2 per ticker |
