# V14 Forensic Pattern: Zero SPY/QQQ/IWM/DIA trades over 10 months

**Run:** `v14-fullrun-julapr-1777074817` (Jul 2025 → Apr 2026)
**Surfaced by:** User observation 2026-04-25

## Observation

Over 225+ trades across the full V14 run on the 203-ticker universe, we have **zero trades** on the four major index ETFs that ANY swing trader following our system would expect to be active in:

- SPY: 0 trades
- QQQ: 0 trades
- IWM: 0 trades
- DIA: 0 trades

The only ETFs that traded were a few commodity / metals ETFs:
- GLD: 3 trades
- SLV: 1 trade
- GDX: 1 trade

This is a hole. SPY moved several percent in clean trends multiple times during the window (rally Q4, Feb pullback, March rally) and we participated in none of them via the index proxies.

## Root cause: ETF Precision Gate (V12 P6) is too restrictive

`worker/pipeline/tt-core-entry.js:914-1014` enforces a **10-filter conjunction** for SPY/QQQ/IWM/DIA. Every single filter must pass:

| F# | Filter | Requirement | Where it fails for indices |
|---|---|---|---|
| F1 | Daily EMA stack aligned with direction | E21>E48>E200 (long) or reverse (short) | OK during trends, fails in transitions |
| F2 | Pullback depth | Within 1.5% of daily EMA21 | **Indices rarely pull back this shallowly — usually overshoots or stays >2%** |
| F3 | Daily RSI | 40-65 | **Trends drive RSI to 65-75 routinely; the 65 ceiling kills uptrend entries** |
| F4 | 1H structure aligned | Above/below c34_50 cloud | OK most of the time |
| F5 | 30m above ATR Saty-0 | Soft (skipped if missing) | Often missing |
| F6 | Weekly not overextended | Within 2 weekly ATRs of weekly EMA21 | Indices regularly trade > 2 weekly ATRs above EMA21 in trends |
| F7 | VIX < 25 | Hard cap | OK most days |
| F8 | Breadth aligned | breadth_pct > 50 (long) | Often missing data → no fail, but gates other things |
| F9 | No macro event in 48h | Hard | **48h is huge — kills most of the trading week around CPI/FOMC/NFP** |
| F10 | Conviction ≥ 70 | Hard | ETFs score lower on `relative_strength` signal vs SPY (it IS SPY) |

The combination of F2 (1.5% pullback ceiling) + F3 (RSI 40-65 band) + F9 (48h macro proximity) + F10 (conviction ≥ 70) is **practically a "never trade ETFs" rule** when applied conjunctively.

## Why this matters

The user's stated goal: **"Have generally an open trade with SPY or QQQ every couple of days."** ETF trades are core to the system's marketing and identity. Zero ETF trades over 10 months means we built a system that doesn't deliver the headline use case.

## Forensic plan post-V14

### Step 1 — measure the gate's true impact

Re-run the V14 backtest in **dry-mode** (no actual trades, just gate evaluation) for SPY/QQQ/IWM/DIA. For every bar where the legacy `qualifiesForEnter` would have approved (rank >= 90, etc), record:
- Did F1 fail? F2? ... F10?
- What was the `__focus_conviction_score` at that bar?
- What was the actual SPY price 1d / 5d / 10d later?

This gives us a candidate set of "missed" ETF trades.

### Step 2 — bucket by retroactive outcome

For each candidate bar (where would-have-traded), classify the next-5-day move:
- **Big win** (≥ +1.5% in direction)
- **Win** (+0.5% to +1.5%)
- **Flat** (-0.5% to +0.5%)
- **Loss** (-0.5% to -1.5%)
- **Big loss** (≤ -1.5%)

For each filter (F1-F10), measure: when this filter alone fails, what's the next-5d outcome distribution?

### Step 3 — derive the truly-predictive filters

The filters that consistently sit on the LOSS side of the bar split are real. The ones that don't differentiate are noise and should be loosened or dropped.

I expect:
- **F1 (EMA stack)** is real — entering a counter-trend ETF rarely works
- **F4 (1H aligned)** is real — direction confirmation matters
- **F7 (VIX < 25)** is real — high VIX regimes are choppy, ETF entries fail
- **F2 (pullback ≤ 1.5%)** is too tight — indices commonly bounce from 2-3% pullbacks (loosen to 4%)
- **F3 (RSI 40-65)** is too narrow — clean uptrends run RSI 60-75 (extend to 35-72)
- **F6 (weekly within 2 ATR)** is too tight — strong trends carry beyond 2 weekly ATRs (extend to 3 ATRs)
- **F9 (macro 48h)** is way too long — block 4h before, 12h after major events; not 48h
- **F10 (conviction ≥ 70)** is fine but lower for ETFs (conviction floor 65 since they're inherently lower-conviction by signal design)

### Step 4 — relaxed V15 ETF gate

Replace the 10-filter conjunction with a **scored gate**:

```
etf_score = (
   2.0 * F1_passed    # EMA stack — high weight
 + 1.5 * F4_passed    # 1H aligned — high weight
 + 1.5 * F7_passed    # VIX OK — important
 + 1.0 * F2_relaxed   # pullback ≤ 4%
 + 1.0 * F3_relaxed   # RSI 35-72
 + 0.5 * F6_relaxed   # weekly ≤ 3 ATR
 + 0.5 * F8_passed    # breadth aligned
 + 1.0 * F9_relaxed   # macro 12h post-event, 4h pre-event
 + 0.5 * F10_etf      # conviction ≥ 65
)
# require etf_score >= 6.0 out of 9.5 max
```

Anything else gets soft-rejected with a ranked reason string.

### Step 5 — validate before going wide

Run a Jul-Sep 2025 ETF-only smoke (4 tickers × 90 days). Target:
- ≥ 8 SPY/QQQ/IWM trades over the 3 months
- WR ≥ 65% (ETFs trend cleanly when filters are right)
- No catastrophic losers (< -2% per trade)

If that passes, push to full 10-month rerun.

## Other tickers to reconsider

The smoke set the user reminisced about (FIX, AVGO, NVDA, BABA, etc.) is well-represented in this run. The MISSING ETFs and the LIGHT trade count on big sector ETFs (XLE, XLF, XLK, XLI, XLV all have 0 trades) suggest a broader "ETF gate is too tight" pattern. The Sector ETFs aren't precision-gated though — they should be tradable via the regular path. Need to investigate why they didn't trade either.

```
Sector ETFs that traded 0 times: XLE, XLF, XLK, XLI, XLV, XLP, XLY, XLU, XLB, XLC, XLRE, XHB, USO, SOXL, TNA, TLN
```

That's a separate audit — the universe filtering or sector regime gate likely deems them too "neutral" to ever break out.

## Success criteria

After V15 ETF gate fix:
- SPY: 5-15 trades over 10 months
- QQQ: 5-15 trades over 10 months
- IWM: 3-10 trades over 10 months (smaller cap, less liquid)
- DIA: 2-5 trades over 10 months (slowest mover)
- Combined WR on ETFs: ≥ 70% (these should be high-quality cherry-picked entries)
- Sector ETFs: at least one per major sector quarter (so XLF should trade in a financials-strong quarter, etc.)

## Code refs

- `worker/pipeline/tt-core-entry.js:914-1014` — the 10-filter ETF Precision Gate
- `scripts/v12-activate-killer-strategy.sh:51-64` — DA keys for the gate (currently set to enable + tight thresholds)

## Status

**Captured for post-V14 audit.** Will run after the H-trade Saty-ATR audit since this also relates to ATR-level awareness.
