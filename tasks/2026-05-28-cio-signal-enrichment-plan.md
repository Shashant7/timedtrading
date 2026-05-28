# 2026-05-28 — CIO signal enrichment plan

PR #330 restored CIO so it actually runs on live entries/trims/exits/stalls. But the user's follow-up: **is CIO actually trained on everything the model tracks?** The audit answer is **no, several large signal families are silently invisible to CIO today**.

## What CIO currently sees

### Entry proposal (`buildCIOProposal` in `worker/cio/cio-service.js`)
- Trade params: ticker, direction, entry_px, sl, tp, rr, rank, setup, confidence
- Ticker profile (static): behavior_type, sl_mult, doa_hours, max_hold_hours
- Pullback confirmation + details
- FVG imbalance D
- EMA21 distance
- Regime (vocabulary: execution_regime_class, swing_regime_snapshot, market_volatility_regime, market_backdrop_class, market_trend_bias)
- Scores: htf_score, ltf_score
- Technicals: atr, completion, phase_pct, ema_regime_d, st_dir D/30m/1H, rsi 30m/15m
- Flags: momentum_elite, squeeze_release, squeeze_on, orb_confirmed/against/fakeout
- ORB primary only (breakout, priceVsORM, dayBias, widthPct)
- Danger score + flags
- Sizing meta (method, risk_pct, vix)
- Ichimoku D (position, tk_bull, cloud_bullish)
- PDZ zone D + 4h, pdz_pct_D, pdz_size_mult
- Ripster bias state + cloud alignment (5_12/34_50/72_89 across 10m/1H/D)
- 4-pane chart vision (4H/1H/30m/15m candles + EMA9/21/48 + SuperTrend + RSI panel)

