# Phase G — Saty ATR Levels + Full-Universe Backtest

**Date**: 2026-04-20  
**Status**: Planning (waiting on Phase-F v6 to complete, ETA ~1h from now)

## User directive (2026-04-20)

> "When v6 is done, I'd like to see if we can make any refinements to
> improve the win rate and return on trade. Refinement idea: use Saty
> ATR Levels on Multiday, Swing, Position and Longterm Modes to assess
> Target levels. A +/-100 ATR Level on a Multiday (30m) should represent
> a peak for the week. This may also vary by ETF, large cap and small
> cap, etc.
>
> I also would like to start a full universe backtest across Jul to Apr
> once we have validated the refinements using targeted validation
> tests."

## Two interlocking work streams

### Stream 1: Saty ATR Levels → TP targets (primary refinement)

**Current state (good news)**: Saty ATR Levels are ALREADY computed
(`worker/indicators.js:3015 computeATRLevels`) for five horizons:

| Mode | Scoring TF | Anchor TF | Meaning |
|---|---|---|---|
| Day | 15m | Daily | prev-daily close ± Fib(0.236…3.0) × Daily ATR(14) |
| **Multiday** | **30m** | **Weekly** | **prev-weekly close ± Fib × Weekly ATR(14)** — user's primary request |
| Swing | 1H | Monthly | prev-monthly close ± Fib × Monthly ATR(14) |
| Position | 4H | Quarterly | prev-quarterly close ± synthetic quarterly ATR |
| Long-term | D/W | Yearly | prev-yearly close ± synthetic yearly ATR |

Levels emitted per horizon: `prevClose`, `atr`, `trigger_up` (±23.6 %),
`levels_up[].price`, `levels_dn[].price` at each Fib ratio, plus `disp`
(displacement in ATR multiples), `band` (`TRIGGER`, `GATE_382`, `KEY_618`,
`ATR_100`, `EXT_200`, `EXT_300`), `gate` (golden-gate tracker 0.382→0.618).

**What's missing**: ATR Levels are currently surfaced as **signals**
(used by movePhase, fuel scoring, UI) but NOT as **explicit TP targets
on open trades**. The engine uses ATR-derived TPs (`deep_audit_tp_atr_override`)
but not the Fib-level map.

**Refinement design**:

1. **Target ladder from ATR Levels** — on entry, populate `trade.tp_ladder`
   from the Multiday (Weekly-anchor) ATR Levels:
   - TP1 = +0.382 × Weekly ATR (Gate entry level) — trim first tier
   - TP2 = +0.618 × Weekly ATR (Gate completion / "Key Target") — trim second tier
   - TP3 = +1.000 × Weekly ATR (**"+100 ATR" = weekly peak the user called out**) — trim third tier (or full exit)
   - Runner = +1.618 × Weekly ATR for momentum extensions beyond weekly range
   
   Mirror ladder below anchor for SHORTs.

2. **Cohort-aware ATR ladder selection** per v5 pattern-mining evidence:
   - **Index ETFs (SPY/QQQ/IWM)**: use Multiday (Weekly) as primary anchor. +0.618 targets typically hit; +1.000 is the weekly peak — rare. So ladder weights: TP1 trim 40%, TP2 trim 40%, TP3 runner 20%.
   - **Mega-Cap Tech**: use Swing (Monthly). These names trend past Weekly +1.0 frequently. TP1 trim 30%, TP2 trim 30%, TP3 trim 20%, Runner 20%.
   - **Industrials**: use Multiday (Weekly). Similar to ETFs but with more room — TP1 30%, TP2 40%, TP3 30%.
   - **Speculative (AGQ/RIOT/etc.)**: use Swing (Monthly) or Position (Quarterly). These make multi-month moves — skip Multiday TP1 (leaves money on table), enter ladder at TP2.
   - **Sector ETFs**: same as Industrials (once XLY unpaused).

3. **ATR-based invalidation** — if price reaches +0.236 × Weekly ATR
   within the first 2 hours of entry and then retraces below the anchor
   prev-close, the entry failed its first target; tighten stop to
   breakeven.

4. **Exhaustion detection using ATR `band` / `rangeOfATR`**:
   - LONG at entry: don't take entries where Multiday `band === "EXT_200"`
     or `"EXT_300"` (already past the weekly's 2-ATR bull band — odds of
     +100 within the week are low).
   - SHORT mirror: reject when Multiday `band === "EXT_300"` below (already
     capitulated to −3 weekly ATR — the -100 target was passed).

### Stream 2: Full-universe backtest validation

**Current universe**: 24-ticker tier1-tier2 (SPY/QQQ/IWM + Mag 7 + 14 tier-2).

**Full universe**: `configs/backfill-universe-2026-04-18.txt` = 215 tickers
(SECTOR_MAP minus futures/crypto/TV-only).

**Validation approach** (not just "run full universe and see"):

1. **Targeted validation probes first** — before a 10-month full-universe
   rerun, validate Phase-G (ATR TP ladder) on KNOWN-GOOD dates:
   - Jul 1 2025 (known uptrend): expect ETF Multiday +0.618 hit on SPY,
     +1.000 on QQQ/MegaCap names
   - Mar 27 2026 (known downtrend, we already ran): expect SHORT TPs at
     −0.618 Multiday for the 6 shorts that fired there
   - Sep 15 2025 (known mixed): expect conservative ladder exits

