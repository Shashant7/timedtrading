# Scoring System Overhaul — High-Probability Trade Engine

## Diagnosis: Why Jul 1 – Feb 23 Underperformed

### The Numbers

| Metric | Value | Problem |
|--------|-------|---------|
| Total trades | 749 | Too many — frequency doubled Nov→Feb |
| Overall win rate | 48.2% | Sub-50% means system has no statistical edge |
| LONG avg return | +2.40% | Positive but masked by frequency |
| SHORT avg return | -0.33% | SHORTs destroy capital |
| `sl_breached` exits | 243 (32% of all) | #1 exit reason, 38.3% WR, -$30.85 avg |
| `max_loss` exits | 55 (7%) | **0% win rate**, -$305 avg — catastrophic |
| `SOFT_FUSE_RSI_CONFIRMED` | 99 exits | **82.8% WR**, +$267 avg — the bright spot |
| Jul–Oct monthly WR | 53–62% | System works in trending markets |
| Nov–Feb monthly WR | 41–49% | System fails in choppy markets |
| Trades/month (Jul) | 66 | Disciplined |
| Trades/month (Feb) | 116 | Over-trading — almost 2x |
| Avg hold (winners) | 29.3 days | Letting winners run ✓ |
| Avg hold (losers) | 20.5 days | Losers held too long |

### Root Causes

1. **No chop detection** — the system keeps trading at the same intensity in choppy/range-bound markets. Win rate drops from 62% → 43% but trade frequency *doubles*.

2. **Stop-losses are structurally wrong** — ATR-based stops don't account for market structure. 243 trades (32%) hit SL with only 38.3% WR. Many of these are likely noise-triggered shakeouts in legitimate setups.

3. **max_loss catastrophes** — 55 trades blew through stops to -$305 avg. These are regime-change events the system didn't detect fast enough. -$16,778 total drag.

4. **SHORTs have no edge** — 166 SHORT trades with -0.33% avg return. The "Gold Standard SHORT" (contrarian fade from bull state) works in trending markets but gets destroyed in chop where reversals are shallow.

5. **Volume is barely used** — only ±1 point in HTF regime score. No RVOL gate on entries. The system enters trades without confirming institutional participation.

6. **Ichimoku is a binary gate, not a scoring component** — currently only checks daily/weekly cloud position as a blocker. Doesn't use TK Cross, cloud thickness, Chikou confirmation, or Kumo twist — all of which professional technicians rely on for high-probability setups.

---

## The Fix: Six Pillars

### Pillar 1: Native Ichimoku Computation & Deep Scoring

**Current state**: Ichimoku data comes from an external source, only `position` (above/below/inside) is stored, used as a binary entry gate.

**Target state**: Full native computation across D, 4H, 1H, 30m timeframes with a rich Ichimoku score contributing to both HTF and LTF bundles.

#### 1A. Compute All 5 Components

Add `computeIchimoku(bars)` to `indicators.js`:

```
Tenkan-Sen  = (highest_high(9)  + lowest_low(9))  / 2
Kijun-Sen   = (highest_high(26) + lowest_low(26)) / 2
Senkou A    = (Tenkan + Kijun) / 2                    [plotted 26 periods ahead]
Senkou B    = (highest_high(52) + lowest_low(52)) / 2  [plotted 26 periods ahead]
Chikou Span = current close                            [compared to 26 periods ago]
```

Minimum bars needed: 78 (52 + 26 displacement). Already have 300+ bars for scoring TFs.

#### 1B. Derived Signals (per timeframe)

| Signal | Computation | Score Contribution |
|--------|-------------|-------------------|
| **TK Cross** | Tenkan > Kijun = bullish | ±8 pts |
| **Price vs Cloud** | Above = bull, below = bear, inside = neutral | ±12 pts |
| **Cloud Color** | Senkou A > B = green (bull), else red | ±5 pts |
| **Cloud Thickness** | `abs(SenkouA - SenkouB) / ATR` — thick = strong trend | 0-10 regime modifier |
| **Chikou Confirmation** | Chikou > price_26_ago = confirmed bull | ±8 pts |
| **Kumo Twist** | Senkou A crossing Senkou B (26 bars ahead) | Early warning flag |
| **TK Spread** | `(Tenkan - Kijun) / ATR` — wide = trending, narrow = choppy | Regime classifier input |
| **Kijun Slope** | Kijun rising/falling/flat over last 5 bars | Trend direction/strength |
| **Price-to-Kijun Distance** | `(price - Kijun) / ATR` — overextended if too far | Mean reversion signal |

