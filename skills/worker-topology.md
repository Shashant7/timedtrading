# Worker Topology (post-decomposition, 2026-06-10)

**WHEN to use:** Any work touching cron scheduling, worker deploys,
`scheduled()` behavior, or when diagnosing "which worker runs X?".
Read BEFORE changing `worker/index.js` cron code or any `wrangler.toml`.

## The shape

One **codebase** (`worker/index.js` + modules), four **deployed workers**.
The dedicated workers deploy the SAME monolith bundle but are role-gated
via `WORKER_ROLE` + feature flags, so each cron lane executes in exactly
one place (CPU isolation without a code split).

| Worker | Dir / config | Role | Owns |
|---|---|---|---|
| `timed-trading-ingest` | `worker/` | monolith (API + fallback) | ALL `/timed/*` routes, DOs, any cron lane not externalized |
| `tt-feed` | `worker-feed/` | feed | price-feed cron + stream keep-alive (`worker/feed/*`) |
| `tt-engine` | `worker-engine/` | engine | */5 scoring + trade lifecycle lanes |
| `tt-research` | `worker-research/` | research | hourly research arms + 22:00 UTC nightly mega-batch (`worker/research/nightly-batch.js`) |

Sidecar (separate codebase, unrelated to this split): `worker-bridge/`
(IBKR / Robinhood bridge).

## The flags (cutover levers)

Two flags per domain — one on the monolith ("stop doing X"), one on the
dedicated worker ("start doing X"):

| Domain | Monolith flag (OFF→external) | Dedicated flag |
|---|---|---|
| feed | `PRICE_FEED_EXTERNAL=true` | `FEED_ENABLED=true` on tt-feed |
| engine | `ENGINE_EXTERNAL=true` | `ENGINE_ENABLED=true` on tt-engine |
| research | `RESEARCH_SLOTS_EXTERNAL=true` | `RESEARCH_ENABLED=true` on tt-research |

Rules:

1. **Order matters**: set the monolith's `*_EXTERNAL` flag FIRST, then
   enable the dedicated worker. Dual-execution corrupts state (kanban
   oscillation, double investor rebalance). A short gap is safe; overlap
   is not.
2. Flags are plain-text **vars** managed via the Cloudflare dashboard.
   All four `wrangler.toml`s set `keep_vars = true` so CI deploys do NOT
   reset dashboard-set vars. NEVER `wrangler secret put` a name that
   already exists as a var (clash → deploy failure; see
   `tasks/2026-06-10-worker-decomposition-plan.md`).
3. Rollback = flip the pair back in the reverse order.

## Deploys (CI)

| Workflow | Trigger paths | Deploys |
|---|---|---|
| `.github/workflows/deploy-worker.yml` | `worker/**` | monolith |
| `deploy-feed.yml` | `worker-feed/**`, `worker/feed/**` | tt-feed |
| `deploy-engine.yml` | `worker-engine/**`, `worker/**` | tt-engine |
| `deploy-research.yml` | `worker-research/**`, `worker/**` | tt-research |

Because engine/research ship the monolith bundle, ANY `worker/**` change
redeploys them too — keep `scheduled()` role-gating intact.

## Health / verification

```bash
curl -s https://timed-trading.com/timed/health | jq '{ok, pricesAgeSec, pricesSource, tombstones}'
curl -s https://tt-feed.shashant.workers.dev/feed/health | jq
# engine / research health require CF Access service token headers
```

- `watchdog.yml` (GitHub Actions, every 30 min) checks health + feed age +
  scoring freshness. It tolerates Cloudflare bot-challenge HTML (warns,
  doesn't fail) and counts only ACTIVE tombstones (`count > 0`).
- Cron execution check: `wrangler tail tt-engine --format pretty` during a
  */5 boundary, or read the run markers in KV (`skills/kv-inspection.md`).

## Where the role gate lives

`worker/index.js` `scheduled()` — looks at `env.WORKER_ROLE`
(`engine` / `research` / unset = monolith) and the `*_EXTERNAL` /
`*_ENABLED` flags to decide which virtual-cron lanes run. When adding a
NEW cron lane, decide which role owns it and gate it there, otherwise it
runs on every worker that ships the bundle.
