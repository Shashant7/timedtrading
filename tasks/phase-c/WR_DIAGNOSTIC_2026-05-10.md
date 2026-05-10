---
title: Investor-Mode WR Diagnostic — root cause and fix for the 19% WR preprod backtest
created: 2026-05-10
agent: cursor/investor-wr-diagnose-bcab
related: tasks/phase-c/HANDOFF_NEW_AGENT_2026-05-10.md, tasks/phase-c/INVESTOR_BACKTEST_AND_TREND_HOLD_PLAN.md
---

# WR Diagnostic — Why the v3 backtest produced 19% WR (and how v4 fixes it)

## TL;DR

The preprod run `phase-c-stage2-th-do-v3-jul2025-may2026` was running with an **incomplete config snapshot** — only 5 keys in `backtest_run_config` vs the 428 keys pinned by the canonical Phase C trader baseline. **376 of the 376 shared keys had identical values to the canonical run**, but 376/381 `deep_audit_*` keys were never even loaded into preprod's `model_config`. They silently fell back to **hard-coded code defaults** for the entire run.

Hypothesis C from the handoff (**config drift**) was right in spirit, but the failure mode is sharper than "drift": preprod's `model_config` was **never fully populated** in the first place. The clone script (`scripts/clone-live-to-preprod.sh:79-92`) only seeds 12 explicitly listed keys.

The `loadReplayRuntimeConfig` path (`worker/replay-runtime-setup.js:677-682`) treats the partial pinned snapshot as authoritative — it does NOT per-key fall back to `model_config` for missing entries. Combined with a partial preprod `model_config`, this means the run executed with whatever default constants the worker code happened to ship with, not the canonical Phase C trader gates.

## Action taken (this session, 2026-05-10 18:25 UTC)

1. **Cancelled** v3 run mid-flight (session 24/220, 25 trades, 4W/17L = 19% WR).
2. **Bulk-cloned** all 433 live `model_config` rows into preprod via `wrangler d1 execute --file=` against `timed-trading-ledger-preprod`.
3. **Re-applied** the 3 explicit TH overrides on preprod:
   - `deep_audit_trend_hold_enabled = "true"`
   - `deep_audit_trend_hold_max_positions = "6"`
   - `deep_audit_exit_doctrine_enabled = "true"` (already true on live, no override delta)
