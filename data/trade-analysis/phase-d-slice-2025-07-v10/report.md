# July 2025 Slice — v10 (v6 + conviction 70→74)

| Field | Value |
|---|---|
| Run ID | `phase-d-slice-2025-07-v10` |
| Environment | `timed-trading-ingest-preprod` |
| Config | v6 base + `deep_audit_focus_min_entry_conviction` 70 → 74 (selectivity lever) |
| Status | **Complete** (07-01 → 07-31; 07-16 infra-skipped after 5×`1102`; finalized with month-end closes) |
| Note | The 300s watchdog (vs 180s) carried the heavy mid/late-month days that defeated v9 |

## Result

| Run | Trades | WR | Sum P&L |
|---|---:|---:|---:|
| **Anchor** `phase-c-slice-2025-07-v1` | 25 | **76.0%** | **+26.05%** |
| v6 (different engine state) | 26 | 65.4% | +18.08% |
| v9 (`rank_bypass=0`) | 43 | 41.9% | +12.41% |
| **v10 (conviction 74)** | **43** | **41.9%** | **+14.98%** |

v10: **43 trades, 18W / 22L / 3 flat = 41.9% WR, +14.98%** (+$1,428 on the replay book).

## Verdict: does NOT beat the anchor — and the conviction lever was a dud

v10 is **statistically identical to v9** (same 43 trades, same 41.9% WR, marginally
better P&L). Raising the focus-conviction floor 70 → 74 changed **nothing** — the
same marginal losers fired (CDNS 4 trades −$232, IWM 4 trades −$164, ON, SGI), so
the conviction floor is **not the binding constraint** on those entries.

## The real diagnosis (index split)

| Cohort | Trades | WR | Sum P&L |
|---|---:|---:|---:|
| **Index (SPY/QQQ/IWM)** | 11 | 36.4% | **−$242** |
| **Non-index** | 32 | 43.8% | +$1,670 |

Two separate problems, both vs the anchor:

1. **The index model over-trades.** The anchor made **0 index entries**; v10 took
   **11** (SPY 4 / IWM 4 / QQQ 3) at 36% WR for a net **−$242**. Pure drag the
   anchor never carried. v6 enables `deep_audit_index_model_enabled` — disabling
   it (matching the anchor's actual profile) removes this drag immediately.
2. **Non-index entry quality has regressed vs the frozen anchor.** Even setting
   the index trades aside, the current engine's 32 non-index July entries hit
   only **43.8% WR** — versus the anchor's **76%** on 25 names. That gap is *not*
   a config flip; the anchor reflects a different (frozen) engine state whose
   July selectivity the current engine no longer reproduces.

### Worst / best (v10)
- Drag: CDNS −$232 (4), ON −$212, IWM −$164 (4), SGI −$145, AGQ −$107.
- Edge: MSFT +$589 (2), IESC +$462, NVDA +$300, FIX +$284, ETN +$273.

## Recommendation

- **v11 = v10 + `deep_audit_index_model_enabled=false`** is the one clearly
  principled next run (restores the anchor's 0-index profile; projected ~32
  trades / ~44% WR / ~+17-18% — better P&L, removes the −$242 index drag). Worth
  a single run, but it will **not** reach 76% WR.
- **Closing the 44%→76% non-index gap is an engine/calibration investigation,
  not a knob.** The current `tt_core` July selection admits ~32 non-index names
  at 44% WR; the anchor admitted 25 at 76%. The next real work is *why* — compare
  the anchor's frozen `model_config` snapshot (`backtest_run_config` for
  `phase-c-slice-2025-07-v1`) against current, and identify which gate/threshold
  loosened. Chasing it with one-off conviction/rank tweaks (v9, v10) has not
  worked.

## Infra note

Pre-prod `candle-replay` returns `503 / error 1102` (worker resource limit) on
heavier mid/late-month days as the open book grows (more management eval per
interval). The **300s watchdog** got every day through except 07-16 (5× hard
fail). Reliable full-month runs need the heavier days to fit the worker budget —
an env/limit task, or split the per-day replay into smaller ticker batches.

## Reproduce

```bash
PRE=https://timed-trading-ingest-preprod.shashant.workers.dev
curl -s "$PRE/timed/admin/runs/trades?run_id=phase-d-slice-2025-07-v10&limit=10000&key=$TIMED_API_KEY"
```
