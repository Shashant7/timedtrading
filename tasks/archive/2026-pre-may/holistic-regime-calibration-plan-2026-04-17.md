# Holistic Regime Calibration Plan — 2026-04-17

> **Single source of truth for Cloud Agent execution.** Every phase below maps to a feature branch and a PR. Do not mix phases in a single PR. Artifacts (backtests, CSVs, raw JSON) live under `data/trade-analysis/<run_id>/` and are git-ignored for large files; only `report.md` and `proposed_tuning.md` are committed.

---

## Goal

Build a system the user can blindly follow with:

1. **High win rate** on every monthly slice.
2. **Preserved big winners** (≥5 % PnL trades are not clipped by management rules).
3. **SPY ≥ 80 % WR** as a standalone acceptance target.
4. **Full Jul 2025 → Apr 17 2026 coverage** so we avoid regime-specific overfit.

---

## Design principles

- **Monthly slicing, not monolithic runs.** Each month is a separate backtest with its own artifacts. Avoids orchestrator stalls, makes progress visible, enables walk-forward.
- **Backdrop → outcome pairing.** Every monthly report is tagged with the month's cycle / sector / regime / cross-asset-vol snapshot, so tuning proposals are justified by "this is what worked in this backdrop."
- **Additive engine changes only.** Each DA-key tweak is a standalone PR, validated on the current month, then replayed across all prior months before merge.
- **Walk-forward holdout.** Last one or two months are always held out from calibration until explicitly validated.
- **Clean single-writer replay.** No DO-runner + direct-loop concurrency. Every run is single-writer; dual writes silently corrupt trade state (observed 2026-04-17 in Run B v1/v2).

---

## Universe

- **Tier 1 (priority for regime analysis + SPY target):**
  `SPY, QQQ, IWM, AAPL, MSFT, GOOG, AMZN, META, NVDA, TSLA`
- **Tier 2 (broad-coverage basket, preserves existing signal):**
  `AGQ, CDNS, ETN, FIX, GRNY, HUBS, IESC, MTZ, ON, PH, RIOT, SGI, SWK, XLY`
- Combined **24-ticker universe** for every monthly slice.
- Data preflight verified 2026-04-17: candles and earnings coverage present for Tier 1 across May 2025 – Apr 2026 (ETFs correctly have no earnings).

---

## Phase roadmap

Each phase = one branch, one PR. Branch naming is fixed.

### Phase A — Foundation freeze

**Branch:** `phase-a/foundation-freeze`

**Scope**

- Commit the already-implemented R5 + R6 + KV-binding fix as its own PR (it exists only as uncommitted changes on `main` today).
- Lock in: `R5 ON + R2v3 ON + R6 ON` as the base config package.
- Update `tasks/lessons.md` with:
  - Bug E (`env.KV` vs `env.KV_TIMED` in replay steps).
  - DO runner stall pattern + "always use direct loop" guidance.
  - Dual-writer contamination pattern (two concurrent writers on the same `run_id` corrupts trade lifecycle).

**Outputs**

- One PR. Deploy the worker. Record the deployed `Version ID`.

**Acceptance**

- Direct candle-replay on `2025-07-01` returns `ok: true`.
- Fresh Jul–Nov direct run preserves CDNS Jul 1 lifecycle (no silent `OPEN`).

---

### Phase B — Monthly backdrop framework

**Branch:** `phase-b/monthly-backdrop`

**Scope**

Build `scripts/build-monthly-backdrop.js` that emits, per month, a `data/backdrops/<YYYY-MM>.json` with:

- **Cycle**: market-cycle phase label (uptrend / distribution / downtrend / accumulation), derived from `tf_tech.D` + `tf_tech.4H` aggregates across Tier-1 tickers.
- **Sector leadership**: top and bottom sectors by relative strength vs SPY, and the rotation delta vs the prior month.
- **Regime frequency**: count of `HTF_BULL_LTF_BULL / BULL_PULLBACK / BEAR_* / TRANSITIONAL` across Tier-1.
- **Cross-asset volatility**: VIX avg/max, MOVE, DXY trend direction, gold/oil dispersion.
- **Event density**: earnings dates in scope + known macro events (FOMC / CPI / jobs) from `worker/market-events-seed.js`.

**Outputs**

- One PR. Script + 10 pre-built monthly backdrop JSON files for `2025-07 … 2026-04`.

**Acceptance**

- All 10 JSON files present and schema-consistent.
- Spot-check 2025-11 correctly flags the earnings-cluster density we know caused the R3 drought.

---

### Phase C — Monthly slicer + first pass

**Branch:** `phase-c/monthly-slicer`

**Scope**

- Extract the direct-loop logic into `scripts/monthly-slice.sh` with:
  - Watchdog that detects a hung session (no `runner_session_complete` log line for > 180 s) and auto-resumes from the last completed date.
  - Lock acquire / release on start and exit.
  - Single-writer enforcement: abort if `backtest_runner` reports an active DO run against the same `run_id`.
- Launch the first slice: `2025-07` on the 24-ticker universe with the locked config package.

**Outputs**

- One PR for the script.
- Follow-up PR with the `2025-07` slice artifacts: `report.md`, `proposed_tuning.md`, comparison vs v5 baseline.

**Acceptance**

- `2025-07` slice completes end-to-end without stall.
- Artifact trade counts match between `trades.csv` and `/admin/runs/trades`.

---

### Phase D — Per-month analysis loop