4. **Verified** preprod model_config: 433 total rows, 381 `deep_audit_*` keys.
5. **Started** v4 run `phase-c-stage2-th-do-v4-cfgfix-jul2025-may2026` with identical params (`trader_only=true`, 5m interval, batch 30, keep-open, low-write).
6. **Verified** v4 pinned snapshot: 433 keys (vs v3's 5).

## Forensic numbers

### Config snapshot comparison

| run | env | source | rows in `backtest_run_config` | rows with `deep_audit_*` |
|---|---|---|---:|---:|
| `phase-c-stage1-jul2025-may2026` (canonical 52.3% WR baseline) | live | `scripts/full-backtest.sh` | 428 | 376 |
| `phase-c-stage2-th-do-v3-jul2025-may2026` (broken 19% WR) | preprod | DO `snapshotConfig` from preprod model_config | 5 | 3 |
| `phase-c-stage2-th-do-v4-cfgfix-jul2025-may2026` (this session) | preprod | DO `snapshotConfig` after full clone | **433** | **381** |

### `model_config` table comparison

| env | total rows | `deep_audit_*` rows |
|---|---:|---:|
| live | 433 | 381 |
| preprod (before fix) | 5 | 3 |
| preprod (after fix) | 433 | 381 |

### Drift check (live current vs canonical phase-c-stage1)

376 shared `deep_audit_*` keys, **0 with differing values**. Live has 5 keys added since the canonical run (3× `ai_cio_*`, 2× `trend_hold_*`). The Phase C trader gates are byte-identical on all 376 shared keys.

So: cloning today's live `model_config` faithfully reproduces the canonical Phase C config except for the 5 new keys, all of which we want the new behavior of (or are explicitly overridden).

### v3 loss profile (the symptom)

17 LOSS trades by exit reason (top of chart):

| exit reason | n | sample tickers |
|---|---:|---|
| `doctrine_force_exit` | 5 | BABA −1.96, KWEB −1.59, ITT −1.45, MNST −0.87, XYZ −0.24 |
| `atr_day_adverse_382_cut` | 5 | JCI −0.79, FIX −0.66, SPY −0.66, STRL −0.64, CAT −0.32 |
| `phase_i_mfe_fast_cut_2h` | 4 | LULU, ARM, BG, DKNG |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 2 | AMZN −1.20 (4.93% MFE!), APP −0.21 (2.18% MFE) |
| `atr_week_618_full_exit` | 2 | ELF, AA |
| `thesis_flip_htf` | 2 | BG −0.66, GE −0.21 |
| various | 5 | runner_drawdown_cap, max_loss_time_scaled, sl_breached, atr_tp_ladder_runner_full, adv_div_dead_money_be_cut |

All 17 LOSSes had `trend_hold_state = null` — TH never engaged. So the bad WR is purely the **trader path running with default-instead-of-canonical exit thresholds**. Specifically the threshold-driven exits (`doctrine_force_exit`, `atr_day_adverse_382_cut`, `phase_i_mfe_fast_cut_2h`) read their cutoffs from `deep_audit_*` keys that weren't in the pinned snapshot.

### Loss-cause mapping to missing config

The exit reasons firing most often map directly to gates whose tuning lives in keys that were missing from the v3 snapshot:

| exit reason | keys that tune it | in v3 pin? |
|---|---|---|
| `doctrine_force_exit` | `deep_audit_doctrine_*` (multiple) | NO |
| `atr_day_adverse_382_cut` | `deep_audit_atr_adverse_cut_*` (5 keys) | NO |
| `phase_i_mfe_fast_cut_2h` | `deep_audit_phase_i_mfe_*` (multiple) | NO |
| `thesis_flip_htf` | `deep_audit_thesis_flip_*` (3 keys) | NO |
| `atr_week_618_full_exit` | `deep_audit_atr_week_618_*` (2 keys) | NO |
| `max_loss_time_scaled` | `deep_audit_time_scaled_max_loss_*` (4 keys) | NO |
| `adv_div_dead_money_be_cut` | `deep_audit_adv_div_dead_money_*` (5 keys) | NO |

Every prominent exit-reason in the v3 LOSS distribution maps to a config key that was missing from the snapshot, falling through to the worker's hard-coded defaults. Those defaults are tighter than the canonical Phase C tuned values, hence the early cuts and the bad WR.

## Why the partial snapshot wasn't loud enough to catch earlier

Three failure modes interacted to mask the problem:

1. `scripts/clone-live-to-preprod.sh:73-99` calls itself out: *"For full clone we'd need an /admin/model-config?action=list endpoint; for now we replicate the keys we explicitly know matter for Phase 3 + Phase 4 validation."* — i.e. partial-clone was a known TODO, not a bug.
2. `worker/backtest-runner-do.js:165-225` (`snapshotConfig`) writes whatever `model_config` has at the time the run starts. With a 5-row preprod `model_config`, the snapshot is 5 rows. Function returns success.
3. `worker/replay-runtime-setup.js:606-702` (`loadReplayRuntimeConfig`) treats `replayRunConfig` as authoritative if it's non-null — `if (replayRunConfig) { for (const key of REPLAY_DA_KEYS) … }`. There is **no per-key fallback** to `model_config` if `replayRunConfig[key]` is undefined. This is the silent step that converts "partial snapshot" into "default values for ~85 deep_audit_* keys without warning".

## Architectural follow-ups (filed in this PR)

1. **Make `clone-live-to-preprod.sh` do a true full clone** (dump live `model_config` to JSON, restore via `wrangler d1 execute --file=`). Already executed manually this session — this PR captures the SQL pipeline so the next env-bringup is one command.
2. **Per-key live-fallback in `loadReplayRuntimeConfig`** when a pinned snapshot lacks a `REPLAY_DA_KEYS` entry — promotes silent defaults to a loud `console.warn` and reads from `model_config` as a backstop. (Risk: low. Behavior change: only fires when a snapshot is partial, which previously produced the silent-default behavior diagnosed above.)
3. **Snapshot-completeness assertion** at run-start: log a warning if `backtest_run_config` row count for the new run is less than ~80% of the size of `model_config` at start time. (Defensive; cheap.)

## Validation plan for the v4 run

Smoke check on **first 22 sessions** (covering all of July 2025, the same window the v3 run produced its 19% WR slice on). Pass criterion:

- WR ≥ 45% on the July 2025 trade set
- No new exit reason categories firing that the canonical phase-c-stage1 didn't show
- TH lifecycle eval is reachable (we expect 1-3 promotions in July; v3 had 0)

If smoke passes, let v4 run all 220 sessions (~13h). If smoke fails, the v3-style WR is **not** caused by the partial config alone, and we re-investigate (Hypothesis B — TH eval timing — is the next candidate).

After full run completes, validate against `tasks/phase-c/PHASE_3_DESIGN.md` SNDK pass criterion (≥1 SNDK trade with pnl ≥50%, Σ SNDK pnl ≥200%, no SNDK closes via the 5 suppressed reasons) and the March 2026 regression guard (`trader_th_mar pnl% NOT < trader_only_mar - 1.0%`).

## State at hand-back

- Live: untouched. Cash $140,786, realized $40,020. Cron unmuted.
- Preprod model_config: 433 rows (post-clone), 381 deep_audit_*.
- Preprod v3 run: cancelled at session 24. Trade rows preserved for forensic compare.
- Preprod v4 run: queued, alarm-driven. Monitor: `https://timed-trading-ingest-preprod.shashant.workers.dev/backtest-monitor?key=…&run_id=phase-c-stage2-th-do-v4-cfgfix-jul2025-may2026`
- Branch: `cursor/investor-wr-diagnose-bcab` — this doc + the clone-script fix + the per-key fallback.
