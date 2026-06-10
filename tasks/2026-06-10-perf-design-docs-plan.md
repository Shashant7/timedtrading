# 2026-06-10 — Performance Tuning + Journey-Page Design Unification + Docs

## A. Performance (load + page-switch speed)

Audit findings (react-app-dist served by Pages + `_worker.js` advanced mode):

1. ~17 synchronous `<script>` tags in `<head>` on every journey page —
   render-blocking. Largest: shared-right-rail.compiled.js (882KB),
   auth-gate.js (124KB), shared-bubble-chart.compiled.js (102KB), React +
   ReactDOM + lightweight-charts from unpkg, marked from jsdelivr.
2. No cache headers: `_headers` does NOT apply in advanced mode (_worker.js);
   every page switch revalidates every asset (one conditional request each).
3. Fonts: tt-tokens.css contains TWO `@import` google-fonts chains —
   serialized render-blocking round trips inside CSS load.
4. Third-party origins (unpkg, jsdelivr) add TLS handshakes + outage risk.
5. Page switches are full MPA navigations; no prefetch/prerender.
6. Build ships unreferenced 1.1MB shared-right-rail.js (babel source) to dist.
7. `?v=` build stamp covers .js only — CSS links are manually bumped
   (tt-tokens.css?v=20260610-verda4) or unversioned (tailwind.generated.css).

Plan (all build-level so every page benefits without editing 30 HTML files):

- [x] A1. Vendor self-host react, react-dom, marked, lightweight-charts under
      react-app/vendor/; build rewrites CDN URLs → /vendor/*?v=stamp.
      Skip legacy index-react.source.html (has CDN fallback loader logic).
- [x] A2. Build pass: add `defer` to every external script tag (order is
      preserved among deferred scripts so the dependency chain holds).
      Skip index-react.source.html + proof.html (parse-time inline refs).
- [x] A3. Build pass: stamp `?v=` on same-origin stylesheet links too.
- [x] A4. _worker.js: immutable 1y cache for ?v=-versioned + /vendor/ assets,
      no-cache (revalidate) for HTML.
- [x] A5. tt-tokens.css: merge the two @imports into one URL.
- [x] A6. Speculation rules (prerender, moderate eagerness) for the 5 journey
      pages, injected by tt-nav-extras.js (deferred, on all pages).
- [x] A7. Stop copying shared-right-rail.js babel source to dist.
- [ ] Future (not this pass): true lazy-load of the rail bundle on first
      open; per-file content hashing (conflicts with BUILD_MARKER doctrine —
      every deploy intentionally rewrites every blob to dodge Pages'
      content-addressed cache corruption).

## B. Design unification (Active Trader + Investor → Today's Verda language)

- [x] B1. Promote Today's canonical patterns into tt-tokens.css Verda section:
      .tt-disclose (details chrome), .tt-status (tier-1 header) so all pages share.
- [x] B2. active-trader.html: Verda :root map (solid bark surfaces, Manrope
      display var, 18px radii), hero → eyebrow + Manrope headline,
      HowToReadCard → <details class="tt-disclose"> collapsed by default,
      account strip/chips/lanes harmonized to bark surfaces + Verda radii.
- [x] B3. investor.html: same treatment (inv-* classes).
- [x] B4. investor-panel.js: Action Board / Market Health / Investor Brief
      headings → .tt-sec-title + .tt-sec-h pattern; replace hardcoded hex
      (#10b981 / #f59e0b / text-white) with tokens.

## C. Documentation for future agents

- [x] C1. DESIGN.md: Verda canonical page patterns (status header, eyebrow +
      headline, card, disclosure) + migration status table.
- [x] C2. CONTEXT.md: worker topology (monolith + tt-feed/tt-engine/tt-research
      role split + flags) and frontend performance doctrine bullets.
- [x] C3. AGENTS.md: repo map rows (worker-feed/engine/research, vendor/),
      skills table additions.
- [x] C4. New skills: skills/worker-topology.md, skills/frontend-performance.md;
      update skills/README.md, skills/verda-ui-migration.md,
      skills/cache-bust-rail.md (css stamping now automatic).