2. **Cohort-aware validation universe** — before going to 215, run a
   **40-ticker Phase-G validation universe** that covers all cohorts:
   - Index ETFs: SPY, QQQ, IWM (3)
   - Sector ETFs: XLK, XLV, XLF, XLY, XLI, XLE, XLP, XLU (8 — unpauses XLY)
   - Mega-cap Tech: AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA (7)
   - Mag-adjacent tech: AVGO, ORCL, ADBE, CRM, NFLX, AMD (6)
   - Industrials: ETN, FIX, PH, SWK, MTZ, IESC, PWR, GEV (8)
   - Speculative: AGQ, RIOT, GRNY, SGI, PLTR, NET (6)
   - Healthcare/Finance: AMGN, GILD, JPM (3 — new cohort probe)
   
   That's **41 tickers** — big enough to shake out cohort rule edge cases
   without the noise of 215.

3. **Only after the 40-ticker v7 validates cleanly** do we launch the
   215-ticker v8 full-universe run. That's the "final answer" backtest.

## Execution plan (sequential)

### Phase-G.1: Capture + analyze v6 baseline (no code changes)
- Wait for continuous-slice-v6 to finish
- Run pattern-miner on v6 (RUN_VERSION=v6)
- Confirm SHORT contribution and v2→v6 trajectory
- Identify which cohorts MOST need ATR-based TPs (where current TP method
  leaves the most money on table based on MFE-vs-exit gap)

### Phase-G.2: ATR Level TP ladder + DA keys
Implement in `worker/index.js` trade-creation path:
- On new LONG trade: populate `trade.tp_ladder` = [TP1_382, TP2_618, TP3_1000, Runner_1618]
  from `tickerData.atr_levels.week.levels_up` (Multiday anchor)
- SHORT mirror on `levels_dn`
- New DA keys:
  - `deep_audit_atr_tp_ladder_enabled` (true)
  - `deep_audit_atr_tp_ladder_mode_{index_etf,megacap,industrial,speculative}`
    — picks anchor horizon (week / month / quarter) per cohort
  - `deep_audit_atr_tp_trim_pct_t1/t2/t3` (default 30/30/30, runner 10)
- Management-side: evaluate each TP level every bar; execute partial
  trim at each level hit, route remainder via existing runner logic.

### Phase-G.3: ATR exhaustion entry gates
- Reject entry when Multiday `band === "EXT_200"` or `"EXT_300"` LONG
- Reject when Multiday `band === "EXT_300"` SHORT (deep capitulation)
- New DA keys:
  - `deep_audit_atr_exhaustion_reject_long_bands` = `"EXT_200,EXT_300"`
  - `deep_audit_atr_exhaustion_reject_short_bands` = `"EXT_300"`

### Phase-G.4: Targeted single-day validation
Run on 3 dates (Jul 1, Sep 15, Mar 27) with new ATR ladder active.
Verify TPs hit where theoretically expected + trades land correctly.
If validation fails → tune and re-probe before going broader.

### Phase-G.5: 40-ticker Phase-G validation universe (v7)
Continuous run Jul→Apr, full 210 trading days, using
`configs/backtest-universe-phase-g-40.txt` (new file).
Target: training-month PnL >= v6 +20pp, WR >= 70 %, all 6 cohorts
positive, SHORT cohort >= 15 trades.

### Phase-G.6: Full 215-ticker universe backtest (v8)
Only launches if v7 meets all acceptance criteria.
Using `configs/backfill-universe-2026-04-18.txt`.
Expected runtime: 210 days × 215 tickers at ~30s → 100-130 min.
Checkpointed, watchdog'd, continuous-slice-v6 style.

## Acceptance criteria for Phase-G

| Gate | Metric | Target |
|---|---|---|
| ATR ladder fires | % of trades with tp_ladder populated | > 95 % |
| TP1 hit rate | % of trades that hit the 0.382 level | > 50 % |
| TP3 hit rate | % of trades that hit the 1.000 level | > 15 % for MegaCap, > 5 % for ETF |
| MFE-vs-exit gap | Before Phase-G: ~45 % of MFE captured. After: > 55 % | |
| v7 40-ticker training | Sum PnL | >= v6 training PnL + 20 % |
| v7 WR | | >= 70 % |
| v7 SHORT count | | >= 15 across Feb/Mar/Apr |
| v7 cohort signs | All 6 cohorts | Positive Sum PnL |
| v8 215-ticker full | Sum PnL | >= v7 |
| v8 stable | No stalls, no crashes, completes in < 180 min | |

## Non-goals / boundaries

- Do NOT change the Phase-F entry gates (those are validated)
- Do NOT modify the management-side exit rules except the TP ladder hookup
  (F1-F4 stop-loss logic stays)
- Do NOT add new indicators — ATR Levels are already computed
- Do NOT tune off Mar/Apr holdout data until v7 validates on training

## Open questions to answer during Phase-G.1 analysis

1. What's the typical MFE-vs-exit gap today? Probably need this metric
   to know which cohorts ATR ladder helps most.
2. For ETFs, does Multiday +1.0 actually happen weekly? Or is +0.618 the
   realistic ceiling? Need empirical distribution.
3. For Speculative, does Swing (Monthly) +1.0 happen? Or are these doubly
   extended (weekly + monthly)?
4. Do shorts behave symmetrically or do they capitulate (undershoot
   targets) faster than LONGs trend?

All answerable from v6 trades + block-chain once the rerun completes.