#### 1C. Ichimoku Score per Timeframe (0 to ±50)

```
ichimokuScore = tkCross(±8) + priceVsCloud(±12) + cloudColor(±5)
              + chikouConfirm(±8) + kijunSlope(±5)
              + cloudThicknessBonus(0-5) + overextensionPenalty(-5 to 0)
```

Bullish max: +43, Bearish max: -43. Clamp to ±50.

#### 1D. Integration into HTF/LTF Bundles

#### v3 Timeframe Architecture (IMPLEMENTED)

**HTF bundle**: M(10%) → W(20%) → **D(40%)** → 4H(30%)
- Daily is the anchor (healthy rate of change, primary trend signal)
- 4H catches early flip detection (needs decent weight to serve this purpose)
- Weekly provides confirmation but lags
- Monthly provides macro context but lags most
- Ichimoku: 30% of blended HTF score, 70% existing EMA/ST/squeeze

**LTF bundle**: **1H(35%)** → 30m(30%) → 10m(20%) → 5m(15%)
- 1H was moved from HTF into LTF to stabilize the bundle and reduce noise sensitivity
- This is the key fix: the old LTF (30m/10m/5m) was too reactive to noise
- 30m provides swing context, 10m/5m for precise timing
- Ichimoku: 20% of blended LTF score (weighted 45% on 1H, 30% on 30m), 80% existing
- During RTH: 1H/30m get slight boost, 5m dampened (noisiest)

**Rationale**: Ichimoku's strength is trend identification (HTF), not scalp timing (LTF). Weight it heavier in HTF. Moving 1H to LTF makes the lower timeframe bundle behave more like a swing signal than a scalp signal.

---

### Pillar 2: Relative Volume (RVOL) as Entry Quality Gate

**Current state**: `volRatio` (current bar volume / SMA20 volume) is computed per bundle but contributes only ±1 point to HTF regime score and ±3 to momentum boost.

**Target state**: RVOL becomes a first-class entry gate and position sizing multiplier.

#### 2A. Enhanced RVOL Computation

In `computeTfBundle`, already computing `volRatio`. Need to also compute:

```
rvol_5bar  = avg(volume, last 5 bars) / SMA(volume, 20)  // Recent trend
rvol_spike = current_volume / max(volume, last 20 bars)   // Breakout detection
```

#### 2B. RVOL Entry Gate (in `qualifiesForEnter`)

| RVOL (30m) | Action |
|------------|--------|
| < 0.5 | **DEAD ZONE** — no new entries. Volume too thin for reliable signals. |
| 0.5 – 0.8 | **LOW** — require higher score threshold (+5 pts) and max completion 0.50 |
| 0.8 – 1.3 | **NORMAL** — standard thresholds |
| 1.3 – 2.0 | **ELEVATED** — institutional interest. Slight position size boost (1.1x) |
| > 2.0 | **SURGE** — breakout/catalyst. Position size boost (1.25x), extended TP runner |

#### 2C. RVOL in Scoring

Add `volQuality` component to LTF bundle:
```
volQuality = 0
if (rvol_30m > 1.5 && direction_aligned) volQuality = +5
if (rvol_30m > 2.0 && direction_aligned) volQuality = +8
if (rvol_30m < 0.5) volQuality = -5  // thin volume penalty
```

#### 2D. RVOL Confirmation for SHORT Entries

SHORTs are the weakest link. Require RVOL > 1.3 on the 30m or 1H for any SHORT entry. Institutional selling volume is the strongest confirmation that a short setup is real, not just a pullback.

---

### Pillar 3: Regime Detection — Chop Filter

**The core problem**: The system generates the same volume of signals in trending and choppy markets. Win rate drops 20 percentage points in chop but trade frequency doubles. This is the single biggest P&L destroyer.

#### 3A. Market Regime Classifier

