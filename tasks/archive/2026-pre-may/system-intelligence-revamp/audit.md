# System Intelligence — Revamp Audit (2026-05-03)

> Source: `react-app/system-intelligence.html` (4,466 lines).
> Active backtest: `phase-c-stage1-jul2025-may2026` (live, single-leg
> continuous Jul → May 2026 in `tmux phase-c-leg`). Last completed sim
> day: **2025-08-29**. The `replay-lock` is currently false (the leg
> orchestrates its own checkpoint).
>
> Calibration generation visible on Dashboard: **#22**, dated
> 2026-03-17 — **stale by ~6 weeks** versus the active leg.

## Tab-by-tab audit

### 1. Dashboard
- **Shows**: Hero KPIs (SQN/WR/Expectancy/Avg R/Trades/PF) tagged
  "Generation #22", Model Health snapshot, Direction Accuracy
  (7,263 resolved), What's Working / Proceed With Caution path
  rankings, "What the Data Shows" winner-move profiles, Applied
  Adaptations, Hindsight Oracle, VIX regime grid.
- **Data sources**: `GET /timed/system/dashboard` → reads the most
  recent calibration report from D1 (`calibration_reports` /
  `pattern_outcomes`). Does NOT join the active backtest run.
- **Stale?** Yes — KPIs are from generation #22 (2026-03-17). Active
  leg is generating fresh trades into `backtest_run_trades`
  (`phase-c-stage1-jul2025-may2026`) but those numbers are not shown
  here at all.
- **User intent**: At-a-glance "is the engine healthy?" + "is my
  current backtest looking good?".
- **Top UX problems**:
  1. Headline numbers refer to a months-old generation, not the
     active run. Misleads any operator landing here.
  2. 6-tile KPI strip + 6 sub-cards (Model Health, Direction Acc,
     What's Working, Proceed with Caution, "What the Data Shows",
     Applied Adaptations, Hindsight Oracle, VIX Regime) — no clear
     reading order.
  3. Uses legacy `card`/`badge-good`/`badge-bad` styles, not v2 `--ds-*`
     tokens. Visual mismatch with the rest of the suite.
- **Latent use case**: Live "engine health" pill (green/yellow/red
  based on Loop 2 pause state, recent WR, consecutive losses) and a
  top-5 winners / bottom-5 losers list pulled from the active run's
  trades — that's the actual "is the system passing?" signal an
  operator wants in 10 seconds.

### 2. Analysis (Live Audit + Calibration Report)
- **Shows**: Two stacked surfaces — `DeepAuditTab` (Executive Summary,
  Direction, Exit Reasons, Tickers, Entry Paths, Time & Hold,
  Recommendations) and `CalibrationTab` (Health & Apply, Entry Paths
  & Profiles, Models & Signals, Risk Management, Market Context,
  Trade Quality).
- **Data sources**: `GET /timed/calibration/deep-audit` and
  `GET /timed/calibration/report`. Both run from `closed_trades` /
  `direction_accuracy`. Not scoped to a `run_id`.
- **Stale?** Calibration report is generation #22 from Mar 17. Deep
  audit re-runs on every page hit, so it's "live" against the live
  trades store, but it is NOT scoped to the active backtest run — it
  blends archived runs and live trades.
- **User intent**: "Tell me what's broken in the engine and what to
  flip." This is the gold-mine tab.
- **Top UX problems**:
  1. Two parallel surfaces (Live Audit vs Calibration Report) with
     overlapping content and very different idioms. New user has no
     idea which to trust.
  2. "Apply Top 3 Recs" only updates `model_config`. It does not
     touch the active backtest's `backtest_run_config` so changes
     have zero effect on the in-flight leg.
  3. No way to refresh-on-write or auto-refresh while the active
     backtest is running. Operator has to remember to refresh.
- **Latent use case**: "Show me Aug 2025 specifically" filtering tied
  to an `?run_id=` query, plus a "Run Analysis" button that re-runs
  the audit pipeline server-side (no local `node scripts/calibrate.js`
  required) and surfaces proposed config-patches on the active run.

### 3. Runs (Operations Console + Backtest Runs Registry)
- **Shows**: Top — `Backtest Operations Console` (4 KPI cards +
  Active Run Console + Queued Jobs + Recent Completed + Operator Feed
  + Launch Contract). Bottom — `Backtest Runs` table with 7+ action
  buttons per row, a Compare modal, a Variant modal, and a Detail
  modal.
- **Data sources**: `/timed/admin/runs?limit=60`,
  `/timed/admin/runs/live`, `/timed/admin/replay-lock`,
  `/timed/admin/backtests/status`, `/timed/admin/backtests/logs`.
  Polls every 5 s.
- **Stale?** No — auto-refreshes; Backtest Operations Console pulls
  every 5 s from the runner.
- **User intent**: "What's running, what's done, what should I
  promote?"
