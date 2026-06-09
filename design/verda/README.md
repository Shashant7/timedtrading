# Verda Finance — incoming design system bundle

**What this is:** the third-party design system the operator downloaded
(2026-06-09) as the basis for the Timed Trading UI refresh. It is the
**source bundle**, kept verbatim for reference. Nothing in this folder
is served to users.

| File | Role |
|---|---|
| `DESIGN.md` | Verda's normative spec (tokens, components, do/don'ts) |
| `system.css` | The full stylesheet (`.vf-*` classes + CSS custom properties) |
| `preview.html` | Visual reference page — match its structure/spacing when porting |
| `cover.html` / `cover.png` / `preview-desktop.png` | Marketing/preview artifacts |
| `metadata.json` | Palette + concept metadata from the design service |

## Security audit (2026-06-09, full-system-review session)

Third-party design bundles are a supply-chain vector (CSS exfiltration,
embedded scripts, prompt-injection in spec files). This bundle was
audited before intake:

- `system.css` — ONE external reference: Google Fonts `@import`
  (Manrope + Inter). No other `url()` targets, no `expression()`,
  `behavior:`, `-moz-binding`, or attribute-selector exfiltration
  patterns. **Clean.**
- `preview.html` / `cover.html` — one external script
  (`unpkg.com/lucide@latest` — icon library); inline scripts only call
  `lucide.createIcons()`. No fetch/cookie/storage/beacon code. **Clean.**
- `DESIGN.md` / `metadata.json` — descriptive spec content only; no
  agent-directed instructions (prompt injection). **Clean.**

**Caveat for production use:** `lucide@latest` is unpinned. When Lucide
is adopted in product pages, pin a version (e.g.
`https://unpkg.com/lucide@0.460.0`) — never ship `@latest`.

## How to use this bundle

Read **[`skills/verda-ui-migration.md`](../../skills/verda-ui-migration.md)**
before touching any UI. Summary of the rules:

1. **Root `DESIGN.md` stays normative** for everything currently
   shipped. Verda is adopted page-by-page; the root spec is updated as
   the merged system evolves.
2. `system.css` is copied/adapted into the served app via the migration
   skill (it is NOT linked from this folder — Pages serves `react-app/`).
3. Verda has no semantic trading colors (success/danger/warning data
   states) and no JetBrains-Mono numeral tokens — those Timed Trading
   tokens are PRESERVED and layered on top during migration.
4. Never mix `vf-*` and `tt-*` component classes on the same page.

## Provenance

Uploaded by the operator 2026-06-09 (commits `745eafbd`, `884568c3` —
"Add files via upload"), originally landing at repo root +
`docs/`; consolidated here in the verda-intake PR. Verda's own spec
references `output/css/system.css` paths from the design service's
export layout — ignore those paths; this folder is the canonical home.