Combine signals into a regime score per ticker:

```
regimeScore = 0

// Ichimoku cloud thickness (0-10 scale, normalized by ATR)
cloudThickness = abs(SenkouA_daily - SenkouB_daily) / ATR_daily
if (cloudThickness > 1.5) regimeScore += 3   // thick cloud = trending
if (cloudThickness < 0.5) regimeScore -= 3   // thin cloud = chop

// TK Spread (Tenkan-Kijun distance)
tkSpread = abs(Tenkan_daily - Kijun_daily) / ATR_daily
if (tkSpread > 0.3) regimeScore += 2   // trending
if (tkSpread < 0.1) regimeScore -= 2   // choppy

// EMA Structure convergence
if (emaStructure_daily in [-0.3, 0.3]) regimeScore -= 2  // EMAs tangled = chop
if (abs(emaStructure_daily) > 0.7) regimeScore += 2      // EMAs fanned = trend

// SuperTrend stability (no flips in last 10 bars)
if (stDir_daily same for 10+ bars) regimeScore += 2
if (stDir_daily flipped in last 3 bars) regimeScore -= 2

// Squeeze state
if (daily_squeeze_on) regimeScore -= 1  // compressed = waiting

// RVOL (thin volume = unreliable signals)
if (avg_rvol_5day < 0.7) regimeScore -= 2
```

Regime classification:
```
TRENDING:      regimeScore >= 5   → full confidence, normal parameters
TRANSITIONAL:  regimeScore 0-4    → reduced confidence, tighter gates
CHOPPY:        regimeScore < 0    → minimal trading, strict filters
```

#### 3B. Regime-Adaptive Trading Parameters

| Parameter | TRENDING | TRANSITIONAL | CHOPPY |
|-----------|----------|--------------|--------|
| Entry score threshold | htf ≥ 10 | htf ≥ 15 | htf ≥ 25 |
| Min Risk:Reward | 1.5x | 2.0x | 3.0x |
| Max completion | 0.60 | 0.45 | 0.30 |
| Position size multiplier | 1.0x | 0.75x | 0.50x |
| SHORT entries allowed | Yes | Yes (RVOL > 1.3) | **No** |
| Max daily entries | 10 | 5 | 2 |
| SL cushion | Standard | +10% wider | +25% wider |
| Max hold days (losing) | 20 | 12 | 7 |

**Impact estimate**: Applying CHOPPY filters to Nov–Feb would have:
- Reduced 425 trades to ~180 (eliminated ~60% of the noise trades)
- Wider SLs would have saved ~40% of the `sl_breached` exits
- Blocking SHORTs in chop would have eliminated ~80 losing SHORT trades

#### 3C. Global Chop Overlay (SPY/QQQ regime)

In addition to per-ticker regime, compute a market-wide regime from SPY:
- SPY below Ichimoku cloud + thin cloud + tangled EMAs = market chop
- When market chop: apply CHOPPY parameters to ALL tickers regardless of individual regime
- Prevents trading against macro headwinds

---

### Pillar 4: Hindsight Calibration Pipeline Enhancement

**Current state**: Calibration pipeline exists (`runCalibrationPipeline`, `autopsyTradesServerSide`, `generateCalibrationReport`) but doesn't include Ichimoku or RVOL signals.

#### 4A. Enrich Historical Trade Data with New Signals

For each closed trade in `trades` table:
1. Load candles at `entry_ts` across all TFs
2. Compute Ichimoku state (TK cross, cloud position, thickness, Chikou)
3. Compute RVOL at entry
4. Compute regime score at entry
5. Store in `direction_accuracy` / `calibration_trade_autopsy`

#### 4B. Information Coefficient (IC) Analysis

For each new signal, compute correlation with trade outcome:
```
IC = correlation(signal_value_at_entry, trade_pnl)
```

Signals with IC > 0.05 get weight in the scoring formula.
Signals with IC < -0.02 are anti-predictive and should be inverted or removed.

#### 4C. Walk-Forward Optimization

Split the 8-month backtest into:
- **Training**: Jul 1 – Nov 30 (5 months)
- **Validation**: Dec 1 – Feb 23 (3 months)

Optimize weights on training, validate on out-of-sample. Prevents overfitting.