- **Top UX problems**:
  1. **Massive cognitive load.** 4 KPI cards on top, plus Active Run
     console, plus Queued Jobs, plus Recent Completed, plus Operator
     Feed, plus Launch Contract — six panels for what is at most
     three pieces of info.
  2. Per-row action set: Refresh Metrics / Details / Autopsy /
     Compare / Validate Sentinels / Promote Live / Promote → Trades /
     Archive / Delete. Nine buttons per row. Most are rare. No
     "default action" highlighted.
  3. Recent Logs Panel duplicates the Active Run Console's status
     stream with different formatting. Operator has to read both.
- **Latent use case**: Single-row "active run banner" at the top
  with progress (sim day X of Y, last 5 trades, P&L), and ALL row
  actions collapsed to a `…` menu with `Details` as the click-through
  default. The registry table should default-sort by recency,
  hide archived, and not pre-load the variant modal on hover.

### 4. Move Discovery
- **Shows**: "5 KPI tiles (Total Moves, Capture Rate, Missed,
  Churned, Diagnosis Coverage) + 4 sub-tabs (Overview, Miss
  Buckets, Churn, Explorer).
- **Data sources**: `GET /timed/move-discovery` → reads the result of
  the LOCAL scripts `discover-moves.js` and `diagnose-missed-moves.js`
  uploaded to KV (`move:discovery:report`). Last upload was
  2026-03-09 per the displayed `generated` field.
- **Stale?** Yes — generated 2026-03-09 (so ~8 weeks stale).
  Diagnosis Coverage is 0 because the diagnosis script was never
  re-run after the move-data refresh.
- **User intent**: "Where are we leaving money on the table and
  what's the next knob to tune?"
- **Top UX problems**:
  1. Diagnosis Coverage tile shows `0` as if it's a metric, with no
     CTA to fix it. Operator can't tell whether it's broken or just
     truly zero.
  2. "Current Read" card on Overview is a wall of conditional
     text — useful but no action button. It says "increase HTF
     weight in rank formula" with no link to the knob.
  3. Sub-tab labels include counts (e.g. "Churn (12)") which is good,
     but the Overview vs Miss Buckets vs Churn vs Explorer split is
     not differentiated visually — looks like the same content
     repeated four ways.
- **Latent use case**: Each metric card should drill down into either
  (a) the Trade Autopsy page filtered to those trades, or (b) the
  specific calibration knob to tune. Diagnosis Coverage = 0 should
  show a one-click "Run diagnosis" CTA that POSTs to a new endpoint
  and uploads results.

### 5. Patterns & Learning
- **Shows**: 4 sub-tabs — Pattern Library (TD9/TD13/Bull/Bear etc.),
  Predictions (recent), Learning Loop (direction accuracy by entry
  path), Ticker Profiles (which includes Market/Sector context
  history + regime profile mapping + ticker context profiles).
- **Data sources**: `GET /timed/model/patterns`,
  `GET /timed/model/predictions`, `GET /timed/model/retrospective`,
  `GET /timed/system/ticker-profiles`,
  `GET /timed/system/regime-profiles?limit=24`,
  `GET /timed/system/context-history?limit=20`.
- **Stale?** Pattern Library shows 25 active patterns, many with
  `samples=0`. Context History pane is empty (the
  `/timed/system/context-history` endpoint returns `{market: [],
  sectors: []}` on most environments because the source D1 table
  `market_context_daily` isn't populated by any cron in this
  worker — it's only seeded by a one-shot script that has not been
  re-run).
- **User intent**: "Which patterns are working? Which tickers does
  the engine 'understand'?"
- **Top UX problems**:
  1. Empty Context History pane gives no feedback — operator can't
     tell if the table is empty or the call failed.
  2. Pattern Library shows all 25 patterns including ones with 0
     samples — pure noise.
  3. Ticker Profiles table is a very wide 9-column grid that's hard
     to scan; the personality count chips at the top are a much
     better navigation aid but get scrolled past.
- **Latent use case**: Default-filter patterns to those with `samples ≥
  20` (with a "show all" toggle). For Context History, when empty,
  surface a "Run context backfill" CTA pointing at the right script
  (or auto-run if cheap).

