# Frontend Performance Doctrine

**WHEN to use:** Adding a script/stylesheet to any page, adding a new
page, touching `scripts/build-frontend.js`, `react-app/_worker.js`, or
investigating "the app loads slowly / page switches are slow".

## The pipeline (what the build already does for you)

`npm run build:frontend` (`scripts/build-frontend.js`) transforms every
`react-app/*.html` into `react-app-dist/` (committed; Pages serves dist):

1. **JSX precompiled** — `<script type="text/babel">` → `<page>.compiled.js`.
   No babel-standalone in the browser.
2. **`defer` on every external script** (`addDeferToExternalScripts`).
   Deferred scripts download in parallel and execute in DOCUMENT ORDER
   after parse — the dependency chain (react → tt-live-data → shared-* →
   page.compiled.js) is preserved. Excluded: `index-react.source.html`,
   `proof.html` (inline scripts reference library globals at parse time —
   see `PERF_TRANSFORM_EXCLUDED_SOURCES`).
3. **CDN → vendored** (`replaceCdnWithVendor`): unpkg/jsdelivr URLs
   rewritten to `/vendor/*` (react, react-dom, lightweight-charts, marked,
   dompurify, prop-types, htm — versions in `react-app/vendor/README.md`).
   Source HTML keeps CDN URLs so pages still open raw from `react-app/`.
4. **`?v=` stamping on JS AND CSS** (`rewriteSharedScriptCacheBust`) —
   every same-origin script/stylesheet URL gets the build timestamp.
   NEVER hand-bump a `?v=` again; just rebuild.
5. **BUILD_MARKER appended to every js/html asset** — intentionally makes
   every deploy's blobs unique to dodge Pages' content-addressed cache
   corruption (manifest present, blob missing → 500). Do NOT "optimize"
   this away with per-file content hashes.

## The cache layer (`react-app/_worker.js`)

`_headers` files are IGNORED in Pages advanced mode, so the Pages worker
sets caching explicitly when serving assets:

- `?v=`-stamped + `/vendor/*` → `public, max-age=31536000, immutable`.
  Page switches load every shared asset from disk/memory cache with ZERO
  revalidation requests; each deploy changes the `?v=` so stale is
  impossible.
- `.html` + `service-worker.js` → `no-cache` (ETag revalidation).
- everything else → 1h.

## Page-switch speed

- **Speculation rules** (`tt-nav-extras.js`): Chromium prerenders the
  other 4 journey pages on nav-link hover (`eagerness: "moderate"`).
- **`tt-fetch-cache.js`** (`window.TTFetchCache`): sessionStorage
  stale-while-revalidate for API data — use it for any heavy initial
  `/timed/*` fetch so a revisit paints instantly from cache.

## Rules when adding things

1. New shared script on a page → plain `<script src="x.js?v=ANY">`; the
   build adds defer + stamps it. Do NOT add sync scripts to `<head>`.
2. New third-party lib → vendor it (`react-app/vendor/` + a
   `CDN_VENDOR_MAP` entry), don't add a CDN origin.
3. New inline `<script>` that uses `React`/library globals at parse time →
   don't. Wait for DOMContentLoaded, or it breaks under defer.
4. New CSS link → same-origin links get stamped automatically; external
   font links need `preconnect` (already in page heads).
5. Adding a font family → extend the SINGLE combined `@import` at the top
   of `tt-tokens.css` (one round trip), don't add a second `@import`.

## Known remaining opportunities (not yet done)

- True lazy-load of the right-rail bundle (~880KB parse/exec on every
  page even deferred) — needs `shared-rail-bootstrap.js` to inject the
  rail scripts on first open instead of static tags.
- `index-react.html` (legacy trades page) still on the sync/CDN path.

## How to verify

```bash
npm run build:frontend
rg -o '<script[^>]*src="[^"]*"' react-app-dist/today.html   # all defer + /vendor/
curl -sI "https://timed-trading.com/vendor/react.production.min.js?v=x" | rg -i cache-control
# expect: public, max-age=31536000, immutable
```
