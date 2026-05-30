# V11 Analysis Pipeline — Identify, Translate, Apply

**Status:** PLANNING (no code yet)  
**Date:** 2026-04-22  
**Trigger:** V11 full run in progress. Once it completes (~10-15h wall clock)
we'll have ~500-800 trades with full signal_snapshot + entry_path + MFE/MAE
data. Goal: a data-science-backed pipeline that turns that data into
calibration decisions.

---

## 1. The core problem statement

We have proven that **tickers, sectors, and indexes each have their own
behavioral style**:

| Cohort | Examples | Observed style |
|---|---|---|
| Index ETFs | SPY, QQQ, IWM | Shallow pullbacks, slow trends, low vol |
| Mega-cap tech | AAPL, MSFT, GOOGL, META, NVDA | Clean MTF structure, smooth trails |
| Small-cap tech | AGYS, AEHR, APLD, etc. | Gap risk, volatile, earnings-driven |
| Commodity ETFs | GDX, GLD, USO, SLV | Macro-driven, different fuel |
| Crypto-adjacent | COIN, MSTR, IREN | Extreme vol, bi-modal outcomes |
| Defensive/utility | XLU, XLP, PG | Slow, narrow range |
| Cyclicals | XLY, XLI, CAT | Regime-sensitive |
| Broker dealers / banks | JPM, GS, MS | News-driven jumps |

Our engine has partial support:
- `static_behavior_profile` (min_rank, sl_mult, doa_hours, max_hold_hours)
- `SECTOR_RATINGS` (OW/N/UW)
- `_cohort` tags (`index_etf`, `megacap`, `industrial`, `speculative`)
- Execution profiles (`correction_transition`, `choppy_selective`, etc.)

But these are mostly hand-tuned. **V11's data is our chance to calibrate
all of them from actual outcomes.**

---

## 2. The 3-stage pipeline

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│     IDENTIFY         │ -> │     TRANSLATE        │ -> │       APPLY          │
│                      │    │                      │    │                      │
│ What does the data   │    │ What concrete        │    │ DA-keys / profile    │
│ actually say?        │    │ tuning follows       │    │ deltas / code changes│
│                      │    │ from the findings?   │    │                      │
│ - Per-ticker stats   │    │ - Per-cohort         │    │ - activate-v12.sh    │
│ - Signal calibration │    │   sl_mult / tp_mult  │    │ - Updated profile    │
│ - Regime breakdown   │    │ - Per-path rank floor│    │   YAML               │
│ - Feature importance │    │ - Per-sector SHORT   │    │ - PR diff            │
│ - Bootstrap CIs      │    │   gates              │    │                      │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘
```

Each stage has clear deliverables.

---

## 3. IDENTIFY — what we'll compute

### 3.1 Univariate signal analysis (reuse `scripts/rank-signal-calibration.py`)

For every signal in `signal_snapshot_json` (RSI div, ATR disp, Saty phase,
supertrend alignment, ripster clouds, etc.), compute:

- `P(win | signal=on)` vs `P(win | signal=off)`
- `E[pnl_pct | signal=on]` vs `E[pnl_pct | signal=off]`
- WR lift and PnL lift
- **95% CI via bootstrap** (1000 resamples) — this is the data-science
  rigor we've been missing. A 5% WR lift on n=10 isn't real.

**Statistical tests to apply:**
- Chi-square for WR differences (signal × win/loss contingency table)
- Mann-Whitney U for pnl_pct distributions (non-parametric, no normality assumption)
- False-discovery correction (Benjamini-Hochberg) when we test many signals

Output: `v11-signal-lift.csv` and a text report listing signals by FDR-adjusted significance.

### 3.2 Per-entry-path analysis (reuse `scripts/v11-entry-path-analysis.py`)

Already built and ready. Post-v11 will populate `entry_path`, so this
script gives us the WR/PnL per trigger (tt_pullback vs tt_momentum vs
tt_confirmed_long vs tt_reclaim etc.).

### 3.3 Per-ticker behavior profile (NEW)

**The key new thing for the "style" insight.** For each ticker:

- `n_trades` (sample size)
- `WR`, `avg_win`, `avg_loss`, `profit_factor`
- `avg_hold_hours`
- `typical_exit_reasons` (what mechanism ends its trades)
- `MFE/MAE distribution` (does this ticker's trade usually reach +3%? +1%? never?)
- `natural_vol` (from our candles — ATR%)
- `gap_frequency` (overnight gaps > 1%)
- `earnings_surprise_magnitude` (avg EPS surprise %)

Then cluster tickers into **behavioral archetypes** (K-means or
hierarchical clustering on these features). Likely output: 5-8 clusters
like:
- "Smooth megacap trenders"
- "Volatile small-cap breakouts"
- "Range-bound defensives"
- "Gap-prone earnings plays"
- "Commodity-correlated ETFs"

Each archetype suggests different SL/TP multipliers, different rank
thresholds, different hold windows.

### 3.4 Per-sector analysis

Same breakdown by sector (Tech, Healthcare, Energy, Financials, etc.)
plus cross-break with `monthlyCycle` regime — does Healthcare win in
uptrends but lose in chop? Does Energy outperform when SPY is weak?

### 3.5 Regime-conditional performance

For each regime label from the monthly backdrop:
- `uptrend` / `downtrend` / `transitional`
- Plus `execution_regime_class` (TRENDING / TRANSITIONAL / CHOPPY)

Compute WR/PnL per entry_path × per direction × per regime.
Answers: "Does tt_pullback LONG work in TRANSITIONAL markets, or only
TRENDING?"

### 3.6 Exit-reason quality audit

For each exit_reason, compute:
- How often it fires
- Avg pnl when it fires
- **Counterfactual: what would the pnl have been if we held another hour? 4 hours? 1 day?**
  - Requires candle data for the ticker post-exit
  - Reveals whether an exit rule is cutting too early or too late

This is expensive to compute (needs post-exit candle lookups) but high-leverage.

### 3.7 Feature importance via gradient-boosted tree (NEW)

Train a simple scikit-learn `GradientBoostingClassifier` with:
- **X:** ~30-40 engineered features from signal_snapshot (entry MTF bias per TF, phase values, rsi values, rvol, ATR disp, supertrend directions, regime class, cohort one-hot, direction)
- **y:** binary win/loss (or continuous pnl_pct for regression)
- **CV:** 5-fold time-series split (NOT random — otherwise we leak future)

Output: `feature_importances_` ranked list.

**Honest caveats I'll enforce:**
- 500-800 samples is SMALL. Only use shallow trees (max_depth=3, n_estimators=50).
- Time-series CV to prevent look-ahead leakage.
- Permutation importance rather than gini importance (more honest on
  correlated features).
- ALWAYS report out-of-fold accuracy to confirm the model is even
  learning something above base rate.

This gives us a **data-driven ranking of which signals matter** that's
rigorous enough to replace the hand-tuned weights in computeRankV2.

### 3.8 Bootstrap confidence intervals on headline metrics

For every "WR = X%" / "PnL = Y%" we report, also report
`(X ± margin, 95% CI)` via bootstrap. Critical for honest comparison
with v10b / Phase-I smoke.

---

## 4. TRANSLATE — from insight to tuning

This is where we stop reporting and start proposing.

### 4.1 Per-ticker/cohort profile deltas

From §3.3 clustering, for each archetype, propose:
```yaml
# tuned_cohort_profiles.yaml
clusters:
  smooth_megacap_trender:
    tickers: [AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA]
    rank_floor: 70          # lower — they're reliable
    sl_mult: 1.0            # standard
    tp_mult: 1.3            # let winners run
    max_hold_hours: 336     # 2 weeks ok
    mfe_early_cut_pct: 0.3  # cut if no 0.3% MFE in 4h
  volatile_small_cap:
    tickers: [AGYS, AEHR, ...]
    rank_floor: 85          # higher — need more signal
    sl_mult: 1.3            # wider for gap risk
    tp_mult: 1.1            # take profits quicker
    max_hold_hours: 48      # don't hold long
    mfe_early_cut_pct: 0.5  # cut harder
