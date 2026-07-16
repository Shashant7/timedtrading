# Deploy

**WHEN to use:** You've made any change in `worker/` or `react-app/` and
need it live for the user.

**Prerequisites:**
- `wrangler` available at `node_modules/.bin/wrangler` (run via path; the
  agent VM does not have `wrangler` on PATH)
- Cloudflare API token already in `~/.wrangler` config (the agent VM is
  pre-authenticated)
- Branch pushed to GitHub (Pages auto-deploys from `main` after merge)

---

## Deploy decision tree

| What you changed | What to deploy |
|---|---|
| `worker/*.js`, `worker/wrangler.toml`, `worker/*.sql` | **Worker, BOTH envs** (default + production) |
| `react-app/shared-right-rail.js` (the right-rail React source) | **Rail compile + frontend build + git push** |
| `react-app/*.html` (any page using JSX/React) | **Frontend build + git push** |
| Any static asset under `react-app/` | **git push** (Pages auto-deploys) |
| `worker-bridge/*` (the IBKR/Robinhood sidecar) | **Bridge worker** (separate Wrangler config) |

---

## Worker deploy (default + production)

```bash
cd /workspace/worker
# Default env (workers.dev URL)
../node_modules/.bin/wrangler deploy 2>&1 | tail -5
# Production env (custom domains, prod KV/D1 bindings, prod secrets)
../node_modules/.bin/wrangler deploy --env production 2>&1 | tail -5
```

Both must succeed. The deploy is fast (~5s each).

### Feed cron lives on `tt-feed` (post-cutover)

If `PRICE_FEED_EXTERNAL=true` on the monolith (paired with
`FEED_ENABLED=true` on tt-feed), **monolith deploys do not refresh the
*/1 price-feed cron**. Any change under `worker/feed/**` (or
`worker-feed/**`) must also deploy tt-feed:

```bash
cd /workspace/worker-feed
../node_modules/.bin/wrangler deploy 2>&1 | tail -5
# Verify: prices_age_sec fresh + price_feed_cron_active
curl -s https://tt-feed.shashant.workers.dev/feed/health | python3 -m json.tool
```

Symptom of a stale tt-feed: Discord `price_value_freshness` with ~30–40m
ages on a cohort while majors stay live and `pricesSource=twelvedata_stream`
(stream DO is on the monolith; heal cron is not).

### Verify

```bash
curl -s https://timed-trading-ingest.shashant.workers.dev/timed/health | python3 -m json.tool | head -10
# Expect: ok=true, dataVersion matches expectedVersion
```

---

## Frontend deploy (React/HTML)

The compile step is mandatory — Pages serves files from `react-app-dist/`
(NOT `react-app/`) for any page that ships compiled JSX:

```bash
cd /workspace
npm run build:frontend 2>&1 | tail -5
# → Built frontend into react-app-dist
# → Build marker: cache-bust:<timestamp>

# Commit the regenerated dist files
git add react-app-dist/ react-app/
git commit -m "build: regenerate frontend dist after <what changed>"
git push -u origin <branch-name> 2>&1 | tail -3
```

Pages auto-deploys from `main` on push. After your branch merges to
`main`, the new asset lands in ~30-60s.

### Verify

```bash
# Check Pages is serving the updated file
curl -s "https://timed-trading.com/mission-control.compiled.js" -A "Mozilla/5.0" \
  | head -c 1000 | grep -c "<thing you just added>"
```

---

## Right-Rail change (special case)

`shared-right-rail.js` is a Babel-compiled source. After editing it:

```bash
cd /workspace
node scripts/compile-right-rail.js 2>&1 | tail -3
npm run build:frontend 2>&1 | tail -3
# Bump ?v=... query string in every <script src="shared-right-rail.compiled.js">
# (already automated by build:frontend; verify by greping)
git grep "shared-right-rail.compiled.js?v=" react-app/*.html | head -5
```

---

## Bridge worker deploy

The bridge is in `worker-bridge/` with its own `wrangler.toml` and its own
domain (`tt-broker-bridge.shashant.workers.dev`):

```bash
cd /workspace/worker-bridge
../node_modules/.bin/wrangler deploy 2>&1 | tail -5
```

The main worker reaches the bridge via the `BROKER_BRIDGE_URL` env var
(in `worker/wrangler.toml`) + `BROKER_BRIDGE_OPERATOR_KEY` secret.

---

## Common pitfalls

- **Skipping the second wrangler deploy.** Production is a separate
  Cloudflare environment. The default deploy goes to workers.dev URL; the
  production deploy goes to the custom domain. Both must run.
- **Forgetting to `git push` after `npm run build:frontend`.** Pages
  deploys only on push to `main` — `wrangler` does NOT publish Pages.
- **Forgetting to compile the right rail.** Edits to `shared-right-rail.js`
  are invisible until you run `compile-right-rail.js` + `build:frontend`.
- **The `?v=` cache buster matters.** Browsers cache `shared-right-rail.compiled.js`
  aggressively. `build:frontend` rewrites the `?v=cache-bust:<ts>` string in
  every page that loads it. If you hand-edit the page without rebuilding, the
  client will keep serving the old compiled JS.
- **CF Access policy regex.** When you add a new admin HTML page, also
  list it in the regex in the Cloudflare Zero Trust dashboard, or
  authenticated users hit a redirect loop on that page. The current
  shape lives in [CONTEXT.md](../CONTEXT.md) ("CF Access policy regex").

---

## Cheat-sheet: deploy after a typical bug fix

```bash
# In a feature branch
cd /workspace
# 1. Edit worker/index.js + react-app/mission-control.html
npm run build:frontend
cd worker && ../node_modules/.bin/wrangler deploy && ../node_modules/.bin/wrangler deploy --env production
cd ..
git add -A
git commit -m "fix(mc): <short>"
git push -u origin cursor/<descriptive-name>-9f61
```

Then open / update the PR. Pages will auto-deploy the static assets on
the next merge to `main`.

## Source

- `package.json` → `scripts` section
- `scripts/build-frontend.js` → which files get compiled into `react-app-dist/`
- `scripts/compile-right-rail.js` → Babel compile for `shared-right-rail.js`
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Deploy" section
