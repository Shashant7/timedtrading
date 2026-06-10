# Verda UI Migration

**WHEN to use:** Any session doing UI work after 2026-06-09, and
especially when porting a page to the new **Verda Finance** design
system. Read this BEFORE touching `tt-tokens.css`, any `react-app/*.html`
styling, or root `DESIGN.md`.

## Prerequisites

- Read root [`DESIGN.md`](../DESIGN.md) (still normative for shipped pages)
- Read [`design/verda/DESIGN.md`](../design/verda/DESIGN.md) (the incoming spec)
- Open [`design/verda/preview.html`](../design/verda/preview.html) in a
  browser as the visual reference — match its structure and spacing
- Audit status: bundle was security-audited clean on 2026-06-09 — see
  [`design/verda/README.md`](../design/verda/README.md)

## The strategy (decided 2026-06-09)

1. **Page-by-page migration, not big-bang.** Pages are Babel-standalone
   HTML with per-page styles; converting all ~30 at once guarantees
   regressions. Convert one journey page per PR, screenshot before/after,
   then move on.
2. **Verda tokens enter through `tt-tokens.css`, not a second
   stylesheet.** Copy the needed `--vf-*` custom properties and `vf-*`
   component classes from `design/verda/system.css` into a clearly
   marked `VERDA` section of `react-app/tt-tokens.css` (single import
   point — every page already loads tt-tokens). Do NOT add a second
   `<link>` per page; that doubles font loads and creates specificity
   wars.
3. **Never mix `vf-*` and `tt-*` component classes on the same page.**
   A page is either migrated (Verda chrome) or not (tt chrome). Shared
   components (`shared-right-rail`, nav, bottom nav) migrate LAST, in
   one dedicated PR, after all journey pages.
