# Phase-H.3: Entry Discipline + Regime-Adaptive Strategy

**Date**: 2026-04-20
**Driver**: Cross-backtest analysis revealed we peaked at Phase-E.3 (v5) with **68.8% WR / +214% PnL** on 117 selective LONG-only trades, then regressed monotonically through Phase-F (+SHORTs), Phase-G (+early-dead-money cuts), and H.1/H.1b tuning attempts.

**User mandate**: "Aim higher than 60%. We know how each month generally does, we know which sectors did well, we know how volatility is — dynamically apply the right strategy based on the market characteristics. Tighten entry selection and choose solid setups across various signals."

**Target**: **WR ≥ 65% aggregate, ≥ 60% every month, no month PnL < 0%.**

---

## The Smoking Gun

Same window (Jul 2025 – Feb 2026, 8 months) across versions:

| Version | Trades | WR | PnL | LONG | SHORT | Rank <70 | Comment |
|---|---:|---:|---:|---:|---:|---:|---|
| **E.3 v5** | **109** | **68.8%** | **+214.3%** | **109** | **0** | **2** | **Peak — LONG-only sniper** |
| F v6b | 148 | 54.1% | +48.8% | 89 | 59 | 27 | +SHORT, floodgates open |
| G v7 | 170 | 56.5% | +88.5% | 91 | 79 | 32 | +early-DM, more marginals |
| H.1b v8b | 39 (partial) | 51.3% | +7.4% | ? | ? | ? | Killed early |

**Root cause**: Phase-F's SHORT activation + lowered rank floor (46 vs E.3's 61) took on marginal trades. Phase-G's ATR TP ladder and early-DM didn't fix selectivity — they adjusted exit management on trades we shouldn't have entered.

## April 2026 — The Macro-Backdrop Failure

| Month | Backdrop cycle | v6b LONG/SHORT | v7 LONG/SHORT | v7 WR | v7 PnL |
|---|---|---|---|---:|---:|
| 2025-07 | uptrend | 22/0 | 24/4 | 57% | +20% |
| 2025-11 | downtrend | 1/22 | 3/11 | 79% | +23% |
| 2026-03 | downtrend | 0/45 | 0/36 | 64% | +23% |
| **2026-04** | **uptrend** | **0/12** | **1/22** | **22%** | **−33%** |

**April was labeled "uptrend" by our own backdrop data**, yet we opened 22 SHORTs. **Every one of those 22 SHORTs was wrong by construction**. If we had honored the cycle label, April WR would have been near 100% (0 trades) instead of 22%.

This is not a tuning problem. This is a **strategy-regime coupling** problem.

---

## H.3 Design — Three Layers

### Layer 1 — Restore E.3 Entry Tightness (rank floor + cohort thresholds)

