---
version: alpha
name: Verda Finance
description: A confident dark-mode neo-banking design system that pairs ink-green surfaces with a single high-voltage mint accent, oversized editorial display type, pill controls, and softly tilted stat cards.
colors:
  primary: "#38F2A1"
  secondary: "#A6F7CF"
  tertiary: "#06241A"
  neutral: "#8AA39A"
  surface: "#0B1410"
  surface-raised: "#13201A"
  on-surface: "#E8F2EC"
  on-primary: "#06241A"
  border: "#1F3128"
  focus: "#A6F7CF"
  error: "#F26F6F"
typography:
  display-xl:
    fontFamily: Manrope
    fontWeight: 800
    fontSize: 4.75rem
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  display-lg:
    fontFamily: Manrope
    fontWeight: 800
    fontSize: 3.25rem
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  headline-md:
    fontFamily: Manrope
    fontWeight: 700
    fontSize: 1.5rem
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body-md:
    fontFamily: Inter
    fontWeight: 400
    fontSize: 1rem
    lineHeight: 1.55
    letterSpacing: "0"
  body-sm:
    fontFamily: Inter
    fontWeight: 400
    fontSize: 0.875rem
    lineHeight: 1.5
    letterSpacing: "0"
  label-sm:
    fontFamily: Inter
    fontWeight: 500
    fontSize: 0.75rem
    lineHeight: 1.4
    letterSpacing: "0.04em"
    textTransform: uppercase
  numeral-xl:
    fontFamily: Manrope
    fontWeight: 800
    fontSize: 3rem
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariantNumeric: tabular-nums
rounded:
  none: "0px"
  sm: "10px"
  md: "18px"
  lg: "28px"
  xl: "40px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  xxl: "64px"
  section: "96px"
  container: "1200px"
  gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: "14px 28px"
  button-primary-hover:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.full}"
    padding: "13px 27px"
    border: "1px solid {colors.border}"
  button-secondary-hover:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    border: "1px solid {colors.primary}"
  input-field:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    placeholderColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: "14px 16px"
    border: "1px solid {colors.border}"
    typography: "{typography.body-md}"
  input-field-focus:
    border: "1px solid {colors.primary}"
    outline: "3px solid rgba(166,247,207,0.32)"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "28px"
    border: "1px solid {colors.border}"
  card-stat:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: "24px"
    border: "1px solid {colors.border}"
  checkbox:
    backgroundColor: "{colors.surface-raised}"
    border: "1px solid {colors.border}"
    rounded: "6px"
    size: "20px"
  checkbox-checked:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  tabs:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.full}"
    padding: "6px"
    border: "1px solid {colors.border}"
  tabs-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
  badge-accent:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
    typography: "{typography.label-sm}"
elevation:
  flat: "none"
  card: "0 18px 40px -28px rgba(0,0,0,0.75)"
  accent-glow: "inset 0 0 0 1px rgba(56,242,161,0.16)"
  focus: "0 0 0 3px rgba(166,247,207,0.32)"
---

## Overview

Verda Finance is the design system for a contemporary neo-bank that treats money as quiet, serious, and a little glamorous. It is built for hero marketing pages, dashboards, account flows, and stat-heavy product surfaces. The dominant feeling is a dimly lit ledger: deep ink-green surfaces, oversized editorial display type, a single electric mint accent doing all the heavy lifting, and softly tilted floating stat cards that read like physical artifacts pinned to a board.

The system should feel **confident, editorial, and product-grade**. It should not feel like a recolored SaaS template, a neumorphic toy, or a glassy crypto landing page. There are no rainbow gradients, no glass blur stacks, no purple-to-pink accents, and no decorative noise textures. Surfaces are intentionally flat; depth is created by stacking three tones of green-ink (Ink → Bark → faint inner mint glow) rather than by drop shadows.

Three traits are non-negotiable: (1) **one accent only** — Mint Voltage carries every primary action and key number; (2) **oversized tight display type** that lets headlines breathe with negative tracking; (3) **the tilted stat card** as the signature artifact — at least one mint-bordered, slightly rotated stat card should appear in any hero composition.

## Colors

The palette is engineered around a single hero accent on a layered ink-green substrate. Body backgrounds (Ink) and raised surfaces (Bark) differ by about six luminance steps so cards lift without needing shadows. Borders are a Moss hairline at one pixel — never thick brutalist outlines.

| Token | Name | Hex | Role |
| ----- | ---- | --- | ---- |
| `surface` | Ink | `#0B1410` | Primary page background, base canvas. |
| `surface-raised` | Bark | `#13201A` | Cards, panels, raised tab strips, inputs. |
| `border` | Moss | `#1F3128` | Hairline dividers and 1px card outlines. |
| `primary` | Mint Voltage | `#38F2A1` | CTAs, key numerals, focus accents, inline highlight pill. |
| `secondary` | Spring | `#A6F7CF` | Soft halos, hover lighten, focus ring. |
| `on-surface` | Cream | `#E8F2EC` | Primary text on dark backgrounds. |
| `neutral` | Sage | `#8AA39A` | Muted body, captions, partner-logo strip. |
| `on-primary` | Charcoal Ink | `#06241A` | Text and icons that sit on top of Mint Voltage. |

