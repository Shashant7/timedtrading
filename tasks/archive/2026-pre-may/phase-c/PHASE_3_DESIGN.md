# Phase 3 Design — Tier 3 Roadmap

**Date:** 2026-05-06
**Status:** Design doc — implementation deferred to next session(s)
**Author:** Cloud Agent (handoff to next session)
**Branch:** `cursor/phase-c-stage1-jul-verdict-2e87`

---

## Context

Tier 1 (sizing clarity, re-calibration) and Tier 2 (Daily Brief / Right Rail unification) shipped in V15 P0.7.69-72. The live engine is running on the promoted Phase-C run with a $140,086 seeded account.

This document covers the remaining four work streams the user requested:

1. **Trend-hold hybrid mode** — let runners run on tickers that are trending and never broke structure (SNDK / GOOGL / AMD / MU style)
2. **Investor backfill** — seed investor account_ledger Jul 2025 → May 2026 (mirror of P0.7.70 trader seed)
3. **Pre-prod environment** — staging tier so we can run experimental backtests, test calibration changes, and promote to live safely
4. **Safe promote workflow** — formalize the staging → review → promote loop now that we have actual users

Each section is structured as: *Problem → Approach → Concrete API/data shape → Risks → Effort estimate (technical, not calendar).*

---

## 1. Trend-Hold Hybrid Mode

### Problem

In the 587-trade promoted run, our biggest **realized** winners were swing trades that we trimmed aggressively because the engine treats every trade as an active swing — never as a long-term ride. Concrete examples from the run:

| Ticker | Setup | Realized PnL | What we left on the table |
|---|---|---:|---|
| SNDK | n=11, WR 73% | +$4,034 | SNDK rallied ~80% Aug→Mar without breaking weekly structure. We took 11 trades for ~5% each. A single position held would've returned ~80%. |
| AEHR | n=9, WR 89% | +$2,688 | Similar — rotated in and out of a clean uptrend, never let a winner ride. |
| BE | n=9, WR 78% | +$2,508 | Same pattern. |
| AMD / MU / GOOGL | small n | various | Rarely entered because rank min cutoff filtered them out, but when entered, exited too fast. |

The user's stated goal: *"hold a trade like SNDK or GOOGL or AMD or MU. These tickers rallied and never really broke trend and only continue to make new ATHs. Maybe its a hybrid between Investor Mode and Active Trader."*

### Approach

Introduce a third trade lifecycle state alongside `Active Trader` and `Investor`:

**`Trend-Hold`** — a trade originally entered as Active Trader gets *promoted* to Trend-Hold when:
1. **Quality check** — the trade has reached MFE >= +5% (proves the setup worked), AND
2. **Trend integrity** — the ticker is in `MOMENTUM_ELITE` or `STRONG_BULL` HTF state, AND
3. **Structural intact** — none of: weekly EMA-21 break, daily SuperTrend flip, weekly TD9 sell signal, RSI-D divergence > 2 sessions

Once promoted, the trade switches management profile:
- **No more time-based exits** (no stagnant-exit, no fresh-failure)
- **Trail stop becomes weekly-based** (e.g. "exit on weekly close below EMA-21" rather than 1.5x daily ATR)
- **Trim ladder switches** to investor-style (10% on +20%, another 10% on +50%, hold 80% of position)
- **Re-entry on pullback** instead of full exit (DCA the dip — borrow from investor-mode `dca_next_ts`)

When promoted, surface this on the Trades page with a `🚀 Trend-Hold` badge and update the kanban card to show "Riding the runner" instead of "Active management."

### Demotion path

A Trend-Hold position drops back to `Active Trader` (or exits) when:
- Weekly EMA-21 closes below (clean break, not just intra-week wick)
- Daily SuperTrend flips bear AND price closes below pivot S2
- Weekly TD9 sell prints
- HTF state degrades from MOMENTUM_ELITE to NEUTRAL or worse for 3+ consecutive sessions

### Concrete data shape

New columns on `trades` table:
```sql
ALTER TABLE trades ADD COLUMN trend_hold_promoted_at INTEGER;
ALTER TABLE trades ADD COLUMN trend_hold_demoted_at INTEGER;
ALTER TABLE trades ADD COLUMN trend_hold_state TEXT;  -- "active" | "demoted" | null
ALTER TABLE trades ADD COLUMN trend_hold_max_mfe_pct REAL;
```

