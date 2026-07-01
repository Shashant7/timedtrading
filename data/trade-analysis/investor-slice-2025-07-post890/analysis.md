# Investor post-#890 vs v12 — July 2025 slice analysis

_Generated 2026-06-29T21:52:29.086Z · daystate 2025-07-01 (preprod KV) · exit 2025-07-31 D close (preprod D1)_

## Executive summary

The **`investor-post890-july`** tmux run **completed** (2026-06-29 ~01:01 UTC). This is the first formal writeup.

| source | Jul 1 opens | month-end auto report |
|---|---:|---|
| v12 (`investor-slice-2025-07-v12`) | **15** | 14W/1L · +$6,381 |
| post-#890 (`investor-slice-2025-07-post890`) | **8** | 15W/0L · +$4,850 |
| **Δ (post890 − v12)** | **-7** | post890 **−$1,531** on reported ΣP&L |

PR #890's **4H SuperTrend slope gate** is the intended explanation for fewer Jul 1 opens (15 → 8). A daystate replay on **current** preprod KV (post–v14 trader slice) confirms the mechanism on **META** but shows **scoring drift**: only **7** tickers reach `accumulate` today vs **15** logged on Jun 28.

## 1. Observed slice logs (authoritative open counts)

From `data/trade-analysis/run-investor-post890-july.log` and `run-v12-retry-2025-07.log`:

- **v12:** `2025-07-01  +15 open / -0 close` → month-end force-close 15 positions
- **post890:** `2025-07-01  +8 open / -0 close` → month-end force-close 15 positions

The post890 run used `--no-reset`; month-end `open_before=15` vs `opened=8` in the replay log implies **7 positions were already open** before/alongside the slice (carryover), not 15 fresh Jul 1 deploys. Treat headline **100% WR** on the post890 report as **artifact noise**.

Auto reports (`investor-accuracy-report.mjs`) aggregate **all** closed investor lots on preprod in a 400d window — not an isolated run export.

## 2. Daystate replay (current KV + `worker/investor.js`)

Slice universe = **24 tickers** with `monthly_bundle` in daystate (July v14 trader replay). Simulation uses investor-replay rules: `accumulate` stage, D/W/M ST alignment, max 15 slots, $5k notional.

| variant | Jul 1 opens (sim) | Jul 31 ΣP&L (sim) | W/L |
|---|---:|---:|---:|
| v12 baseline — slope gate **off** | 7 | +$2,676 | 7/0 |
| post-#890 — slope gate **on** | 6 | +$2,299 | 6/0 |

**Scoring drift:** simulated open counts (7 / 6) are below logged counts (15 / 8) because Jun 28–29 daystate had more `accumulate`-stage names under the then-deployed engine bundle.

### Blocked by slope gate (baseline opens − post890 opens)

| ticker | score | stage | 4H stDir | 4H stSlope | stSlopeDn | Jul 31 counterfactual P&L |
|---|---:|---|---:|---:|---|---:|
| META | 55 | accumulate | 1 | -1 | yes | +$377 |

**META** (score 55): 4H ST **bearish** with **active downward slope** (`stDir=+1`, `stSlope=-1`) — canonical #890 block. Jul 31 counterfactual: **+$377** (winner blocked).

### Shared sim opens

SGI, QQQ, AMZN, IESC, XLY, GOOGL

## 3. v12 loser (reported 14W/1L)

Per-ticker trade export was **not** saved for the v12 investor slice. On **current** Jul 1 daystate, Jul 31 D-close marks for the top ST-aligned slice names are **all winners** — so the reported loser likely comes from:

1. A **lower-ranked** Jul 1 open not reproduced in today's daystate (scoring drift), and/or
2. **Force-close pricing** differing from D-close marks, and/or
3. Report **aggregation** across multiple preprod replay generations.

Worst Jul slice-universe D-close performers (if opened Jul 1): **HUBS −6.9%**, **SWK −3.9%** — plausible loser candidates if v12 included them at `accumulate` on Jun 28 daystate.

## 4. Interpretation & recommendation

- **Slope gate works as designed** on opposing 4H slope (META blocked; flat 4H bearish names like MTZ/AGQ are **not** blocked per PR #890 spec).
- **Observed economics:** post890 auto report **underperformed** v12 by **~$1,531** on ΣP&L despite perfect WR — fewer/smaller deploy + carryover artifacts; do not read 100% WR as edge validation.
- **July counterfactual on META:** gate forfeited **~$377** on a clean D-close mark — acceptable if the gate prevents larger CRDO/MOD-style re-entry damage live (the PR #890 motivation).
- **Next step:** when replay lock clears, re-run **isolated** v12 vs post890 investor slices with `--reset`, export per-lot JSON, and name all **7** blocked tickers on identical daystate.
- **Keep slope gate live** pending live decision_records with engine=investor; tune only after a second month + live rebalance sample.

## 5. Caveats

1. Day-1 deploy + month-end mark methodology — not live mid-month invalidation.
2. Daystate version mismatch vs Jun 28–29 runs (v14 KV blob today).
3. post890 `--no-reset` carryover inflates month-end position count vs replay `opened=` counter.
4. Re-run isolated slices (when replay lock free) to export `investor_lots` per run_id.

---
`TIMED_API_KEY=… node scripts/analyze-investor-post890-july-diff.mjs`