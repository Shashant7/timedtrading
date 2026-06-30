# Agent Onboarding

Welcome to Timed Trading. This file is the first thing a brand-new agent
should read. It tells you what to look at, in what order, and why.

---

## 1. Read these (in order, ~10 minutes)

1. **[CONTEXT.md](CONTEXT.md)** — single page summarising the whole
   system. Stack, deploy, journey pages, the 200+ critical lessons
   condensed into 1-line bullets. Re-read at the start of every session.
2. **[skills/README.md](skills/README.md)** — index of reusable
   playbooks. Most "how do I do X?" questions are answered here.
3. **[tasks/todo.md](tasks/todo.md)** — current live work. Append your
   own todos before non-trivial work; mark them done before exiting.
4. **[tasks/lessons.md](tasks/lessons.md)** — long-form history of every
   correction the user has had to make. Skim, then keep open in a tab
   so you can grep it when something looks familiar.

---

## 2. Workflow (the four rules)

1. **Plan first.** Anything 3+ steps → add it to `tasks/todo.md` BEFORE
   touching code. Updating the todo list is part of the work.
2. **Stop on sideways.** Two failed attempts at the same thing → STOP
   and re-plan. Don't push through.
3. **Verify before done.** "Would a staff engineer approve this?" If you
   can't answer yes, you're not done. Run the smoke test, hit the live
   endpoint, look at the actual UI.
4. **Update lessons after corrections.** When the user has to tell you
   "no, that's wrong because…", add the lesson to `tasks/lessons.md`
   AND a one-line bullet to `CONTEXT.md`. The next agent should not
   make the same mistake.

---

## 3. Common operations — go straight to the skill

| You need to… | Read |
|---|---|
| Deploy a worker / frontend change | [skills/deploy.md](skills/deploy.md) |
| Fix a ticker with stale or wrong data | [skills/rescore-ticker.md](skills/rescore-ticker.md) |
| Backfill candles (D / W / M) | [skills/backfill-candles.md](skills/backfill-candles.md) |
| Read or update the Investor / Trader UI | [skills/mission-control-tour.md](skills/mission-control-tour.md) |
| Debug a 401 / 403 / 404 / 503 | [skills/debug-http-codes.md](skills/debug-http-codes.md) |
| Query D1 directly | [skills/d1-debugging.md](skills/d1-debugging.md) |
| Inspect a KV value | [skills/kv-inspection.md](skills/kv-inspection.md) |
| Test or debug a Discord alert | [skills/discord-alerts.md](skills/discord-alerts.md) |
| IBKR / Broker Bridge work | [skills/broker-bridge.md](skills/broker-bridge.md) |
| Sanity check an Investor zone vs Finnhub | [skills/sanity-check-investor.md](skills/sanity-check-investor.md) |
| Frontend blank-page / build issue | [skills/frontend-build.md](skills/frontend-build.md) |
| Force a cache-bust after a deploy | [skills/cache-bust-rail.md](skills/cache-bust-rail.md) |
| Add a worker route / self-fetch / WS / render LLM HTML | [skills/security-auth-patterns.md](skills/security-auth-patterns.md) |
| Any UI styling work or Verda design-system migration | [skills/verda-ui-migration.md](skills/verda-ui-migration.md) |
| Cron / deploy / "which worker runs X?" (post-decomposition) | [skills/worker-topology.md](skills/worker-topology.md) |
| Add scripts/styles to a page, slow loads, caching, page-switch speed | [skills/frontend-performance.md](skills/frontend-performance.md) |

If the operation you need isn't here, search the skills folder for
keywords first, then [tasks/lessons.md](tasks/lessons.md). If you still
can't find it AND you spend more than ~3 tool calls figuring it out,
WRITE A NEW SKILL before exiting. Future you will thank you.

---

## 4. Repo map (top-level)

| Path | What it is |
|---|---|
| `worker/` | Main Cloudflare Worker — routes, cron, trade logic, scoring |
| `worker-feed/` / `worker-engine/` / `worker-research/` | Wrangler configs for the role-split workers (tt-feed / tt-engine / tt-research) — same bundle, role-gated crons. See [skills/worker-topology.md](skills/worker-topology.md) |
| `worker-bridge/` | Sidecar bridge worker (IBKR / Robinhood) — separate deploy |
| `react-app/` | Source HTML + JSX pages |
| `react-app/vendor/` | Self-hosted third-party libs (react, lightweight-charts, …) — versions in its README |
| `react-app-dist/` | Built / pre-compiled output that Pages serves (commit after `npm run build:frontend`) |
| `scripts/` | Build, deploy, replay, analysis helpers |
| `skills/` | **Reusable playbooks for common operations** |
| `tasks/` | Plans (`todo.md`), lessons (`lessons.md`), recent session-specific plans |
| `tasks/archive/` | Old (pre-May 2026) plans; Jul→Apr recovery **complete** (see `tasks/archive/2026-pre-may/README.md`) |
| `docs/` | Long-form architectural documents + runbooks |
| `CONTEXT.md` | Single onboarding page (load every session) |
| `AGENTS.md` | This file |

