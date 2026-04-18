# Phase D probe — T6 (ETF pullback-depth + non-Prime rank) insufficient alone

> **Status.** T6 Variant A code implemented, deployed, activated via
> `model_config`, and probed against both calm-uptrend (Jul 2025) and
> downtrend (Nov 2025) regimes. T6 gates relax as designed but produce
> **zero new ETF trades** in any tested slice because the ETFs' primary
> blockers are elsewhere in the gate chain. Rolled back; closing the
> implementation PR; returning to analyzer extension before the next
> DA-key experiment.

## Timeline

- **2026-04-18 ~02:50 UTC.** Implemented T6 Variant A in
  `worker/pipeline/tt-core-entry.js` + `worker/replay-runtime-setup.js`:
  three new DA keys (`deep_audit_pullback_min_bearish_count_index_etf_tickers`,
  `_index_etf`, and `deep_audit_pullback_non_prime_min_rank_index_etf`).
  When the current ticker is in the CSV set, `pullbackMinBearishCount` and
  `selectiveNonPrimeMinRank` use the override values instead of their base
  values. Single-stock behaviour unchanged.
- **02:55 UTC.** Deployed worker to both envs. Default:
  `b51ab72d-1557-4a74-a432-3cfe7e3335f3`. Production:
  `fa8b6be2-f10d-4e0a-8ffa-b31fe80eb8ac`.
- **02:56 UTC.** Activated T6 via
  `POST /timed/admin/model-config` with `SPY,QQQ,IWM,XLY` / `min_bearish=1`
  / `non_prime_min_rank=85`.
- **02:58–03:09 UTC.** Ran four gate-level probes. Details below.
- **03:10 UTC.** Rolled back the three DA keys to empty strings. Deployed
  worker still contains the T6 code, but the override is inert.

## Probes and results

All probes ran against `POST /timed/admin/candle-replay` with
`fullDay=1&cleanSlate=1&freshRun=1` under a freshly registered run_id
that had `active_experiment_slot=1` so the pinned config contained the T6
keys.

### Probe 1 — Jul 9 2025, SPY/QQQ/IWM (calm uptrend, same day as Phase-C finding)

| Gate | Baseline (Phase-C) | T6 active | Δ |
|---|---:|---:|---:|
| `tt_pullback_not_deep_enough` | 47 | **15** | −32 |
| `tt_pullback_non_prime_rank_selective` | 34 | **19** | −15 |
| `tt_pullback_5_12_not_reclaimed` | 4 | 4 | 0 |
| `tt_no_trigger` | 78 | 78 | 0 |
| Stage = `in_review` | 74 | **121** | +47 |
| Stage = `setup` / `watch` | 163 | 116 | −47 |
| **New ETF trades** | 0 | **0** | 0 |

T6 relaxed the targeted gates exactly as designed (+47 bars advanced from
`setup` stages up to `in_review`). But `tt_no_trigger: 78` did not move —
47 more bars reached `in_review`, none of them produced a trigger event.

### Probe 2–4 — Nov 4 / 13 / 20 2025, SPY/QQQ/IWM/XLY (downtrend, R3 drought)

| Day | Dominant blocker | Count | Secondary | Count | ETF trades |
|---|---|---:|---|---:|---:|
| 2025-11-04 (earnings cluster) | `tt_bias_not_aligned` | 192 | `da_short_rank_too_low` | 76 | 0 |
| 2025-11-13 (mid-drought) | `tt_bias_not_aligned` | 212 | `tt_no_trigger` | 60 | 0 |
| 2025-11-20 (late-drought) | `tt_no_trigger` | 200 | `tt_bias_not_aligned` | 102 | 0 |

None of these blockers is what T6 targeted. The binding constraints are:

- **`tt_bias_not_aligned`** — daily/4H/1H/10m cloud vote is not unanimous.
  Dominant in transitional / choppy downtrend backdrops.
- **`tt_no_trigger`** — no pullback/reclaim trigger event in the bar.
  Dominant in calm uptrends *and* late-drought downtrends.
- **`da_short_rank_too_low`** — short-side rank floor too high for
  downtrend-regime SHORT setups.
