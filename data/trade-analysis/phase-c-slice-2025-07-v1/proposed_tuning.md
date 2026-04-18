# Proposed tuning — 2025-07 slice

> Source: `report.md` for `run_id=phase-c-slice-2025-07-v1`.
>
> **Scope.** Phase C does NOT tune — this document is a discussion draft of
> candidate DA-key deltas for Phase D's per-month analysis loop. Nothing in
> here is applied. Each proposal is paired with the expected impact and the
> gates it must satisfy (plan §Phase D acceptance gates + anti-overfit
> safeguards) before any of it reaches `main`.

## Anti-overfit budget (from plan)

1. **Full-coverage rule:** any DA-key change must survive replay on all 10
   months.
2. **Regression budget:** no month may regress in WR by more than 2 pp or in
   PnL by more than 10 %.
3. **Holdout discipline:** `2026-03` and `2026-04` are frozen until Phase G.
4. **SPY isolation:** SPY overlay never changes during evaluation of an
   overlay candidate — only before and after.

## Current 2025-07 baseline (set by this slice)

| Metric | Value |
|---|---|
| Trade count | 25 |
| WIN / LOSS | 19 / 6 |
| Win rate | 76.0 % |
| Big winners (≥ 5 %) | 2 (AGQ +10.33 %, CDNS +5.61 %) |
| Clear losers (≤ −1.5 %) | 3 (RIOT −3.58 %, CDNS −3.34 %, SGI −3.09 %) |
| Sum `pnl_pct` | +26.05 % |

Any proposal below is **acceptable only if** it holds this anchor to ≥ 74 %
WR, ≥ 2 big winners, and ≥ +23.4 % sum-pnl-pct (regression budget) on a
replay of the same month.

## Candidate tunings

### T1. Tighten `pullback_support_holding` round-trip guard for half-trimmed runners

- **Evidence:** `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` fired on ETN
  (Jul 1 → Jul 2, +0.31 %) and GOOGL (Jul 22 → Jul 23, +0.22 %). Both were
  high-rank setups (ETN rank 100, GOOGL rank 100) that completed a trim, then
  hit this safety exit within 24 h at near-entry price. The subsequent ETN
  (Jul 8 → Jul 22) captured +4.04 % on the same ticker, suggesting the first
  ETN was cut too early.
- **Proposal:** raise the round-trip-failure threshold for `rank ≥ 95`
  runners (give high-confidence setups more room before the cut).
- **Expected 2025-07 impact:** +2 trade-gain swings worth an incremental
  ~+2–3 % on those two trades. Does not add or remove trades.
- **Risk:** widens draw-downs on legitimate round-trip failures; must be
  validated against Nov 2025 / Feb 2026 bear months where round-trip failures
  are the *right* exit.

### T2. Relax `eod_trimmed_underwater_flatten` during uptrend-backdrop weeks

- **Evidence:** AMZN (Jul 1 → Jul 8, +0.35 %) and MTZ (Jul 2 → Jul 2,
  −0.13 %) were forced flat at EOD despite the Phase-B backdrop showing an
  uptrend cycle (HTF_BULL_LTF_BULL 82 %). In a strong-uptrend week this
  flatten leaves runner upside on the table.
- **Proposal:** gate the EOD-flatten on `backdrop.cycle ≠ uptrend` (or a
  realized-vol threshold). Requires threading the Phase-B backdrop JSON into
  the runtime, which is a Phase F concern, not Phase D.
- **Expected 2025-07 impact:** MTZ gets the chance to either close WIN or
  trip a different exit. AMZN holds longer and potentially catches the Jul 8
  → Jul 22 leg that ETN got.
- **Risk:** in downtrend months (2025-11, 2026-02, 2026-03) removing the EOD
  flatten would increase drawdowns. Cannot be applied unconditionally — this
  is a regime-conditional DA-key and belongs to Phase F.

### T3. Block entries on the last two days of a ≥ 4-ticker earnings cluster

- **Evidence:** The three `max_loss` losers are all entries from the last
  week of July:
  - RIOT Jul 22 (rank 84, entered into Jul 22 cluster anchor) → −3.58 %.
  - SGI Jul 28 (rank 97, in the CDNS/META/MSFT/SWK Jul 28–30 cluster) →
    −3.09 %.
  - CDNS Jul 31 (rank 93, day after the cluster peak) → −3.34 %.
  - Matches Phase B's Jul 28–30 cluster (4 tickers × 3 days) exactly.
- **Proposal:** for days where `data/backdrops/<month>.json
  .event_density.earnings.clusters_ge3_tickers_within_3d` contains a cluster
  with ≥ 4 tickers, block new entries on the anchor day ± 1 calendar day
  unless `rank ≥ 97` **and** the sector ETF has RS vs SPY ≥ 0.