```

This becomes a new DA-key family: `deep_audit_cohort_profile_{cohort}`.

### 4.2 Per-entry-path calibration

From §3.2 findings, propose per-path thresholds:
```yaml
entry_paths:
  tt_pullback:
    min_rank: 80
    min_rr: 2.0
    require_consensus_signals: 3
  tt_confirmed_long:
    min_rank: 75        # stricter than baseline if our data says so
    min_rr: 3.0
  tt_momentum:
    min_rank: 90        # momentum should be "elite or don't take"
    ...
```

### 4.3 Per-sector SHORT gates

From §3.4, if Sector X loses on SHORTs regardless of rank, hard-block
SHORTs for that sector:
```yaml
short_blocks_by_sector:
  - Healthcare       # per v10b + V11 data
  - Consumer Staples
```

### 4.4 Updated computeRankV2 weights

From §3.7's feature importance, re-derive the rank formula with
data-backed weights instead of hand-tuned ones. This is the honest
rank-V2 we couldn't build on v10b's biased sample.

### 4.5 Concrete exit-rule deltas

From §3.6's counterfactual analysis, tune:
- `mfe_proportional_trail` parameters
- `early_dead_money_flatten` age threshold
- `atr_adverse_cut` pct threshold
- New `phase_i_mfe_*` tier thresholds

### 4.6 Regime-aware activation

From §3.5, propose a **regime-switching config**: which DA-keys to
toggle when monthly backdrop flips from uptrend to downtrend.

---

## 5. APPLY — shipping the tunes

Output of TRANSLATE is a structured YAML. APPLY converts it into:

### 5.1 `scripts/phase-j/activate-v12.sh`

Single shell script that applies ALL derived DA-key overrides.
Reuses the existing `phase-i/XX-*.sh` pattern.

### 5.2 `configs/cohort-profiles.json` checked into repo

Machine-readable per-ticker/cohort profile document. Worker loads this
at startup (via existing `SECTOR_RATINGS` / profile plumbing).

### 5.3 Automated PR generation

The pipeline outputs a PR-ready diff: activate script + config file +
a markdown summary of findings for the PR body. One command creates
the PR.

### 5.4 Regression-test harness

Before merging, re-run the Aug 1-7 Phase-I smoke WITH the new
calibration. If it beats or matches Phase-I's 63.8% WR / +84.53%,
ship it.

---

## 6. Technical stack

- **Python 3** (already have scripts/*.py pattern)
- **pandas + numpy** (already used elsewhere)
- **scikit-learn** for the GBT + clustering (light install)
- **scipy.stats** for chi-square, Mann-Whitney, bootstrap CIs
- **matplotlib** optional — we've done fine with ASCII tables

No new infra. Runs locally on V11's trades.json export.

---

## 7. Reuse vs rebuild

What we already have:

| Existing script | Reuse for |
|---|---|
| `rank-signal-calibration.py` | §3.1 univariate (add bootstrap + FDR) |
| `v11-entry-path-analysis.py` | §3.2 as-is |
| `v10b-full-autopsy.py` | §3.6 exit-reason structure |
| `phase-e-pattern-miner.py` | §3.3 per-ticker mining (extend with clustering) |
| `phase-g-trade-forensics.py` | §3.6 counterfactual exit analysis |
| `entry-quality-analysis.py` | §3.7 feature engineering |
| `cross-run-analysis.js` | Headline comparison against Phase-I smoke |
| `calibrate.js` | §5 APPLY plumbing |

What's genuinely new:

| New | Why |
|---|---|
| `v11-cohort-clustering.py` | Archetype discovery (§3.3) — we've never done this |
| `v11-feature-importance.py` | GBT feature ranking with proper CV (§3.7) |
| `v11-bootstrap-ci.py` | Confidence intervals framework (§3.8) |
| `v11-translate.py` | YAML proposals from the identification stage |
| `v11-pipeline.py` | One-command orchestrator of all stages |

---

## 8. Execution sequence (after V11 completes)

1. **V11 completes** (~10-15 hours wall clock from now)
2. **Export** via existing trade-autopsy endpoint → `data/trade-analysis/<run>/trades.json`
3. **Run pipeline** (30-60 min):
   ```bash
   python3 scripts/v11-pipeline.py --run-id <v11> --output tasks/v11-findings/
   ```
   Generates:
   - `01-signal-lift.txt` (§3.1)
   - `02-entry-path.txt` (§3.2)
   - `03-ticker-profiles.csv` + `03-clusters.txt` (§3.3)
   - `04-sector-analysis.txt` (§3.4)
   - `05-regime-conditional.txt` (§3.5)
   - `06-exit-reasons.txt` (§3.6)
   - `07-feature-importance.txt` (§3.7)
   - `08-bootstrap-cis.txt` (§3.8)
   - `translate/proposed-tunes.yaml` (§4)
4. **Human review** of proposed tunes — 30-60 min
5. **Apply** via `scripts/phase-j/activate-v12.sh` and deploy
6. **Regression smoke** on Aug 1-7 to validate (~20 min)
7. **v12 full rerun** if smoke passes — this is our decisive run

---

## 9. Honest caveats

1. **Sample size limits.** 500-800 trades sounds like a lot for
   aggregate stats but is small per-ticker. Per-ticker calibration
   with n<10 per ticker is noise. We'll cluster into archetypes to
   reach n≥20 per group before trusting any per-class conclusion.

2. **Look-ahead leakage.** If we tune on v11 data and re-test on v11
   data, we're overfitting. Our ACCEPTANCE test should be:
   - Tune on v11 Jul-Feb
   - Validate on v11 Mar-Apr (out-of-sample window)
   - OR use proper k-fold time-series CV

3. **Regime rarity.** We probably don't have enough bear-regime trades
   to tune SHORT logic robustly from one run alone. Be honest about
   low-confidence conclusions on rare regimes; flag them for future
   data collection rather than forcing a recommendation.

4. **The clustering "archetypes" are a hypothesis.** If the clusters
   don't separate cleanly (high intra-cluster variance), the concept
   isn't validated and we fall back to manual cohort tags.

5. **Simple models first.** GBT with max_depth=3 before anything
   fancier. Anything deeper on 500 samples is memorization.

---

## 10. Deliverables checklist

At the end of this pipeline:

- [ ] One-page executive summary (Phase-I → V11 delta headline)
- [ ] `configs/cohort-profiles.json` (ticker archetype mapping)
- [ ] `scripts/phase-j/activate-v12.sh` (one-command tune)
- [ ] `tasks/v11-findings/` directory with per-stage reports
- [ ] PR description with statistical evidence for every proposed change
- [ ] Regression smoke results
- [ ] If all above pass: **merge to main, promote as golden master**

That's the win state. Everything between here and there is evidence-gathering.
