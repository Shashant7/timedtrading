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

### T4. Investigate why SPY/QQQ/IWM produced zero entries in an 82 % bull month

- **Evidence:** No trades on the three large-cap ETFs despite 22 days of
  bull-bias. Phase-A locked config has `deep_audit_confirmed_min_rank` +
  pullback-depth gates that appear to filter out qualifying ETF entries.
- **Proposal (diagnostic, not tuning):** Phase D needs an "unentered
  candidates" diagnostic — `intervals × tickers × block_reasons` matrix for
  each month — so we can tell *why* SPY/QQQ/IWM never triggered. This is a
  Phase D analyzer requirement, not a DA-key change.
- **Expected impact:** diagnostic clarity; no metric change.

### T5. `PRE_EVENT_RECOVERY_EXIT` is firing as intended but costing marginal edges

- **Evidence:** PH (Jul 9 → Jul 10, +0.09 %) and GRNY (Jul 29, −0.15 %) both
  exited via `PRE_EVENT_RECOVERY_EXIT`. The rule correctly de-risked ahead
  of events, but in both cases the ticker continued higher into the event.
- **Proposal:** keep the rule as-is for this slice. Revisit in Phase D once
  we have 3+ months of PRE_EVENT_RECOVERY_EXIT data — single-month sample
  is too noisy.

## What's NOT proposed (yet)

- **R6 band widths** — the 6 `mfe_proportional_trail` exits all captured
  valid runner profit (+1.00 % to +4.04 %). No evidence from July that the
  band widths are wrong. Bugbot PR #2 flagged a theoretical "band floor
  equals MFE entry" issue; July data does not show it materialising.
- **R2v3 MFE decay thresholds** — did not fire at all this slice (no
  `MFE_DECAY_*` exit reasons). Need more data before tuning.
- **Max-loss defaults** — the 3 `max_loss` hits are all from the earnings
  cluster (see T3). The fix is entry-gating, not loss-sizing.
- **SPY overlay** — zero SPY trades in July ⇒ no data to tune. Phase E will
  start from this observation.

## Next step

This doc is **not actionable** in Phase C. Phase D picks it up, applies T3
as the first narrow DA-key experiment (the only proposal with unambiguous
evidence in a single slice), replays July + Aug + Sep + Oct + Nov + Dec +
Jan + Feb under both old and new behaviour, and only then opens a PR to
merge the DA-key change.

Carry forward T1 / T2 until we have ≥ 2 months of consistent evidence.
