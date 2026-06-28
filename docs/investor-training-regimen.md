# Investor Mode — Training Regimen

The Active Trader evolves through a tight, repeatable loop: **reset → replay a
month → analyze → tune `deep_audit_*` knobs → re-run → compare vs an anchor**
(`scripts/monthly-slice.sh`, anchored on `phase-c-slice-2025-07-v1`). Until now
Investor Mode had the replay *primitive* but no equivalent regimen, so it
couldn't evolve the same disciplined way. This doc defines the parity loop.

## TL;DR — one command

```bash
TIMED_API_KEY=… scripts/investor-slice.sh --month=2025-07 --run-id=investor-slice-2025-07-v1
```

Resets the pre-prod replay lane, walks the month day-by-day through
`/timed/admin/investor-replay`, then prints + writes the accuracy report
(WR / P&L / payoff, split by FSD tier) to
`data/trade-analysis/investor-slice-2025-07-v1/report.md`.

## The loop (trader-parity)

1. **Anchor.** Establish a baseline run and freeze its numbers as the bar to
   beat (the investor analog of `phase-c-slice-2025-07-v1`). First run on a
   clean config = the anchor; record WR, sum P&L, payoff, and the FSD-tier
   split. Suggested id: `investor-slice-2025-07-v1`.
2. **Hypothesis → knob.** Pick ONE lever (table below) and change it in
   `model_config` on pre-prod (`scripts/sync-model-config-to-preprod.mjs` or a
   `push-*-config.mjs`). One change per iteration so deltas are attributable.
3. **Re-run** `investor-slice.sh` with a new `--run-id` (e.g. `…-v2`).
4. **Compare** the report vs the anchor. Beat it on the metric that matters
   (WR for "pick winners"; payoff/Σ for "let winners run") without regressing
   the others.
5. **Promote or revert.** A lever that beats the anchor on pre-prod and holds up
   across ≥2 months graduates to live `model_config` (a tier-2
   `learning_proposals` change — operator-gated, never auto). Losers are
   archived as negative results (like July trader v9).

## Levers (all `deep_audit_investor_*`, live-tunable, replay-mirrored)

| Knob | Default | What it tunes |
|---|---|---|
| `accumulate_strong_score_min` | 70 | Score → Accumulate stage gate |
| `auto_init_min_score` | 65 | Capital-deployment floor |
| `fsd_strong/core/light_score_relief` | 10 / 6 / 3 | FSD picks clear the floor with conviction relief (selection is done; time the entry) |
| `fsd_offlist_score_bump` | 0 | Extra bar for non-FSD names |
| `loss_reentry_cooldown_days` | 10 | Block re-entry after a losing close (CRDO/MOD fix) |
| `loser_cooldown_consec_losses` / `_days` | 2 / 45 | Persistent-loser ban |
| `fsd_removal_exit_enabled` / `_exit_pct` / `_window_days` | on / 1.0 / 14 | Exit when FSD drops a name |
| `accum_zone_momentum_runner_*` | see code | Momentum-runner accumulation-zone detection |
| `reduce_trim_min_sessions` / `_pct` | 2 / 0.30 | Reduce-stage trim cadence |
| `invalidation_min_hold_hours` | 18 | Defer same-session invalidation round-trips |

Defaults + bounds: `loadInvestorConfig()` in `worker/investor.js`. Replay parity
list: `REPLAY_DA_KEYS` in `worker/replay-runtime-setup.js`.

## Metrics (what "beat the anchor" means)

From `scripts/investor-accuracy-report.mjs` (the analyzer the slice runs):

- **WR** — wins / closed. The "pick winners" north star.
- **Sum P&L** and **payoff** (avg win ÷ |avg loss|) — does the edge compound?
- **FSD-tier split** — do GRNY/GRNJ/GRNI picks out-perform non-FSD names? (Live
  baseline 2026-06-28: FSD 62% WR vs non-FSD 57% — anchoring validated.)
- **Signal-outcome loop** — `investor_action` forward-return grades mature at
  the 60-day horizon (resolver pit-stop heal keeps them current).

## Day-state dependency (READ BEFORE running)

`investor-replay` scores the investor universe from `timed:replay:daystate:{date}`.
That day-state is written by the **trader** `candle-replay`, which the trader
`monthly-slice.sh` runs with **`skipInvestor=1`** — so it carries trader scoring
but **not** the investor inputs (monthly bundle / accumulate stage) the investor
entry gate needs. Consequence: a standalone investor slice on a freshly-reset
env returns **0 opens** (confirmed 2026-06-28: `investor-slice-2025-07-v1` opened
0 across all 22 July days even though day-state existed).

**Correct sequence to produce a real investor anchor:**
1. Seed **investor-inclusive day-state** for the period — either a `candle-replay`
   run WITHOUT `skipInvestor=1`, or a dedicated per-day investor scoring pass that
   writes the investor stage into `timed:replay:daystate:{date}`.
2. Run `investor-slice.sh --month=… --no-reset` so it **reuses** that day-state
   instead of wiping it.

This is the open tooling gap for the investor regimen: the slice drives the
replay + analysis correctly, but the upstream day-state must include investor
scoring. Closing it (a `--seed-investor-daystate` step, or a monthly-slice flag
to drop `skipInvestor`) is the next build before the first investor anchor.

## Guardrails (learned the hard way)

- **Pre-prod only.** `investor-slice.sh` defaults to
  `timed-trading-ingest-preprod` and resets the replay lane (`replayOnly=1`) —
  live investor positions are never touched. Confirm the base URL before a run.
- **One lever per iteration.** Bundled changes make deltas unattributable.
- **Selectivity > volume.** The trader's July v9 (`rank_bypass=0`) over-traded
  (43 trades / 42% WR) and lost to the anchor (25 / 76%). The same trap applies
  here: loosening score floors to surface more names dilutes WR. FSD relief is
  bounded for this reason — it lowers the bar only for names the desk already
  selected, not for everything.
- **FSD membership is current-holdings data** → the slice's FSD-tier split is
  directional (membership at report-time, not at-trade-time). Treat tier deltas
  as a guide, not a point-in-time truth.
- **Infra flakiness.** Replay days can return `503 / error 1102` (worker
  resource limit) under load; the driver retries 5× with backoff. Re-run with
  `--resume` if a run aborts.

## Files

- `scripts/investor-slice.sh` — the driver (this regimen, one command).
- `scripts/investor-accuracy-report.mjs` — the analyzer (WR / P&L / FSD tiers).
- `worker/index.js` `runInvestorDailyReplay()` — the replay engine each day.
- `worker/investor.js` — score / stage / config; all `deep_audit_investor_*`.
- `tasks/2026-06-28-investor-mode-deep-dive.md` — why this regimen exists.
