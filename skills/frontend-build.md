# Frontend Build (Babel + JSX compile)

**WHEN to use:** A page loads as a blank screen, a JSX edit doesn't
appear in production, or you've added a new page that uses React.

---

## Why we have a build step

`react-app/*.html` ships with **Babel Standalone** for in-browser JSX
compilation. That works for rapid iteration but:

- 1-3s cold-load delay → users see a blank screen
- Babel CDN reliability is suspect
- Compiled output isn't cached

So `scripts/build-frontend.js` runs Babel **at build time** for the
heavy pages, writes `react-app-dist/<page>.compiled.js`, and rewrites
the page's `<script>` tag to load the pre-compiled bundle.

---

## What `npm run build:frontend` actually does

1. Reads each entry in `scripts/build-frontend.js` (the page list)
2. Babel-compiles each page's inline `<script type="text/babel">` blocks
3. Emits `react-app-dist/<page>.compiled.js` (one per page)
4. Copies the HTML to `react-app-dist/<page>.html`, rewriting:
   - `<script type="text/babel">…</script>` → `<script src="<page>.compiled.js?v=cache-bust:...">`
   - `?v=cache-bust:...` query strings on shared utilities
5. Prints `Built frontend into react-app-dist` + the cache-bust marker

`react-app-dist/` is what **Pages serves**, not `react-app/`.

---

## "I added a new page, where do I register it?"

Edit `scripts/build-frontend.js` (the array near the top). Add an entry:

```js
{ src: "react-app/my-new-page.html", out: "my-new-page" }
```

Then `npm run build:frontend`. Verify:

```bash
ls react-app-dist/my-new-page.*
# my-new-page.compiled.js
# my-new-page.html
```

Also remember:

- Add the page to the CF Access policy regex (Cloudflare Zero Trust dashboard) if it's authenticated
- Add it to `ADMIN_ONLY_PAGES` set in `react-app/_worker.js` if it's admin-only
- Add it to `JOURNEY_PATHS` in `tt-nav-extras.js` if it uses the `.nav-links` markup

---

## Blank-page bug — checklist

If a page loads blank:

1. **DevTools Console** — any uncaught error? Most common:
   - `ReferenceError: h is not defined` → page is using `h(...)` shorthand for `React.createElement` but never declared it. Add `const h = React.createElement;` near the top.
   - `Cannot read properties of undefined (reading 'X')` → a React component crashed during render. The whole tree unmounts → blank page. Wrap in `<ErrorBoundary>` for sanity.

2. **DevTools Network** — is `<page>.compiled.js` loaded? If 404:
   - You ran `build:frontend` but didn't push to main → Pages serving old assets. See [cache-bust-rail.md](cache-bust-rail.md).
   - You added the page to the entries but the build failed. Check console output.

3. **JSX root tree** — App's return MUST have a single root. The frequent
   bug:
   ```jsx
   return ( <>                  // fragment wrapper
     <div className="tt-root">
       ...
       <GoProModal />            // OK
     </div>                       // close root div
   </> );                         // close fragment
   ```
   An extra `</div>` before `<GoProModal />` puts the modal at fragment
   level and React doesn't crash, but rendering is wrong. (PR #266)

4. **Babel-page nav must be static HTML** — JSX-rendered nav doesn't
   appear until the bundle compiles. The pattern is to put the nav
   markup directly in the `<body>`, OUTSIDE `<div id="root">`, so it
   paints immediately. See `today.html` / `active-trader.html`.

---

## "My change isn't appearing"

Most likely:

1. You changed `react-app/foo.html` but didn't run `npm run build:frontend`.
2. You ran the build but didn't commit `react-app-dist/`.
3. You committed but haven't pushed to `main` (or your branch isn't merged).
4. You did all three but the browser cached. See [cache-bust-rail.md](cache-bust-rail.md).

Verify:

```bash
# Local dist exists and includes your change
grep "<your new code>" react-app-dist/foo.compiled.js | head -3

# Pages serves your change
curl -s "https://timed-trading.com/foo.compiled.js" -A "Mozilla/5.0" | grep -c "<your new code>"
```

## Source

- `scripts/build-frontend.js` — Babel entrypoint + page list
- `scripts/compile-right-rail.js` — special-case rail compile
- `react-app/_worker.js` — Pages worker (admin gate + `/timed/*` proxy)
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Frontend" entries
