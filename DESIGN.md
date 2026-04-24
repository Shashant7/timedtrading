---
version: alpha
name: Timed Trading
description: >
  Dark-mode trading UI. Editorial masthead at the top of long-form surfaces
  (Daily Brief, Splash, FAQ, Terms). Data-dense utility chrome everywhere
  else (Active Trader, Investor, Trades, Autopsy). Three type families, one
  palette, one set of motion primitives.

colors:
  # ─ Background scale (layered panel elevation) ──────────────
  bg-0: "#0b0e11"                   # page background — never layer content directly
  bg-1: "#040506"                   # panel / card  (rgba white 0.022 baked)
  bg-2: "#0a0a0b"                   # elevated      (rgba white 0.04 baked)
  bg-3: "#0f0f10"                   # hover / focused (rgba white 0.06 baked)

  # ─ Text scale (four levels, use by semantic role not by weight) ──────
  text-0: "#f4f5f7"                 # display / serif headlines
  text-1: "#e5e7eb"                 # body — default
  text-2: "#9ca3af"                 # secondary metadata
  text-3: "#6b7280"                 # muted labels / captions
  text-4: "#4b5563"                 # faint — dividers-as-type only

  # ─ Borders (two strengths) ─────────────────────────────────
  border-weak: "#0a0a0b"            # rgba white 0.04 baked
  border-strong: "#161618"          # rgba white 0.08 baked

  # ─ Semantic accents ─────────────────────────────────────────
  success: "#34d399"
  success-dim: "#0f2921"            # rgba(52,211,153,0.14) baked
  warning: "#f59e0b"
  warning-dim: "#2c1e0a"            # rgba(245,158,11,0.14) baked
  danger: "#ef4444"
  danger-dim: "#2c1314"             # rgba(239,68,68,0.14) baked
  info: "#67e8f9"
  info-dim: "#122b2f"               # rgba(103,232,249,0.14) baked

  # ─ Brand + editorial ────────────────────────────────────────
  primary: "#14b8a6"                # brand teal — CTA, link hover
  primary-dim: "#0f2a29"            # rgba(20,184,166,0.14) baked
  editorial: "#a78bfa"              # editorial purple — LIVE pill, masthead label
  editorial-dim: "#1e1932"          # rgba(167,139,250,0.14) baked

  # ─ Pair surfaces (WCAG AA contrast pairs) ──────────────────
  on-primary: "#0b0e11"             # brand bg -> dark text
  on-editorial: "#ffffff"           # purple bg -> white text
  on-danger: "#ffffff"
  on-success: "#0b0e11"
  on-warning: "#0b0e11"

typography:
  # ─ Editorial family — Instrument Serif ─────────────────────
  # Reserved for: Daily Brief H1/H2, Splash sections, FAQ/Terms mastheads,
  # Trade Autopsy page title, Investor "Market Health" subhead.
  # Never mix on the same element as UI body text.
  display-editorial:
    fontFamily: Instrument Serif
    fontSize: 2.125rem              # 34px — hero
    lineHeight: 1.1
    letterSpacing: -0.02em
    fontWeight: 400

  h1-editorial:
    fontFamily: Instrument Serif
    fontSize: 1.625rem              # 26px
    lineHeight: 1.1
    letterSpacing: -0.015em
    fontWeight: 400

  h2-editorial:
    fontFamily: Instrument Serif
    fontSize: 1.375rem              # 22px
    lineHeight: 1.2
    letterSpacing: -0.01em
    fontWeight: 400

  pull-quote:
    fontFamily: Instrument Serif
    fontSize: 1.0625rem             # 17px — markdown blockquote in briefs
    lineHeight: 1.45
    fontWeight: 400
    fontStyle: italic

  # ─ UI family — Inter ───────────────────────────────────────
  h1-ui:
    fontFamily: Inter
    fontSize: 1.25rem               # 20px — dashboard section heads
    lineHeight: 1.2
    letterSpacing: -0.01em
    fontWeight: 600

  h2-ui:
    fontFamily: Inter
    fontSize: 1rem                  # 16px — subsection
    lineHeight: 1.2
    fontWeight: 600

  body-lg:
    fontFamily: Inter
    fontSize: 0.875rem              # 14px
    lineHeight: 1.5
    fontWeight: 400

  body-md:
    fontFamily: Inter
    fontSize: 0.8125rem             # 13px — default
    lineHeight: 1.5
    fontWeight: 400

  body-sm:
    fontFamily: Inter
    fontSize: 0.75rem               # 12px — dense chrome
    lineHeight: 1.4
    fontWeight: 400

  label-caps:
    fontFamily: Inter
    fontSize: 0.625rem              # 10px — uppercase section labels
    lineHeight: 1.4
    letterSpacing: 0.16em
    fontWeight: 700

  # ─ Data family — JetBrains Mono ────────────────────────────
  # Use anywhere a number anchors a row: prices, percentages, rank, R:R,
  # win rate, PnL, timestamps in tables. Numbers belong in mono.
  num-display:
    fontFamily: JetBrains Mono
    fontSize: 1.75rem               # 28px — Market Health score, hero stats
    fontVariation: '"tnum" 1, "zero" 0'
    fontWeight: 700
    letterSpacing: -0.015em

  num-lg:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem              # 14px — card prices, R:R
    fontVariation: '"tnum" 1, "zero" 0'
    fontWeight: 600

  num-md:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem               # 12px — inline metadata
    fontVariation: '"tnum" 1, "zero" 0'
    fontWeight: 500

