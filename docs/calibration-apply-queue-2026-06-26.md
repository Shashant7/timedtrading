# Calibration Apply Queue — 2026-06-26

Prioritized list of what to apply next, synthesized from:

- Week live scorecard (`docs/week-calibration-2026-06-26.md`)
- Full autopsy `cal_1782508713652` (644 trades, mixed live+replay)
- **Live-only autopsy `cal_1782510783746`** (615 trades, `run_id` empty since 2026-06-20)
- Production `model_config` + pending `learning_proposals`

Re-queue after live autopsy completes:

```bash
node scripts/queue-calibration-apply.mjs --report-id <live_report_id>
```

---

## Apply order (operator)

| # | Action | Tier | Bus | Status |
|---|--------|------|-----|--------|
| 0 | Week calibration guards (repeat churn, range-reversal, ATH confirm, pullback cap) | P1 | `apply-week-calibration-config.mjs` | **Applied** |
| 0 | config_hash unification + NVDA SL hard-exit | P0 | code deploy PR #855–857 | **Applied** |
| 1 | Verify NVDA exits at published SL; confirm EXIT `decision_record` | P0 | operational | **Acked (#5)** |
| 2 | Tighten time-scaled 4h max-loss `-2.0` → `-2.5` | tier1 | `learning_proposals` #8 | **Applied** |
| 3 | Blend `calibrated_sl_atr` `0.3` → `0.45` (toward autopsy `0.53`) | tier1 | `learning_proposals` #6 | **Applied** |
| 4 | Approve ATH breakout demotion (`tt_ath_breakout` blocked) | tier2 | `learning_proposals` #2 | **Applied** |
| 5 | Review support-bounce demotion (`tt_n_test_support`) — GEV open | tier2 | `learning_proposals` #1 | **Applied** |
| 6 | SHORT min rank `55` → `80` | tier2 | `learning_proposals` #7 | **Applied** |
| 7 | Discovery: widen trail ATR mult → 3 (churn) | tier2 | `learning_proposals` #4 | **Applied** |
| 8 | Discovery: investor accumulate floor 65 → 60 | tier2 | `learning_proposals` #3 | **Applied** |

---

## Already in production (no re-apply)

These match autopsy deep-audit recommendations #1–#3; do **not** duplicate:

| Key | Current value | Autopsy rec |
|-----|---------------|-------------|
| `deep_audit_max_loss_pct` | `{"normal":-2,"pdz":-5}` | Tighten max-loss fuse |
| `deep_audit_rsi_tp_delay` | `true` | Favor RSI exhaustion exits |
| `deep_audit_block_regime` | `"LATE_BULL"` | Block LATE_BULL entries |
| `deep_audit_avoid_hours` | `[12,13]` | Worst hour ET 13:00 |
| `deep_audit_time_scaled_max_loss_enabled` | `true` | Time-scaled fuse ON |
| `calibrated_tp_tiers` | trim 1.5 / exit 2.5 / runner 3.5 | Matches autopsy SL/TP rec |

---

## Do not apply (hold gates)

| Item | Reason |
|------|--------|
| `deep_audit_conviction_fusion_enabled` | Forward `decision_records` validation not cleared (~4 rows today) |
| `deep_audit_bleeder_shield_enabled` | Same — corpus OOS sizing negative |
| `POST /timed/calibration/apply` on diagnostic reports | `analysis_only: true` → `diagnostic_only=1` → API returns 409 |
| Full SL jump to 0.53 ATR | Walk-forward **WARNING**: IS SQN 3.92 → OS SQN −2.09 |
| Blind path disables from mixed corpus | Use live-only autopsy + edge scorecard per-path evidence |

---

## Live-only autopsy command

```bash
USE_D1=1 node scripts/calibrate.js \
  --since 2026-06-20 \
  --live-only \
  --skip-moves \
  --no-sync \
  2>&1 | tee /tmp/calibrate-live-only.log
```

Expect ~616 closed trades (`run_id` empty). **Completed:** report `cal_1782510783746` — 615 trades, WR 50.7%, SQN 2.94, PF 1.94, SL rec 0.51 ATR. WFO still WARNING (OS SQN −2.29). Deep-audit endpoint still reads all 644 trades (same 3 recs; all already in `model_config`).

Compare report to mixed `cal_1782508713652` before approving tier2 demotions.

---

## Rollback

- Config: `model_config_history` + `POST /timed/calibration/rollback`
- Learning bus: reject pending proposal in MC or `decideProposal(id, 'rejected')`
- Week guards: revert keys in `scripts/apply-week-calibration-config.mjs` (set to `false` / remove include list)

---

## Cadence

- **Daily (this week):** watch NVDA / NEU / GEV + `decision_records` accrual
- **Weekly:** `node scripts/analyze-week-activity.mjs --days 7`
- **After ~50 decision_records:** re-run forward validation (`docs/self-calibrating-loop.md` §4)
