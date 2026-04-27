# V15 ETF Fix — Progress Report

**Date:** 2026-04-25
**Status:** Partial fix landed (h3_consensus exemption). Trades still not firing.

## What I learned by mining Phase E2

You were right to push on this. Phase E2 v4 (8 monthly slices, 2025-07 → 2026-02) produced:
- **47 ETF trades**
- **71.7% WR**
- **+40.96% PnL**
- All LONG (no SHORTs in the window)
- Setups: 91% had `setup_name=None` (the trades came from the dedicated `tt_index_etf_swing` trigger path, not standard TT setups)
- Exits dominated by `SOFT_FUSE_RSI_CONFIRMED` (n=10), `SMART_RUNNER_SUPPORT_BREAK_CLOUD` (n=7), `replay_end_close` (n=6)

This is the playbook we lost. The `tt_index_etf_swing` trigger code is still in `worker/pipeline/tt-core-entry.js:1023-1094` and DA defaults are still set to enable it. **The trigger code is intact — it's just unreachable** because gates added in subsequent phases block ETFs upstream.

## Timeline of what was added that broke ETFs

| Commit | What changed | Impact on ETFs |
|---|---|---|
| `9f32a60` Phase E (Apr 19) | Added `tt_index_etf_swing` trigger | **ENABLED ETF trading** |
| `052f82d` Phase E.3 | Cohort-aware thresholds | Fine — kept compatible |
| `99e39bf` Phase H.3 | Added h3_consensus gate (3-of-5 signals) | **BLOCKED ETFs** (auto-fail volume + sector signals) |
| `2c67650` Phase H.4 | Earnings-proximity, mid-trade regime-flip | Fine — doesn't affect ETF entries |
| `3e5265e` Phase I | computeRankV2 + universe-adaptive rank floor | Maybe affects? need to verify |
| `1f02e50` V12 | killer strategy (P1+P3+P4+P6) | P6 added 10-of-10 ETF Precision Gate but it's downstream of h3 |

The window where ETFs traded successfully is **Phase E to Phase H.2**. After Phase H.3, the consensus gate killed them.

## What's been fixed in V15 so far

### Code change in `worker/pipeline/tt-core-entry.js` (committed 9593e1d)

```javascript
// V15 (2026-04-25): EXEMPT INDEX ETFs from h3_consensus gate
const _h3IsIndexEtf = ['SPY','QQQ','IWM','DIA'].includes(_tickerUpperEarly);
const _h3ConsensusEnabled = String(daCfg.deep_audit_consensus_gate_enabled ?? "false") === "true"
  && !_h3IsIndexEtf;
```

### Validation results

8-day diagnostic (Aug/Sep/Oct 2025 + Jan/Mar 2026):

| Metric | V14 (before) | V15 P0.4 (after) | Δ |
|---|---|---|---|
| Total ETF blocks | 503 | 32 | **-94%** |
| `h3_consensus_below_min` | 358 | 0 | eliminated |
| `tt_bias_not_aligned` | 71 | 0 | eliminated |
| **Trades created** | 0 | 0 | unchanged |

Full-month Jul 2025 validation (4 ETFs only):
- **V15 P0.4: 0 trades** (vs Phase E2 v4 baseline: **9 trades, 100% WR for July**)

So the h3 exemption **eliminated the 2 dominant blockers** but trades aren't yet firing. That means there are **OTHER gates** between the h3 layer and the actual trade-creation step that also need attention.

## What's still blocking — the next gates to investigate

The 32 remaining blocks in our V15 sample:
| Reason | Count | Action |
|---|---|---|
| `da_short_rank_too_low` | 12 | SHORT-side rank floor; legitimate, leave alone |
| `h3_rank_below_transitional_floor` | 10 | Per-regime rank floor; needs ETF carve-out |
| `rvol_dead_zone` | 5 | rvol gate; ETFs have low rvol, needs carve-out |
| `h3_long_blocked_in_downtrend` | 3 | Regime-aware block; legitimate, leave alone |
| `phase_i_short_no_spy_downtrend` | 2 | SHORT-specific, leave alone |

**Net non-blocked bars:** 503 - 471 (now passing) = **471 bars now reach the trigger layer without h3 issues.**

So the remaining issue is **at the trigger layer** — the actual `tt_index_etf_swing` trigger conditions aren't firing. Possible causes:

1. **Rank score still too low** for `tt_index_etf_swing` (requires `rank >= 92`). Phase E2 used the OLD `computeRank` formula. V14 pinning may have shifted the rank distribution down.
2. **`pct_above_e48` band too tight** (needs 1.0% to 7.0% for LONG). If indices are sitting AT the EMA, they fail.
3. **`e21_slope_5d_pct` band too tight** (needs 0.3% to 3.0% for LONG). In sideways months indices may be sub-0.3.
4. **State requirement** (HTF_BULL_LTF_PULLBACK or HTF_BULL_LTF_BULL). Other states don't qualify.
5. **`c10_8` cloud requirement** (above or inCloud). If 10m EMA cloud isn't above price, fail.

Need a third diagnostic that traces what the `tt_index_etf_swing` trigger sees on each bar and which condition fails.

## Recommended next step

Add **trigger-level diagnostic logging** that captures, for each ETF bar that passes h3:
- rank score
- pct_above_e48
- e21_slope_5d_pct
- state
- c10_8 cloud position

Then re-run a Phase E2 day where we KNOW a SPY trade fired. Compare: Phase E2's data values vs current values. The diff will tell us exactly which threshold needs to be relaxed.

This is a 1-hour change followed by a 5-min validation replay.

## After we get ETF trades firing

The validation plan is:
1. Run a 1-month ETF-only replay (Jul 2025)
2. Compare to Phase E2 baseline: target 8-12 trades, 60%+ WR
3. If matches: run 10-month full-universe rerun
4. If not: tighten ETF-specific quality (e.g., raise the swing-trigger rank floor)

## Honest takeaway

I underestimated the scope of the ETF fix. It's NOT just about toggling one gate — there are **multiple stacked gates** added across phases H.3, I, and V12 that need ETF carve-outs. The good news is:

1. **Code already exists** for ETF entry (`tt_index_etf_swing`)
2. **Gates can be exempted surgically** without rewriting (one `&& !_h3IsIndexEtf` line per gate)
3. **Phase E2 baseline tells us the target** (47 trades / 8 months / 71.7% WR)

**Estimated work** to land working ETF trades: ~3-4 surgical exemptions across the gate stack, plus a 5-day diagnostic replay each iteration. Should be done within today.

Then the real V15 development can proceed (Saty ATR, slope alignment, conviction rebalance, per-ticker fatigue) on a foundation where ETF trading actually works.