### 6. History
- **Shows**: A flat table of calibration generations (#1…#22) with
  SQN/WR/Expectancy/Avg R deltas; click row → load that report into
  the Analysis tab.
- **Data sources**: `GET /timed/system/history`. Reads
  `calibration_reports` table.
- **Stale?** The table is correct as of generation #22 (Mar 17). No
  new generations have been written since.
- **User intent**: "Did calibration improve over time?" + "Let me
  re-open generation N's report."
- **Top UX problems**:
  1. Row click silently swaps the Analysis tab content with no
     breadcrumb / no return-to-current.
  2. No visual delta direction indicator beyond green/red on the
     already-tiny `DeltaBadge` chip.
  3. No way to compare two generations side-by-side.
- **Latent use case**: Sparkline of SQN over generations directly in
  the History header so operator sees the trend without reading
  numbers.

### 7. Trade Grading
- **Shows**: Three risk tier inputs (Prime / Confirmed / Speculative)
  with per-trade $ at $100K and $25K accounts, plus a Tier
  Distribution table (Closed Trades).
- **Data sources**: `GET /timed/admin/grade-config`. Posts to
  `/timed/admin/model-config`.
- **Stale?** Inputs reflect saved values; distribution table reflects
  trades actually closed against the engine. Live.
- **User intent**: "Set risk per tier, see how many trades each tier
  produced."
- **Top UX problems**:
  1. Sits as a 7th tab when it's really a single-screen settings
     panel — could live in a sub-section of Dashboard / Settings.
  2. The "Save Changes" button doesn't preview impact on portfolio
     drawdown, so operator can't reason about the change.
  3. The "On $100K: $X risk per trade" math is correct but lacks
     context — what's the current account balance, what's the YTD
     impact of moving Prime from 1.0% → 1.5%?
- **Latent use case**: Rolled into Dashboard as a small "Risk Wallet"
  card; the table-of-tiers can show recent contributions to current
  P&L so the operator can see the live cost of each tier.

## Information Architecture proposal

### Goal
Someone unfamiliar lands on `/system-intelligence.html` and within
30 seconds knows:
1. Is the engine healthy?
2. Is the latest backtest passing?
3. What should I tweak next?

### Proposed 4-tab IA

| New tab | Folds in | Top-of-page content |
|---|---|---|
| **Engine** (default) | Old Dashboard + Trade Grading + relevant Health items from Patterns | Engine Health pill (green/yellow/red), live KPIs from active run, top winners/losers, risk-tier mini-card, "what changed in last 24 h" |
| **Analysis** | Old Analysis (Live Audit + Calibration Report merged) | Active-run-scoped audit; auto-refresh every 60 s while in flight; one-click Run Analysis + Apply Recs; right-rail "Proposed Calibration" panel |
| **Runs** | Old Runs (cleaned) | Single status banner; cleaner table (one default action per row, others under "…") |
| **Discovery** | Old Move Discovery + Patterns Library + relevant context tables | Each metric card drills into Trade Autopsy or a knob; pattern library default-filtered to ≥20 samples; Context History with explicit "Empty? Run backfill" CTA |

History becomes an inline link inside Analysis (`Past generations
→`); Trade Grading becomes a row inside Engine. The total tab count
goes from 7 → 4.

### Visual language

All new code uses v2 tokens (`--ds-*`):

- Cards: `background: var(--ds-bg-surface)`, `border: 1px var(--ds-stroke)`, `border-radius: var(--ds-radius)` — see `DsCard` semantics.
- Hero numbers: `var(--ds-fs-hero)` / `var(--tt-font-mono)` /
  tabular-nums, gold (`var(--ds-accent)`) ONCE per region.
- Direction colors: `var(--ds-up)` / `var(--ds-dn)`. Never raw hex.
- Engine Health pill borrows `.ds-chip--up` / `.ds-chip--accent` /
  `.ds-chip--dn` for green/yellow/red.
- Tabs: borrow `.ds-tab` / `.ds-tab__item`.

### Net code reduction targets

- 4,466 line file → ~2,800 lines after Move Discovery refactor and
  Runs cleanup.
- Per-row action buttons: 9 → 1 default + "…" menu.
- Operations Console: 4 KPI cards + 5 sub-panels → 1 status banner +
  the Active Run Console (kept).

## What shipped (2026-05-03)

| Phase | Commit(s) | Status |
|---|---|---|
| 1 — Audit | `dc15991` | ✅ |
| 2 P0 — Engine tab live KPIs | `956dc6f` (+ `af87a18` fallback fix) | ✅ |
| 2 P2 — Analysis automation | `956dc6f` | ✅ |
| 2 P1 — Runs tab cleanup | `37c2c95` | ✅ |
| 2 P3 — Move Discovery actionability | `295c636` | ✅ |
| 2 P4 — Patterns & Learning hygiene | `295c636` | ✅ |
| 3 — Calibration automation endpoint | `956dc6f` | ✅ |

### New endpoints
- `GET  /timed/admin/system-intelligence/engine-snapshot[?run_id]`
- `POST /timed/admin/system-intelligence/run-analysis[?run_id]`
- `POST /timed/admin/system-intelligence/calibrate[?run_id]`

### Verified live (against `phase-c-stage1-jul2025-may2026`)
- engine-snapshot: 173 trades / 156 closed, WR 59.6%, PF 2.58, net
  $11,806, SQN 4.36, max DD $1,033 (8.6%), sim day 60/305 (Aug 29).
  Health: green.
- calibrate: 1 proposal — "Add CVNA to ticker blocklist" (3 trades,
  cumulative R −4.18, net −$527). Targets `run` (writes to
  `backtest_run_config`).
