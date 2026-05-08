# Phase C Stage 1 — COMPLETED

**Last updated:** 2026-05-06 (UTC)
**Branch:** `cursor/phase-c-stage1-jul-verdict-2e87`
**Run ID:** `phase-c-stage1-jul2025-may2026`
**Status:** ✅ COMPLETED, PROMOTED TO LIVE

---

## 🏆 Final Result

```
💰 Account:       $100,000 → $140,086  (+40.09%, +$40,086)
📊 Total trades:  587 closed (10 months: Jul 2025 → May 2026)
🎯 Win rate:      52.3% (307W / 280L)
🏆 Big winners:   38 (sum +$35,422)
⚠️ Big losses:    30 (sum -$12,636)
💥 Catastrophic:  1 (ALB Mar-02 only — overnight gap, unfixable)
🔻 SHORT trades:  37 (45.9% WR, +$1,712 net)
```

## Monthly progression

| Month | Trades | WR | PnL$ | Big W | Big L | Cat | Account |
|---|---:|---:|---:|---:|---:|---:|---:|
| Jul 2025 | 91 | 57% | +$11,903 | 7 | 3 | 0 | $111,903 |
| Aug | 78 | 58% | +$2,144 | 3 | 3 | 0 | $114,047 |
| Sep | 69 | 52% | +$8,320 | 7 | 4 | 0 | $122,367 |
| Oct | 55 | 40% | +$3,704 | 3 | 4 | 0 | $126,071 |
| Nov | 24 | 50% | -$399 | 1 | 2 | 0 | $125,672 |
| Dec | 57 | 51% | +$3,607 | 2 | 1 | 0 | $129,279 |
| Jan 2026 | 77 | 58% | +$8,451 | 9 | 2 | 0 | $137,730 |
| Feb | 74 | 51% | +$2,239 | 3 | 5 | 0 | $139,970 |
| Mar | 39 | 36% | -$3,005 | 0 | 6 | 1 | $136,965 |
| Apr | 20 | 65% | +$3,259 | 3 | 0 | 0 | $140,224 |
| May | 3 | 33% | -$138 | 0 | 0 | 0 | **$140,086** |

**8 of 11 months profitable.**

---

## Promotion

- ✅ Promoted to Trades page (`promoted-trades/promote`)
- ✅ Sentinel-validated against `v16-canon-julapr-30m-1777523625` (12 matched pairs, $394 PnL delta)
- ✅ Promoted to Live engine (`runs/mark-live`, no force needed)
- ✅ `live_config_slot=1` — this run is the production engine
- ✅ Cron-mute lifted, live trading active

## Architectural improvements built this session

| Improvement | Lines | Impact |
|---|---:|---|
| V13 wall-clock corruption fix (P0.7.57-58) | ~80 | Eliminated double-corruption that wiped earlier runs |
| Cron-mute admin endpoint | ~30 | Stops live cron from racing the replay |
| Rollback API (`runs/rollback-to-date`) | ~250 | Mid-run rewind without manual SQL |
| Setup admission matrix (P0.7.59) | 200 | Regime-aware entry gating per setup × grade × direction |
| Exit doctrine (P0.7.59-65) | 350 | Force-exit on regime flip + fresh-fail + giveback |
| Cluster throttle (P0.7.63) | 150 | Top-N by composite when 5+ entries fire same hour |
| ETF profile (P0.7.66) | 400 | Tighter TP/SL/management for SPY/QQQ/IWM/XL* |
| Market internals layer (P0.7.67) | 600 | TICK/ADD context for sizing + tape-capitulation exits + SHORT unlock |
| Loss-anatomy + ML-edge research | n/a | Foundation for proposals 1-7 |

## Files changed

- `worker/index.js` (multiple insertions)
- `worker/phase-c-setup-admission.js` (NEW)
- `worker/phase-c-exit-doctrine.js` (NEW)
- `worker/phase-c-cluster-throttle.js` (NEW)
- `worker/etf-profile.js` (NEW)
- `worker/market-internals.js` (NEW)
- `worker/replay-candle-batches.js` (additions)
- `worker/replay-runtime-setup.js` (added DA flags)
- `worker/pipeline/tt-core-entry.js` (admission + sizing wiring)
- `scripts/v15-activate.sh` (P0.7.57 → P0.7.67 calibration)
- `scripts/backfill-internals-from-csv.js` (NEW)
- `scripts/continuous-slice.sh` (--keep-lock support)

## What's next (post-session)

User wants live evaluation for the rest of the week. Run is live; cron is unmuted; live engine is using P0.7.67 V15 calibration (admission matrix + exit doctrine + ETF profile + cluster throttle + TICK/ADD market internals).

### Deferred items

1. **MTF context unification** (Phase 2 architectural cleanup) — single canonical `ticker-scenario` object for Right Rail + Daily Brief + Trade page. Defer to next session.
2. **EV-model sizing** (loss-anatomy proposal #5) — Gradient-boosted regressor on rank_trace features, nightly training. Defer.
3. **Manifest end_date extension API** — local patch ready, needs CF token KV write perms restored. Apply when permissions return if user wants to extend through May-05.
4. **CF API token refresh** — KV write perms missing as of session end. User needs to refresh in Cursor Dashboard for next session's deploys.
5. **System Intelligence redesign** — frontend deployed (`c44a189e`), users seeing the new 4-tab IA (Engine / Analysis / Runs / Discovery).