Rules:

- Never use pure `#000` or pure `#FFF`. Every neutral has a green undertone so the palette stays coherent.
- An accent fill always pairs with Charcoal Ink text. Do not place white text on Mint Voltage.
- Do not introduce a second accent hue (no blue, purple, orange, or red brand color). The only "error" red is reserved for genuine validation errors and never appears decoratively.
- Spring is for *light touches*: focus halos, hover lighten on the primary button, and the inner glow of stat cards. It is not a body color.

## Typography

Verda uses two free Google Fonts:

- **Manrope** at weights 700 and 800 for display headings, hero copy, and the oversized tabular numerals in stat cards.
- **Inter** at weights 400 and 500 for body copy, nav links, button labels, captions, and form controls.

Display type is oversized and tight. The hero headline runs at `clamp(3rem, 6vw, 4.75rem)` with `-0.03em` tracking and a `1.04` line height. Body text stays neutral and readable at `1rem / 1.55`. Stat numerals use Manrope 800 with `tabular-nums` so columns of figures line up cleanly.

A signature pattern is the **inline highlight pill**: inside a long display heading, wrap a short key phrase (typically the noun being sold) in a Mint Voltage pill with Charcoal Ink text. This pill uses a pill radius (`999px`), tight padding, and keeps the same Manrope 800 weight as the surrounding heading.

Labels above stats are Inter 500 uppercase with `0.04em` tracking, set in Sage. Do not place these label/kicker lines directly above an `h1` or `h2` — lead with the heading itself.

## Layout

Pages are organized as **wide editorial sections** stacked vertically with deliberate breathing room. The container max-width is `1200px` with `24px` gutters. Section vertical padding is `96px` on desktop and tapers to `64px` on mobile. Within a section, content typically uses a single centered column for hero copy, then optional asymmetric flanking artifacts (the tilted stat cards) sitting in the lateral whitespace.

Recommended section patterns:

- **Hero**: centered headline (with optional inline mint highlight pill), one paragraph of Sage body, then a pair of pill buttons (primary + secondary). Place one tilted stat card on each side of the headline using absolute positioning at the section edges so they appear to float into the margin. Decorate the section corners with the `+` plus-mark glyph (2–4 instances per section, never more).
- **Stats row**: a horizontal strip with 3–4 numeric metrics, each metric showing a large Manrope-800 numeral in Cream above a small Sage uppercase label. Use a 1px Moss vertical divider between metrics.
- **Feature grid**: two or three columns of `card` components on a Ink background. Each card has a Lucide icon at top-left, a Manrope 700 headline, and a paragraph in Sage. Cards do not need shadows — the Bark fill against Ink already lifts them.
- **Logo strip**: a centered row of monochrome partner wordmarks rendered in Sage at 60% opacity beneath the hero, separated by `40px` gaps.
- **CTA band**: a wide Bark surface with a tight headline and a single Mint Voltage pill button, framed by hairline Moss borders.

Below `720px` the page collapses to a single column; tilted stat cards drop to non-rotated cards stacked below the hero copy. Buttons stay pill-shaped but go full-width.

Asymmetric placement is preferred over rigid 12-column grids. The system reads as **editorial layout, not dashboard chrome**. Whitespace is generous; do not compact sections to fit more.

## Elevation & Depth

Verda is **mostly flat**. Depth is built from three tonal layers — Ink (background), Bark (raised surface), and a faint inner mint glow on hero stat cards. Avoid:

- Drop shadows under buttons or cards (only the tilted hero stat cards may use a barely-there `0 18px 40px -28px rgba(0,0,0,0.75)`).
- Inner shadows or beveled edges of any kind.
- Glass blur or backdrop-filter.

Approved depth tokens:

- `--shadow-card`: extremely soft, for hero stat cards only.
- `--shadow-accent-glow`: `inset 0 0 0 1px rgba(56,242,161,0.16)` — used as a mint inner ring on hover state of primary CTAs and on signature stat cards.
- `--shadow-focus`: `0 0 0 3px rgba(166,247,207,0.32)` — a Spring halo applied on `:focus-visible` for every interactive control.

## Shapes

Radii are generous and consistent.

- `sm` (10px): chips, input fields, small badges.
- `md` (18px): secondary buttons (when not pill), small icon tiles, logo lockups.
- `lg` (28px): cards, panels, content blocks.
- `xl` (40px): the oversized signature stat cards and hero illustrations.
- `full` (999px): pill buttons, nav pills, tags, inline highlight pill.

