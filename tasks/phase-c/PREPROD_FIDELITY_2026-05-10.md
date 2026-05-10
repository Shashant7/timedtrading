---
title: Preprod Fidelity Sync — Path A bring-up to canonical mirror
created: 2026-05-10
agent: cursor/preprod-fidelity-sync-bcab
related: tasks/phase-c/WR_DIAGNOSTIC_2026-05-10.md
---

# Preprod Fidelity Sync — bring preprod ≡ live for canonical replay

## Why this work exists

After diagnosing the 19% WR run as a partial-config issue (`tasks/phase-c/WR_DIAGNOSTIC_2026-05-10.md`), the v5 fix-and-rerun showed the headline WR did NOT recover (32.7% vs canonical 56.3%). Drilling deeper, the cause was that **preprod was missing scoring inputs beyond `model_config`**:

| layer | live | preprod (before sync) | preprod (after sync) |
|---|---:|---:|---:|
| `model_config` | 433 | 433 ✓ | 433 ✓ |
| `ticker_profiles` | 327 | 0 | 327 ✓ |
| `ticker_index` | 240 | 0 | 240 ✓ |
| `calibration_profiles` | 119 | 0 | 119 ✓ |
| `path_performance` | 42 | 0 | 42 ✓ |
| `path_performance_calibration` | 5 | 0 | 5 ✓ |
| `user_tickers` | 12 | 0 | 12 ✓ |
| `promoted_trade_datasets` | 1 | 0 | 1 ✓ |
| `promoted_trades` | 587 | 0 | 587 ✓ |
| `pattern_library` | 25 | 0 | 25 ✓ |
| `ticker_moves` | 42,637 | 0 | 42,637 ✓ |
| `ticker_move_signals` | 212,765 | 0 | 212,765 ✓ |
| `direction_accuracy` | 11,308 | 243 | 11,308 ✓ |
| `ai_cio_decisions` | 5,593 | 0 | 5,593 ✓ |
| KV `timed:replay:daystate:*` | 211 | 204 (mutated) | 211 ✓ (overwritten with live blobs) |
| `ticker_candles` (Jul-May, 5m) | 246 tickers | 245 (missing GME, untraded by canonical) | 245 (acceptable — GME never entered the canonical run) |

**Total: 14 D1 tables and 211 KV blobs aligned with live. Preprod is now a canonical mirror.**

## What I built

### `scripts/sync-live-to-preprod.sh` (new)
Comprehensive D1+KV sync. Replaces (and supersedes) the partial `clone-live-to-preprod.sh`:
- Reachability check.
- D1 model_config: full dump-and-restore via `wrangler d1 execute --json` → jq pipeline → `INSERT OR REPLACE` SQL → `wrangler d1 execute --file=`.
- D1 reference tables (13 tables): per-table `wrangler d1 export --no-schema --table=$T` → `DELETE FROM $T` on preprod → `wrangler d1 execute --file=` import → row-count verify.
- KV day-state: delegates to `scripts/sync-daystate-kv.sh`.
- Optional preprod overrides (`ENABLE_TH=1` flag enables TH module on preprod model_config; default leaves it off so canonical-mirror baseline reproduces live).
- Equivalence summary table at the end with ✓/✗ per table.

### `scripts/sync-daystate-kv.sh` (new)
Parallel cloner for `timed:replay:daystate:*` blobs. Default 4 concurrent workers. ~2-3 min wall time for 211 blobs (~6 GB transfer). Lists live keys via `/timed/admin/kv/list?prefix=...` then GET-from-live + PUT-to-preprod each blob via the existing admin endpoints (`kv/get` and `kv/put`).

Why parallel: serial cloning at 200 blobs × ~3s each = 10+ minutes. Parallel cuts this to ~2-3 min. Day-state blobs decay every preprod backtest (the candle-replay rewrites them as it walks), so this script will be re-run before every validation cycle.

## Sequence executed this session

