# Signal Family Catalog v1

**Status:** audit-backed catalog  
**Created:** 2026-06-17  
**Purpose:** map signal families to shipped code, payload fields, persistence,
consumers, and awareness mode before building sequence/path models.

This catalog is the companion to
[`active-trader-information-hardening-plan.md`](active-trader-information-hardening-plan.md).
It should be updated before any new event/sequence names are introduced.

---

## Awareness modes

| Mode | Meaning |
|---|---|
| **Snapshot** | Latest state only; useful but memoryless. |
| **Event** | Detects a transition or edge, usually with a timestamp. |
| **Lookback** | Scans a recent window for structure, pivots, divergence, or prior touches. |
| **Path** | Tracks ordered state over multiple bars/snapshots. |
| **Context** | Macro/research/sector/ticker-personality input, not a price event. |

---

## Catalog

| Family | Canonical code | Main payload fields | Current consumers | Awareness |
|---|---|---|---|---|
| TD Sequential / DeMark | `worker/indicators.js` `computeTDSequentialMultiTF`, `detectMeanReversionTD9`; `worker/timing-signals.js`; `worker/root-strategy.js` L6 | `td_sequential`, `td_sequential.per_tf`, entry `setup_snapshot.td_seq` | timing overlay, root confluence, mean-reversion entry, model prediction logging, exits | Event / snapshot |
| Phase / Saty oscillator | `worker/indicators.js` `satyPhaseSeries`, phase fields in `computeTfBundle`; `worker/timing-signals.js` | `tf_tech.{TF}.saty`, `saty_phase_pct`, `saty_phase_exit`, `phase_pct`, `phase_zone` | timing overlay, focus tier, root L8, entry/exit guards | Event / snapshot |
| Saty ATR ranges | `worker/indicators.js` `buildATRLevelMaps`; `worker/day-trade-game-plan.js`; `worker/daily-brief.js` | `atr_levels`, day/week levels, prediction contract targets | right rail levels, day-trade targets, conviction proximity | Snapshot |
| EMA / EMA cloud / Ripster | `worker/indicators.js` EMA series, `ripsterClouds`, `daily_structure`; `worker/pipeline/ripster-*` | `tf_tech.{TF}.ema`, `tf_tech.{TF}.ripster`, `daily_structure.e5/e12/e21/e48/e200` | entry paths, exit doctrine, root L7, technical UI | Snapshot / event for crosses |
| SuperTrend | `worker/indicators.js` `superTrendSeries`; `worker/root-strategy.js` ST trigger; `worker/trend-hold.js` | `tf_tech.{TF}.stDir`, `st_support`, `flags.st_flip_*` | entry gates, exit fuses, root L7 trigger, timing | Event |
| PDZ / premium-discount | `worker/indicators.js` `computePDZ`; `worker/pipeline/sizing.js` | `pdz_D`, `pdz_4h`, `tf_tech.{TF}.pdz`, `pdz_zone_*` | position sizing, root L4, entry context, right rail | Snapshot / lookback |
| FVG | `worker/indicators.js` `detectFVGs`, `computeFVGImbalance`; `worker/pipeline/enrichment.js` | `fvg_D`, `fvg_4h`, `fvg_imbalance_D`, `tf_tech.{TF}.fvg`, `flags.fvg_*` | root L4 ICT, entry enrichment, technical UI | Lookback / event-like |
| Liquidity zones / sweeps | `worker/indicators.js` `detectLiquidityZones`; `worker/pipeline/enrichment.js` | `liq_D`, `liq_4h`, `liq_W`, `tf_tech.{TF}.liq`, `flags.liq_*` | entry enrichment, congestion filter, root L4 context | Lookback / snapshot sweep |
| ORB | `worker/indicators.js` `computeORB`; `worker/day-trade-game-plan.js` opening-range helpers | `orb`, day-trade game plan OR levels | root L5 Carter, entry gates, day-trade playbook, timing copy | Path within session |
| RSI / divergence | `worker/indicators.js` `rsiSeries`, `detectRsiDivergence`; `worker/timing-signals.js` | `tf_tech.{TF}.rsi`, `rsi_divergence`, RSI fields in setup snapshots | entry quality, timing, exits, technical UI | Snapshot / lookback |
| Squeeze | `worker/indicators.js` TTM squeeze fields; `detectFlags`; `tt-core-entry` | `tf_tech.{TF}.sq`, `flags.sq30_release`, `flags.sq1h_release` | entry paths, root L5 Carter, trail facts, timing copy | Event |
| VWAP | `worker/indicators.js` VWAP fields | `tf_tech.{TF}.vwap*`, setup snapshots | some entry buffers, trade autopsy, day-trade context | Snapshot / touch lookback |
| RVOL / volume | `worker/indicators.js` `volRatio`, `rvol_map`; `worker/pipeline/gates.js` | `rvol_map`, `volatility_tier`, volume fields | entry gates, rank traces, breakout context | Snapshot |
| Gaps / overnight context | `worker/indicators.js` daily gap reversal + `computeOvernightGapContext`; `tt-core-entry` | `daily_structure.gap_reversal`, `overnight_gap` | gap reversal paths, prediction contract, day-trade context | Event / path |
| Markov / regime | `worker/lib/regime-markov*`, `regime-hmm*`, `computeSwingRegime` | `regime_forecast`, `regime`, `regime_class`, HMM fields where present | sizing, timing, root L3, move-ending, calibration | Path / context |
| Research / strategy context | `worker/strategy-context.js`, CRO/FSD/CIO services, `theme-tilt.js`, `officer-rank-tilt.js` | `_theme_tilt`, strategy alignment, CIO/CRO context, rank traces | rank tilt, CIO narrative, timing warnings, research desk | Context |
| Ichimoku | `worker/indicators.js` `computeIchimoku`, `computeIchimokuScore` | `ichimoku_d`, `ichimoku_w`, `ichimoku_map`, `tf_tech.{TF}.ich` | root L2 Newton, technical context, invalidation levels | Snapshot |
| Volume profile | `worker/volume-profile.js`; optional `_vp` injection | `_vp`, `/timed/volume-profile` response | root L4 if present, right rail/API context | Snapshot |
| Support/resistance structures | `worker/indicators.js` range box, N-test, 52w high/low; prediction contract levels | `daily_structure.range_box`, `daily_structure.n_test_support`, `daily_structure.ath52w`, `levels` | entry paths, right rail levels, root context | Lookback |

