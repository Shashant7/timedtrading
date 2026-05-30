# V15 ETF Deep Dive — Why SPY/QQQ/IWM Don't Trade

**Diagnostic run:** `etf-diag-1777154454` — 9 sample days across Aug/Oct/Mar
**Universe:** SPY, QQQ, IWM, DIA only

## TL;DR — My V14 plan was wrong about the cause

I assumed the **ETF Precision Gate** (the 10-of-10 conjunction in V12 P6) was blocking ETFs.

**The data says: ETFs never even reach that gate.** The real blockers are EARLIER in the entry pipeline:

| Reason | Rejections | % of all blocks |
|---|---|---|
| **`h3_consensus_below_min`** | **410** | **82%** |
| `tt_bias_not_aligned` | 71 | 14% |
| `h3_rank_below_transitional_floor` | 6 | 1% |
| `da_short_rank_too_low` | 6 | 1% |
| `rvol_dead_zone` | 4 | <1% |
| `phase_i_short_no_spy_downtrend` | 3 | <1% |
| `h3_long_blocked_in_downtrend` | 3 | <1% |

The ETF Precision Gate didn't get a single rejection — meaning **zero ETF bars even reached it.**

## Root cause: H3 Consensus Gate is structurally wrong for indices

The h3 consensus gate (`worker/pipeline/tt-core-entry.js:666-716`) requires **3 of 5 signals**:

1. **Trend alignment** — at least 2 of (1H, 4H, D) ST aligned
2. **Momentum alignment** — RSI 30m AND RSI 1H both same side of 50
3. **Volume confirmation** — rvol ≥ 1.2 on 30m or 1H
4. **Sector alignment** — ticker's sector OW for LONG, UW for SHORT
5. **Phase positioning** — phase 15-75%

For index ETFs, two of these are structurally broken:

- **Signal #3 (Volume)**: SPY/QQQ/IWM have steady, predictable volume profiles. Intraday rvol rarely hits 1.2 because there are no earnings catalysts, no news spikes — just flow. Indices auto-fail this signal.

- **Signal #4 (Sector)**: SPY's "sector" is "ETF" or "Index". Our `SECTOR_RATINGS` map doesn't classify index ETFs as overweight/underweight (because they ARE the market). Indices auto-fail this signal.

So before we even start, indices have **only 3 of 5 signals available** and need all 3 to pass. This is why we see 410 `h3_consensus_below_min` rejections in 9 sample days.

## Sample bar evidence

`SPY 2025-08-04 setup state`:
- `kanban_stage=setup, state=HTF_BULL_LTF_BULL, rank=58, htf=20.2, ltf=0.6`
- `bull_stack=true, pct_above_e21=0.11` ← clean bull setup, just at the EMA
- **Rejected for `h3_consensus_below_min`**

A trader looking at this bar would say "good pullback in bull regime, take it." Our system says "rank 58 too low; volume-rvol absent; no sector signal — block."

## Historical confirmation

Mined 5 prior multi-month runs (V11, V12, Phase-I) for ETF trades:

| Run | Total trades | ETF trades | W/L | PnL |
|---|---|---|---|---|
| `phase-v12b-1777000051` | 51 | 0 | — | — |
| `phase-v12-1776996993` | 42 | 0 | — | — |
| `phase-i-v11-1776897135` | 192 | 5 | 1W/3L (1 OPEN) | -1.7% |
| `phase-i-v11-1776886767` | 87 | 1 | 0W/1L | -0.5% |
| `phase-i-w1w2w3-augnov` | 61 | 1 | 0W/1L | -1.5% |

**Across the entire engineering history of this system: 7 ETF trades total, 1 winner.** The 80-90% WR ETF goal isn't a recent failure — it's a structural one we've been carrying.

## What's needed for 80-90% ETF WR

The user's goal is achievable, but it requires **a separate code path for index ETFs** with completely different scoring weights. Here's the architecture:

### V15 ETF dedicated path

```
isIndexETF = ticker in {SPY, QQQ, IWM, DIA}

if isIndexETF:
  // Skip h3 consensus (designed for stocks)
  // Skip sector alignment (N/A)
  // Skip rvol gate (N/A — indices have steady volume)
  
  // Use ETF-specific 5-signal consensus instead:
  signals = 0
  if EMA stack aligned with direction              : signals++
  if 1H + 4H supertrend aligned                    : signals++
  if RSI 1H + RSI D both same side of 50           : signals++
  if breadth_pct aligned (>55 long / <45 short)    : signals++
  if Saty ATR proximity favorable (NEW signal)     : signals++
  
  if signals >= 4 of 5 (vs the 3 of 5 for stocks):
    // Index ETFs need higher conviction by design
    proceed
  else:
    reject "etf_consensus_below_min"
```