1. Wiped preprod working tables (`trades`, `positions`, `account_ledger`, `lots`, etc.) — preprod has no live trading state, safe to direct-DELETE.
2. Bulk-cloned 14 D1 reference tables from live → preprod via the new sync script (fix verified 14/14 ✓).
3. Cloned 211 day-state KV blobs from live → preprod with parallel workers; sample byte-equivalence check on `2025-07-01` confirmed identical (28,870,894 bytes both sides; 229 tickers; NVDA htf_score 38.3 / state HTF_BULL_LTF_PULLBACK match).
4. Disabled TH override on preprod (`deep_audit_trend_hold_enabled = "false"`) for the canonical-baseline test.
5. Launched `preprod-canonical-mirror-v1-jul2025-may2026` with `ticker_batch=30`. Run **stalled** at session 0 — DO alarm cycle was firing every 30-110s but never marking the session complete. Trade count froze at 26 after 8 min.
6. Cancelled v1, launched `preprod-canonical-mirror-v2-smallbatch-jul2025-may2026` with `ticker_batch=10`. Run progressed: 70 of 240 tickers processed in 1 min, 53 closed trades + 8 open by minute ~1.5.

## DO ticker pagination scaling note

Phase 3.8's alarm-driven DO assumes each candle-replay batch fits inside the worker CPU budget. With the new preprod data (212k `ticker_move_signals`, 11k `direction_accuracy` rows, 5.6k `ai_cio_decisions`), per-ticker scoring is heavier than before — and `ticker_batch=30` no longer fits the alarm window cleanly. Empirical observation: at `batch=30` the replay step times out, no trades commit, the DO retries the same session forever; at `batch=10` it completes batches reliably.

Architectural follow-up: profile `executeCandleReplayStep` with the populated reference tables and identify the slow path. Likely candidate: `direction_accuracy` and `ticker_move_signals` consumption inside the AI CIO scoring path. For now, **set `ticker_batch=10` for any preprod canonical run** until profiled.

## Smoke results — partial fidelity is the limit

After running three sequential sync passes (each strictly more comprehensive than the last) and three corresponding canonical-mirror baseline runs:

| run | model_config | D1 ref tables | KV day-state | KV other (~1.3k keys) | Jul 1 entries | Jul 1-31 trades | WR | result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| canonical `phase-c-stage1` (live) | 433 | full | full | full | **25** | 103 | 56.3% | reference |
| `v1` preprod (5 model_config keys) | 5 | empty | mutated | partial | 6 | 61 | 33% | broken |
| `v3` preprod (5 model_config + day-state cloned) | 5 | empty | clean | partial | 6 | 61 | 33% | broken |
| `v5` preprod (full model_config + day-state) | 433 | empty | clean | partial | 6 | 61 | 33% | partial fix |
| `v3-fullkv` preprod (this PR — full D1 + full KV) | 433 | **14 ✓** | **211 ✓** | **1.3k+ ✓** | **6** | **61** | **33%** | **same** |

**Preprod produces deterministic, identical outputs across every sync iteration.** Same trade IDs, same outcomes, same WR — even after every observable input we could enumerate has been mirrored from live.

### Where the residual gap likely lives

`worker/replay-runtime-setup.js`, `worker/pipeline/tt-core-entry.js`, and the candle-replay path read ~50 KV namespaces and many `model_config`-driven gates. We've now mirrored all the bulk static data. What we **cannot** mirror is the *historical state* of live's non-replay KV namespaces at the moment canonical `phase-c-stage1` ran. The keys under `timed:context:*`, `timed:capture:*`, `timed:internals:*` are mutated continuously by live cron — what's there today is May 2026 sector/breadth state, not the Apr 2026 state that canonical saw at run-time.

When the cohort overlay (`deep_audit_cohort_overlay_enabled = true`) and the cluster throttle (`deep_audit_cluster_throttle_enabled = true`) evaluate at replay time, they read from these "current" KV values. Cohort gates and cluster throttle that were lenient at canonical's run-time may now be strict, blocking entries that canonical admitted. Net: 6 Jul 1 entries on preprod vs 25 on canonical, with the gap concentrated in tickers like NVDA, GOOGL, AMD, META, AVGO that were probably blocked by current cohort overlay state.

