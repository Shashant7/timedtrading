# Cache-Bust the Right Rail (and other React bundles)

**WHEN to use:** User reports "I changed code but I don't see it" after a
deploy, or you just changed `shared-right-rail.js`, `shared-price-utils.js`,
or any other shared JS imported across pages.

**Prerequisites:**
- Branch already built (`npm run build:frontend`) and merged to `main`
- ~30 seconds for Pages to redeploy

---

## Why this matters

Pages serves the static JS bundles with **`Cache-Control: max-age=...`**.
Browsers will keep the OLD bundle cached for up to 24h unless the URL
changes. We force a fresh fetch by appending `?v=<unique-string>` to every
`<script src>` that loads the bundle.

`npm run build:frontend` automatically rewrites those `?v=...` query
strings to a unique timestamp on every build. The mechanism:

```
<script src="shared-right-rail.compiled.js?v=cache-bust:1780000000000:..."></script>
```

When the build timestamp changes, the URL is different, the browser fetches
fresh, and the user sees the new code.

---

## The single trustworthy command

```bash
cd /workspace
npm run build:frontend
git add react-app-dist/ react-app/
git commit -m "build: regenerate frontend dist after <what changed>"
git push -u origin <branch-name>
```

After the branch merges to `main`, Pages auto-deploys in 30-60s.

---

## Verify the bust landed

```bash
# Check the deployed HTML pulled the latest cache-bust marker
curl -s "https://timed-trading.com/today.html" -A "Mozilla/5.0" \
  | grep -oE "shared-right-rail.compiled.js\?v=[^\"]*" | head -1
```

Compare the `v=` value against your local:

```bash
grep -oE "shared-right-rail.compiled.js\?v=[^\"]*" react-app/today.html | head -1
```

If they match → Pages has deployed. If they don't match → wait 30-60s and
re-curl. If still mismatched after 5min → the branch didn't merge to main.

---

## "I still see the old version in my browser"

After confirming Pages serves the new bundle, the user's browser may still
be caching. Have them:

1. Open DevTools → Network tab → check "Disable cache" → reload
2. Or hard-reload: `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Win/Linux)
3. Or test in an Incognito window (fresh cache)

The cache-bust query string SHOULD make this unnecessary, but a few
browsers (older Safari, some proxies) ignore query-string variation. If
the user reports a stale UI even after that, double-check the cache-bust
landed via the curl above.

---

## When `build:frontend` is NOT enough

If you edit a file that `build:frontend` doesn't process (e.g. a raw
`.js` in `react-app/` that isn't imported via a compiled page), the
cache-bust string for it won't auto-update. Two options:

1. **Add it to `scripts/build-frontend.js`** — preferred for shared utils.
2. **Manually bump the `?v=` in every page that loads it** — quick fix.

Files automatically rewritten by `build:frontend` include:

- `react-app/today.html`, `active-trader.html`, `investor.html`, etc.
- `shared-right-rail.compiled.js` (after `compile-right-rail.js`)
- `*.compiled.js` for any JSX-bearing page

## Source

- `scripts/build-frontend.js` — actual rewriter
- `scripts/compile-right-rail.js` — Babel pass for the rail
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Frontend cache" entries
