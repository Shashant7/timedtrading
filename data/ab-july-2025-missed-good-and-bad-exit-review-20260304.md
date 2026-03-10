# July 2025 A/B Deep Dive (Control vs Variant)

Generated: 2026-03-04T21:42:14.631Z

## 1) Overlapping Trades
- Control: max concurrent 10, same-ticker overlaps 0
- Variant: max concurrent 10, same-ticker overlaps 3
- Variant same-ticker overlap examples: AWI(AWI-1751572200000-5quino4zb vs AWI-1751998200000-24bx6qwlw); AWI(AWI-1751572200000-5quino4zb vs AWI-1752156000000-khup3knmt); AWI(AWI-1751572200000-5quino4zb vs AWI-1753811400000-p2s5w1g9y)

## 2) Control Good Trades Missing in Variant
- Control good trades: 16
- Missing in variant: 15

- ANET LONG 2025-07-10: control PnL 722.77 (12.26%), variant block=none stage=exit -> Add rapid re-entry/reclaim path after management-stage transitions to avoid missing resumed trends.
- PWR LONG 2025-07-23: control PnL 340.26 (4.22%), variant block=ripster_bias_not_aligned stage=trim -> Relax strict 34/50 MTF unanimity (allow 2-of-3 with D+1H priority) or permit pullback exception when D/1H aligned and 10m recovering.
- PLTR LONG 2025-07-23: control PnL 317.66 (4.91%), variant block=none stage=exit -> Add rapid re-entry/reclaim path after management-stage transitions to avoid missing resumed trends.
- AMZN LONG 2025-07-01: control PnL 315.74 (3.95%), variant block=golden_htf_below_floor stage=exit -> Decouple legacy quality/rank floors when ripster bias+trigger are valid; use softer thresholds in strong daily regime.
- GE LONG 2025-07-03: control PnL 256.86 (5.22%), variant block=ripster_bias_not_aligned stage=exit -> Relax strict 34/50 MTF unanimity (allow 2-of-3 with D+1H priority) or permit pullback exception when D/1H aligned and 10m recovering.
- CCJ LONG 2025-07-14: control PnL 244.21 (5.03%), variant block=none stage=enter -> Review snapshot manually; no dominant block reason captured.
- H LONG 2025-07-09: control PnL 213.26 (2.67%), variant block=golden_htf_below_floor stage=trim -> Decouple legacy quality/rank floors when ripster bias+trigger are valid; use softer thresholds in strong daily regime.
- PH LONG 2025-07-23: control PnL 147.73 (1.91%), variant block=trigger_stale stage=exit -> Review snapshot manually; no dominant block reason captured.
- MSFT LONG 2025-07-14: control PnL 114.55 (1.91%), variant block=none stage=enter -> Review snapshot manually; no dominant block reason captured.
- DPZ LONG 2025-07-17: control PnL 93.46 (1.56%), variant block=rr_too_low stage=watch -> Review snapshot manually; no dominant block reason captured.
- PANW LONG 2025-07-07: control PnL 89.07 (1.23%), variant block=ripster_bias_not_aligned stage=watch -> Relax strict 34/50 MTF unanimity (allow 2-of-3 with D+1H priority) or permit pullback exception when D/1H aligned and 10m recovering.
- AAPL LONG 2025-07-10: control PnL 78.61 (0.98%), variant block=da_htf_too_low stage=exit -> Decouple legacy quality/rank floors when ripster bias+trigger are valid; use softer thresholds in strong daily regime.
- ORCL LONG 2025-07-23: control PnL 56.84 (5.70%), variant block=ripster_bias_not_aligned stage=exit -> Relax strict 34/50 MTF unanimity (allow 2-of-3 with D+1H priority) or permit pullback exception when D/1H aligned and 10m recovering.
- GE LONG 2025-07-23: control PnL 33.61 (3.37%), variant block=ripster_bias_not_aligned stage=defend -> Relax strict 34/50 MTF unanimity (allow 2-of-3 with D+1H priority) or permit pullback exception when D/1H aligned and 10m recovering.
- DY LONG 2025-07-28: control PnL 23.73 (2.38%), variant block=none stage=just_entered -> Review snapshot manually; no dominant block reason captured.

## 3) Variant Bad Exit Review
- bad_exit count: 35
- winners/losses in bad_exit: 21/14
- avg pnlPct: 2.78%
- avg hold days: 27.42

### Early-Exit Candidates (positive pnl but short hold)
- HII 2025-07-01: pnlPct 0.13%, hold 0.26d
- KLAC 2025-07-17: pnlPct 0.18%, hold 0.84d
- AWI 2025-07-08: pnlPct 0.18%, hold 0.81d
- CAT 2025-07-23: pnlPct 0.21%, hold 0.01d
- ORCL 2025-07-29: pnlPct 0.29%, hold 0.83d
- AWI 2025-07-29: pnlPct 0.38%, hold 0.00d
- GEV 2025-07-18: pnlPct 0.40%, hold 0.18d
- HII 2025-07-10: pnlPct 0.67%, hold 0.99d
- CAT 2025-07-02: pnlPct 0.68%, hold 0.17d
- FIX 2025-07-16: pnlPct 0.84%, hold 0.86d
- PH 2025-07-01: pnlPct 0.88%, hold 0.24d
- H 2025-07-07: pnlPct 0.97%, hold 1.06d

## Action Recommendations
- Entry: Soften ripster bias gate from strict 3/3 (D,1H,10m 34/50) to 2/3 with D+1H mandatory in strong daily regime.
- Entry: Add secondary trigger path when 5/12 cross is absent but 8/9 reclaim + ST flip + improving LTF confirms continuation.
- Entry: Reduce/disable legacy da_htf_too_low and adaptive_rank_below_min blockers for ripster-qualified setups in regime-confirmed trend.
- Exit: Demote first 5/12 loss to DEFEND/TRIM, not full EXIT; require 34/50 loss persistence + 1H confirmation for hard exits.
- Exit: Add N-bar debounce (2-3 bars) for ripster management exits to avoid one-bar shakeout exits.
- Exit: Add re-entry reclaim rule after premature exit when 34/50 bias re-aligns and 5/12 recrosses within short window.
- Risk: Disallow overlapping same-ticker entries unless explicit add-entry criteria and risk budget remain valid.
- Risk: Track exit efficiency proxy: bad_exit with positive pnl and short hold as under-capture candidates.