New module `worker/trend-hold.js`:
```js
export function shouldPromoteToTrendHold(trade, tickerData)
export function shouldDemoteFromTrendHold(trade, tickerData)
export function getTrendHoldExitDoctrine(trade, tickerData)
```

Wire into `worker/phase-c-exit-doctrine.js` so the existing `chooseExitDoctrine` checks Trend-Hold rules first.

### Risks

- **Backtest validation required.** Trend-Hold rules could re-introduce the catastrophic losses we cut in P0.7.63-65 if poorly calibrated. Specifically: the gave-back rule we tuned (force_exit only when 90% giveback AND now-losing AND 2+ sessions old) is the floor — any Trend-Hold rule that overrides it must keep this guarantee.
- **Sample size.** Even SNDK only had 11 trades over 10 months. We'd see ~5-10 promotions per quarter. That's not enough to statistically tune the promotion thresholds — we'd need to lean on rules-based heuristics rather than ML.
- **Account capacity.** Holding 5 Trend-Hold positions at 7% each means 35% of account locked in slow-bleed-or-massive-win mode. Need a Trend-Hold-specific position cap (suggested: max 3 simultaneous, drop the lowest-MFE if a 4th qualifies).

### Effort estimate

- **Module + table changes**: contained, similar invasiveness to `etf-profile.js` or `phase-c-exit-doctrine.js`.
- **Backtest validation cycle**: 1 full month replay (Jul-Aug or a single regime window) to validate promotion thresholds + ride-runner exit doctrine.
- **Live validation**: needs 4-8 weeks of live trades to see meaningful promotion candidates.

**Recommended sequence:** implement module, add to existing exit doctrine pipeline as opt-in flag (`deep_audit_trend_hold_enabled=false` by default), run targeted backtest leg, then enable for live with a small position cap.

---

## 2. Investor Backfill (Jul 2025 → May 2026)

### Problem

The trader account is correctly seeded ($100k → $140,086 via P0.7.70). The **investor** account still shows $100k baseline / 0 positions / 0 PnL because investor-mode replay was never run during the Phase C trader-only backtest.

The user wants the investor lane to also reflect "what the system would have done over the past 10 months" so:
- Trades page Investor column has real data
- Equity curve compares trader vs investor visually
- We can compare the two strategies on the same period

### Approach (3 options, increasing fidelity)

**Option A — Quick & approximate (~30 min):** Compute investor-style ledger entries directly from the existing trader trades. Filter to trades with `setup_grade = "Prime"` AND `direction = "LONG"` AND `held_days >= 5` (proxies for "investor-quality" entries). Apply Investor sizing (5% per position, max 15 positions). Seed `account_ledger mode='investor'` analogously to P0.7.70.

  - Pros: Fast, deterministic, mirrors the P0.7.70 pattern exactly.
  - Cons: Not a true investor backtest — it's a re-cast of trader data through investor-sizing lens. Investor entry/exit logic (monthly supertrend bullish, accumulate/reduce stages) isn't run.

**Option B — Per-day investor replay using trader's day-state KV (blocked):** This was attempted (`scripts/investor-backfill-jul-may.sh`) and discovered the day-state KV from the trader-only Phase C run does NOT contain `tf_tech.D/W.stDir` and `monthly_bundle.supertrend_dir` — fields the investor entry gate requires. Investor-replay returns `opened=0` for every day.

  - Pros: True investor logic, identical to live behavior.
  - Cons: Requires a re-replay of all 218 trading days *with investor scoring enabled*. ~4-6 hours of compute, risk of new bugs surfacing. Dependent on tf_tech being computed during replay.

**Option C — Full investor-mode backtest as a new run (~6-8 hours wall):** Run `scripts/full-backtest.sh --investor-only 2025-07-01 2026-05-04` after first ensuring the trader run's day-state KV is rehydrated to include the missing tech fields. Highest fidelity, longest path.

### Recommended

**Start with Option A.** It's a 30-min job and gives the user real numbers in the Investor column today. Path:

```js
// New worker helper
async function d1SeedInvestorLedgerFromPromoted(env, options = {}) {
  // Filter promoted_trades to investor-quality candidates:
  //   - setup_grade = "Prime"
  //   - direction = "LONG"
  //   - held_days >= 5
  //   - ticker in MOMENTUM_ELITE or STRONG_BULL state at entry
  // For each, emit synthetic investor entries at Investor sizing
  // (INVESTOR_BASE_ALLOC_PCT = 5%) with the same entry/exit prices.
  // PnL becomes: shares * (exit - entry) where shares = 5000 / entry_price.
  // Wipe + rebuild investor account_ledger and portfolio_snapshots.
}
```

