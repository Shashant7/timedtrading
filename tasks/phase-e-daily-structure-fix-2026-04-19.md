# Phase E — Daily Structure Alignment + ETF/Short Activation

Date: 2026-04-19

## Mission

From the user (2026-04-19):

1. **Fix SPY/QQQ/IWM non-participation.** The Daily Brief actively predicts
   levels and price action for these three; there is no excuse for 0
   trades across 10 months. Find the true binding gate, not a guess.
2. **Kill the fakeout losers.** 29 clear losers are concentrated in
   overextension-above-D48 patterns and decelerating-D48-slope entries.
   Use Daily 21/48/200 EMA structure to filter.
3. **Enable SHORT-side trades.** In Mar 2026 (SPY −5.3 %, broke D200 Mar 6),
   the engine still took 6 LONGs and 0 SHORTs. `tt_short_pullback_not_deep_enough`
   fires 8,033 times; the SHORT path needs to be regime-activated by SPY's
   daily structure, not by each ticker's own daily ST flip.
4. Iterate until training months green, ETF trades present, shorts fire.

## Evidence from 10-month v2 synthesis (Jul 2025 – Apr 2026)

| Signal | Training months (Jul-Feb) |
|---|---|
| Trades / WR | 158 / 57.7 % |
| SPY / QQQ / IWM trades | 0 / 0 / 0 |
| Shorts | 0 |
| Clear losers (pnl ≤ −1.5 %) | 29 (sum −59 % pnl) |
| 22/24 clear losers analyzed in bull-stack (D21 > D48 > D200) | — |
| 10/24 clear losers overextended >5 % above D48 (vs 2/8 big winners) | — |
| `max_loss` cohort: median hold 25 h, 0 % WR | — |

### D-EMA structure comparison at entry (clear losers vs big winners)

| Metric | Clear losers (median, max) | Big winners (median, max) |
|---|---|---|
| `pct_above_e48` | +3.6 %, **+23.2 %** | +4.5 %, **+6.5 %** |
| `e21_slope_5d` | +0.9 %, +7.2 % | +1.3 %, +2.3 % |
| `pct_above_e200` | +12.4 %, +82 % | +17 %, +26 % |

**Fakeout signature**: entering long when pct_above_e48 > +7 % OR when
e21_slope_5d is flat (< +0.3 %) or parabolic (> +3 %). Winners live in a
tight band of "healthy-expansion" structure.

### ETF block-chain at setup stage (score ≥ 95, kanban=setup)

| State | Top blocks (SPY) |
|---|---|
| HTF_BULL_LTF_PULLBACK | `tt_no_trigger` 35, `tt_momentum_pullback_state_weak` 18, `tt_momentum_30m_5_12_unconfirmed` 6 |

SPY in HTF_BULL_LTF_PULLBACK with score=100 **never gets a trigger**.
`pullbackTrigger` requires `ltfConfirm = ltfRecovering || hasRsiDivBull`
which is strict for soft ETF pullbacks.

### Short-side block-chain (Mar 2026, downtrend, 8033 tt_short_pullback blocks)

- 8010 of 8033 at kanban=watch stage, state=HTF_BEAR_LTF_BEAR — meaning the
  ticker ALREADY confirmed bearish state but the SHORT pullback-depth gate
  still requires 2 of 3 LTF ST to be bearish → prevents entering on first
  pullback after a proper bearish state forms.

## Fix design (3 targeted changes)

### Fix 1 — `tt_index_etf_pullback` reclaim trigger (ETF-specific)

New SPY/QQQ/IWM-only entry trigger in `worker/pipeline/tt-core-entry.js`
that fires alongside `momentumTrigger`/`pullbackTrigger`/`reclaimTrigger`
when the engine detects an index ETF in the classic swing-dip context:

**Fires when ALL:**
- Ticker ∈ `deep_audit_index_etf_swing_tickers` (default `SPY,QQQ,IWM`)
- Side = LONG
- `state === "HTF_BULL_LTF_PULLBACK"` OR equivalent
- Daily structure bullish: `bD.px > bD.e21 > bD.e48 > bD.e200`
- `bD.e21_slope_5d` between `min_slope` (default 0.3 %) and `max_slope` (default 3 %)
- `pct_above_e48` between `min_dist` (default 1 %) and `max_dist` (default 7 %)
- Score ≥ `deep_audit_index_etf_swing_min_score` (default 92)
- 30m or 1h price has touched D21 or D48 in last 10 intraday bars
- RVol ≥ 0.7 (not dead)

**Symmetric SHORT trigger** when ticker ∈ ETF set AND
`state === "HTF_BEAR_LTF_BOUNCE"` AND daily bear-stack AND
`pct_below_e48` in valid band.

This gives us a well-gated ETF path that fires only when the daily structure
is clean — which is what the Daily Brief predicts on. DA keys:

