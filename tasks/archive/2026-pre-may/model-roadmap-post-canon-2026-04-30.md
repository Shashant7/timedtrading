# Post-canonical model roadmap (2026-04-30)

> **Source data**: full Jul 2025 → Apr 2026 canonical run (588 closed trades,
> 51.4% WR, +421.47% cum PnL, 9/10 winning months). Forensic detail in
> `tasks/autopsy-2026-04-30.txt`.

## Headline findings (re-cap)

1. **Mar 2026 was one cohort.** VOLATILE_RUNNER LONGs entered when daily PDZ
   was `discount_approach` — counter-trend mean-revert bets on names that
   aren't mean-reverters. 14 such trades full-run, 4W/9L, **−18.30%**.
   Same setup on PULLBACK_PLAYER personality is roughly neutral
   (+0.35% on 6 trades) → rule must be **personality-conditional**.
2. **Largest single PnL leak: dead-money cuts.** `phase_i_mfe_fast_cut_*` +
   `dead_money_24h` + `early_dead_money_flatten` = 78 trades × −1.23% avg =
   **−95.84% cumulative**. Of those, **32 had no adverse divergence at entry**
   — the runner-protect target population. Currently DA flag DISABLED.
3. **Strong adverse RSI div (strength ≥ 30) at entry: WR 20%, n=5.**
   Small sample but consistent.
4. **`atr_day_adverse_382_cut` is overfit.** Works on VOLATILE_RUNNER
   (5 cuts, the cohort that needs tight stops anyway), hurts PULLBACK_PLAYER
   (17 cuts, −12.87%) and SLOW_GRINDER (8 cuts, −10.58%) — both designed to
   absorb adverse moves and reclaim. **25 of 36 had positive MFE before
   the cut** — we got too cute.
5. **The bread-and-butter is unbroken.** PDZ premium-stack (D + h4 both
   premium) on a LONG = with-trend continuation: 486 trades, WR 52%,
   **+354.77%**. Don't touch this.

## What I'm cautious about

- "+12.28% net" counterfactual from skipping discount_approach LONG-VR is
  *post-hoc on the same dataset that suggested the rule*. Cohort effects
  are real, but the magnitude won't transfer cleanly out-of-sample.
- "~+25% from runner-protect" assumes half the killed-clean trades retrace
  toward MFE if held — soft assumption, not modeled. Could be much smaller
  in practice.
- Mar 2026 only had 29 trades. Some of this could be regime + small-n
  volatility, not a fixable structural flaw.

**The autopsy points at the right experiments to run; I will not promise
the PnL deltas as outcomes. They are hypotheses to validate.**

## Priority-ranked fix list

| # | Fix | Expected impact | Risk |
|---|-----|----------------:|-----:|
| **P1a** | Re-enable runner-protect with clean-entry gate (no adv-div at entry → bypass dead-money cuts) | ~+25% | Low |
| **P1b** | Block strong adverse RSI div (strength ≥ 30) at entry | ~+4% | Negligible |
| **P2** | Block `discount_approach LONG` on personality ∈ {VOLATILE_RUNNER, PULLBACK_PLAYER} | ~+12% | Low–Medium |
| **P3** | Personality-aware `atr_day_adverse_382_cut`: keep tight on VOLATILE_RUNNER, loosen/disable on PULLBACK_PLAYER + SLOW_GRINDER | ~+12% | Medium |
| P4 | Wire `entrySignals` boolean fields into trade record at write-time (DX, no PnL impact, prerequisite for P1a) | 0 | None |

## Promotion gates

### Gate 0 — UI live validation (now)

- Get PR #49 in front of you in a real browser.
- Click through Daily Brief, Bubble Map default Focus filter, tab badges,
  kanban polish, setup name cleanup.
- Sign off or flag pixel-level fixes.
- **Then merge PR #49.**

### Gate 1 — Implement P1 fixes

Both behind DA flags so they can be A/B'd and rolled back instantly.

**P1a — Runner-protect with clean-entry gate**
- Re-enable `deep_audit_runner_protect_healthy_enabled` (currently `false`).
- Add new gate `deep_audit_runner_protect_require_clean_entry` (default
  `true`) that requires `entrySignals.adverse_rsi == false &&
  adverse_phase == false` at trade-creation time to bypass dead-money cuts.
- Wire `entrySignals` into the trade record at creation so exit logic
  doesn't re-parse `setup_snapshot` (this is P4 from the autopsy — pulled
  forward because P1a depends on it).
- Code touches:
  - `worker/index.js` trade creation block — write `entrySignals`
  - `worker/index.js` `processTradeSimulation` exit gates — read
    `trade.entrySignals` instead of re-parsing setup_snapshot
  - `worker/replay-runtime-setup.js` — register the new flag

**P1b — Block strong adverse RSI div (strength ≥ 30) at entry**
- New gate in `worker/pipeline/entry-selector.js`. Default: enabled.
- Unit test in `scripts/test-phase-c-entry-selector.js`.

### Gate 2 — A/B replay validation

Re-run canonical Jul → Apr backtest **twice** under the same code:

- `run_a` — baseline (P1a/P1b OFF). Should reproduce the +421%.
- `run_b` — with P1a + P1b ON.

Compare:
- Per-month PnL (especially Mar 2026)
- Winning months count (target: 10/10, was 9/10)
- WR delta on the cohorts the autopsy targeted
- Cum PnL delta

**Promotion criteria (must all pass):**
- ≥ 8 of 10 months ≥ baseline.
- Mar 2026 ≥ baseline (the test month).
- No month with ≥ −5% regression that wasn't already negative in baseline.
- No new "open at end" pile-up (>5 of total).

If criteria don't pass, iterate on gate parameters and re-replay. Do **not**
promote.

### Gate 3 — Live activation

- Promote PR to merge → main → live worker auto-deploys.
- Activate DA flags in production for **simulation slot only first**.
- Watch ≥ 1 week of live behavior before flipping to any non-sim slot.
- Right rail / Discord alerts already show conviction + signals so we can
  monitor the gate decisions in real-time.

### Gate 4 — P2 / P3 (deferred until P1 is validated)

- **P2** (`discount_approach LONG` block on VOLATILE_RUNNER + PULLBACK_PLAYER)
  is a more invasive entry filter — takes capacity. Only activate after P1
  lands and the engine has its capacity baseline back.
- **P3** (personality-aware ATR cut) is the riskiest because it loosens
  existing protective cuts. Requires its own A/B replay.

## Open questions

- Mar 2026 had ~50% lower trade volume than Jul-Feb avg. Was this regime
  (low setup-density) or did entry-quality blocks tighten? Worth a per-month
  block-chain analysis before assuming the trade count delta is "fixable".
- The 32 "clean entry → killed by dead-money" trades — what's their
  distribution by setup-name? If concentrated on one setup, the runner-protect
  scope can be narrowed (lower risk of letting a structurally bad setup ride).
- TD9 fired on only 75 trades total (10 bullish, 65 bearish). Sample is
  small; revisit predictive value after another quarter of data.