rounded:
  xs: 4px
  sm: 6px
  md: 10px
  lg: 14px
  xl: 20px

spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px
  7: 48px
  8: 64px

components:
  # ─ Containers ──────────────────────────────────────────────
  panel:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: 16px

  card:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: 24px
  card-hover:
    backgroundColor: "{colors.bg-2}"

  # ─ Labels + pills ─────────────────────────────────────────
  label:
    textColor: "{colors.text-3}"
    typography: "{typography.label-caps}"
  label-editorial:
    textColor: "{colors.editorial}"
    typography: "{typography.label-caps}"

  pill-data:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text-2}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.sm}"
    padding: 4px
  pill-bias-long:
    backgroundColor: "{colors.info-dim}"
    textColor: "{colors.info}"
    rounded: "{rounded.sm}"
    padding: 4px
  pill-bias-short:
    backgroundColor: "{colors.danger-dim}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: 4px
  pill-live:
    backgroundColor: "{colors.editorial-dim}"
    textColor: "{colors.editorial}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.sm}"

  # ─ Buttons ────────────────────────────────────────────────
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 12px
    typography: "{typography.body-md}"
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: 12px

  # ─ Brief / editorial surfaces ──────────────────────────────
  brief-h1:
    textColor: "{colors.text-0}"
    typography: "{typography.display-editorial}"
  brief-h2:
    textColor: "{colors.text-0}"
    typography: "{typography.h2-editorial}"
  brief-pull-quote:
    textColor: "{colors.text-1}"
    typography: "{typography.pull-quote}"
    padding: 16px
  brief-es-prediction:
    backgroundColor: "{colors.warning-dim}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: 12px

  # ─ Status strip cells (Analysis page Zone A) ───────────────
  status-strip-cell:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.text-1}"
    typography: "{typography.num-md}"
    padding: 6px

  # ─ Page shell ──────────────────────────────────────────────
  page:
    backgroundColor: "{colors.bg-0}"
    textColor: "{colors.text-1}"

  # ─ Hover / focused state for interactive list rows ─────────
  row-hover:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.text-1}"

  # ─ Table divider / hairline ────────────────────────────────
  divider:
    backgroundColor: "{colors.border-weak}"
  divider-strong:
    backgroundColor: "{colors.border-strong}"

  # ─ Metadata: faint counts like "3 / 8" ────────────────────
  metadata-faint:
    textColor: "{colors.text-4}"
    typography: "{typography.num-md}"

  # ─ Semantic status badges ─────────────────────────────────
  status-success:
    backgroundColor: "{colors.success-dim}"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    typography: "{typography.label-caps}"
  status-warning:
    backgroundColor: "{colors.warning-dim}"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    typography: "{typography.label-caps}"

  # ─ Alert / callout surfaces ───────────────────────────────
  # NOTE: on dim backgrounds, text uses the solid semantic color for
  # WCAG contrast. The `on-*` color pairs are for solid semantic fills
  # (e.g. a solid success button) — not for the dim callout surface.
  callout-danger:
    backgroundColor: "{colors.danger-dim}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: 12px
  callout-success:
    backgroundColor: "{colors.success-dim}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: 12px
  callout-warning:
    backgroundColor: "{colors.warning-dim}"
    textColor: "{colors.warning}"
    rounded: "{rounded.md}"
    padding: 12px

  # ─ Primary color used as dim fill (e.g. brand-accent footer rule) ──
  brand-accent:
    backgroundColor: "{colors.primary-dim}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"

  # ─ Editorial "LIVE" pill with tt-heartbeat dot ─────────────
  live-indicator:
    backgroundColor: "{colors.editorial-dim}"
    textColor: "{colors.on-editorial}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.sm}"