### V15 ETF-specific signal: Saty ATR confluence

The user explicitly called out Saty ATR levels as the missing piece. For ETFs especially:

- **+1 signal** if entry is BETWEEN two ATR levels in direction of trade (clean runway)
- **0 signal** if entry is AT a level (chop zone)
- **-1 signal** (signal subtracted) if entry is INTO a level (the H-trade fade pattern)

### V15 ETF rank treatment

Per V14 baseline, we found `computeRank` is anti-predictive at the top. For ETFs specifically:

- Drop ALL rank floors (no rank>=N gates apply to indices)
- Replace with a single ETF-conviction floor: ETF-specific score >= 65 (calibrated separately)

### Result expected

Hand-counting clean SPY pullback setups in our 9-day diagnostic window:
- 2025-08-04 SPY: bull-stacked, 0.11% above E21 — clean pullback ← would trade LONG
- 2025-10-13 SPY: data shows bull regime, light pullback ← would trade LONG
- 2026-03-09 (volatile): probably SHORT setup ← need to verify
- 2026-03-16 (recovery): probably LONG ← need to verify

A reasonable target with the ETF-specific path: **8-15 ETF trades over 10 months at 70-80% WR**.

90%+ WR is aspirational and would require:
1. Even tighter conviction floor (only "perfect" setups)
2. ETF-specific exit rules (looser stops, wider targets — indices move slower)
3. Macro filter (no entries within 2h of FOMC, CPI, NFP — even tighter than stocks)

We can target 75% WR in V15 and tighten further toward 90% over subsequent iterations as we collect ETF-specific trade data.

## Updated V15 plan section (ETF path)

Replacing the V14 plan's "Replace ETF Precision Gate" item:

### NEW P0.4 — Build ETF-dedicated entry pipeline

**File:** `worker/pipeline/tt-core-entry.js`

1. Detect `isIndexETF = ticker in {SPY,QQQ,IWM,DIA}` at top of qualifier
2. If index ETF: bypass h3 consensus, bypass rvol gate, bypass sector gate, bypass legacy rank floor
3. Apply ETF-specific 5-signal consensus (4 of 5 required)
4. Apply ETF-specific Saty ATR confluence signal
5. Apply ETF-specific conviction floor (65 with restructured weights)
6. Then proceed to setup-specific evaluation (TT Pullback / TT Momentum)

The existing 10-of-10 ETF Precision Gate (`tt-core-entry.js:914-1014`) becomes the FINAL check, not the only check. Loosen its 10 filters per V14 plan but keep them as a quality safety net.

### NEW P0.5 — ETF-specific exit rules

**File:** `worker/pipeline/tt-core-exit.js`

Indices move slower than stocks:
- Wider stop: 1.5 ATR (vs 1.0 ATR for stocks)
- Wider TP1: 2.0 ATR (vs 1.5 ATR)
- Slower MFE trail: trail 60% of MFE (vs 50% for stocks)
- No fast-cut at 2h: indices need more time to develop

## Validation plan

1. Implement the ETF-dedicated path
2. Run a focused 10-month replay on SPY/QQQ/IWM/DIA only (4 tickers)
3. Validate: 8-15 trades, 70%+ WR, +PnL contribution
4. Then merge into full universe rerun

## What this changes about the V15 plan

The V15 plan in `tasks/v15-quality-over-quantity-plan-2026-04-25.md` had ETF as P0.4 — "Replace ETF Precision Gate with scored gate." That's still a valid loosening, but it's NOT the primary blocker. The real fix is **carving out a dedicated ETF entry path** because the system was never designed for index ETFs in the first place.

Updated V15 priority:

- **P0.4 (revised):** Build ETF-dedicated entry pipeline (bypass stock-centric gates)
- **P0.5 (new):** ETF-specific exit rules (wider stops, slower trails)
- **P0.6 (downgraded):** Loosen ETF Precision Gate as final quality check

This is a LARGER change than I estimated yesterday — but it's the only way to hit the 80-90% WR target on index ETFs.

## Code refs

- `worker/pipeline/tt-core-entry.js:666-716` — h3 consensus gate (the actual blocker)
- `worker/pipeline/tt-core-entry.js:914-1014` — ETF Precision Gate (downstream, never reached)
- `worker/pipeline/tt-core-entry.js:705-707` — phase positioning (also a constraint to relax for ETFs)
- `worker/pipeline/tt-core-exit.js` — ETF-specific exit rules go here
