# July Readiness Review — 2026-06-26

July is the anchor month for the backtest ladder (Jul → Apr recovery complete).
This review compares **July 2025 backtest baselines** to **today's live model** so
the operator can spot logic drift before the first full month replay.

Re-run July slice (preprod, current config):

```bash
node scripts/sync-model-config-to-preprod.mjs
curl -X DELETE -H "X-API-Key: $TIMED_API_KEY" \
  https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/cron-mute
export TIMED_API_KEY=<admin-key>
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v2 \
  --label=phase-d-slice-2025-07-v2 --tickers=tier1-tier2 --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```

**Status:** ✅ Completed 2026-06-27 on preprod (`phase-d-slice-2025-07-v2`).
Full comparison: `data/trade-analysis/phase-d-slice-2025-07-v2/report.md`.

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

## Phase D replay results (`phase-d-slice-2025-07-v2`)

Preprod replay with **493 production `model_config` keys synced** (2026-06-27).
22 sessions, ~58 min wall-clock. Same 24-ticker universe as Phase C anchor.

### Headline vs Phase C anchor

| Metric | **v2 (current config)** | **v1 anchor** | Δ |
|--------|------------------------|---------------|---|
| Trades | **42** | 25 | +17 (+68%) |
| Win rate | **45.2%** | 76.0% | −30.8 pp |
| Sum `pnl_pct` | **+25.64%** | +26.05% | −0.41 pp |
| Big winners (≥5%) | 2 | 2 | — |
| Clear losers (≤−1.5%) | 2 | 3 | −1 |
| SPY+QQQ+IWM entries | **15** | 0 | +15 |

**Verdict:** Return parity on equal-weight sum pnl_pct, but **much noisier**
(+68% trade count, WR cut nearly in half). The pre-replay hypothesis
("fewer trades, higher quality") was **wrong**.

### What changed vs anchor

| Dimension | v2 observation |
|-----------|----------------|
| Entry paths | ATH breakout **17** (dominant); pullback 13; support 8; range reversal 4 |
| Index ETFs | **15 trades** (IWM 7, SPY 5, QQQ 3) — anchor had zero |
| Exit mix | SL breach 13 + capitulation force 13 vs anchor MFE trail 6 + TP 3 |
| Big winners | Still 2 — return held via breadth, not quality |

### Why predictions missed

1. **Setup demotion keys not wired** — `deep_audit_setup_demotion_*` in
   `model_config` does not block admission; KV matrix still admits ATH/support.
2. **Index ETF overrides likely ON** in synced config — unlocks SPY/QQQ/IWM
   entries the anchor never produced.
3. **Tighter SL (0.45 ATR)** raised `sl_breached` count but breadth compensated.
4. **ATH confirm gate** did not suppress ATH volume — STRONG_BULL/EARLY_BULL
   still admit ATH entries through the admission matrix.

---

## Deviation verdict (updated post-replay)

| Area | Pre-replay guess | **Actual v2 replay** | Risk |
|------|-----------------|----------------------|------|
| Entry count | Down | **Up (+68%)** | More churn; lower live WR expectation |
| Entry quality | Up | **Down (45% WR)** | Noise masked by breadth |
| Exit capture | Mixed | **More SL + force exits** | Less MFE-trail profit-taking |
| Index ETFs | Still gated | **15 entries unlocked** | Major logic-path deviation |
| Sum pnl_pct | Possibly lower | **−0.41 pp (flat)** | Return OK; quality not OK |

**Net:** Current config is **broader and noisier**, not more defensive. July live
monitoring should expect **~45% WR with similar PnL% ceiling** if breadth holds —
not the anchor's 76% WR profile.

**Improvement path:** See `docs/july-slice-v2-improvement-plan.md`. Top lever:
revert index ETF unlocks (P0) — counterfactual removes 15 trades at −4.59% and
raises WR to 59% / pnl to +30.2% on the same ledger.

---

## Pre-July checklist (recommended)

1. ~~**Re-run July monthly slice**~~ ✅ Done — see `phase-d-slice-2025-07-v2/report.md`.
2. **Path scorecard** — gap reversal, pullback, ATH, support bounce separately.
3. **Index probe** — v2 shows 15 index entries; audit
   `deep_audit_pullback_*_index_etf*` keys in synced config and block-chain
   for admission reasons (override vs rank floor).
4. **Wire setup demotion → admission matrix** — priority; demotion keys did
   not reduce ATH volume in v2 replay.
5. **Block-chain diff** — `compare-block-chains.js` on v1 vs v2 to explain
   capitulation-force exit spike (13 vs anchor's 0).
6. **Hold OFF:** conviction fusion, bleeder shield until `decision_records` ≥ 50.
7. **Monitor:** earnings-week entries (Jul 28–30 cluster pattern).

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