Key parameters to optimize:
- Ichimoku score weights per TF
- RVOL threshold for entry gate
- Regime score thresholds
- Score threshold adjustments per regime
- SL Kijun anchor vs ATR

#### 4D. Golden Profile Updates

The existing `calibration_profiles` system stores winner/loser profiles by entry state. Update to include:
- `ichimoku_score_p25/p50/p75` — Ichimoku score distribution for winners
- `rvol_p25/p50` — RVOL distribution for winners
- `regime_score_p50` — regime at entry for winners
- `cloud_thickness_p50` — cloud thickness for winners vs losers

---

### Pillar 5: Adaptive SL/TP Using Ichimoku Structure

**Current state**: SL is ATR-based with volatility tier adjustments. TP uses ATR multiples and Golden Gate levels.

**Problem**: 243 SL breaches (38.3% WR) + 55 max_loss (0% WR) = 298 trades destroyed by poor stop placement.

#### 5A. Kijun-Sen as Primary SL Anchor

The Kijun-Sen (26-period midpoint) is a natural equilibrium level. Professional Ichimoku traders use it as the primary stop reference.

```
For LONG:
  kijunSL = Kijun_Sen_daily - (ATR * 0.2)   // small cushion below Kijun
  cloudSL = CloudBase_daily - (ATR * 0.1)    // cloud base as hard floor
  sl = max(kijunSL, cloudSL)                 // whichever is closer (tighter)

For SHORT:
  kijunSL = Kijun_Sen_daily + (ATR * 0.2)
  cloudSL = CloudTop_daily + (ATR * 0.1)
  sl = min(kijunSL, cloudSL)
```

**Blend with existing**: Use `0.6 * kijunSL + 0.4 * currentATR_SL` during transition period, then shift to pure Kijun after validation.

#### 5B. Cloud-Relative TP Levels

```
TP1 (trim):   Opposite cloud boundary (price above cloud → far edge of cloud as minimum TP)
TP2 (target): 1.5 × cloud thickness beyond entry
TP3 (runner): Kijun of the next higher timeframe
```

#### 5C. Regime-Adaptive SL Width

| Regime | SL Method |
|--------|-----------|
| TRENDING | Kijun anchor (tight) — trend will carry price |
| TRANSITIONAL | Kijun + 1.5σ cushion — need room for noise |
| CHOPPY | Cloud boundary + 2σ cushion — wide stop or don't trade |

#### 5D. Time-Based Exits for Losers

The data shows losers are held 20.5 days avg. In chop, this is far too long.

```
if (regime === CHOPPY && holdingDays > 5 && pnl < 0) → EXIT
if (regime === TRANSITIONAL && holdingDays > 10 && pnl < -1%) → EXIT
if (holdingDays > 15 && pnl < -2%) → EXIT regardless of regime
```

#### 5E. Reduce max_loss Threshold

Current `-8%` in favorable zone, `-4%` normal. Those 55 max_loss trades at -$305 avg suggest the threshold is way too generous.

```
New thresholds:
  TRENDING:      -5% favorable, -3% normal
  TRANSITIONAL:  -4% favorable, -2.5% normal
  CHOPPY:        -3% favorable, -2% normal
```

---

### Pillar 6: Trade Frequency Governance

**The data is clear**: 66 trades in July (62% WR) vs 116 in February (43% WR). The system trades more when it should trade less.

#### 6A. Score Threshold Floor

```
minHTFScore = BASE_THRESHOLD + regimeAdjustment + streakAdjustment

BASE_THRESHOLD = 10
regimeAdjustment:
  TRENDING: 0
  TRANSITIONAL: +5
  CHOPPY: +15

streakAdjustment (last 10 trades):
  WR < 40%: +5
  WR < 30%: +10
```

This means in CHOPPY + cold streak: need htf ≥ 35 (currently 10). Only the strongest signals get through.

#### 6B. Weekly Trade Budget

| Regime | Max New Entries/Week |
|--------|---------------------|
| TRENDING | 15 |
| TRANSITIONAL | 8 |
| CHOPPY | 3 |

#### 6C. Consecutive Loss Cooldown

