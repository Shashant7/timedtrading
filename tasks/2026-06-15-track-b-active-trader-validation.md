# Track B — Active Trader Engine Validation (kickoff 2026-06-15)

Separate from the foundation rebuild (own branch
`cursor/track-b-active-trader-validation-cbcd`). Validates/tunes the CURRENT
engine against live outcomes, now that the foundation gives fresh scores and the
replay harness is warm. Owed items from
`tasks/2026-06-12-never-stale-and-performance-review.md` (Part 5).

## Data sources (confirmed)
- **All closed trades:** live D1 `timed-trading-ledger` `trades` table (read-only).
  594 closed trades, **51% WR, +$38,929 net**. (NB: the `losing-trades-report`
  admin endpoint returns LOSERS ONLY — do NOT use it for WR/expectancy.)
- **Conviction components per trade are NOT stored** in the trade record
  (`signal_snapshot_json` has avg_bias/tf/gap/cvg/lineage/regime, not the
  conviction breakdown). Re-weighting (#2) therefore needs a **replay sweep**:
  re-score each ticker at its `entry_ts` and extract the conviction components,
  then correlate with `pnl`.

## Finding #1 — expectancy by exit lane (all 594 closed trades, live)

**Biggest LOSS lanes (fast-cut / risk tuning candidates, #3):**
| exit_reason | n | WR% | sum$ |
|---|---:|---:|---:|
| doctrine_force_exit | 58 | 7 | **-8,467** |
| HARD_LOSS_CAP | 14 | 0 | -5,867 |
| max_loss_time_scaled | 33 | 15 | -3,496 |
| max_loss | 19 | 11 | -3,249 |
| thesis_flip_htf | 42 | 17 | -2,932 |
| phase_i_mfe_fast_cut_2h | 15 | 0 | -1,876 |
| atr_day_adverse_382_cut | 26 | 12 | -1,768 |
| phase_i_mfe_fast_cut_zero_mfe | 12 | 0 | -1,644 |

**Biggest WIN lanes (working — protect/keep):**
| exit_reason | n | WR% | sum$ |
|---|---:|---:|---:|
| TP_FULL | 47 | 100 | +15,354 |
| HARD_FUSE_RSI_EXTREME | 22 | 91 | +14,262 |
| ST_FLIP_4H_CLOSE | 27 | 100 | +9,438 |
| sl_breached | 29 | 66 | +8,319 |
| peak_lock_ema12_deep_break | 19 | 95 | +5,747 |
| mfe_decay_structural_flatten | 32 | 91 | +5,163 |
| atr_week_618_full_exit | 33 | 76 | +4,649 |
| PROFIT_GIVEBACK_STAGE_HOLD | 36 | 94 | +3,358 |

### Reads
- **MFE ratchet (#1) is doing its job directionally:** the `phase_i_mfe_fast_cut_*`
  lanes show 0% WR (they exit positions already turning into losers — cutting
  dead money early), while the profit-protection side
  (`mfe_decay_structural_flatten` +$5,163 @ 91%, `peak_lock_ema12_deep_break`
  +$5,747 @ 95%) is strongly positive. The small negative on the fast-cut lanes
  is the cost of cutting early vs a larger loss — the intended trade-off. The
  equal-scope 60-day replay (still owed) quantifies the net counterfactual.
- **`doctrine_force_exit` is the single biggest bleed (-$8,467 @ 7% WR)** — the
  top candidate to investigate/tune (is it firing too late / on recoverable
  setups?).
- **`HARD_FUSE_RSI_EXTREME` (+$14,262 @ 91%)** is a star exit — keep/strengthen.

## Owed items + approach (next, on this branch)
1. **MFE ratchet 60-day equal-scope replay** (#1): run candle-replay over the
   last 60d with the ratchet on vs off; confirm the +$3,037 / +7pt-WR
   counterfactual + the Monday-RTH proof the open book isn't force-clipped.
2. **Conviction re-weighting** (#2): replay-sweep each closed trade's `entry_ts`,
   extract conviction components from `rank_trace_json`, correlate each with
   `pnl` (current overall corr ≈ -0.02), re-weight so the signal separates
   winners/losers; keep Tier-C suspended until it does.
3. **Fast-cut lane keep/loosen/kill** (#3): use the expectancy table above +
   the continuation table to decide per lane; the kill-switch + tunable windows
   already ship (`deep_audit_phase_i_fast_cut_*`).
4. **Short-shadow review** (#4): after ~2 weeks of `[SHORT_SHADOW]` logs.

## Guardrails
Config-gated, safe defaults, replay-validated before any live weight change.
Do NOT mix into the foundation PR. Keep on the #649 / Track B branch.