**Branch template:** `phase-d/slice-<YYYY-MM>`

**Scope** (repeat for each month)

- Run monthly slice.
- Analyzer produces:
  - Setup × backdrop heatmap (entry_path × setup_grade × execution_profile × sector).
  - Grade calibration: did Prime / Confirmed / Speculative each perform as labeled in this backdrop?
  - MFE / MAE distributions per grade and setup.
  - **Big-winner retention rate** = realized PnL / MFE peak. Target ≥ 60 %.
  - Clear-loser reduction rate vs widen v5 baseline.
- `proposed_tuning.md` lists specific DA-key deltas with the expected impact number.

**Outputs**

- One PR per month: `report.md`, `proposed_tuning.md`, and the `tuning_proposal.json` describing key deltas.

**Acceptance gates per month**

- WR ≥ current best − 2 pp.
- Big-winner count ≥ current best − 1.
- PnL ≥ 0.

If a month's proposal fails a prior month's gate on replay, **do not merge**; iterate.

---

### Phase E — SPY-only optimization track

**Branch:** `phase-e/spy-track-<YYYY-MM>`

**Scope** (runs in parallel with Phase D)

- SPY-only monthly slice with a tunable SPY overlay in `configs/spy-overlay.json`.
- Candidate entry tightenings:
  - Raise min rank floor.
  - Require `HTF_BULL_LTF_BULL` state + daily cloud aligned.
  - Block SPY entries on earnings-week days of its largest constituents.
- Candidate management tightenings:
  - R6 with narrower bands (e.g., 2 % → 0.5, 4 % → 0.7, 7 % → 0.85).
  - R2v3 with MFE-peak threshold lowered to 2 % for SPY specifically.

**Acceptance**

- SPY WR ≥ 80 % across all 10 monthly slices.
- SPY average ≥ 10 trades / month across Tier 1 co-entries.
- No SPY big-winner is lost relative to the un-overlaid baseline.

**Outputs**

- Final PR lands `configs/spy-overlay.json` and a `spy-acceptance-report.md` proving the target.

---

### Phase F — Dynamic engine calibration

**Branch:** `phase-f/regime-calibration`

**Scope**

Translate Phase D + E insights into runtime behavior:

- **Setup favoring**: regime-conditional DA keys for `tt_momentum` (e.g., enable `correction_transition` only when MOVE ≥ threshold).
- **Risk sizing**: regime multipliers tied to VIX / MOVE quartiles.
- **Management**: R6 bands per regime.

**Acceptance**

- Parity replay across all 10 months: no month regresses > 2 % in WR or PnL.
- At least two months show material improvement from the regime-aware variant vs the static package.

---

### Phase G — Walk-forward holdout validation

**Branch:** `phase-g/walkforward-holdout`

**Scope**

- Hold out `2026-03` and `2026-04` from calibration.
- Train / tune on `2025-07 … 2026-02`.
- Validate the final config package against the holdout months.

**Acceptance**

- Holdout WR within 3 pp of training average.
- Holdout PnL within 10 % of training average.
- No holdout month below 55 % WR.

If any gate fails: do NOT merge Phase F. Iterate until stable.

---

### Phase H — Cloud Agent execution contract

**Branch:** `phase-h/cloud-agent-runner`

**Scope**

- `scripts/cloud-agent-monthly.sh` that the Cloud Agent calls for each slice.
- Agent-invariant behavior:
  1. Pull latest `main`.
  2. Create its phase branch.
  3. Run the slice via the direct loop.
  4. Wait for completion. Auto-resume on stall.
  5. Run analyzer.
  6. Commit artifacts + report.
  7. Open a PR with standard metadata (month, run_id, gate pass / fail summary).
  8. Stop. Never merges its own PR.

**Acceptance**

- Agent successfully completes a dry run on the `2025-07` slice without manual intervention.

---

## Anti-overfit safeguards (mandatory)

1. **Full-coverage rule**: any DA-key change must survive replay on all 10 months.
2. **Regression budget**: no month may regress in WR by more than 2 pp or in PnL by more than 10 %.
3. **Holdout discipline**: `2026-03` and `2026-04` are frozen until Phase G.
4. **SPY isolation**: SPY overlay never changes during evaluation of an overlay candidate — only before and after.
5. **Commit hygiene**: one concern per PR (code / config / analysis / docs never mixed).

---

## Cloud Agent handoff checklist (for session kickoff)

1. Confirm branch: `plan/holistic-regime-calibration` is pushed and this file is accessible.
2. Read `tasks/todo.md` and `tasks/lessons.md` first.
3. Execute phases in order. Never start Phase D monthly slices before Phase C is merged.
4. If ambiguity in a DA-key change, open a draft PR and pause for human review.
5. Never force-push. Never rebase main.
6. Always deploy the worker before a monthly slice and record the Version ID in the PR body.

---

## Open decision before Phase A starts

The A vs B clean comparison showed:

| Run | WR | PnL | Big winners | Note |
|---|---|---|---|---|
| Run A (R5 on, R2v3 off) | 58.44 % | $8,027 | 7 | more PnL |
| Run B (R5 on, R2v3 on)  | 62.96 % | $7,512 | 7 | +4.5 pp WR |

Given the stated goal (high WR + preserve big winners), we adopt **R5 ON + R2v3 ON + R6 ON** as the locked base for Phase A. Phase D will surface any regime where R2v3 should be conditionally disabled.