---

## Overview

Timed Trading is a dark-mode trading cockpit with two voices:

**Editorial** — long-form surfaces (Daily Brief, Splash, FAQ, Terms, Trade
Autopsy headlines). Instrument Serif, generous line-height, warm neutrals.
This is the voice that tells the market's story.

**Terminal** — the cockpit itself (Active Trader, Investor, Trades). Inter
for chrome, JetBrains Mono for every number, no serif anywhere. Dense but
not crowded. Color signals meaning, never decoration.

The rule: **editorial voice is reserved for pages where users read.
Terminal voice is for pages where users decide.** Don't mix them on the
same element.

## Colors

The palette is built around four background layers and four text weights.
Semantic colors (success / warning / danger / info) are sparingly used —
they should mark state, not decorate it. Brand teal (`primary`) is the
CTA driver; editorial purple marks "live" / narrative voice.

Every `*-dim` variant is the base at ~14 % opacity on `bg-0`. Use dim as
the fill for status pills; use the solid color for text on a dim fill.

- **bg-0** is the page. Never place text directly on it without a container.
- **bg-1** is the default card / panel surface.
- **bg-2 / bg-3** are hover states. Don't use them as primary surfaces —
  cards stacked on bg-2 start to lose elevation signal.
- **text-0** is reserved for serif editorial display. Sans body never
  uses text-0 — it uses text-1.
- **text-4** is *only* for dividers-as-type (e.g. "3 / 8" faint count).
  Don't use it for anything a user needs to read.

### Direction / outcome

- Green (`success`) = long trending up, win, market breadth positive.
- Red (`danger`) = short, loss, breakdown.
- Amber (`warning`) = caution, pullback, elevated risk.
- Cyan (`info`) = bias direction when not committed to a trade (LONG
  bias pill on a watchlist card).
- Purple (`editorial`) = live / narrative / non-actionable annotation.

The only time an element gets multiple colors is when it's
communicating multiple dimensions (e.g. a card shows cyan bias and
mono green price — two different signals).

## Typography

Three families. Don't mix on the same element.

**Inter** runs the UI chrome — labels, buttons, nav, body copy,
pill text. It handles ~85 % of visible characters.

**JetBrains Mono** carries every number that anchors a row. Prices,
percentages, rank scores, R:R, PnL, volume, timestamps. The rule is
strict: if it's a number a user might compare against another number,
it's mono.

**Instrument Serif** is the editorial voice. Used on:
- Daily Brief H1 (long-form date: "Wednesday, April 23")
- Daily Brief H2 (section headings in the markdown body)
- Daily Brief pull-quotes (single-strong-child paragraphs)
- Splash, FAQ, Terms masthead titles
- Trade Autopsy page title ("Every trade, dissected.")
- Investor Market Health subhead ("Is the tide in or out?")
- Archive drill-in masthead

Never mix serif and sans on the same line or adjacent element. The round-2
UX fix removed the splash's `hero-editorial` serif sub-line specifically
because pairing it with a sans headline created a "half-converted" feel.
If you want emphasis, use weight and color — not serif.

### Tabular nums

Body CSS sets `font-variant-numeric: tabular-nums` globally. Any element
that displays a number inherits column-aligned digits without explicit
mono family. For dense tables, apply `num-md` or `num-lg` tokens to
force the mono family as well.

## Layout

Spacing scale is a 4px grid: `spacing.1` through `spacing.8` map to
4/8/12/16/24/32/48/64 px. Padding on cards is `spacing.5` (24px); pills
use `spacing.1-2` (4-8px). Never hand-type `padding: 7px` or
`margin: 13px`; every spacing value should resolve to a token.

Container widths:
- **Long-form pages** (Brief, FAQ, Terms) — max-width 800px
- **Dashboard pages** — fluid; cards typically 280-300px wide in Kanban
  lanes, 450px when the right rail is active
- **Splash** — max-width 1120px

## Elevation & Depth

Three shadow levels, all warm-black:

- `shadow-sm` — subtle lift on inline pills and buttons
- `shadow-md` — default on cards
- `shadow-lg` — modals, popovers, anything above the base plane

Don't stack elevation. If a card is on `shadow-md`, its child buttons
shouldn't also be on `shadow-md`. Elevation should read as depth, not
noise.

## Shapes

Radius scale:

- `rounded.xs` (4px) — inline tag chips, inputs
- `rounded.sm` (6px) — pills, small buttons, data badges
- `rounded.md` (10px) — cards, panels, modals, containers
- `rounded.lg` (14px) — hero cards, feature callouts
- `rounded.xl` (20px) — marketing only (splash bubble radar)