---

## 5. Branching + PRs

- Cloud agents create branches `cursor/<slug>-9f61`.
- One logical change per commit; don't batch.
- Push after every iteration (implement → test → fix → push).
- Open / update the PR at the end of every turn — see
  [skills/deploy.md](skills/deploy.md) for the full deploy cycle.

---

## 6. House rules

- **No emojis** in code, commits, or PRs unless the user asks.
- **No "you / your" in user-facing copy** (compliance). Use "the trader",
  "this account", or rephrase.
- **Never inline daily change math** — always go through
  `getDailyChange(t)` in `react-app/shared-price-utils.js`.
- **Gate live prices + scores to Pro/VIP/Admin** — Members (signed in, never paid) and anonymous users see neither. Server: `canAccessLivePrices()` (tier ∈ {pro, admin}; VIP→pro); UI: `window._ttIsPro` (= Pro/VIP/Admin).
- **`window._ttIsPro` for feature gating** — paid features.
- **Footer must include** "Market data powered by Twelve Data" (licensing).

---

## 7. When in doubt

1. Grep [tasks/lessons.md](tasks/lessons.md) for keywords.
2. Check [skills/README.md](skills/README.md).
3. Read the relevant area in [CONTEXT.md](CONTEXT.md).
4. Look at recent merged PRs on `main` for the same area —
   `git log --oneline main -20 -- <file>`.

If you still don't know, ASK in the PR description what assumption
you're making so the user can correct course before things compound.

---

## Cursor Cloud specific instructions

Startup runs `npm install` automatically (Node 22 + npm pre-installed; no
lockfile, so `npm install` not `npm ci`). Standard commands live in
`package.json` and `skills/deploy.md` — `wrangler` is NOT on PATH, use
`./node_modules/.bin/wrangler`. The notes below are the non-obvious bits.

- **Tests are the only gate; there is no lint step.** `npm test` (vitest). CI
  (`.github/workflows/test.yml`) adds `node --check` on the worker entrypoints +
  an esbuild bundle check (`node scripts/embed-dashboard.js` then
  `npx esbuild worker/index.js --bundle --format=esm --outfile=/dev/null`).
- **`npm run build:frontend` always dirties `react-app-dist/`** (re-stamps `?v=`
  cache-busts). CI's `check-dist.yml` ignores those markers; if you built only
  to verify, revert with `git checkout -- react-app-dist react-app`.
- **Local run = main worker + Pages frontend** (the cron workers are the same
  bundle, role-gated, and not needed locally):
  - `cd worker && ../node_modules/.bin/wrangler dev --port 8787` (Miniflare
    KV/D1/DO; empty local DB + a bundled 15-ticker seed universe).
  - `./node_modules/.bin/wrangler pages dev react-app-dist --port 8788` (from
    repo root, after `build:frontend`). 8788 is the port allow-listed in the
    worker's `CORS_ALLOW_ORIGIN`.
- **The worker won't boot without a couple of secrets.** A fresh `wrangler dev`
  returns `503 runtime_misconfigured` (`missing:TIMED_API_KEY`,
  `missing:CF_ACCESS_AUD`). Create a git-ignored `worker/.dev.vars` with
  placeholders (`TIMED_API_KEY=local-dev-key`, `CF_ACCESS_AUD=local-dev-aud`);
  add real `TWELVEDATA_API_KEY`/`OPENAI_API_KEY` there only for live data.
- **API key == admin tier locally.** `/timed/*?key=local-dev-key` (or header
  `X-API-Key`) returns unredacted prices+scores; without it, anon callers get
  the Member view (`_redacted:true`).
- **The Pages frontend proxies `/timed/*` to PRODUCTION** —
  `react-app/_worker.js` hardcodes `WORKER_ORIGIN` to the deployed worker. To
  hit the local worker, temporarily point the built `react-app-dist/_worker.js`
  at `http://localhost:8787` (revert; don't commit).
- **Authenticated pages can't load locally.** `/today`, `/index-react`, etc. sit
  behind Cloudflare Access (Google OAuth), which can't complete on the VM — only
  `/splash` renders. Exercise authenticated logic via the API (`curl` + `?key=`).
- **Crons don't auto-fire** in `wrangler dev`; trigger via
  `curl http://localhost:8787/cdn-cgi/handler/scheduled`.
- **Local D1 starts empty;** schema is created lazily in-code by
  `d1Ensure*Schema()` (no `.sql` files). `POST /timed/ingest-capture` is the most
  robust way to exercise the ingest pipeline locally (tolerates missing tables /
  scoring errors); read it back from KV at `timed:capture:latest:<TICKER>`.
