# July Readiness Review — 2026-06-26

July is the anchor month for the backtest ladder (Jul → Apr recovery complete).
This review compares **July 2025 backtest baselines** to **today's live model** so
the operator can spot logic drift before the first full month replay.

Re-run July slice:

```bash
export TIMED_API_KEY=<admin-key>
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v2 \
  --label=phase-d-slice-2025-07-v2 --tickers=tier1-tier2 --block-chain
```

---

## Why July matters

| Fact | Implication |
|------|-------------|
| First month of the Jul→Apr promotion ladder | Acceptance gates were written against July WR / PnL |
| **82% HTF_BULL_LTF_BULL** backdrop in Jul 2025 | Long-biased month; SHORT paths underrepresented |
| Phase C anchor: **76% WR, +26% sum pnl_pct** (25 trades, 24-ticker universe) | Bar to beat on equal universe |
| Wider Jul–Aug lane: **55% WR, SQN 2.38, PF 2.34** (78 trades) | Shows breadth vs concentrated slice |

July rewards: **rank ≥ 90 entries**, **MFE proportional trail** exits, **gap reversal +
pullback** paths, letting winners run (>7d hold bucket best in live autopsy).

---

## July 2025 baseline scorecard

### Phase C slice (`phase-c-slice-2025-07-v1`) — canonical 24-ticker anchor

| Metric | Value |
|--------|-------|
| Trades | 25 (19W / 6L) |
| Win rate | **76.0%** |
| Sum `pnl_pct` | **+26.05%** |
| Big winners (≥5%) | 2 (AGQ +10.3%, CDNS +5.6%) |
| Direction | 25 LONG / 0 SHORT |
| Engine | `tt_core` entry + management |

**Exit mix:** `mfe_proportional_trail` (6), `TP_FULL` (3), `max_loss` (3),
`HARD_FUSE_RSI_EXTREME` (2 big winners).

**Rank edge:** rank ≥ 90 → 84.2% WR (19 trades); rank < 90 → 50% WR (6 trades).

Source: `data/trade-analysis/phase-c-slice-2025-07-v1/report.md`

### Wide universe Jul–Aug (`backtest_2025-07-01_2025-08-08@…`)

| Metric | Value |
|--------|-------|
| Trades | 78 |
| WR / SQN / PF | 55.1% / **2.38** / **2.34** |
| Avoidable losses | 18/34 losses; **12 against_regime** (−30.6% damage) |
| Weakest state | `HTF_BULL_LTF_PULLBACK` — WR 42.9%, SQN 0.66 |
| Best regime class | `TRANSITIONAL` — WR 68.4%, SQN 2.61 |

Source: `data/trade-intelligence-backtest_2025-07-01_2025-08-08_…json`

### v16 wide baseline (108 trades, July only)

WR **54.6%**, sum PnL% **+93.1%**. Dominant paths: `tt_gap_reversal_long`,
`tt_pullback`, `tt_n_test_support`. SPY/QQQ/IWM **did** trade in this lane
(pullback / gap) vs zero in Phase C slice.

Source: `data/trade-analysis/v16-ctx4-jul-oct-1777398500/baseline-july.json`

---

## Known July pathologies (from recovery docs)

| Issue | Tickers / paths | Root cause |
|-------|-----------------|------------|
| Bad entries, opposed LTF | INTU, ORCL, UNP, **RIOT** | Structure not aligned at entry |
| Missed capture | **XLY** | `tt_pullback_not_deep_enough`, `tt_no_trigger` |
| Zero index entries | SPY, QQQ, IWM (Phase C) | Pullback depth + rank floor 90 |
| Earnings cluster losses | CDNS, SGI Jul 28–31 | `max_loss` into Jul 28–30 cluster |
| Early runner cuts | ETN, GOOGL | `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` |
| Momentum bleed | `tt_momentum` | 13/15 in loser evidence bucket |

---

## Live model vs July backtest — major deviations

Changes since the Phase C / v16 July runs that **will change July replay output**:

### Entry gates (likely fewer bad entries, possibly fewer total entries)

