# Sanity Sweep Agent Loop

**WHEN to use:** A `#system-alerts` sanity sweep fires and the operator wants
it **acted on** (not just acknowledged). Also when wiring Cursor Cloud Agents
to auto-fix code-class failures.

Supersedes draft PR #896 (`cursor/sanity-sweep-agent-loop-6d1e`, Jun 2026) —
rebasing that branch was impractical (~1100 commits behind). Land this
evolved loop from `main` instead.

---

## What runs (after merge + deploy)

| Stage | What | Where |
|---|---|---|
| Detect | Full hourly + fast */15 checks | `worker/sanity-sweep.js` cron |
| **Heal first** | COO self-heal before Discord (full only) | `worker/coo/coo-orchestrator.js` |
| Track | Open incidents in KV `sanity_sweep:incidents:v1` | `worker/sanity-incidents.js` |
| Alert | Discord `#system-alerts` with **Actions** section | `sanitySweepCron` |
| Agent triage | Hourly GH issues (`sanity-sweep-agent`) + optional Cursor Auto | `.github/workflows/sanity-sweep-agent.yml` |

Fast sweeps still skip Discord + heal (hourly full owns paging) so :00 ET
does not double-post.

### Auto-healed at runtime (`COO_SELF_HEAL=true`)

| Check | Action |
|---|---|
| `portfolio_reconcile` | `POST /timed/admin/ledger/repair?mode=investor` |
| `candle_freshness_open` | Alpaca/TD backfill per stale ticker |
| `invalidation_distance` | `tightenWideOpenStops()` |
| `investor_signal_bridge_coverage` | broker-bridge catch-up |
| `compute_freshness` | `POST /timed/investor/compute` |

Heal runs only when `COO_SELF_HEAL=true` so dry-run skips do not inflate
escalate counters. After **2 failed** auto-heal attempts on an `auto_heal`
check, the incident status becomes `escalated`.

### Escalates to agent/PR (`needs_pr`)

| Check | Typical fix |
|---|---|
| `classifier_consistency` | `worker/investor.js` exhaustion gate |
| `thesis_stage_consistency` | `generateThesis()` vs stage |
| `position_drift` | trim cooldown bypass |

Ops/infra checks (`alert_delivery`, `cron_tick_alive`, bridge bindings,
role split) stay manual — rotate webhooks, inspect cron topology, bridge logs.

---

## Operator walkthrough (wire once after merge)

### 1. Deploy the worker

```bash
npm run deploy:worker   # or full npm run deploy
```

Confirm `COO_SELF_HEAL=true` (already in `worker/wrangler.toml` + role workers):

```bash
grep COO_SELF_HEAL worker/wrangler.toml worker-engine/wrangler.toml worker-research/wrangler.toml
```

### 2. GitHub Actions secret (required for triage)

Repo → **Settings → Secrets and variables → Actions** → New repository secret:

| Name | Value |
|---|---|
| `TIMED_TRADING_API_KEY` | Same value as worker secret `TIMED_API_KEY` |

This is **not** the worker's `CURSOR_API_KEY`. The workflow polls the live
incidents API with the admin key.

### 3. Optional: Cursor Auto dispatch from Actions

Same page → add secret:

| Name | Value |
|---|---|
| `CURSOR_API_KEY` | Cursor API key (Dashboard → Integrations / API) |

When set, each **new** `sanity-sweep-agent` issue also POSTs
`https://api.cursor.com/v1/agents` with `model: auto-smart` /
`optimize_for=balanced` and `autoCreatePR: true` (same Auto mode as Trade
Review after PR #1270).

Without this secret, use the dashboard path in step 4.

### 4. Cursor Cloud Agents (label trigger — if no Actions API key)

1. Cursor → Cloud Agents → connect `Shashant7/timedtrading`.
2. Trigger on issues labeled **`sanity-sweep-agent`**.
3. Prefer Auto / Auto-smart in the agent model picker.

The workflow creates the label on first run (color `#d97706`) if missing.
Manual create is fine too.

### 5. Enable the workflow

**Actions → Sanity sweep agent triage** — ensure enabled.
Schedule: hourly at `:20` UTC + `workflow_dispatch`.

Manual: **Run workflow**.

### 6. Smoke test

```bash
# Force full sweep + heal + incident sync + Discord path
curl -s -X POST -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading-ingest.shashant.workers.dev/timed/admin/sanity-sweep" \
  | jq '{ok, incidents, heal}'

# Open incidents / code-fix queue
curl -s -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading-ingest.shashant.workers.dev/timed/admin/sanity-sweep/incidents" | jq
curl -s -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading-ingest.shashant.workers.dev/timed/admin/sanity-sweep/incidents?needs_pr=1" \
  | jq '.open'
```

Then run the workflow once and confirm either a skip ("No open code-fix
incidents") or a new issue + optional Auto agent comment.

---

## How this differs from Trade Review (PR #1270)

| | Trade Review | Sanity sweep agent loop |
|---|---|---|
| Trigger | Admin "File as agent-ready" | Hourly GH Actions + Discord Actions block |
| Worker secret | `CURSOR_API_KEY` on the Worker | Not required on Worker for triage |
| Actions secret | — | `TIMED_TRADING_API_KEY` (+ optional `CURSOR_API_KEY`) |
| Label | `agent-ready` / `trade-review` | `sanity-sweep-agent` |
| Auto mode | Worker → Cursor v1 API | Actions → Cursor v1 API (optional) or dashboard label |

---

## Discord alert shape

Alerts include an **Actions** block:

- `Auto-heal applied (N): check_ids…`
- `Still open: N incident(s) — M need code PR`
- Hint: `GET /timed/admin/sanity-sweep/incidents?needs_pr=1`

---

## Adding a new check to the playbook

Edit `SANITY_CHECK_PLAYBOOK` in `worker/sanity-incidents.js`:

- `auto_heal: true` + handler in `coo-orchestrator.js` for runtime fixes
- `needs_pr: true` + `files_hint` for code defects
- `kind: "ops" | "infra"` for manual runbook items
