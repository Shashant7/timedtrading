# V13 — Focus Tier Strategy

**Problem statement (user):**
> The smoke run is the epitome of what we're looking for. The key was we
> only traded certain tickers. Can we apply that approach but scaled to
> our universe? We want a system that dynamically boosts tickers and
> trade strategies as it recognizes shifts, based on data, memory,
> profiles, and market dynamics.

## The insight

The Jul–Sep smoke (24 tickers, 86.4 % WR, PF ~11) outperformed V11
(full 215 universe, 52 % WR, PF 1.58) by margins that dwarf any
individual strategy tweak. The reason isn't that the strategy was
different — it's that the **universe was curated**.

Scaling from 24 to 215 tickers introduces:

- **Sector dilution** — random names from low-conviction sectors.
- **Regime mismatch** — tickers that work in bull trending tape but
  not in chop get traded all the time.
- **Entry floor drift** — rank 92 in a pool of 24 candidates means
  something very different than rank 92 in a pool of 215.

The fix is not to go back to 24 tickers. The fix is to let the
strategy **treat our universe as a hierarchy**, not a flat list.

## Focus Tier architecture

Three tiers, dynamically populated at the start of each scoring cycle.
All 215 tickers get scored every cycle (this is cheap); only trades
get different treatment based on tier.

### Tier A — Conviction (the "smoke set")

Tickers we're publicly confident about. Dynamically sourced:

1. **TT_SELECTED hard-coded** (the 24 currently: AMGN, AMZN, AXP,
   BABA, BG, BRK-B, CLS, CRS, CRWV, CSX, DBA, ETHA, GEV, GILD, JCI,
   MRK, MTB, PH, PWR, QXO, TSLA, TT, VST, WMT)
2. **GRNY / GRNJ / GRNI top-10 holdings** (pulled weekly from the
   ETF holdings feed — Fundstrat Direct publishes these, we already
   sync for backdrop)
3. **Mark Newton "Upticks"** — his weekly top picks. Also already
   tracked in the daily brief pipeline.
4. **Our 30-day rolling top performers** — any ticker with ≥ +3 %
   cumulative PnL across ≥ 2 wins in the last 30 trading days auto-
   promotes to Tier A. Auto-expires when it falls below the threshold.

Expected Tier A size: 40–60 tickers, changes weekly.

**Treatment on entry:**
- Rank floor: 88 (vs 90 for Tier B, 94 for Tier C)
- Get the ETF Precision Gate treatment for trimming decisions if the
  ticker is an index/sector ETF
- Larger risk budget (1.25× tier B)

**Treatment on exit:**
- Winner-protect at MFE ≥ 2.5 % (vs 3.0 % for Tier B/C)
- Runner MFE trail at activation 2.5 % (vs 3.0 %)
- `phase_i_mfe_fast_cut_*` Tier 0 fires only if MAE ≥ 1.0 %

### Tier B — Standard (core large-caps + sectors)

What every trader watches but we don't have explicit conviction on:

1. **Core large-caps** — AAPL, MSFT, NVDA, META, GOOGL, AMZN, NFLX,
   ORCL, CRWD, JPM, BRK-B, XOM, COST, UNH, LLY
2. **Index ETFs** — SPY, QQQ, IWM, DIA
3. **Sector ETFs** — XLK, XLF, XLY, XLC, XLP, XLI, XLE, XLRE, XLU,
   XLV, XLB, XHB
4. **Macro/volatility** — VIXY, USO, GLD, SLV, IAU, GDX

Expected size: ~35 tickers (stable).

**Treatment:** Default V12 rules. Rank floor 90. Standard trim-75 and
MFE trail at 3 %.

### Tier C — Exploratory (the rest)

Remaining ~120 tickers from the broader universe. Scored every cycle,
but with much stricter entry gates — so the strategy only takes a
Tier C trade when it's genuinely high-probability.

**Treatment:**
- Rank floor 94
- Must have a confirming Tier A or Tier B correlation (e.g. ticker's
  sector ETF is in an aligned trend)
- Reduced risk budget (0.75× Tier B)
- No P6 ETF Precision Gate (the Precision Gate is Tier-A / Tier-B only)

## Market-dynamics adaptivity

Three signals that dynamically re-tier:

### Signal 1 — 30-day rolling performance

A Tier C ticker with 2 wins and +3 % cumulative PnL in the last 30
trading days **auto-promotes to Tier A** for the next 30 days. A
Tier A ticker that drifts to net-negative PnL over 30 days falls to
Tier B. Audit-logged.

### Signal 2 — Sector regime

When `monthly-backdrop-*.json` has a sector marked **leadership** or
**momentum**, all tickers in that sector temporarily boost one tier
(C → B or B → A). Reverses when sector rotates out. This is the
"system recognizes shifts" the user asked for.