4. **Trading semantics are preserved on top of Verda.** Verda has no
   data-state colors and no mono numerals. Keep these Timed Trading
   tokens layered in (they do not exist in Verda and must not be lost):
   - `--tt-success` / `--tt-danger` / `--tt-warning` / `--tt-info`
     (+ `-dim` fills) for P&L, direction, alerts. Map Verda's
     `--vf-primary` (#38F2A1 Mint Voltage) to the BRAND accent role
     only — do not use mint for "price up" (it reads as success but is
     a CTA color; keep `--tt-success` #34d399 for data).
   - `num-*` / JetBrains Mono tabular numerals for every number a user
     compares. Verda's `numeral-xl` (Manrope 800 tabular) is for HERO
     stat cards only, not data tables.
   - Volatility-normalized card colors (`getNormalizedIntensity`).
5. **Type mapping:** Manrope 700/800 replaces Instrument Serif for
   display/editorial headings on migrated pages; Inter stays for body
   and chrome; JetBrains Mono stays for data numerals. Never mix
   Manrope and Inter on the same element (carries over the old
   serif/Inter rule).

## Token mapping (tt → vf)

| Timed Trading token | Verda token | Note |
|---|---|---|
| `--tt-bg-0` #0b0e11 | `surface` (Ink #0B1410) | page background |
| `--tt-bg-1/2` (white alpha) | `surface-raised` (Bark #13201A) | cards/panels — Verda uses SOLID fills, not alpha |
| `--tt-border-weak/strong` | `border` (Moss #1F3128) | Verda has ONE border strength, always 1px |
| `--tt-brand` #14b8a6 teal | `primary` (Mint Voltage #38F2A1) | CTAs, focus, key numerals |
| `--tt-editorial` #a78bfa purple | — none — | retire on migrated pages; LIVE pill uses mint badge |
| `--tt-text-0/1` | `on-surface` (Cream #E8F2EC) | |
| `--tt-text-2/3` | `neutral` (Sage #8AA39A) | |
| `--tt-success/danger/...` | — none — | KEEP tt semantics (see rule 4) |
| Instrument Serif headings | Manrope 800, tight tracking | editorial voice |
| pill radius ad-hoc | `rounded.full` 999px buttons/tabs/chips | Verda tabs are pills, never underline |

## Per-page migration checklist

1. `git checkout -b cursor/verda-<page>-XXXX`
2. Port the page's chrome to `vf-*` classes / `--vf-*` tokens; keep all
   data logic untouched (`getDailyChange`, admin gating, `_ttIsPro`).
3. Hero/stat surfaces: use the tilted stat card + inline mint highlight
   pill per `design/verda/DESIGN.md` (marketing pages: splash, learn,
   proof). Cockpit pages (active-trader, investor, portfolio): adopt
   palette + radii + buttons/tabs only — NO ±3° tilts on data surfaces.
4. Icons: Lucide, pinned version (never `@latest`), `currentColor`,
   18–24px. Do not mix with existing emoji/inline-SVG on the same page.
5. `npx @google/design.md lint DESIGN.md` if you changed the root spec.
6. `node scripts/build-frontend.js` → commit `react-app-dist/` with it.
7. Screenshot before/after; verify: nav identical behavior, right rail
   loads, prices still admin/pro-gated, no `tt-*`+`vf-*` mixing.
8. Update the migration tracker table below in the same PR.

## Migration tracker

> **Mechanism since 2026-06-10:** `body.vf-page` in `tt-tokens.css`
> re-points every shared token family (`--ds-*`, legacy `--tt-*`, and the
> marketing pages' `--bg-*/--text-*/--accent` names) at the Verda palette.
> A page migrates by adding `class="vf-page"` to `<body>` + Manrope font
> link + targeted hex fixes (heroes, CTAs, gold→mint). Custom properties
> set on `<body>` override page-local `:root` blocks (nearest ancestor
> wins), so local token blocks don't need deleting.

| Page | Status |
|---|---|
| splash.html | **DONE 2026-06-10** (vf-page + Manrope hero w/ mint highlight pill, pill CTAs, mint accent) |
| today.html | **DONE 2026-06-10** (first migration — page-local `:root` repoint) |
| active-trader.html | **DONE 2026-06-10 v2** (full page-local `:root` repoint matching today.html, 18px card radii, Manrope hero, guide → shared `tt-disclose` collapsed) |
| investor.html | **DONE 2026-06-10 v2** (same v2 treatment; `investor-panel.js` headers → eyebrow + Manrope, violet → spring) |
| portfolio.html | **DONE 2026-06-10** (vf-page; equity-curve data colors kept) |
| insights.html | **DONE 2026-06-10** (vf-page + gold→mint inline sweeps) |
| learn.html / faq.html / proof.html / terms.html | **DONE 2026-06-10** (vf-page; proof got tokens link + full `:root` retheme; serif headings → Manrope 700/800) |
| daily-brief.html | **DONE 2026-06-10** (vf-page + full grey/teal sweep — Tailwind arbitrary greys remapped to Verda neutrals) |
| research-desk.html | **DONE 2026-06-10** (vf-page + declutter: collapses, ledger cap) |
| mission-control.html | **DONE 2026-06-10** (vf-page + declutter: McCollapse sub-accordions) |
| shared nav + right rail + bottom nav + activity strip + global search | **DONE 2026-06-10** (chrome hex sweep: Ink bg, Verda neutrals, gold→mint; data colors — candles, up/dn, lane stages — untouched) |
| investor-panel.js / trades-performance.js | **DONE 2026-06-10** (same chrome sweep) |
| admin pages (system-intelligence, screener, ticker-management, calibration, alerts, trade-autopsy, investor-dashboard, model-dashboard, debug-dashboard, brand-kit, admin-clients, simulation-dashboard, index-react) | **DONE 2026-06-10** (vf-page + Manrope mechanical pass) |

**Migration COMPLETE 2026-06-10** — every page that links `tt-tokens.css`
now carries `vf-page` (or its own Verda `:root` in today/proof). Future
pages: add `class="vf-page"` to `<body>` + Manrope font + use tokens.

## Canonical page patterns (2026-06-10 — copy these, don't invent)

Promoted to `tt-tokens.css` (shared) and documented with JSX shapes in
root `DESIGN.md` § "Verda canonical page patterns":

- **Section** = `.tt-card.tt-card-pad` + `.tt-sec-title` eyebrow
  (11px uppercase, dim) + `.tt-sec-h` headline (Manrope 800).
- **Tier-1 page header** = `.tt-status` (eyebrow label + Manrope
  `.greeting` + `.session` pills). Journey pages use this instead of
  bespoke gradient heroes.
- **Progressive disclosure** = `<details class="tt-disclose">` with
  `summary > .tt-disclose-title/.tt-disclose-sub/.tt-disclose-caret`,
  body in `.tt-disclose-body`, COLLAPSED by default, open-state in
  localStorage. Use for guides ("How to read this page"), heat maps,
  anything instructional — never ship a default-open explainer wall.
- Card radius is `var(--vf-radius-md, 18px)` everywhere; KPI tiles
  inside strips use 10px.

## How to verify

- Page renders with Verda chrome, zero console errors, fonts load once.
- `rg -n "vf-" react-app/<page>.html` and `rg -n "tt-(btn|card|chip)"
  react-app/<page>.html` — only one family present.
- Live data behavior unchanged (kanban stages, prices, gating).

## Source files

- `design/verda/system.css` — copy classes from here (do not link it)
- `react-app/tt-tokens.css` — single integration point
- `scripts/build-frontend.js` — canonical build (NOTE:
  `scripts/build-index-react.js` is broken on current source layout)