- **Expected 2025-07 impact:** removes RIOT (−3.58 %) and at least one of
  the last-week entries. Keeps CDNS +5.61 % (rank 94 inside the cluster —
  just misses the `≥ 97` gate, so we'd lose this winner too; tightening to
  `≥ 93` would keep the big winner but still block RIOT). Net estimated
  swing: +3–4 % sum-pnl, clear-losers − 1.
- **Risk:** over-blocking during legitimate earnings-week breakout
  opportunities. Must replay Oct and Jan (both have 5 clusters) to confirm
  the gate doesn't kill good entries in those months.

### T4. Unentered-candidates diagnostic (SPY/QQQ/IWM) — findings from the targeted probe

Follow-up to the original report question "why did SPY/QQQ/IWM produce zero
entries in an 82 % bull month?" I re-ran 2025-07-01 / 07-09 / 07-15 / 07-22
with `tickers=SPY,QQQ,IWM&fullDay=1` so the worker returned its full
`blockReasons` counter for those three tickers. Aggregated over the four
probe days (948 scored ETF intervals total):

| `block_reason` | count | share | Gate source |
|---|---:|---:|---|
| `tt_no_trigger` | 418 | 48.5 % | no pullback/reclaim trigger in the bar |
| `tt_pullback_not_deep_enough` | 223 | 25.9 % | `tt-core-entry.js:768-780`, `deep_audit_pullback_min_bearish_count=2` |
| `tt_momentum_30m_5_12_unconfirmed` | 82 | 9.5 % | 30m cloud not confirming |
| `tt_pullback_non_prime_rank_selective` | 72 | 8.4 % | `tt-core-entry.js:1026-1033`, `deep_audit_pullback_non_prime_min_rank=90` |
| `tt_pullback_5_12_not_reclaimed` | 44 | 5.1 % | 5/12 cloud reclaim still missing |
| `tt_bias_not_aligned` | 19 | 2.2 % | daily/4H/1H/10m cloud vote not unanimous |
| `tt_momentum_ltf_fractured` | 3 | 0.3 % | LTF structure fractured |

Critical finding: the ETFs are **enabled and scored** every 5-min interval
(`scored=237 / skipped=0` per day × 22 days ⇒ ~5,200 ETF observations) and
reach `setup` / `in_review` stage frequently. On 2025-07-09 both SPY
(`score=100`, `kanban_stage=in_review`) and QQQ (`score=99`,
`in_review`) were a single structural signal away from qualifying. Two
specific gates are the pinch points:

- **`tt_pullback_not_deep_enough`** requires **2 of {15m, 30m, 1H
  SuperTrend}** to have flipped bearish before the pullback is deep
  enough. Index ETFs in a calm uptrend (July 2025 realized vol 6.7 %,
  SPY +2.34 % monthly) almost never produce simultaneous 2-of-3 ST flips
  — the index pulls back mildly, then resumes higher.
- **`tt_pullback_non_prime_rank_selective`** bumps any non-Prime setup at
  `rank < 90` out of the entry path. SPY scored 87–88 at multiple
  setup-stage moments in July; those all got filtered here.

These gates are tuned for individual stock pullbacks; index ETFs need a
different sensitivity. Hence T6.

### T5. `PRE_EVENT_RECOVERY_EXIT` is firing as intended but costing marginal edges

- **Evidence:** PH (Jul 9 → Jul 10, +0.09 %) and GRNY (Jul 29, −0.15 %) both
  exited via `PRE_EVENT_RECOVERY_EXIT`. The rule correctly de-risked ahead
  of events, but in both cases the ticker continued higher into the event.
- **Proposal:** keep the rule as-is for this slice. Revisit in Phase D once
  we have 3+ months of PRE_EVENT_RECOVERY_EXIT data — single-month sample
  is too noisy.

### T6. Relax the pullback-depth gate for index / sector ETFs (SPY/QQQ/IWM/XLY)

- **Evidence:** Direct consequence of T4. The two ETF-blocking gates are:
  - `tt_pullback_not_deep_enough` — requires 2 of 3 ST timeframes flipped
    bearish; index ETFs rarely satisfy that in calm uptrends.
  - `tt_pullback_non_prime_rank_selective` — non-Prime rank floor 90;
    SPY sits at 87–88 at setup-stage moments.