| Change | Live config / code | July impact |
|--------|-------------------|-------------|
| ATH breakout confirm gate | `deep_audit_ath_breakout_confirm_gate_enabled=true` (5 min + 3 cycles) | Fewer IWM-style false breaks; **lower ATH capture** |
| ATH breakout demotion | `deep_audit_setup_demotion_TT Tt Ath Breakout_long=blocked` | Blocks ATH long admissions (KV matrix still primary) |
| Range reversal adverse phase | `deep_audit_range_reversal_block_adverse_phase=true` | Blocks NVDA-style adverse 15m div entries |
| Support bounce demotion | `deep_audit_setup_demotion_TT Tt N Test Support_long=blocked` | May reduce `tt_n_test_support` (90d PF 0.19) |
| Repeat churn guard | global + GRNY/PH/CRDO/MOD/GRNJ include list | Stops same-day SL re-entry loops |
| Pullback liquidity cap | avg vol < 500k → notional cap | Smaller GRNJ-style overnight risk |
| Block LATE_BULL | `deep_audit_block_regime=LATE_BULL` | Jul is mostly EARLY/STRONG_BULL — **low impact** |
| Avoid hours 12–13 ET | `deep_audit_avoid_hours=[12,13]` | Skips worst live hour; Jul backtest had lunch entries |
| SHORT min rank 80 | was 55 | Jul was 100% LONG in Phase C slice — **minimal** |
| Tighter SL ATR | `calibrated_sl_atr=0.45` (was 0.3) | Tighter stops vs July MFE-trail winners |
| Time-scaled max-loss 4h | `-2.5%` (was −2.0) | Faster cuts on slow losers |

### Exit / management (likely tighter, less bleed)

| Change | Impact |
|--------|--------|
| `deep_audit_trail_atr_mult=3` | Wider runner trail — **more room** vs round-trip failures |
| `deep_audit_rsi_tp_delay=true` | Delays fixed TP when RSI trending — **more left_money → RSI exits** |
| NVDA SL hard-exit (`sl-hard-exit.js`) | Live only; enforces published SL on stale marks |
| Bleeder shield | **OFF** — no change vs July backtest |
| Conviction fusion sizing | **OFF** — no change vs July backtest |

### Provenance (no PnL change)

| Change | Notes |
|--------|-------|
| `decision_records` + `config_hash` | Attribution only; shipped mid-June 2026 |
| `loadDeepAuditConfigFromDb()` | Same config fingerprint on all paths |

### Structural gaps to watch

1. **Setup demotion keys** are in `model_config` but admission blocking is primarily
   the phase-c KV matrix (`phase-c-setup-admission.js`). Demotion keys are audit
   trail until wired to `admitSetup()`.
2. **SPY/QQQ/IWM gap** — Phase C had zero entries; v16 had pullbacks. Current
   model still uses pullback depth + rank floors unless index override is ON.
3. **WFO WARNING** on live autopsy (OS SQN negative) — aggressive SL tightening
   may hurt July's let-winners-run profile.

---

## Deviation verdict

| Area | Drift vs July anchor | Risk |
|------|---------------------|------|
| Entry count | **Down** (more gates, demotions, avoid hours) | Miss July capture on ATH / support / lunch setups |
| Entry quality | **Up** (adverse phase, ATH confirm, churn guard) | Fewer RIOT/NVDA-style bad entries |
| Exit capture | **Mixed** (tighter SL + wider trail + RSI TP delay) | May trim AGQ/CDNS winners differently |
| Index ETFs | **Still gated** unless override | SPY target WR not evaluable |
| Regime fit | **Aligned** for Jul 2025 uptrend (LONG-heavy, block LATE_BULL low impact) | |

**Net:** Live model is **more defensive** than the July anchor. Expect **higher quality,
fewer trades, possibly lower sum pnl_pct** on a straight replay unless index/ATH
relaxations are intentionally enabled for July.

---

## Pre-July checklist (recommended)

1. **Re-run July monthly slice** with current `model_config` → compare to
   `phase-c-slice-2025-07-v1` on WR, trade count, exit mix, big winners.
2. **Path scorecard** — gap reversal, pullback, ATH, support bounce separately.
3. **Index probe** — confirm SPY/QQQ/IWM rejection reasons still logged
   (`tt_pullback_not_deep_enough`, rank floor).
4. **Wire setup demotion → admission matrix** OR merge demotion into KV matrix
   before relying on demotion keys.
5. **Hold OFF:** conviction fusion, bleeder shield until `decision_records` ≥ 50.
6. **Monitor:** earnings-week entries (Jul 28–30 cluster pattern).

---

## Commands

```bash
# Trade intelligence on archived July run
USE_D1=1 node scripts/trade-intelligence.js \
  --run-id phase-c-slice-2025-07-v1 --json

# Calibrate archived July
USE_D1=1 node scripts/calibrate.js --run-id phase-c-slice-2025-07-v1 --since 2025-07-01

# Weekly live scorecard (forward)
node scripts/analyze-week-activity.mjs --days 7
```
