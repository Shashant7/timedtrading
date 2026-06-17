# TradingView Indicator

This directory contains the Pine Script indicator for Timed Trading.

## Files

- `TimedTrading_Unified.pine` - **Primary** indicator (ScoreEngine + Heartbeat, 5-min unified)
- `TimedTrading_Levels_Overlay.pine` - **Chart overlay** — TT universe, bias, stop, targets, S/R lines + table
- `TimedTrading_Indicator_Parity_Export.pine` - **Benchmark exporter** for indicator parity fixtures (TradingView chart-data export)
- `LuxAlgo-Sequencer-Export.pine` - **Numeric export companion** for LuxAlgo Sequencer prep/lead-up parity
- `TimedTrading_ScoreEngine.pine` - Original ScoreEngine (v1.1.0)
- `TimedTrading_Heartbeat_Minimal.pine` - Lightweight 1m heartbeat (price + daily change only; KV, 2-day TTL; no D1)

## Indicator parity export (Phase 1 hardening)

Use `TimedTrading_Indicator_Parity_Export.pine` to create TradingView benchmark
CSV exports for `data/indicator-fixtures/v1/`.

### First fixture batch

Run the exporter for:

- Tickers: `SPY`, `QQQ`, `IWM`, `USO`, `XLE`, `NVDA`, `TSLA`, `UNH`, `MSTR`, `GLD`
- Timeframes: `D`, `W`, `60`

### Session settings

Match the fixture policy exactly:

- `D`, `W`, `M`: exchange-session bars.
- `60`, `240`: RTH bars.
- `5`, `10`, `15`, `30`: extended-hours bars for equities.
- ORB columns are meaningful only on intraday RTH charts.

### Export steps

1. Open a TradingView chart for one ticker/timeframe.
2. Add `TimedTrading_Indicator_Parity_Export.pine`.
3. Ensure the chart session matches the policy above.
4. Menu → **Export chart data**.
5. Save as `<TICKER>_<TF>_<START>_<END>.csv`, for example:
   `USO_D_2025-01-01_2026-06-15.csv`.
6. Send the CSV export back for conversion into the fixture JSON contract.

The script plots benchmark columns for EMA/RSI/ATR/SuperTrend/TD/Phase/Saty,
PDZ, FVG, liquidity, ORB, VWAP, RVOL, squeeze, and RSI divergence.

### SuperTrend parameter note

The worker's current default SuperTrend is `10,3` (ATR length 10, factor 3.0).
If the TradingView reference indicator is set to `5,3`, either:

1. Set this exporter's **SuperTrend ATR length** input to `5` before exporting,
   or
2. Leave the exporter at `10` and send the separate `5,3` reference columns;
   the fixture conversion will mark them with
   `indicator_params.supertrend = {"atr_len":5,"factor":3.0}`.

Do not compare a `5,3` reference to the worker's `10,3` output without marking
the parameters; that is a parameter mismatch, not a formula mismatch.

Code legends used by the CSV:

- `phase_zone_code` / `saty_phase_zone_code`: `0=LOW`, `1=MEDIUM`,
  `2=HIGH`, `3=EXTREME`
- `pdz_zone_code`: `0=discount`, `1=discount_approach`, `2=equilibrium`,
  `3=premium_approach`, `4=premium`
- `td_tv_side_code`: `-1=bear`, `0=none`, `1=bull`
- `supertrend_dir`: `-1=bullish support`, `+1=bearish resistance`
- `orb_15m_direction`: `-1=breakdown`, `0=none`, `1=breakout`

The conversion/fixture harness lives at:

- `worker/foundation/indicator-parity.js`
- `worker/foundation/indicator-parity.test.js`
- `data/indicator-fixtures/v1/README.md`

### LuxAlgo Sequencer lead-up export

`LuxAlgo-Sequencer.pine` draws preparation/lead-up counts as labels, so those
values do not reliably appear as numeric CSV columns. Use
`LuxAlgo-Sequencer-Export.pine` when direct lead-up parity is needed.

It plots:

- `lux_bull_prep_count`
- `lux_bear_prep_count`
- `lux_bull_prep_complete`
- `lux_bear_prep_complete`
- `lux_bull_leadup_count`
- `lux_bear_leadup_count`
- `lux_bull_leadup_complete`
- `lux_bear_leadup_complete`
- `lux_bull_leadup_delete`
- `lux_bear_leadup_delete`

Use the same ticker/timeframe export workflow as the indicator parity exporter.

### Saty ATR Levels anchor rules

Per Saty's tutorial, ATR level anchors by chart timeframe:

| Chart timeframe | ATR anchor |
|---|---|
| below 30m | previous Daily close |
| 30m | previous Weekly close |
| 60m | previous Monthly close |
| 4H | previous Quarterly close |
| Daily | previous Yearly close |
| Weekly | Yearly can be used, but ATR Levels are less applicable |

Fixture parity for ATR Levels must include the anchor timeframe data or the
exported ATR level columns from `ATRLevels+More.pine`; otherwise we can only
verify internal band consistency, not worker-vs-reference parity.

## TimedTrading Levels Overlay (chart lines + bias table)

Pine Script **cannot call HTTP APIs**. Three modes:

1. **GitHub Seed (auto)** — `request.seed("seed_timedtrading_levels", syminfo.ticker, …)` after syncing worker data into a [Pine Seeds](https://github.com/tradingview-pine-seeds/docs) fork.
2. **TT Sync** — paste the `compact` string from `GET /timed/tv-levels?ticker=SYM`.
3. **Local** — on-chart ATR/pivot math.

> **Note:** TradingView paused provisioning of *new* Pine Seed repos. Use an existing TV fork, or TT Sync paste until a seed repo is enabled.

### GitHub Seed setup

```bash
TIMED_TRADING_API_KEY=... node scripts/sync-tv-levels-seed.mjs
```

Push `seed-timedtrading-levels/` to your Pine Seeds fork (`seed_timedtrading_levels`), run **Check data**, then set indicator Mode → **GitHub Seed (auto)**.

See `seed-timedtrading-levels/README.md` for OHLCV field mapping.

### TT Sync setup (no seed repo)

1. Add `TimedTrading_Levels_Overlay.pine` to the chart (overlay on price).
2. Fetch levels for the current symbol:
   ```
   https://timed-trading-ingest.shashant.workers.dev/timed/tv-levels?ticker=AAPL
   ```
3. Copy the `compact` field from the JSON response.
4. Indicator settings → **TT Sync string (compact)** → paste → Save.

The table shows **TT Universe** (yes/no), **Direction**, **Bias**, **Stage**, **Rank**, **Stop**, and **Targets**. Lines draw STOP (solid red), TRIM/EXIT/RUNNER targets (dashed), and up to 8 S/R levels from the worker.

Refresh the sync string when the setup changes (new scan, stage move, or after the nightly rescore).

---

## Overview

The indicator:
- Scores tickers against signals across LTF (Low Time Frame) and HTF (High Time Frame)
- Calculates HTF and LTF scores using weighted multi-timeframe analysis
- Determines state (Q1, Q2, Q3, Q4)
- Tracks completion, phase, RR (Risk/Reward), and other metrics
- Fires alerts that trigger webhooks to the CloudFlare Worker

## Timeframes

**HTF (High Time Frame)**:
- Weekly (W) - weight: 0.50 (default)
- Daily (D) - weight: 0.35 (default)
- 4H (240) - weight: 0.15 (default)

**LTF (Low Time Frame)**:
- 30m (30) - weight: 0.60 (default)
- 10m (10) - weight: 0.30 (default)
- 3m (3) - weight: 0.10 (default)

## States

- **Q1 (HTF_BULL_LTF_PULLBACK)**: HTF bullish, LTF pullback
- **Q2 (HTF_BULL_LTF_BULL)**: HTF bullish, LTF bullish (aligned long)
- **Q3 (HTF_BEAR_LTF_BEAR)**: HTF bearish, LTF bearish (aligned short)
- **Q4 (HTF_BEAR_LTF_PULLBACK)**: HTF bearish, LTF pullback

## Features

- **SuperTrend**: Phoenix default (ATR length: 10, Factor: 3.0)
- **EMAs**: Fast (5) and Slow (48) for crossovers
- **TTM Squeeze**: Detects squeeze conditions on 30m timeframe
- **Golden Gate**: Optional daily anchor cross detection
- **Phase Detection**: Phoenix-style phase oscillator
- **Completion Tracking**: Based on weekly expected move (ATRw × multiplier)

## Alert Configuration

### Step 1: Add Indicator to Chart
1. Open TradingView
2. Go to Pine Editor
3. Copy the contents of `TimedTrading_ScoreEngine.pine`
4. Click "Save" and "Add to Chart"

### Step 2: Create Alert
1. Right-click on the chart → "Add Alert"
2. **Condition**: Select the indicator (TimedTrading_Unified or TimedTrading_ScoreEngine)
3. **Alert Frequency**: "Once Per Bar Close"
4. **Webhook URL**: `https://timed-trading-ingest.shashant.workers.dev/timed/ingest?key=YOUR_API_KEY`
5. **⚠️ IMPORTANT for Extended Hours**: 
   - To capture pre-market (4am-9am ET) and after-hours (4pm-8pm ET) data for equities:
     - Enable "Extended Hours" in your chart settings (right-click chart → "Settings" → "Symbol" → check "Extended Hours")
     - In the alert settings, ensure "Extended Hours" is enabled (if available in alert configuration)
   - The indicator has an "Enable Extended Hours Alerts" option (enabled by default) - make sure this is checked
   - Note: Futures (ES, NQ) and Crypto (BTC, ETH) trade 24/7 and will always fire alerts
   - Replace `YOUR_API_KEY` with your actual API key from CloudFlare Worker secrets

### Step 3: Alert Message
The indicator automatically builds the JSON payload. In the alert message field, use:

```
{{message}}
```

Or if you need to customize, the JSON structure is:
```json
{
  "ts": <timestamp>,
  "ticker": "<symbol>",
  "tf_hint": "<timeframe>",
  "htf_score": <number>,
  "ltf_score": <number>,
  "completion": <0-1>,
  "phase_pct": <0-1>,
  "state": "HTF_BULL_LTF_PULLBACK|HTF_BULL_LTF_BULL|HTF_BEAR_LTF_BEAR|HTF_BEAR_LTF_PULLBACK",
  "price": <number>,
  "trigger_ts": <timestamp|null>,
  "trigger_price": <number|null>,
  "trigger_reason": "SQUEEZE_RELEASE|EMA_CROSS|OTHER",
  "trigger_dir": "BULL|BEAR",
  "sl": <number|null>,
  "tp": <number|null>,
  "eta_days": <number|null>,
  "rr": <number|null>,
  "flags": {
    "sq30_on": <boolean>,
    "sq30_release": <boolean>,
    "phase_dot": <boolean>
  },
  "reasons": ["<reason1>", "<reason2>", "<reason3>", "<reason4>"]
}
```

### Step 4: Watchlist Alert
1. Create a watchlist with your desired tickers
2. For each ticker, add the indicator to the chart
3. Create an alert on the watchlist (TradingView will apply to all tickers)

### Heartbeat Minimal (Price + Daily Change Only)
For a lightweight stream to keep the dashboard from going stale:
1. Add `TimedTrading_Heartbeat_Minimal.pine` on a **1-minute chart**
2. Create a watchlist alert with **Once Per Bar Close**
3. Webhook: `https://timed-trading-ingest.shashant.workers.dev/timed/heartbeat?key=YOUR_API_KEY`
4. Data is stored in KV with **2-day TTL**; no D1 writes. Merged into `/timed/all` and `/timed/latest` for freshness.

**⚠️ IMPORTANT: Extended Hours Limitation**
- TradingView Watchlist Alerts have a known limitation: **Equity alerts may not fire during extended hours (pre-market 4am-9am ET, after-hours 4pm-8pm ET)**, even if bars are forming and the script is configured correctly.
- **24-hour markets (futures like ES/NQ, crypto like BTC/ETH) will continue to fire alerts** during extended hours.
- **Workaround Options:**
  1. **Individual Chart Alerts**: Create alerts on individual equity charts instead of using watchlist alerts (more setup but more reliable)
  2. **Use Futures/Crypto**: For after-hours trading signals, consider using futures (ES, NQ) or crypto (BTC, ETH) which trade 24/7
  3. **RTH Focus**: Configure alerts to focus on Regular Trading Hours (9am-4pm ET) when all markets are active
- This is a TradingView platform limitation, not a script issue. The script's `enableExtendedHours` and `bypassSessionCheck` options work correctly, but TradingView's alert system may still restrict equity alerts during extended hours.

## Alert Throttling

The indicator includes built-in throttling:
- **Score Delta**: Minimum change in score to resend (default: 3.0)
- **Min Minutes Between Sends**: Throttle interval (default: 5 minutes)
- **Force Baseline**: Option to send every bar (for testing)

Alerts are sent when:
- First baseline (always sent)
- State changes
- Score moves by threshold
- 30m squeeze release occurs

## Debug Mode

Enable `debugHeartbeat` to verify alerts are firing. This sends a heartbeat alert every bar close.

## Notes

- The indicator uses `alert.freq_once_per_bar_close` to prevent duplicate alerts
- JSON is automatically formatted by the indicator
- Webhook must include the `key` query parameter matching your `TIMED_API_KEY` secret
- The indicator calculates all fields automatically - no manual input needed in alert message