- **Proposal (two variants, same expected effect, different blast radius):**

  **Variant A — minimal, ticker-scoped override.** Introduce a new DA key
  `deep_audit_pullback_min_bearish_count_index_etf_tickers="SPY,QQQ,IWM,XLY"`
  (CSV) and a paired
  `deep_audit_pullback_min_bearish_count_index_etf=1` override. When the
  current ticker is in the CSV, `pullbackMinBearishCount` is replaced with
  the override (1 instead of 2). Same pattern for
  `deep_audit_pullback_non_prime_min_rank_index_etf=85`. Zero impact on
  single-stock behaviour; all existing 2025-07 stock trades are
  preserved.

  **Variant B — regime-conditional.** Make
  `pullbackMinBearishCount = (cycle == "uptrend" && realized_vol < 10) ? 1 : 2`
  using the Phase-B backdrop JSON at runtime. This is cleaner but
  requires wiring the backdrop into the replay runtime (Phase F
  concern).

  Start with Variant A — it's narrow enough to ship in Phase D without
  touching the backdrop plumbing.

- **Expected 2025-07 impact:** SPY and QQQ should each produce 2–4
  entries over the month. Based on the probe, SPY was at `in_review`
  `score=100` on Jul 9 and at `setup` `score=88` on Jul 15; those are
  the most likely trigger dates. IWM hit `score=100` on Jul 9 but stayed
  in `watch` — may or may not cross into entry depending on the trigger
  bar. Net estimated new trades: **+4 to +8** across the slice,
  bias toward wins given the strong bull backdrop.

- **Risks and anti-overfit considerations:**
  - **2025-11 downtrend:** relaxing the ETF pullback depth in a bear
    cycle would produce *more* SPY LONG entries in the exact month that
    already had the R3 drought and the defensive-rotation bottom for
    Tech. Phase D replay of 2025-11 under Variant A must confirm the
    new ETF entries don't cluster into losers. If they do, the
    override must be gated on cycle or realized_vol before merge
    (pushing the proposal toward Variant B).
  - **Holdout discipline:** 2026-03 and 2026-04 stay frozen until
    Phase G; Variant A must pass the full-coverage rule (all 10 months
    ± regression budget) on the 8 training months before it gets
    replayed against the holdouts.
  - **SPY overlay interaction:** Phase E's SPY-overlay track is
    expected to *tighten* SPY entries to hit ≥ 80 % WR. T6 *loosens*
    SPY entries. These may work against each other — final Phase E
    config will need to reconcile ("loosen pullback depth but require
    higher rank" is a plausible reconciliation).

- **Plan mapping:** T6 belongs to Phase D if it can be made
  unconditional, and to Phase F (regime-aware DA keys) if it needs
  cycle / realized-vol gating. Either way it supersedes the plan's
  original Phase E "raise min rank floor" candidate — the diagnostic
  shows raising the floor is the *opposite* of what's needed.

## What's NOT proposed (yet)

- **R6 band widths** — the 6 `mfe_proportional_trail` exits all captured
  valid runner profit (+1.00 % to +4.04 %). No evidence from July that the
  band widths are wrong. Bugbot PR #2 flagged a theoretical "band floor
  equals MFE entry" issue; July data does not show it materialising.
- **R2v3 MFE decay thresholds** — did not fire at all this slice (no
  `MFE_DECAY_*` exit reasons). Need more data before tuning.
- **Max-loss defaults** — the 3 `max_loss` hits are all from the earnings
  cluster (see T3). The fix is entry-gating, not loss-sizing.
- **SPY overlay (Phase E)** — the plan's original Phase E candidate was
  "raise min rank floor" for SPY. The T4 diagnostic inverts that: SPY is
  already being filtered *by* the non-Prime rank floor, and the fix is to
  *relax* it for the ETF subset (T6). Phase E will still own the SPY
  ≥ 80 % WR acceptance gate but starts from T6's new baseline.

## Next step

This doc is **not actionable** in Phase C. Phase D picks it up in this
priority order:

1. **T6 (ETF pullback-depth relaxation)** — clearest single-slice evidence
   with a ready-made two-variant implementation. Risk is well-understood
   (2025-11 bear month). Ship Variant A first, full-coverage replay all
   10 training months, promote to Variant B (regime-conditional) only if
   2025-11 regresses more than 2 pp WR.
2. **T3 (≥4-ticker earnings-cluster entry block)** — single-month evidence
   is strong (all 3 July `max_loss` exits trace to the Jul 28–30 cluster),
   but the rule touches the entry gate which also affects winners. Needs
   cross-month replay before merge.
3. **T1 / T2 / T5** — wait for ≥ 2 months of consistent evidence before
   proposing DA-key changes.

Phase D should also produce a standing "unentered candidates" diagnostic
— the ticker × interval × block_reason matrix this probe produced ad-hoc
— as a committed analyzer output so every monthly report surfaces the
same signal without a manual re-run.