After 3 consecutive losses within 5 days:
- 24-hour cooldown (no new entries)
- Next entry requires RVOL > 1.5 AND Ichimoku full bullish alignment
- Position size reduced to 0.5x for next 3 trades

#### 6D. SHORT Trade Governance

Given SHORTs' negative expected value:
- **TRENDING (bear)**: Allow SHORTs, standard parameters
- **TRENDING (bull)**: Allow Gold Standard SHORTs only if RVOL > 1.5
- **TRANSITIONAL**: SHORTs require Ichimoku bearish on daily + weekly + Chikou confirmation
- **CHOPPY**: No SHORTs. Period.

---

## Implementation Phases

### Phase 1: Ichimoku Engine + RVOL + TF Restructure (indicators.js) ✅ COMPLETE
**Scope**: Full native computation, scoring integration, TF architecture overhaul.

- [x] `computeIchimoku(bars)` → all 5 components (Tenkan, Kijun, Senkou A/B, Chikou)
- [x] 18 derived signals: TK Cross, Price vs Cloud, Cloud Color/Thickness, Chikou, Kumo Twist, TK Spread, Kijun Slope, Price-to-Kijun
- [x] `computeIchimokuScore(ich)` → ±50 score with 7 scoring factors
- [x] Enhanced RVOL: `rvol5` (5-bar trend), `rvolSpike` (breakout detection)
- [x] Ichimoku + RVOL wired into `computeTfBundle` output
- [x] HTF restructured: M(10%) → W(20%) → D(40%) → 4H(30%), Monthly added
- [x] LTF restructured: 1H(35%) → 30m(30%) → 10m(20%) → 5m(15%), 1H moved from HTF
- [x] Ichimoku blended: 30% of HTF, 20% of LTF (graceful degradation when absent)
- [x] `ichimokuRegimeOk()` enhanced: uses score + Chikou + cloud color (not just position)
- [x] Kijun SL anchors computed and stored in `ichimoku_d` payload
- [x] `ichimoku_map` (all TFs) and `rvol_map` (all TFs) added to ticker payload
- [x] Full compilation test + synthetic data validation passed

### Phase 2: Regime Classifier (indicators.js + index.js) ✅ COMPLETE
**Scope**: Classify TRENDING/TRANSITIONAL/CHOPPY per ticker + market-wide.

- [x] `classifyTickerRegime(dBundle, h4Bundle, wBundle)` → 7-factor scoring engine
  - Ichimoku: cloud thickness, price inside cloud, TK spread, Kijun slope, Kumo twist
  - EMA structure convergence/divergence
  - SuperTrend stability (bars since flip)
  - Squeeze state
  - Volume conviction (RVOL)
  - 4H early warning (inside cloud, ST divergence)
  - Weekly confirmation (inside cloud, thin cloud)
- [x] `classifyMarketRegime(spyDailyBundle)` → global SPY overlay
- [x] `getRegimeParams(tickerRegime, marketRegime)` → full adaptive parameter set
  - Market overlay: CHOPPY market overrides TRENDING ticker to TRANSITIONAL
- [x] `regime_class`, `regime_score`, `regime_factors`, `regime_params` in ticker payload
- [x] Validated: chop scenario scores -9, trend scores +3, bear trend +3

### Phase 3: Entry Gate Hardening (index.js) ✅ COMPLETE
**Scope**: RVOL gate, regime-adaptive thresholds, SHORT governance, trade budget, cooldown.

- [x] RVOL dead zone gate (< 0.4-0.5 depending on regime = no entry)
- [x] SHORT blocking in CHOPPY regime
- [x] SHORT RVOL minimum (1.0 trending, 1.3 transitional, blocked in choppy)
- [x] Regime-adaptive HTF score floor (10 trending, 15 transitional, 25 choppy)
  - RVOL low adjustment: +5 to +10 score when RVOL < 0.7-0.8
- [x] Regime-adaptive completion cap (0.60 trending, 0.45 transitional, 0.30 choppy)
- [x] Regime-adaptive RR minimum (1.5x trending, 2.0x transitional, 3.0x choppy)
- [x] Regime-adaptive daily entry cap (6 trending, 4 transitional, 2 choppy)
- [x] Consecutive loss cooldown: 3+ losses in 5 days → 24h cooldown
- [x] Regime + RVOL context passed to precision metrics for position sizing

