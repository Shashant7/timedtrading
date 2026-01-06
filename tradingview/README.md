# TradingView Indicator

This directory contains the Pine Script indicator for Timed Trading.

## File

- `TimedTrading_ScoreEngine.pine` - The main Pine Script indicator (v1.1.0)

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
2. **Condition**: Select the indicator (TimedTrading_ScoreEngine)
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