```
deep_audit_index_etf_swing_enabled = true
deep_audit_index_etf_swing_tickers = SPY,QQQ,IWM
deep_audit_index_etf_swing_min_score = 92
deep_audit_index_etf_swing_pct_above_e48_min = 1.0
deep_audit_index_etf_swing_pct_above_e48_max = 7.0
deep_audit_index_etf_swing_e21_slope_min = 0.3
deep_audit_index_etf_swing_e21_slope_max = 3.0
deep_audit_index_etf_swing_rvol_min = 0.7
```

### Fix 2 — `tt_d_ema_overextended` universal fakeout gate

Universal pre-entry gate that rejects trades when daily EMA structure
signals overextension, **regardless of setup or score**:

**Rejects LONG when ANY:**
- `pct_above_e48 > deep_audit_d_ema_long_max_above_e48_pct` (default **7.0 %**)
- `e21_slope_5d > deep_audit_d_ema_long_max_e21_slope_pct` (default **+3.5 %**) AND `pct_above_e21 > 2.5 %` (parabolic-late-cycle)
- `e48_slope_10d < deep_audit_d_ema_long_min_e48_slope_pct` (default **+0.25 %**) AND `state` is a pullback/reclaim setup (flat-EMA fakeout)

**Rejects SHORT when ANY (mirror):**
- `pct_below_e48 > 7.0 %`
- `e21_slope_5d < −3.5 %` AND `pct_below_e21 > 2.5 %` (parabolic-down late)
- `e48_slope_10d > −0.25 %` AND state is short-pullback/bounce

This runs **inside `tt-core-entry.js` as a rejection in the entry pipeline**
between the trigger fires and the qualifyEntry call — so it observes all
paths and catches fakeouts from every source.

DA keys:
```
deep_audit_d_ema_overextension_gate_enabled = true
deep_audit_d_ema_long_max_above_e48_pct = 7.0
deep_audit_d_ema_long_max_e21_slope_pct = 3.5
deep_audit_d_ema_long_min_e48_slope_pct = 0.25
deep_audit_d_ema_short_max_below_e48_pct = 7.0
deep_audit_d_ema_short_max_e21_slope_pct = -3.5
deep_audit_d_ema_short_max_e48_slope_pct = -0.25
```

### Fix 3 — SPY-regime-activated SHORT pullback depth relaxation

Mirror T6A's index-ETF DA pattern but for the SHORT pullback-depth gate
AND for the `ctx_short_daily_st_not_bear` gate, and activate when SPY's
daily structure is bearish (not each ticker's daily ST):

**Change `tt_short_pullback_not_deep_enough` (tt-core-entry.js L966-976):**
- If `spy_bearish_regime === true`, require `bullishPullbackCount >= 1` (not 2)
- `spy_bearish_regime` = SPY bD.px < SPY bD.e48 AND SPY bD.e21 < SPY bD.e48

**Change `ctx_short_daily_st_not_bear` (worker/index.js L3722-3725):**
- Allow bypass when SPY's daily structure is bearish AND ticker's daily ST
  is neutral (stDir=0) — because in a broad market decline, individual
  tickers lag. Keep the gate when ticker's daily ST is explicitly bullish (+1).

DA keys:
```
deep_audit_short_spy_regime_relax_enabled = true
deep_audit_short_spy_regime_min_px_below_e48_pct = 0.1
deep_audit_short_allow_neutral_daily_st_when_spy_bear = true
```

## Execution plan

1. Implement the three worker edits (tt-core-entry.js + worker/index.js
   context-gate + replay-runtime-setup.js DA whitelist).
2. Deploy worker to both environments; record Version IDs.
3. Smoke test each gate with a targeted probe (SPY 2025-07-08, SPY 2026-03-19,
   AGQ 2026-01-15) to verify the new paths trigger / the new gates reject.
4. Apply T6A + new DA keys to model_config.
5. Run 10-month v3 rerun on the 24-ticker universe, deterministic.
6. Compare v3 vs v2 in synthesis; iterate if a month is still red or zero shorts.
7. Validate on 2026-03 / 2026-04 holdouts only AFTER training-month metrics
   meet the bar.
8. PR.

## Acceptance criteria

- [ ] Every training month green (sum_pnl_pct > 0)
- [ ] ≥ 1 SPY/QQQ/IWM trade in 4+ training months
- [ ] ≥ 1 SHORT trade in Feb + Mar 2026 (the bearish months); ideally 3+
- [ ] Training WR ≥ 62 % (up from 57.7 %)
- [ ] Big winner count stable or up (≥ 12)
- [ ] Clear-loser sum_pnl cut by 50 % (from −59 % to ≤ −30 %)
- [ ] Holdout validation: Mar 2026 no worse than −1 %, Apr 2026 green