---

## Known schema / documentation traps

- `docs/SCORING_ARCHITECTURE.md` is Pine-era and should not be treated as the
  canonical current scoring path.
- `setup_snapshot` and `rank_trace_json` field names must be sampled before
  writing SQL/cohort filters. Prior forensic lessons found mismatches such as
  `td9_bull` vs `td9_bullish` and `pdz.h4` vs `pdz.4h`.
- ORB exists in two horizons:
  - `worker/indicators.js` session ORB for ticker payload/root strategy.
  - `worker/day-trade-game-plan.js` opening range for Today/Index Playbook.
- FVG and PFVG are not identical. PFVG is an archived/offline opening-window
  experiment; FVG is the structural detector in `computeTfBundle`.
- Liquidity reclaim fields in root-strategy comments are more aspirational
  than the current `detectLiquidityZones` output. Treat them as a gap until
  the event ledger defines sweep/reclaim events.
- Volume profile exists as a module/API but is not part of the default
  `computeServerSideScores` payload unless injected.
- VWAP is computed, but prior forensics did not justify a blanket Active Trader
  VWAP veto. Use it first for Day Trader/path context or calibrated sequences.

---

## Required next doc before implementation

Before adding a sequence detector, create an event-name mapping table:

```text
event_type -> existing field(s) -> compute function -> horizons -> tests
```

This prevents new sequence names from drifting away from shipped detectors.