What E.3 had that v7 lost:
- **Rank floor**: E.3 minimum rank was **61**; v7's was **46**. The 30 sub-rank-70 trades in v7 (53% WR) are roughly breakeven — their time slot is better spent waiting for A-grade setups.
- **Cohort overlay active**: E.3 enforced cohort-specific slope_min, extension_max, RSI caps. Phase-F kept these but added SHORT-side thresholds that were way too loose (`short_extension_min = -1.0` means "must be 1% below D48 to short" — that's almost any chop).

**Proposed DA keys** (new/modified):

| Key | Phase-G | **H.3** | Rationale |
|---|---:|---:|---|
| `deep_audit_min_rank_floor` | (none) | **90** | Only take A-grade setups — E.3 had 94% of trades at rank≥80 |
| `deep_audit_cohort_short_extension_min_index_etf` | -1.0 | **-3.0** | Must be 3% below D48 to short an Index ETF |
| `deep_audit_cohort_short_extension_min_megacap` | -1.0 | **-2.0** | 2% below D48 for MegaCap |
| `deep_audit_cohort_short_extension_min_industrial` | -1.0 | **-2.5** | 2.5% for industrials |
| `deep_audit_cohort_short_extension_min_speculative` | -1.0 | **-1.5** | Keep speculative looser (higher beta) |
| `deep_audit_short_pullback_require_ltf_bearish_count_min` | 0 | **1** | Kill the 0-of-3 relax — need at least 1 of 3 LTF ST bearish |

### Layer 2 — Regime-Adaptive Strategy (the "macro backdrop" piece)

Use the **monthly backdrop** cycle label (already computed, stored in `data/backdrops/<YYYY-MM>.json`) as a **first-class input to the entry gate**. Two options for implementation:

**2a. In-replay regime resolver** (preferred): Load the backdrop for the current date and expose `ctx.market.monthlyCycle` ∈ `{uptrend, downtrend, transitional}` to `tt-core-entry.js`.

**2b. Live regime resolver** (fallback): Compute the same signal from SPY's 20-day EMA daily slope + 4H bias vote (the same method `build-monthly-backdrop.js` uses).

**Proposed entry rules**:

| Monthly cycle | LONG entries | SHORT entries |
|---|---|---|
| **Uptrend** | Allow (rank ≥ 90) | **BLOCK unless ticker rank ≥ 98 AND cohort=Speculative** |
| **Downtrend** | **BLOCK unless ticker rank ≥ 98 AND SPY 4H ST also bullish** | Allow (rank ≥ 90) |
| **Transitional** | Allow (rank ≥ 92) | Allow (rank ≥ 92 AND full bear structure) |

**April 2026 impact**: Cycle label is "uptrend" → 22 SHORTs become 0. If any individual speculative name like MSTR hits rank 98 with fundamental weakness it can still short, but the default is "don't fight the tape."

**New DA keys**:

- `deep_audit_regime_adaptive_enabled` = true
- `deep_audit_regime_uptrend_short_rank_min` = 98
- `deep_audit_regime_uptrend_short_cohorts` = "Speculative"
- `deep_audit_regime_downtrend_long_rank_min` = 98
- `deep_audit_regime_downtrend_long_require_4h_bull` = true
- `deep_audit_regime_transitional_rank_min` = 92

### Layer 3 — Multi-Signal Consensus Gate

Currently a setup fires if its specific entry condition matches (e.g. `ripster_pullback`). H.3 adds a **consensus requirement**: the setup must be corroborated by signals from other dimensions.

**Required corroborating signals** (at least 3 of 5 must confirm):

1. **Trend alignment** — HTF (1H/4H/D) ST aligned with direction (2 of 3 tfs)
2. **Momentum alignment** — RSI 30m and RSI 1H both on the direction's side (for LONG: RSI > 50 both; for SHORT: RSI < 50 both)
3. **Volume confirmation** — 30m or 1H rvol ≥ 1.2
4. **Sector alignment** — ticker's sector OW for LONGs / UW for SHORTs per current `SECTOR_RATINGS`
5. **Phase positioning** — phase_pct between 15-75 (skip extreme early/late — lowest-WR zones per Phase-E.3 miner)

**New DA keys**:

- `deep_audit_consensus_gate_enabled` = true
- `deep_audit_consensus_min_signals` = 3
- Individual signal toggles (for ablation studies):
  - `deep_audit_consensus_trend_weight` = 1
  - `deep_audit_consensus_momentum_weight` = 1
  - `deep_audit_consensus_volume_weight` = 1
  - `deep_audit_consensus_sector_weight` = 1
  - `deep_audit_consensus_phase_weight` = 1

---

## Implementation

### Code changes (minimal, all in `worker/pipeline/tt-core-entry.js`):

1. **Rank floor check** at the top of the entry candidate scan:

```js
const _rankFloor = Number(ctx.config.deepAudit?.deep_audit_min_rank_floor) || 0;
if (_rankFloor && Number(ticker.rank) < _rankFloor) {
  return rejection("rank_below_floor", { rank: ticker.rank, floor: _rankFloor });
}
```

2. **Regime-adaptive gate** after rank floor:

```js
const _regime = ctx.market.monthlyCycle; // "uptrend" | "downtrend" | "transitional"
const _isShort = direction === "SHORT";
const _adaptive = String(ctx.config.deepAudit?.deep_audit_regime_adaptive_enabled ?? "true") === "true";
if (_adaptive && _regime === "uptrend" && _isShort) {
  const shortRankMin = Number(ctx.config.deepAudit?.deep_audit_regime_uptrend_short_rank_min) || 98;
  const allowCohorts = String(ctx.config.deepAudit?.deep_audit_regime_uptrend_short_cohorts || "Speculative").split(",");
  if (Number(ticker.rank) < shortRankMin || !allowCohorts.includes(ticker.cohort)) {
    return rejection("short_blocked_in_uptrend", { rank: ticker.rank, cohort: ticker.cohort });
  }
}
// symmetric for downtrend LONGs
// transitional uses a bumped rank floor
```

3. **Consensus gate** after regime:

```js
const _consensusEnabled = String(ctx.config.deepAudit?.deep_audit_consensus_gate_enabled ?? "true") === "true";
if (_consensusEnabled) {
  let signals = 0;
  // trend alignment (1H/4H/D)
  // momentum (RSI 30m + 1H)
  // volume (rvol 30m or 1H)
  // sector alignment
  // phase positioning
  const _min = Number(ctx.config.deepAudit?.deep_audit_consensus_min_signals) || 3;
  if (signals < _min) {
    return rejection("consensus_below_min", { signals, min: _min });
  }
}
```

### Context additions (in `worker/pipeline/trade-context.js`):

Add `ctx.market.monthlyCycle` resolution from the backdrop file for the replay date (cheap — already loaded in daily-brief pipeline).

---

## Validation Strategy

Same approach as H.1 but smarter:

1. **Micro-smoke**: April 2026 alone (the worst month). If H.3 blocks >= 90% of the 22 April SHORTs **and** the LONGs that remain hit > 60% WR, layer 1+2 are working.
2. **Mid-smoke**: Aug + Dec (the choppy months where H.1 bled). H.3 should reduce trade count by ~30-40% but hold WR ≥ 55%.
3. **Full v9**: Jul → Apr on 40 tickers. Target WR ≥ 65%, 10/10 winning months (or 9/10 with one marginally negative).

---

## Rollback Plan

Everything behind DA keys. If H.3 over-tightens:
- `deep_audit_consensus_gate_enabled = false` drops layer 3.
- `deep_audit_regime_adaptive_enabled = false` drops layer 2.
- `deep_audit_min_rank_floor = 0` drops layer 1.

Phase-G's protective cuts remain as the safety net underneath.

---

## Success Criteria (v9)

1. **Aggregate WR ≥ 65%** (v7: 54.1%) — aim for 70%+.
2. **Every month WR ≥ 55%** — v7 had 4 months below this.
3. **Every month PnL ≥ 0%** — v7 had 2 losing months.
4. **April WR ≥ 60%** (v7: 22%) — the macro-adaptive test.
5. **Total trades 120-160** — we're explicitly trading volume for selectivity. E.3 had 109, we accept 140 as we include SHORTs in some months.