Consistent radii within a group. A card at `md` shouldn't contain a
child panel at `lg`.

## Components

### Status Strip (Active Trader Zone A)

A sticky row at the top of the Active Trader page. Cells use
`status-strip-cell` tokens: `bg-1` background with `num-md` typography.
First cell is Regime (success/danger/neutral by market mood). Last cell
is a `pill-live` with a heartbeat dot when market is open.

All cells share the same height and baseline — don't let one cell push
taller than the row.

### Ticker Cards (CompactCard)

The primary unit of the Active Trader view. Uses `card` tokens with an
accent border color that matches the bias: cyan for LONG, rose for SHORT,
amber for pullback/caution.

Pills inside the card use *desaturated* variants (10 % tint, not 20 %)
so the sparkline + price color carry the visual story. The round-2 UX
fix established this ratio.

### Brief masthead

Every long-form brief (Daily, Evening, Morning, Archive drill-in) uses
the same masthead pattern:

1. Small editorial `label-editorial` above ("Morning Brief")
2. Large serif `h1-editorial` date ("Wednesday, April 23")
3. Accent-bar ES Prediction callout (`brief-es-prediction`) if present
4. Hairline rule
5. Body content

Content-rank color (warning-amber for morning, editorial-purple for
evening) cues time-of-day without any emoji.

### Pills

`pill-data` is the canonical small uppercase tag. Use it for every
MOVERS / SETUP / STATUS label across the app. Bias pills (`pill-bias-long`,
`pill-bias-short`) carry the same shape but semantic fill.

### Buttons

`button-primary` is the only high-emphasis CTA. One per screen.
`button-secondary` for reverse/cancel. Link-style for tertiary.

Never use `pill-live` styling for a clickable button — `pill-live` is
an annotation, not an action.

## Do's and Don'ts

- DO use `pill-data` for every small uppercase tag across the app.
- DO route every new color through these tokens — no ad-hoc hex in JSX
  or CSS files.
- DO use mono (`num-*`) for any number a user compares against another.
- DO collapse sections that have no content (Intraday Flash renders
  nothing if all entries filtered out).
- DO use `label-editorial` (not `label`) as the eyebrow above a serif
  headline on brief surfaces.

- DO NOT declare new `:root` variables on individual pages. If you
  need a token, add it here and reference it via `--tt-*`.
- DO NOT mix Instrument Serif and Inter on the same element or in
  adjacent text blocks. Pick one voice per line.
- DO NOT use `text-0` for sans body copy. `text-0` is reserved for
  serif editorial display.
- DO NOT use saturated 20 %+ tints on ticker card pills. They
  overwhelm the sparkline + price signal. 10 % is the ceiling.
- DO NOT build new modal flows that aren't in the `components` section
  here. Update the spec first, then build.
- DO NOT bundle Discord CTAs on the splash — splash is about the
  product, not the community. The Analysis-page waitlist button is the
  single canonical Discord entry.

## Motion

Motion tokens live in `tt-tokens.css` as an appendix to this spec (the
DESIGN.md format doesn't yet cover motion primitives):

- `--tt-dur-instant` (80ms) — focus rings, border-color on hover
- `--tt-dur-fast` (160ms) — toast, dropdown
- `--tt-dur-base` (240ms) — modal, sheet
- `--tt-dur-pulse` (600ms) — price pulse tint

Easing is `cubic-bezier(0.2, 0, 0, 1)` (ease-out) for everything except
the price pulse, which uses the standard ease-in-out curve.

Heartbeat dot (LIVE indicator) uses a custom keyframe animation that
pulses opacity 0.4 → 1 → 0.4 over 2s. Never use the heartbeat effect on
non-live content — it signals "this value will change while you watch."

`prefers-reduced-motion` is honored globally in the base stylesheet.

## Cross-references

- `react-app/tt-tokens.css` — runtime CSS variables (manually kept in
  sync with the YAML tokens above)
- `react-app/tailwind.input.css` — Tailwind utilities layer
- `tasks/ui-ux-pass-proposal-2026-04-23.md` — the original UX refactor plan
- `tasks/v11-exit-policy-findings-2026-04-24.md` — reminder that UI
  changes went alongside strategy changes

## Versioning

This file is the normative spec. Runtime CSS (`tt-tokens.css`) must
match. When a token is added or changed:

1. Update `DESIGN.md` first (this file)
2. Run `npx @google/design.md lint DESIGN.md` to catch broken refs /
   contrast failures
3. Update `tt-tokens.css` to mirror the change
4. Test the surface
5. Commit both together with the token name in the commit message