New endpoint: `POST /timed/admin/investor-ledger/seed-from-promoted`. Same payload shape as the trader seed.

If the user wants the *true* Investor strategy result (Option C), we run a dedicated investor backtest leg in a separate session — that's a focused replay job, not something to jam into the live engine session.

### Risks

- Option A is a *projection* not a real backtest. The Investor equity curve from this approach will look smoother than reality (no monthly-supertrend gating, no DCA buys).
- We need to label the Investor account clearly as "Backtested via Active Trader trade filter" so it's not confused with a real Investor-mode run.

### Effort estimate

- **Option A**: small. Same shape as P0.7.70.
- **Option C**: significant. Multi-hour wall time, plus tf_tech rehydration prereq.

---

## 3. Pre-Prod Environment

### Problem

Right now we have one Cloudflare Worker (`timed-trading-ingest`), one D1 database, one KV namespace, and one set of users. Every backtest contends with the live cron for the replay-lock. Every calibration change goes straight to live model_config. This is fine for an empty user base but breaks immediately once real users exist:

- A backtest with the lock held mutes live cron — users see no new trades for hours.
- A calibration change with a bug affects live trades on the next cron tick — no canary period.
- A schema migration applied to live D1 risks data corruption.

The user's stated need: *"if we wanted to run another backtest, we could off-load it to the pre-prod env, testing all kinds of things and then when ready, promote."*

### Approach — environment topology

Three environments:

| Env | Purpose | Worker | D1 | KV | Domain |
|---|---|---|---|---|---|
| **Live (prod)** | Real users, real cron, live trading | `timed-trading-ingest` | `timed-prod` | `KV_TIMED_PROD` | `timed-trading-ingest.shashant.workers.dev` |
| **Pre-prod (staging)** | Test backtests, calibration experiments, schema migrations | `timed-trading-ingest-preprod` | `timed-preprod` | `KV_TIMED_PREPROD` | `timed-trading-ingest-preprod.shashant.workers.dev` |
| **Local dev** | Developer iteration on a single feature | `wrangler dev` | local D1 | local KV | `localhost:8787` |

Both Live and Pre-prod run the **same code** (Wrangler `--env` toggle), bound to different D1/KV instances. Code deploys via `npm run deploy:preprod` first, then `npm run deploy` (live) after pre-prod validation.

### What lives in each env

**Live D1 / KV:** real user accounts, real trades (live cron + backtest-promoted), real account_ledger.

**Pre-prod D1 / KV:** mirror of live data (refreshed weekly via export/import) + experimental scratch space:
- Backtests run here (no contention with live cron)
- Calibration experiments write to pre-prod model_config
- Schema migrations applied here first
- Trade promotion targets pre-prod first (so we can review the promoted set before pushing to live)

### Implementation phases

**Phase 3.1 — Wrangler env config (small):**

Update `worker/wrangler.toml` to add a `preprod` environment:
```toml
[env.preprod]
name = "timed-trading-ingest-preprod"
[env.preprod.vars]
# Same vars as prod, but flagged
TT_ENV = "preprod"

[[env.preprod.d1_databases]]
binding = "DB"
database_name = "timed-preprod"
database_id = "<new-preprod-d1-id>"

[[env.preprod.kv_namespaces]]
binding = "KV_TIMED"
id = "<new-preprod-kv-id>"
```

Add `npm run deploy:preprod` to `package.json`.

Create the new D1 + KV via `wrangler d1 create timed-preprod` and `wrangler kv namespace create KV_TIMED_PREPROD`.

**Phase 3.2 — Data sync tool:**

`scripts/sync-prod-to-preprod.sh`:
- Export critical D1 tables from prod (`trades`, `positions`, `account_ledger`, `model_config`, `promoted_trades`, `promoted_trade_datasets`)
- Import into pre-prod
- Sync KV keys matching `timed:price:*`, `timed:replay:daystate:*`, `timed:internals:*` (read-mostly state)
- Run weekly via cron OR on-demand

**Phase 3.3 — Backtest orchestration moves to pre-prod:**

`scripts/continuous-slice.sh` and `scripts/full-backtest.sh` get a `--env preprod` flag (default). Backtests no longer touch live by default. To push results to live:

```bash
# Step 1: run backtest in pre-prod
bash scripts/continuous-slice.sh --env preprod --start 2026-05-01 --end 2026-05-31

# Step 2: review the run in pre-prod's System Intelligence + Trades page
# (https://timed-trading-ingest-preprod.shashant.workers.dev)

# Step 3: explicit promote-to-live
bash scripts/promote-run-to-live.sh --run-id <id> --source preprod --target live
```

