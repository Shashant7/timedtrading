# Sanity Sweep Agent Loop

**WHEN to use:** A `#system-alerts` sanity sweep fires and the operator wants
it **acted on** (not just acknowledged). Also when wiring Cursor Cloud Agents
to auto-fix code-class failures.

---

## What runs today (after this loop ships)

| Stage | What | Where |
|---|---|---|
| Detect | 14 full + 6 fast checks | `worker/sanity-sweep.js` cron |
| **Heal first** | COO self-heal before Discord | `worker/coo/coo-orchestrator.js` |
| Track | Open incidents in KV | `worker/sanity-incidents.js` |
| Alert | Discord `#system-alerts` with **Actions** section | `sanitySweepCron` |
| Agent triage | Hourly GitHub issues (`sanity-sweep-agent` label) | `.github/workflows/sanity-sweep-agent.yml` |

### Auto-healed at runtime (`COO_SELF_HEAL=true`)

| Check | Action |
|---|---|
| `portfolio_reconcile` | `POST /timed/admin/ledger/repair?mode=investor` |
| `candle_freshness_open` | Alpaca/TD backfill per stale ticker |
| `invalidation_distance` | `tightenWideOpenStops()` |
| `compute_freshness` | `POST /timed/investor/compute` |

### Escalates to agent/PR (`needs_pr`)

| Check | Typical fix |
|---|---|
| `classifier_consistency` | `worker/investor.js` exhaustion gate |
| `thesis_stage_consistency` | `generateThesis()` vs stage |
| `position_drift` | trim cooldown bypass |

Ops/infra checks (`alert_delivery`, `cron_tick_alive`, bridge reconciler) stay
manual — rotate webhooks, inspect cron topology, bridge worker logs.

---

## Operator commands

```bash
# Latest sweep (Mission Control uses this)
curl -s -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading.com/timed/admin/sanity-sweep/latest" | jq '.summary'

# Open incidents (agent poll surface)
curl -s -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading.com/timed/admin/sanity-sweep/incidents" | jq

# Code-fix queue only
curl -s -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading.com/timed/admin/sanity-sweep/incidents?needs_pr=1" | jq '.open'

# Force full sweep + heal + incident sync
curl -s -X POST -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading.com/timed/admin/sanity-sweep" | jq '.incidents, .heal'
```

---

## Wiring a Cursor Cloud Agent

1. Set GitHub repo secret `TIMED_TRADING_API_KEY` (same as worker admin key).
2. Enable workflow **Sanity sweep agent triage** (hourly `:20` UTC).
3. In Cursor → Cloud Agents, connect the repo and trigger on issues labeled
   `sanity-sweep-agent`.
4. Agent reads issue body (check id, anomalies, file hints, prompt) → branch
   `cursor/sanity-<check-id>-6d1e` → PR.

Manual trigger: **Actions → Sanity sweep agent triage → Run workflow**.

---

## Discord alert shape

Alerts now include an **Actions** block:

- `Auto-heal applied (N): check_ids…`
- `Still open: N incident(s) — M need code PR`
- Link hint: `GET /timed/admin/sanity-sweep/incidents?needs_pr=1`

Noise is OK — the point is every alert shows whether runtime heal ran and what
remains open.

---

## Verify COO self-heal is on

`COO_SELF_HEAL=true` in `worker/wrangler.toml` (and role workers). Without it,
heal runs dry-run only (`would_do` logged, no mutation).

```bash
grep COO_SELF_HEAL worker/wrangler.toml worker-engine/wrangler.toml worker-research/wrangler.toml
```

---

## Adding a new check to the playbook

Edit `SANITY_CHECK_PLAYBOOK` in `worker/sanity-incidents.js`:

- `auto_heal: true` + handler in `coo-orchestrator.js` for runtime fixes
- `needs_pr: true` + `files_hint` for code defects
- `kind: "ops" | "infra"` for manual runbook items