### Memory (`buildCIOMemory` in `worker/cio/cio-memory.js`)
- L1: Ticker history (WR, avg PnL, top exit reasons, last 3 trades)
- L2: Regime context (per-regime WR + direction split)
- L3: Path performance (entry_path WR, avg_pnl_pct from path_performance D1 table)
- L3b: Reference priors (feature-flagged via cio_reference_features)
- L4: Ticker profile (static) + franchise/blacklist status
- L5: CIO self-accuracy (approved WR, last 3 rejects)
- L6: Market backdrop (today's VIX/oil/sector + crypto leading indicator + similar episodes)
- L7: Events (macro today, earnings direct, earnings proxy)
- Inline wrapper-added: `latent_regime` (HMM state + posterior + decoded_at)

## What CIO does NOT see (and should)

All present on `tickerData` at scoring time; cost of inclusion is a few hundred extra prompt tokens.

| Signal family | Source field | Why it matters |
|---|---|---|
| **Markov regime forecast** | `tickerData.regime_forecast` (4-state intraday + 12-state expanded + p_1h/p_1d/p_1w) | Forward-looking probability of regime continuation. For LONG entries, p_next of `HTF_BULL_LTF_BULL` >0.7 is high-conviction; <0.5 is fragile. For trim/exit decisions, regime continuation probability directly informs HOLD vs PROCEED. |
| **HMM latent regime** in proposal | `tickerData.latent_regime` | Currently only in memory wrapper, not in proposal body. Lifecycle proposals don't always benefit. Promote to first-class proposal field. |
| **Move archetype + runtime policy** | `tickerData.__learning_policy.recommend.{archetype, guard_bundle, sl_tp_style, trim_run_bias, exit_style}` | Ticker-specific behavior classification (fast_impulse_fragile, slow_grinder, etc.) tells CIO what kind of trade this is and what management style fits. |
| **Adaptive lineage** | `tickerData.__adaptive_lineage` | Shows which engine was selected and why (source: ticker_learning_policy_default / cohort_overlay / scenario_policy / reference_execution_map). |
| **TD Sequential** | `tickerData.tf_tech.{TF}.td.{setup_count, countdown, tv_count}` | Setup count >= 9 on D/4H is a major reversal signal. CIO should know to ADJUST or REJECT trades entering at TD9 in the opposite direction. |
| **Divergence summary** | `tickerData.__entry_divergence_summary.{adverse_rsi, adverse_phase}` + `rsi_divergence` / `phase_divergence` | Bearish RSI div on 30m+ at LONG entry / bullish on SHORT entry = high-risk. Strength >= 30 is the calibrated threshold. |
| **ORB full + targets hit** | `tickerData.orb.byTf.{5,15,30,60}` + targetsHitUp/Dn | Single-window primary is too thin. Multi-window consensus + how many ATR targets the move has already chewed through tells CIO if the move is extended. |
| **Move-phase profile** | `tickerData.move_phase_profile` + `phase_pct` + `completion` | Where in the move are we? Late-phase entries (phase > 75%, completion > 70%) are inherently more fragile. |
| **Regime exhaustion / run length** | `tickerData.regime_exhausted` + `_regime_run_length` | A 200-bar run with `exhausted=true` is statistically due to reverse — CIO should weight this when approving continuation trades. |
| **Markov favor multiplier** | `tickerData.__regime_favor_mult` (when `gates.markov_position_sizing_enabled`) | If the system already cut size due to unfavorable regime, CIO should know — it changes the risk math. |
| **Chop haircut applied** | `tickerData.__chop_size_mult` (when `gates.chop_size_haircut_enabled`) | Same — CIO should know the trade was already chop-sized. |
| **Cohort gate verdict** | `tickerData.__cohort_signal` (Phase 4 G1 pause / G2 cohort-fail block) | Was this trade marginally cleared by cohort floors? Important context. |
| **Open-position context** | derived from `allTrades` | How many open positions in this sector / direction right now? Concentration risk. |

## Design

### Cost
gpt-4o-mini text input is ~$0.15/1M tokens. Adding ~400 tokens × 12 cron ticks/hr × 6.5 RTH hours × 250 active scoring entries per RTH day ≈ negligible. Real cap is **CIO total latency budget (15s)** and **prompt size** (model context). We're well under both.

### What to add — entry proposal (most decision-impacting first)
1. **`markov_forecast`** — condensed: `{ state, matrix_source, p_next_top2, p_5_bar_top2, p_1d_top2, run_length_bars, exhausted }`. 4-state primary; skip 12-state to save tokens (it's rarely decision-changing for individual trades).
2. **`hmm_regime`** — `{ state, posterior_top, confidence_label }` (e.g., BULL_TREND, 0.78, "high"). Promote from memory to proposal for symmetry with lifecycle.
3. **`move_archetype`** — from `__learning_policy.recommend`: `{ archetype, entry_timing, guard_bundle, sl_tp_style, trim_run_bias, exit_style }`.
4. **`engine_resolution`** — from `__adaptive_lineage.entry_engine_resolution`: `{ source, selected_engine, selected_management_engine, blocked }`.
5. **`td_sequential`** — `{ d: { setup_count, countdown }, "4h": {...}, "1h": {...}, "30m": {...} }`. Only include TFs with non-null counts.
6. **`divergence`** — from `__entry_divergence_summary`: `{ adverse_rsi: { count, strongest_tf, strongest_strength }, adverse_phase: same }`. The "adverse" flag is direction-aware (bearish div for LONG, bullish div for SHORT).
7. **`orb_full`** — `{ primary: existing, multi_window: { 5m, 15m, 30m, 60m }, targets_hit_in_dir }`.
8. **`move_phase`** — `{ profile_class, phase_pct, completion_pct, exhausted, regime_run_bars }`.
9. **`sizing_overrides`** — `{ markov_favor_mult, chop_size_mult, danger_size_mult, rvol_high_mult }`. Already in sizingMeta, but breakout makes it more legible.
10. **`open_book`** — `{ open_count, same_sector_count, same_direction_count }`. Computed in proposal builder from allTrades.

### What to add — lifecycle proposal
Same set, but emphasized for trim/exit:
- `markov_forecast.p_5_bar_in_direction` — explicit "probability the next 25min favors holding"
- `hmm_regime` — currently CHOP posterior is the key HOLD-blocker
- `move_archetype` — `trim_run_bias` tells CIO if this ticker historically rewards trimming vs running
- `divergence_at_current_bar` — bearish div firing now on a LONG = PROCEED on trim
- `td_sequential_signal_at_current` — TD setup_count >= 9 firing now = PROCEED on trim/exit

### Memory L8 — Markov + adaptive + archetype
Add to `buildCIOMemory`:
- `markov_summary`: `{ current_state, next_bar_state_prob_in_dir, hour_state_prob_in_dir, day_state_prob_in_dir, matrix_source }`
- `move_archetype_history`: archetype name + how the system historically managed this archetype (from path_performance grouped by archetype if available; otherwise just the static recommendation)
- `recent_chop_haircut_pct` / `recent_markov_favor_mult` — if these have changed sharply over last N ticks, surface it

### Prompt updates
Update `AI_CIO_SYSTEM_PROMPT`:
- Add "STOCHASTIC LAYER" section explaining Markov state names + horizon meanings.
- Add "MOVE ARCHETYPE" section listing recognized archetypes and how to weight them.
- Add "TD9 + DIVERGENCE" rule: "TD setup_count >= 9 on D/4H AND trade is in direction of setup = REJECT (reversal due). Adverse divergence strength >= 30 on 30m+ = REJECT."
- Add "REGIME EXHAUSTION" rule: "regime_run_bars > 200 with exhausted=true on a continuation trade = ADJUST tighter SL or REDUCE size."

Update `AI_CIO_LIFECYCLE_PROMPT`:
- Add explicit HOLD math: "HOLD only when (a) regime_forecast.p_5_bar in trade-direction state > 0.5, (b) no adverse divergence firing, (c) HMM latent NOT in CHOP with posterior > 0.5, (d) no TD9 reversal signal."
- Add archetype-aware PROCEED: "For `fast_impulse_fragile` archetype, default PROCEED on any trim/exit. For `slow_grinder`, allow HOLD if regime_forecast.p_1h in direction > 0.55."

### Tests / verification
- Run `node --check` on each modified file
- `/timed/admin/ai-cio/probe` to confirm the larger prompt still returns valid JSON within 15s
- After next live entry, inspect `proposal_json` column in `ai_cio_decisions` D1 table to confirm all new fields land

## Rollback
Single revert of the commit. All additions are best-effort `?.` chains that no-op if the source field is missing.