**Phase 3.4 — Frontend awareness:**

Pages on pre-prod show a banner:
```
⚠ PRE-PROD — experimental. Data may be reset. Live engine: timed-trading.com
```

Pages can switch between envs via a dropdown (admin-only).

### Risks

- **Cost.** Cloudflare D1 + KV charge per database + per-namespace + per-row-read. A second full-size DB doubles those line items.
- **Data drift.** If pre-prod and live diverge between sync runs, calibration tested in pre-prod may behave differently in live.
- **Promotion bugs.** The promote-from-preprod flow needs to be airtight — no SQL mismatches, no missing rows, no half-applied schema changes.

### Effort estimate

- **Phase 3.1 (Wrangler config + new D1/KV)**: 30 min.
- **Phase 3.2 (sync tool)**: 2-3 hours.
- **Phase 3.3 (backtest orchestration changes)**: 1-2 hours.
- **Phase 3.4 (frontend banner + env switcher)**: 1 hour.

**Total**: ~5-6 hours of focused work, mostly mechanical (config, sync scripting, flag plumbing).

---

## 4. Safe Promote Workflow

### Problem

Today the promote flow is:

```
1. Run backtest (locks cron, takes hours)
2. POST /timed/admin/promoted-trades/promote → marks dataset "active"
3. POST /timed/admin/runs/mark-live → live cron starts using its config
4. Cross fingers
```

There's no review step, no rollback path, no canary period, no sentinel comparison surfaced to the user. With actual users in the loop, this becomes risky: a bad promote means real money decisions follow a regressed model.

### Approach — staged promote with checkpoints

Replace the single promote action with a 4-stage gated workflow:

**Stage 1 — Promote to Pre-Prod**
- Backtest run lives in pre-prod's `backtest_runs` table
- Pre-prod's Trades page shows the run alongside the previous one for visual diff
- Pre-prod's System Intelligence runs calibration against the new run
- Status: `pending_review`

**Stage 2 — Sentinel Comparison**
- Run an automated comparison vs the canonical sentinel basket (e.g. `v16-canon-julapr-30m-1777523625`)
- Compare: total trades, WR, PnL$, big winners, big losses, regime bucket performance
- Surface deltas in a "Promote Review" UI:

  ```
  Sentinel:    587 trades · 52.3% WR · +$40,086
  New run:     593 trades · 51.8% WR · +$38,940
  Delta:       +6 trades · -0.5% WR · -$1,146 (-2.86%)
  Status:      ⚠ minor regression — review before promote
  ```

- Status: `sentinel_validated` or `sentinel_warning`

**Stage 3 — Canary in Live (limited)**
- Mark the new model live with a `canary_pct` (e.g. 25%)
- Live cron uses the new model on 25% of qualifying entries (random selection), legacy model on the rest
- Run for N days (default 5 trading days)
- Compare canary vs control: WR, PnL, big losses
- Surface in System Intelligence as "Canary report"
- Status: `canary_running` → `canary_complete`

**Stage 4 — Full Promote**
- New model goes 100% live
- Old model archived (kept for fast rollback)
- Account ledger continues seamlessly from canary
- Status: `live`

### Rollback path

Single button: "Rollback to previous live model." Restores `live_config_slot` to the prior run, clears `canary_pct`, leaves seeded account_ledger intact (live cron continues from last balance).

### Required schema additions

```sql
ALTER TABLE backtest_runs ADD COLUMN promote_status TEXT;
  -- "pending_review" | "sentinel_validated" | "sentinel_warning"
  -- | "canary_running" | "canary_complete" | "live" | "rolled_back"
ALTER TABLE backtest_runs ADD COLUMN canary_pct INTEGER DEFAULT 0;
ALTER TABLE backtest_runs ADD COLUMN canary_started_at INTEGER;
ALTER TABLE backtest_runs ADD COLUMN canary_metrics_json TEXT;
ALTER TABLE backtest_runs ADD COLUMN previous_live_run_id TEXT;
```

### New endpoints

- `POST /timed/admin/promote-workflow/stage1?run_id=X&target_env=preprod`
- `POST /timed/admin/promote-workflow/stage2-sentinel?run_id=X`
- `POST /timed/admin/promote-workflow/stage3-canary?run_id=X&pct=25`
- `POST /timed/admin/promote-workflow/stage4-fullpromote?run_id=X`
- `POST /timed/admin/promote-workflow/rollback?to_run_id=X`
- `GET /timed/admin/promote-workflow/status?run_id=X`