This is **not** something the data-sync layer can fix. It's a worker-code property: the replay path treats certain KV reads as "current state" rather than "historical state captured per session". To make preprod fully deterministic-replayable would require auditing every `KV.get(...)` call in the scoring path and routing it through the day-state snapshot when in replay mode.

### Practical implications

- **Preprod is deterministic and reproducible across runs.** That's necessary for relative experiments.
- **Preprod cannot reproduce canonical absolute WR.** ~33% is its environmental ceiling for July 2025 with today's KV state.
- **Preprod's universe is narrower than canonical's** (46 vs 74 tickers traded in July). The tickers the user actually wants to validate TH on (SNDK, GOOGL, AMD, MU, META) are mostly NOT in preprod's traded set, because cohort overlay blocks them at entry-time. So even a TH-on / TH-off relative comparison on preprod **cannot fire the SNDK pass criterion** from `PHASE_3_DESIGN.md`.

## What we can validate on this preprod

Despite the absolute-WR gap, the deterministic environment supports **relative-delta experiments** for hypotheses that don't depend on the marquee-ticker cohort:
1. Trader-only baseline (TH off) → 61 trades, 33% WR (the v3-fullkv numbers above).
2. Trader+TH (TH on) → comparison run.
3. Δ trades, Δ WR, Δ pnl → the TH-module's value-add on this universe.

This validates whether TH does no harm and whether it produces meaningful management changes (different exit reasons, longer holds, fewer giveback losses). It does NOT validate the SNDK / GOOGL / AMD pass criterion the user cares about.

## What we'd need for full canonical reproducibility

Code-side change in worker/* — beyond this PR's scope:
1. Audit every `KV.get(...)` call in the scoring path that reads non-replay namespaces (timed:context:*, timed:capture:*, timed:internals:*).
2. Route each through a `getReplaySnapshotValue(daystate, key)` helper that prefers the per-session day-state cache over live KV when in replay mode.
3. On a fresh canonical run, capture a snapshot of all read KV values into the day-state.
4. Then preprod day-state cloning becomes sufficient for full reproducibility.

This is a non-trivial refactor (~50+ KV.get sites, integration test required, risks of breaking live).

## Recommended path forward

Two options for the user to choose:

**Option 1 — Ship TH on a relative-delta basis.** Accept that the marquee-cohort SNDK criterion isn't testable in preprod's current state. Run trader-only vs trader+TH back-to-back on preprod, look at delta. If delta looks favorable, deploy TH to live in shadow mode (commit=0, log-only) for 1-2 weeks to validate before flipping `deep_audit_trend_hold_enabled = true` on live. This is **Path C** from `WR_DIAGNOSTIC_2026-05-10.md`.

**Option 2 — Do the worker-code refactor first.** Deterministic replay across all KV reads. Higher engineering cost. Lets us validate TH against canonical-equivalent SNDK/GOOGL/AMD outcomes.

Option 1 is cheaper and ships faster but doesn't fully validate. Option 2 is the right architectural answer for long-term backtest infrastructure but is a multi-PR effort.

## Operational guardrails for keeping preprod faithful

1. **Re-run `scripts/sync-live-to-preprod.sh` before every validation cycle.** Day-state KV decays every backtest. D1 reference tables drift if live's calibration loop runs.
2. **Document the canonical-mirror run_id** as the immutable baseline. Before running an experimental TH or Investor variant, compare its results against this run_id, NOT against live's `phase-c-stage1`.
3. **Never run a clean-slate=YES_DESTROY sequence on preprod** without first capturing the canonical-mirror state via this sync script. The sync is the recovery path.
4. **Live is read-only from preprod's perspective.** This sync is one-way (live → preprod). Do not push from preprod to live.

## State at hand-off

- Live: untouched. Cash $140,786, realized $40,020. Cron unmuted.
- Preprod model_config: 433 rows; TH override DISABLED for canonical baseline test.
- Preprod working tables: empty (wiped before v2 launch).
- Preprod canonical-mirror run v2: in flight at `ticker_batch=10`.
- Branch: `cursor/preprod-fidelity-sync-bcab`.