- **`rvol_dead_zone`** — low relative-volume filter trips in weekend /
  late-session bars.

T6's two gates (`tt_pullback_not_deep_enough`,
`tt_pullback_non_prime_rank_selective`) are real and do fire — they're
just not the binding constraint across the regimes we tested.

## Why the Phase-C analysis was symptomatic, not causal

The Phase-C report's "2 of the top 4 block reasons gate out ETFs" framing
was correct in aggregate, but it missed the sequencing. ETFs traverse
the entry gate chain in this order (simplified):

1. Stage classification → produces `watch` / `setup` / `in_review` /
   `management`.
2. Bias alignment (`tt_bias_not_aligned`) — **gate 1**.
3. Trigger detection (`tt_no_trigger`) — **gate 2**.
4. Pullback depth (`tt_pullback_not_deep_enough`) — gate 3.
5. Non-Prime rank floor (`tt_pullback_non_prime_rank_selective`) — gate 4.
6. Various downstream structure / divergence / RSI gates — gates 5+.

A raw `blockReasons` counter tells us **what gate rejected the bar** but
is silent on which gate would have rejected it next. When T6 relaxed
gates 3 and 4, the bars that would have been blocked there just fell
through to gate 2 (`tt_no_trigger`) or gate 1 (`tt_bias_not_aligned`) and
were rejected there instead. The counter doesn't reflect the redistribution
in a way that foregrounds the remaining bottleneck, so the Phase-C
"relax these two gates" proposal looked plausible but wasn't.

## What good looks like

To avoid this class of misdiagnosis, the next Phase-D branch will build a
committed **unentered candidates analyzer** that emits a per-ticker
per-interval **ordered block chain** (`bias → trigger → depth → rank → …`)
with one row per rejected bar, rather than a bag of aggregated counters.
Then:

- A "relax gate N" proposal can be evaluated by asking "how many of the
  bars currently rejected at gate N would survive to the *next* gate, and
  what fraction of those get blocked there?" — which is exactly the
  question the aggregated counter cannot answer.
- Monthly reports surface the top-5 binding constraints per ticker cohort
  (Tier-1 ETFs, Tier-1 large-caps, Tier-2 stocks) so we can propose
  cohort-specific tunings with realistic expected impact.

## Current state after rollback

- `phase-d/t6-etf-pullback-2e87` branch + PR #6 **superseded — to be
  closed**. Code is correct; problem is the proposal itself was wrong.
- `model_config` T6 keys rolled back to empty strings at `2026-04-18
  ~03:10 UTC`. Deployed worker still has the T6 code but it's inert.
  Live + replay identical to pre-deploy.
- No drift risk: future runs will neither read nor write the T6 override
  values.

## Next steps (Phase D)

Ordered list, each a separate branch:

1. **`phase-d/unentered-candidates-analyzer-<tag>`** — extend
   `scripts/monthly-slice.sh` (or a new `scripts/analyze-slice.js`) to
   emit the ordered block chain per ticker per interval, committed to
   each slice's `data/trade-analysis/<run_id>/` as
   `block_chain.jsonl` + a top-N summary in `report.md`.
2. **`phase-d/slice-2025-08-<tag>`** — 2025-08 baseline slice on current
   Phase-A config, using the analyzer from (1). Two months of baseline
   data before any DA-key experiment.
3. **Re-evaluate ETFs** with two months of block-chain data. Propose a
   coherent entry-gate change (ETF-scoped `tt_bias_not_aligned` or
   `tt_no_trigger` relaxation, or a combined package) rather than one
   gate in isolation.

## Provenance

- Worker Version IDs during the probe:
  - default: `b51ab72d-1557-4a74-a432-3cfe7e3335f3`
  - production: `fa8b6be2-f10d-4e0a-8ffa-b31fe80eb8ac`
- Baseline reference: `data/trade-analysis/phase-c-slice-2025-07-v1/`
  (Phase-A config, 25 trades, 76 % WR).
- Commit under which probes ran: `b36e082` on
  `phase-d/t6-etf-pullback-2e87` (now superseded).
