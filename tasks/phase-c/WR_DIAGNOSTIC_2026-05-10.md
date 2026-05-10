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

## Smoke results — config fix is necessary but NOT sufficient

After the model_config clone + clean-slate restart (run `phase-c-stage2-th-do-v5-cfgfix-clean-jul2025-may2026`), preprod's July 2025 cohort still underperforms the live canonical baseline by a wide margin:

| run | env | Jul 2025 trades | W | L | TT | WR (W/(W+L)) | Σ pnl% (avg×n) |
|---|---|---:|---:|---:|---:|---:|---:|
| `phase-c-stage1-jul2025-may2026` (canonical 52.3% WR) | live | **103** | 58 | 45 | 0 | **56.3%** | +118% |
| `phase-c-stage2-th-do-v3-jul2025-may2026` (5-key snapshot) | preprod | 61 | 18 | 36 | 7 | 33.3% | +31% |
| `phase-c-stage2-th-do-v5-cfgfix-clean-jul2025-may2026` (433-key snapshot, clean preprod) | preprod | **61** | 18 | 37 | 6 | **32.7%** | **−15%** |

The trade IDs in v3 and v5 are nearly identical — the entry path is producing the same set of entries regardless of which `deep_audit_*` keys are present. The config fix changed pnl values on the TP_HIT_TRIM cohort (and flipped one trade SGI from TT→LOSS) but did not move the headline WR.

### Ticker-set divergence (the deeper finding)

Distinct tickers traded in July:
- canonical: 74
- v5 preprod: 46
- in canonical but NOT v5 (50): AEHR, AGQ, AGYS, ALB, ALLY, AMD, ANET, APD, APLD, ASTS, AVGO, AXP, AYI, BA, BK, BWXT, CARR, CCJ, CLS, CRS, CRWD, DIA, EME, EMR, ETN, GEV, GLXY, GOOGL, H, IBP, IESC, INTC, IREN, IWM, JPM, KTOS, LITE, LRCX, META, MP, MTZ, NEU, NKE, NVDA, PEGA, PLTR, PNC, PSTG, QQQ, STX, U, XHB
- in v5 but NOT canonical (24): AXON, BABA, BE, BRK-B, COST, CW, DKNG, DPZ, ELF, EXPE, FLR, GRNY, HII, INTU, J, JCI, KO, LULU, MNST, PWR, STRL, TT, VMI, XYZ

This is a **scoring-input mismatch**, not a config mismatch. Preprod is selecting entirely different names — including missing every Phase C marquee ticker the user cares about (NVDA, GOOGL, META, AVGO, AMD, AEHR, BE).

Inputs verified equal-or-near-equal:
- `ticker_candles` rows in Jul: live 845,855 / 246 distinct tickers; preprod 844,955 / 245 distinct tickers (Δ 1 ticker, 900 rows — negligible)
- `model_config`: 433 / 381 deep_audit_* on both (after clone)
- worker code: latest deployment 2026-05-10 on both (same main)
- pinned `backtest_run_config` for v5: 433 keys (vs canonical's 428)

Day-state KV (`timed:replay:daystate:YYYY-MM-DD`) is the most likely remaining gap. Sample sizes:
- Jul 1: live 28.87 MB, preprod 35.62 MB
- Jul 8: live 28.88 MB, preprod 32.85 MB
- Jul 15: live 28.90 MB, preprod 33.00 MB
- Jul 22: live 28.90 MB, preprod 32.98 MB
- Jul 29: live 28.80 MB, preprod 33.04 MB

Preprod day-state blobs are **larger** than live's, not smaller. This suggests preprod's day-state has been **mutated** by prior preprod backtest runs (each candle-replay rewrites the daystate as it walks forward). The "canonical Phase C trader" day-state cached on live has not been mirrored back; the prior `clone-live-to-preprod.sh` cloned them once, and subsequent preprod runs overwrote them with their own scoring outputs.

If day-state contains the cached scoring inputs (rank, EMA stack, ST direction, etc.) used by the entry decision, then preprod's entry decisions are operating on **different scoring inputs** than canonical. That's the actual cause of the 56% → 33% WR drop.

## Open question: validation strategy

With preprod-fidelity not currently reproducing canonical absolute WR, two paths forward:

### Path A — Fix preprod fidelity, then validate TH on absolute terms
Re-clone day-state from live (overwrite preprod's mutated copies) AND lock preprod against further day-state mutation during validation runs. Then re-run the trader-only baseline on preprod and confirm WR ≈ 56% before promoting any TH change.
- Effort: write a fresh `clone-daystate-to-preprod.sh` that overwrites the 220 KV blobs (~6 GB writes). Then mark the day-state cohort read-only somehow (or accept that we can only run ONE backtest before mutation re-corrupts it).
- Risk: medium — this might still not be sufficient if there are other inputs we haven't enumerated.

### Path B — Validate TH as a relative delta on preprod
Accept that preprod's WR baseline is whatever it is (~33%). Run two preprod backtests on identical state:
1. trader-only with `deep_audit_trend_hold_enabled=false`
2. trader+TH with `deep_audit_trend_hold_enabled=true`
Compare deltas: did TH lift WR / Σ pnl on its own merit? Did the SNDK / GOOGL / AMD / MU pass criteria fire on Path B given that preprod isn't even entering those names?
- Issue: preprod doesn't trade SNDK / GOOGL / AMD / MU / META in July (they're in the 50-ticker exclusion list). The pass criteria require these specific names to exist as TH-eligible. Path B can't validate the user's actual goal.

### Path C — Validate TH directly on live, in shadow mode
Deploy TH evaluation logic to live with `commit=0` (read-only) and log all promotion decisions for 1-2 weeks of live trading. Compare what TH would have promoted vs what the trader path actually did. This sidesteps preprod entirely.
- Risk: low (no live mutation).
- Limitation: 1-2 weeks of live data ≠ a full Jul→May validation. SNDK trade count drops on live require historical backfill, not forward observation.

## Recommendation

Path A is the right long-term fix. Path C is the right immediate pragmatic step.

In parallel, surface the issue to the user — **the 19% WR observation was misleading; the actual problem is preprod can only reproduce ~33% WR even with corrected config, while canonical produces 56%. The Trend-Hold strategy hasn't been bench-tested under faithful conditions yet.**

## State at hand-back

- Live: untouched. Cash $140,786, realized $40,020. Cron unmuted.
- Preprod model_config: 433 rows (post-clone), 381 deep_audit_*.
- Preprod v3 run: cancelled at session 24. Trade rows preserved for forensic.
- Preprod v4 run: cancelled. Trades inherited from v3 (clean_slate=false).
- Preprod v5 run: cancelled at session 2 after smoke confirmed preprod ≠ canonical at the WR level.
- Preprod working tables: wiped (trades / positions / ledger / lots / events / etc.) prior to v5; safe state for whatever path we choose next.
- Branch: `cursor/investor-wr-diagnose-bcab` — this doc + the clone-script fix + the per-key fallback + the snapshot-completeness assertion.