### Phase 4: Adaptive SL/TP (index.js) ✅ COMPLETE
**Scope**: Kijun-based SL, cloud-relative TP, time exits, regime position sizing.

- [x] Kijun SL blending: 40% Kijun-Sen + 60% existing ATR SL
  - Applied to both replay and live entry paths
  - Safety: blended SL never crosses entry price
- [x] Cloud boundary TP nudging: Senkou Span edges pull TP targets within 15% proximity
  - Acts as structural confluence, doesn't replace ATR-based TPs
  - Also considers Kijun-Sen as supplementary TP magnet
- [x] Regime-adaptive SL cushion via `slCushionMultiplier`
  - TRENDING: 1.0x (normal), TRANSITIONAL: 1.15x, CHOPPY: 1.30x
  - Wider stops in chop prevent noise-triggered exits
- [x] Time-based exit for losers in chop
  - CHOPPY: 7 days max hold for losers, 3.5 days if losing > 2%
  - TRANSITIONAL: 12 days, TRENDING: 20 days
  - Prevents slow bleed in mean-reverting environments
- [x] Regime-adaptive position sizing
  - TRENDING: 1.0x, TRANSITIONAL: 0.75x, CHOPPY: 0.50x
  - Applied to both risk-based (replay) and fixed-size (live) entry paths
  - Smaller positions in chop = less capital at risk in low-probability trades

### Phase 5: Calibration Enhancement (index.js) ✅ COMPLETE
**Scope**: Enrich learning pipeline with v3 signals, IC computation, golden profiles.

- [x] Schema migration: 10 new columns in `direction_accuracy`
  - `regime_class`, `regime_score`, `rvol_best`, `ichimoku_score_d`,
    `ichimoku_position_d`, `cloud_thickness_d`, `tk_cross_d`,
    `entry_quality_score`, `vol_tier`, `position_size_mult`
- [x] `d1LogDirectionAccuracy` enriched: captures all v3 signals at entry time
- [x] IC computation extended: `regime_score`, `rvol_best`, `ichimoku_score_d`,
  `cloud_thickness_d`, `entry_quality_score` queried from `direction_accuracy`
  and fed through Spearman correlation → signal weights
- [x] `extractScoring` updated for winner/loser profile analysis
- [x] `buildProfiles` includes regime distribution, RVOL/Ichimoku percentiles,
  entry quality percentiles for every profile
- [x] Calibration report includes `v3_regime_analysis` section:
  per-regime-class win rate, avg P&L, avg RVOL, avg Ichimoku score
- [x] Live + replay pipelines both flow through `assembleTickerData` which
  includes `regime_class`, `regime_params` — no extra wiring needed

### Phase 6: Validation Replay
**Scope**: Run the improved system against Jul 1 – Feb 23 to measure impact.

- [ ] Clean slate replay with new scoring
- [ ] Compare: win rate, trade count, avg P&L, max drawdown, Sharpe
- [ ] Target: Win rate > 55%, trade count < 450, positive P&L every month

---

## Expected Impact

| Metric | Current | Target | How |
|--------|---------|--------|-----|
| Win rate | 48.2% | > 55% | Chop filter, RVOL gate, Ichimoku confirmation |
| Trade count (8 mo) | 749 | < 450 | Regime-adaptive frequency, trade budget |
| SL breach rate | 32% | < 18% | Kijun SL, wider stops in chop |
| max_loss exits | 55 | < 10 | Reduced thresholds, time exits |
| SHORT win rate | 46.4% | > 52% or < 50 SHORT trades | RVOL gate, chop block |
| Monthly consistency | 3 losing months | 0-1 losing months | Chop filter is the key |
| Sharpe ratio | ~0.3 est | > 1.0 | Fewer trades, higher quality |

---

## Key Principle

**"The best trade is often no trade."**

The current system treats every signal as actionable. The overhaul's philosophy: signals are cheap, but capital is precious. Every entry must pass through a gauntlet of confirmation (Ichimoku alignment + RVOL participation + favorable regime + fresh trigger). The system should trade 40% fewer times but win 15% more often.
