# Deploy

**WHEN to use:** You've made any change in `worker/` or `react-app/` and
need it live for the user.

**BEFORE any `git push` to an existing branch**, run
`bash scripts/check-branch-merge-state.sh`. If the branch's PR has already
merged, the script exits 2 with recovery instructions — cherry-pick onto a
fresh branch off `main` instead. This has bitten three times so far
(2026-08-12 broker hardening; 2026-08-18 index-options card redesign;
2026-08-18 same-day card height fix — same session).

**A merge is NOT a deploy.** Confirm the bundle actually moved before you
tell the user a fix is live. From 2026-09-03 to 2026-09-14 every
`worker/**` merge reported a GREEN `deploy-worker` run and shipped
nothing: `0f67e7132` overwrote the body of the "Resolve Cloudflare
secrets" step, so `secrets-ok` was never written and every deploy step
was skipped by its own `if:`. The fallback wrote a notice and `exit 0`,
so the run went green.

What hid it for eleven days: prod kept moving anyway, because agents
hand-ran `wrangler` at the end of their own sessions. Every version in
the 09-04 → 09-14 list is a `version_upload`, with no version at all on
09-06 or 09-11 — so a merge shipped whenever the next agent happened to
deploy, same day or two days later. #1470 (Index Swings sleeve scale)
merged on 09-14 and reached prod at 22:20Z, eight hours after the TNA
and UDOW signals it was meant to fix. The workflows now `exit 1` when a
credential is missing, but always check the deployment itself:

```bash
# When did prod last ACTUALLY move? (source=wrangler rows, newest first)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/timed-trading-ingest/deployments" \
  | python3 -c "import json,sys; [print(d['created_on'], d.get('source')) for d in json.load(sys.stdin)['result']['deployments'][:5]]"

# Did the CI run deploy, or just report success?
gh run view <run-id> --log | grep -iE "SKIPPED|not configured|Current Version ID"
```

A faster behavioural check: probe a route or a reason string that only
exists in the new code. A stale bundle kept emitting
`notional_*_exceeds_cap_2000` for hours after the commit that deleted
that string was merged and "deployed".

**"The worker is current" is not "prod is current."** Five scripts
deploy separately and `npm run deploy:worker` moves only the first.
Audit them all, then diff each one's date against its own sources:

```bash
for w in timed-trading-ingest tt-feed tt-engine tt-research tt-broker-bridge; do
  printf '%-22s ' "$w"
  curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$w/versions?per_page=1" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.result?.items?.[0]?.metadata?.created_on||'?')})"
done
# then, per script: git log --oneline --since=<its date> origin/main -- <its sources>
```

On 2026-09-14 that showed `tt-feed` last deployed 09-12 and
`tt-broker-bridge` 09-11 — both fine, because neither
`worker-feed/**` + `worker/feed/**` nor `worker-bridge/**` had changed
since. The date alone is not the finding; the date against the source is.

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
| `worker/feed/**` (price feed, merge, stream helpers) | **tt-feed too** (`worker-feed/`) — after cutover the */1 heal/merge cron runs there, not on the monolith |
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
- **Editing `worker/feed/**` but only deploying the monolith.** tt-feed owns
  the */1 price-feed/heal/merge lane after cutover. Deploy
  `cd worker-feed && ../node_modules/.bin/wrangler deploy` (and production
  if that config uses envs) or the merge/heal fix never reaches the cron
  that writes `timed:prices` / `mergeFreshnessIntoLatest`.
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