### Signal 3 — Volatility regime

When VIX > 25 or breadth < 40 %, Tier B and C **both tighten rank
floor by +3** (stricter entry) and winner-protect activates at a
lower MFE threshold (2.0 % vs 3.0 %) — so we exit winners faster
when the tape turns. Normal calibration restores when VIX < 20 and
breadth > 50 %.

## Memory — cross-run learning

The system remembers trade outcomes **per ticker, per setup, per
regime-class**. Stored in a new D1 table `ticker_conviction_scores`:

```
ticker_conviction_scores
  ticker TEXT
  setup TEXT           -- tt_pullback, tt_momentum, etc
  regime_class TEXT    -- bull_stacked, sideways, etc
  n_trades INTEGER
  wins INTEGER
  total_pnl_pct REAL
  last_win_ts INTEGER
  last_loss_ts INTEGER
  conviction REAL      -- computed: f(wr, pnl, recency, sample_size)
  updated_at INTEGER
  PRIMARY KEY (ticker, setup, regime_class)
```

On each scored bar, we look up `conviction(ticker, setup, current_regime)`.

- **`conviction ≥ 0.7`** → rank gets +5 boost
- **`conviction ≤ 0.3`** → rank gets −5 penalty (not a hard block —
  the ticker can still trade if other signals are strong)
- **`n_trades < 3`** → no memory signal (let the fresh signal speak)

Updated every time a trade closes. Populated from V11 history on first
deploy so we start with 10 months of memory, not a cold start.

## ETF sync (Tier A source #2)

New daily job (already have `scripts/build-monthly-backdrop.js` which
reads sector leadership) — extend to **also fetch GRNY/GRNJ/GRNI top-10
holdings** and cache them in KV as `timed:tier_a:etf_holdings` with a
24-hour TTL.

Mark Newton Upticks — he publishes these Mondays. We already pull for
the daily brief. Cache as `timed:tier_a:upticks_current`.

Tier A membership is the union of:
- `TT_SELECTED` (hard-coded, manual)
- `timed:tier_a:etf_holdings`
- `timed:tier_a:upticks_current`
- `timed:tier_a:recent_winners` (30-day rolling, computed nightly)

Recalculated once/day; cached for the full trading day.

## Implementation plan

### Phase 1 — Focus Tier gates (this V13 run)

1. New DA config: tier-specific rank floors and risk multipliers
2. `tt-core-entry.js` reads `ctx.market.ticker_tier` (populated by
   `replay-candle-batches.js` from `TT_SELECTED` + runtime KV lookup)
3. Tier A gets the looser gate; Tier C gets the stricter
4. No volatility-regime auto-adjustment yet (static tier assignment
   for the first V13 run — we validate the tier concept before
   layering dynamic signals)

### Phase 2 — Memory / conviction (V14)

1. New D1 table + backfill from V11
2. Runtime lookup in entry pipeline
3. ±5 rank adjustment based on conviction

### Phase 3 — Full adaptivity (V15)

1. Sector-regime tier boost (read from monthly backdrop)
2. Volatility-regime rank-floor adjustment
3. GRNY/GRNJ/GRNI daily sync
4. Newton Upticks weekly sync

## What we ship in V13

**Just Phase 1.** Tier A gets the smoke-run treatment, Tier C gets a
stricter floor, Tier B is current behavior. No new data sources yet
(static tier membership derived from what's already on disk).

This tests the core hypothesis: **"if we curate the universe, the
strategy works."** If V13 matches or beats the smoke while still
covering the full universe, the concept works. Then we layer memory
and adaptivity in V14/V15 without guessing.

## Universe audit (do first, before V13 launch)

User approved the 12 hard-drop tickers in the previous turn
(`tasks/…` — B, ORCL, DY, AA, PATH, STX, ANET, SWK, ALLY, GE, CDNS,
VMI). Drop them from the universe file. 215 → 203. Plus we keep the
113 "never-traded" tickers in Tier C (they can re-emerge on regime
change).

## Expected outcome for V13

- Tier A tickers produce smoke-like behavior (70-85 % WR on their
  entries)
- Tier B / C bleeds filtered out by the stricter floor, so total
  PnL matches Tier A not dilutes it
- Whole universe coverage preserved → breadth / sector signals stay
  accurate

Target metrics (vs V11):

| | V11 | V13 target |
|---|---:|---:|
| WR | 52 % | 65%+ |
| PF | 1.58 | 2.5+ |
| Total PnL (10mo) | +62 % | +100%+ |
| SPY/QQQ/IWM WR | 25 % | 80%+ (ETF Precision Gate + Tier A treatment) |
| Tier A trades | N/A | 50-70 |
| Tier A WR | N/A | 75%+ |
| Tier C trades | N/A | 30-60 |
| Tier C WR | N/A | 60%+ (stricter gate = fewer but better) |