Border weight is always 1px. There are no thicker brutalist outlines anywhere in the system.

A recurring ornament is the **plus-mark glyph** (`+`), drawn as a 28px square with a 2px Moss stroke. Use it as a decorative scatter element around hero corners and section breaks — at most 2 to 4 per section. It echoes "addition" and "growth" without leaning on illustrative metaphor.

The **signature artifact** is the tilted floating stat card: a 28–40px-radius Bark card with a tiny Sage label at the top, a tabular Manrope-800 numeral as the centerpiece, and an optional thin sparkline strip. Two instances appear in any hero composition — one rotated about -3° on the left, one rotated about +3° on the right. Both use the Mint inner glow.

## Components

All component classes are defined in `output/css/system.css` and should be linked via `../css/system.css` from HTML pages.

- **`.vf-btn` / `.vf-btn--primary`**: Pill primary button. Mint Voltage fill, Charcoal Ink label, no border, 14×28px padding, Manrope 700 1rem. Hover lightens fill toward Spring. Focus shows the Spring halo.
- **`.vf-btn--secondary`**: Pill secondary button. Transparent fill, Cream label, 1px Moss border. Hover swaps the border to Mint Voltage and the label to Mint Voltage. No fill change.
- **`.vf-input`**: Dark-on-dark text input. Bark fill, Moss border, Cream text, Sage placeholder, 10px radius, 14×16px padding. Focus replaces the border with Mint Voltage and adds the Spring halo.
- **`.vf-card`**: 28px radius, Bark surface, 1px Moss border, 28px padding. No shadow by default.
- **`.vf-card--stat`**: 40px radius variant for hero stat cards. Adds the accent-glow inner ring. Supports `.vf-card--tilt-left` and `.vf-card--tilt-right` modifiers for the signature ±3° rotation.
- **`.vf-checkbox`**: 20px square with 6px radius. Unchecked is Bark fill with Moss border. Checked fills Mint Voltage with a Charcoal Ink check glyph. Focus halo applies.
- **`.vf-tabs`**: Pill tab group on a Bark background. Active tab is solid Mint Voltage with Charcoal Ink. Inactive tabs are Cream text with no fill. Hover lightens inactive labels to Spring. **Never** use underline tabs.
- **`.vf-badge`**: Pill chip used for tags, status, and the inline mint highlight in headings.
- **`.vf-divider`**: 1px Moss vertical or horizontal line for separating stat row items and section bands.
- **`.vf-stat`**: Inline stat block — large Manrope-800 numeral in Cream above a small Sage uppercase label.
- **`.vf-plus`**: The plus-mark decorative glyph (an SVG/CSS `+` with 2px Moss stroke).

Icon library: **Lucide** (https://lucide.dev/, ISC license). Render icons at 18–24px with a 1.5px outline using `currentColor`. Use Lucide for nav, feature cards, button leading/trailing glyphs, and inline data icons. Do not mix in other icon families.

Accessibility:

- All interactive elements expose a `:focus-visible` state with the Spring halo (`--shadow-focus`).
- Body text on Ink (`#E8F2EC` on `#0B1410`) and on Bark (`#E8F2EC` on `#13201A`) both exceed WCAG AA for normal text.
- Mint Voltage on Bark passes AA for large text and graphical objects; when used for small body text, switch to Cream.
- Accent fills always pair with Charcoal Ink — never white — to preserve contrast on Mint.

## Do's and Don'ts

**Do**

- Use Mint Voltage as the single accent across the entire system — for primary CTAs, key numerals, inline highlights, and focus rings.
- Layer Ink → Bark → mint inner glow to build depth without shadows.
- Lead sections with the heading itself; let the headline carry the section.
- Apply the inline highlight pill to a single key phrase inside a long display heading, not to multiple phrases.
- Tilt stat cards by exactly ±3° in hero compositions; keep them flat everywhere else.
- Use generous whitespace and large display type — sections should feel airy, not packed.
- Use the plus-mark glyph sparingly (2–4 per section) as a decorative anchor near hero corners.

**Don't**

- Do not introduce a second accent hue or rainbow gradients.
- Do not use drop shadows under regular cards or buttons. Only the tilted hero stat cards may carry the soft `--shadow-card`.
- Do not place an eyebrow, kicker, category label, or all-caps small-caps line directly above an `h1` or `h2`.
- Do not use underline tabs. Tabs are pill-shaped with a solid Mint Voltage active state.
- Do not use pure `#000` or pure `#FFF`. Every neutral is green-tinted.
- Do not place white text on Mint Voltage. Mint always carries Charcoal Ink.
- Do not use glass blur, neumorphism, paper grain, or noise textures.
- Do not mix icon libraries; use Lucide only.
- Do not center every section or use rigid 12-column grids everywhere; the system leans editorial and slightly asymmetric.