### Frontend additions

New System Intelligence tab: **"Promote Workflow"** showing:
- Current live model (run_id, age, metrics)
- Canary status (pct, days remaining, vs-control delta)
- Pending promote candidates (each with sentinel-validation result + go/no-go)
- Rollback button

### Risks

- **Canary complexity.** Splitting live cron into 25%-new / 75%-legacy introduces double-bookkeeping for account_ledger, position tracking, and entry attribution. The selection mechanism (random? deterministic by ticker hash? by hour?) needs careful design to avoid bias.
- **Sentinel drift.** Over months, the sentinel basket itself becomes stale. Need a process for refreshing sentinels (probably annually).
- **User expectations.** A canary period means new features are *delayed* by 5+ trading days. Worth this for safety, but worth communicating.

### Effort estimate

- **Stages 1+2 (review + sentinel)**: contained, 4-5 hours. Mostly endpoint + frontend table.
- **Stages 3+4 (canary + full promote)**: significant. Account ledger split, position attribution, double-bookkeeping. ~1 week of focused work.
- **Rollback**: 2-3 hours once canary infrastructure exists.

**Recommended sequence:**
1. Build Stages 1+2 first (review + sentinel) — gets immediate safety win
2. Skip canary initially; do "shadow mode" instead (run new model in pre-prod alongside live for N days, compare)
3. Add full canary when shadow mode proves it's worth the complexity

---

## Sequencing Recommendation

Given relative cost vs payoff, here's what I'd suggest the next session(s) tackle in order:

| Priority | Item | Effort | Why now |
|---|---|---|---|
| 1 | **Pre-prod env (Phase 3.1 only)** | 30 min | Cheapest, unlocks safe iteration. Just create the new D1/KV and add the wrangler env block — no code changes yet. |
| 2 | **Investor backfill (Option A)** | 30 min | User-visible immediately. Investor column on Trades page becomes alive. Mirrors P0.7.70 pattern. |
| 3 | **Promote workflow Stages 1+2** | 4-5 hours | Sentinel-comparison gate is the highest-value safety improvement before live users grow. |
| 4 | **Trend-hold mode (module + opt-in flag)** | medium | Build the module, leave disabled. Validate against an isolated backtest leg (e.g. just SNDK / AEHR / BE / AGQ ticker subset). |
| 5 | **Pre-prod backtest orchestration (Phase 3.2-3.3)** | 4-6 hours | Once #1 done and we have a real D1 to point at. |
| 6 | **Promote workflow Stages 3+4 (canary)** | 1 week | Wait until live user count justifies it. |

Items 1-2 could be a single half-session. 3 needs its own focused session. 4 + 5 are independent and could parallelize across sessions.

---

## Open Questions for User

1. **Trend-hold rules** — should promotion thresholds be tunable per setup grade (Prime gets +5% MFE bar, Confirmed gets +8%) or uniform?
2. **Pre-prod data refresh** — weekly sync from prod, or on-demand only? Cost-vs-staleness tradeoff.
3. **Canary mechanism** — random per-entry, deterministic by ticker hash, or by hour-of-day? Each has different bias profiles.
4. **Investor backfill** — Option A (quick projection) or wait for Option C (true investor backtest)? A is shippable today; C needs a multi-hour replay.
5. **Sentinel basket** — keep using `v16-canon-julapr-30m-1777523625` as the comparison anchor, or update to the just-promoted Phase-C run as the new sentinel? (Once a run is live, it becomes the next baseline.)

---

## Files this design will touch (preview)

```
worker/trend-hold.js                        NEW (~250 lines)
worker/phase-c-exit-doctrine.js             modified (add trend-hold check)
worker/index.js                             modified (new endpoints)
worker/wrangler.toml                        modified (preprod env)
worker/promote-workflow.js                  NEW (~400 lines)
scripts/sync-prod-to-preprod.sh             NEW
scripts/promote-run-to-live.sh              NEW
react-app/system-intelligence.html          modified (Promote tab)
react-app/simulation-dashboard.html         modified (env banner, investor data)
package.json                                modified (deploy:preprod script)
```

Schema migrations:
```sql
ALTER TABLE trades ADD COLUMN trend_hold_*;
ALTER TABLE backtest_runs ADD COLUMN promote_status, canary_pct, etc.;
```
