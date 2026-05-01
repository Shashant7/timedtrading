# Design System v2 — Spec (2026-05-01)

> **Goal**: every user touchpoint feels cut from the same cloth. That cloth is **legit, expensive, unique**.
>
> **Audience**: a retail investor who needs to feel they are looking at a serious financial-desk tool, not "another crypto trading app."
>
> **Inspiration set**: 5 Dribbble references. Composite design language extracted below.

## Voice & feel — the one-line brief

> Quiet authority. Numbers and direction lead. Color is rare and meaningful. Surfaces are matte, slightly warm, with restrained gold accent.

Anti-patterns we explicitly reject:
- Cyan/blue-everywhere (the 2024 fintech trope)
- Bright neon
- Heavy borders / cards with pronounced strokes
- Emoji-as-decoration (only as semantic stage indicators)
- Stacked full-strength colored chips competing for attention

## 1 · Palette

### Tier 1 — Backgrounds (5 levels, all slightly warm)

| Token | Value | Usage |
|---|---|---|
| `--ds-bg-canvas` | `#0A0D11` | Page background — slightly warmer than pure black |
| `--ds-bg-surface` | `#13171D` | Default card / panel |
| `--ds-bg-surface-hi` | `#1A1F26` | Elevated card / hover |
| `--ds-bg-glass` | `rgba(255, 255, 255, 0.04)` | Frosted overlays (Inspiration 4) |
| `--ds-bg-glass-hi` | `rgba(255, 255, 255, 0.07)` | Hovered glass |

### Tier 2 — Text (4 levels)

| Token | Value | Usage |
|---|---|---|
| `--ds-text-display` | `#F4F5F7` | Hero numbers, page titles |
| `--ds-text-body` | `#D8DCE3` | Body, labels-with-emphasis |
| `--ds-text-muted` | `#8C92A0` | Secondary metadata, axis labels |
| `--ds-text-faint` | `#5C6270` | Dividers-as-type, placeholders |

### Tier 3 — Accent (the unique one)

| Token | Value | Usage |
|---|---|---|
| `--ds-accent` | `#F5C25C` | **Primary gold** — hero numbers, primary CTA, focused selection, brand mark |
| `--ds-accent-hi` | `#FFD27A` | Hovered gold |
| `--ds-accent-soft` | `#E0B265` | Sparklines / mini-bars in primary contexts |
| `--ds-accent-dim` | `rgba(245, 194, 92, 0.14)` | Selected-row tint, focused chip bg |
| `--ds-accent-glow` | `rgba(245, 194, 92, 0.40)` | Subtle outer glow on active CTA |

### Tier 4 — Direction (greens / reds, restrained)

| Token | Value | Usage |
|---|---|---|
| `--ds-up` | `#22C55E` | Up direction text |
| `--ds-up-soft` | `#34D399` | Up sparkline stroke |
| `--ds-up-bg` | `rgba(34, 197, 94, 0.10)` | Up chip background |
| `--ds-dn` | `#F43F5E` | Down direction text |
| `--ds-dn-soft` | `#FB7185` | Down sparkline stroke |
| `--ds-dn-bg` | `rgba(244, 63, 94, 0.10)` | Down chip background |
| `--ds-flat` | `#9CA3AF` | Flat / neutral |

### Tier 5 — Semantic accents (used sparingly)

| Token | Value | Usage |
|---|---|---|
| `--ds-info` | `#60A5FA` | Info badges — neutral data callouts only |
| `--ds-warn` | `#F59E0B` | Risk / defensive states (kanban Defend, etc.) |
| `--ds-violet` | `#A78BFA` | Personality VOLATILE_RUNNER, editorial accents |

### Tier 6 — Strokes & dividers

| Token | Value | Usage |
|---|---|---|
| `--ds-stroke-soft` | `rgba(255, 255, 255, 0.04)` | Cell separators, dividers-as-type |
| `--ds-stroke` | `rgba(255, 255, 255, 0.08)` | Card borders |
| `--ds-stroke-hi` | `rgba(255, 255, 255, 0.14)` | Hovered / focused card |

## 2 · Typography (3 families, 6 sizes, no exceptions)

| Family | Used for |
|---|---|
| **Inter** | All UI chrome, labels, body text |
| **JetBrains Mono** (tabular-nums) | Every numeric value (price, %, score, ATR, qty) |
| **Instrument Serif** (italic optional) | Editorial: brief headlines, callouts, "you're looking at" prose |

| Size token | px | Usage |
|---|---:|---|
| `--ds-fs-caption` | 10 | All-caps tracked labels (uppercase) |
| `--ds-fs-meta` | 11 | Secondary metadata, axis ticks |
| `--ds-fs-body` | 13 | Body text, table cells |
| `--ds-fs-emph` | 15 | Sub-section heads, ticker symbol on cards |
| `--ds-fs-h2` | 22 | Section heads |
| `--ds-fs-hero` | 32 | Hero numbers (price, P&L) |
| `--ds-fs-mega` | 44 | Daily Brief master figure (rare) |

## 3 · Components — the shared 6

Every surface in the app composes from these 6 building blocks. Each lives in `react-app/ds-components.js` as a factory pattern (works in both vanilla pages and React-mounted ones).

### `<DsCard>` — the universal container
- bg: `--ds-bg-surface`
- border: 1px `--ds-stroke`
- radius: 14px
- padding: 16px
- variants: `glass` (uses `--ds-bg-glass`), `interactive` (hover lifts to `--ds-bg-surface-hi` + `--ds-stroke-hi`)

### `<DsTickerCard>` — Inspiration 2 + 5 fusion
The unified ticker representation. Replaces every "ticker chip", "kanban card", and "viewport card" with one consistent visual:

```
┌─────────────────────────────────┐
│ [logo] TICKER  ◦ Personality    │ ← row 1: 28x28 logo + ticker (15px JBM bold) + small status pill
│ ─────────                        │
│  $123.45                        │ ← row 2: HUGE price (22-32px JBM, depends on density)
│  +1.34%  ▲                       │ ← row 3: change% in tinted color, tiny direction arrow
│ ╲ ╱╲╱╲ ↗                          │ ← row 4: faded sparkline (fill 16% opacity, stroke 55%)
└─────────────────────────────────┘
```

Three densities:
- `compact` (Kanban lane card): 240×88px, smaller logo (20px), price 18px
- `default` (Viewport / Market Pulse): 280×120px, logo 24px, price 22px
- `hero` (Bubble Map selected card / Daily Brief feature): 320×160px, logo 32px, price 32px

### `<DsMetricTile>` — Inspiration 1 trading-objectives row
For "Trading Objectives" / hero KPI rows (Daily Brief, Trades page, Right Rail score panel):

```
┌─────────────────────┐
│ TRADES   ⓘ          │ ← caption (10px tracked, muted)
│  68      +5.2%      │ ← hero number (32px JBM) + tiny delta chip
│  ▁▂▄▃▅▆▇▆▅          │ ← optional 8-bar mini sparkline (gold, faded)
└─────────────────────┘
```

Variants: `kpi` (number-only), `with-spark` (adds bars), `with-pill` (adds direction chip), `with-icon` (replaces caption with semantic icon).

### `<DsSparkline>` — the faded data underlayer
- Stroke 1.5px in `--ds-up-soft` / `--ds-dn-soft` / `--ds-spark-flat-stroke`
- Filled area below stroke, 16% opacity of same color
- Always sits behind text (z-index −1 within card) at low contrast
- Sizes: `mini` (40×16), `default` (96×24), `wide` (160×32), `card-bg` (full-card-width × 50)

### `<DsChip>` / `<DsChipGroup>` — chips, pills, segmented controls
One element type, three flavors:
- `solid` — colored background tint, no border (used for direction chips)
- `outline` — transparent bg, 1px `--ds-stroke` border (used for filter pills)
- `accent` — gold-soft selected state (used for active filter, focused tab)

Sizes: `sm` (caption, 18px height), `md` (body, 24px), `lg` (emph, 28px).

### `<DsGlassPanel>` — the right-rail section divider
Per Inspiration 4: each rail section is its own glass-tinted card with its own header row, no inter-section borders, generous internal padding (`--ds-space-4`).

### `<DsSpiderChart>` — Inspiration 3 spider
- Single solid muted-purple-gray fill (`rgba(167, 139, 250, 0.18)`)
- No grid lines beyond the outer pentagon edges
- Vertex labels in caption type, muted color
- Outer ring: 1px `--ds-stroke-hi` solid

## 4 · Surface-by-surface application matrix

| Surface | DsCard | DsTickerCard | DsMetricTile | DsSparkline | DsChip | DsGlassPanel | DsSpider |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Market Pulse top band | ✓ | ✓ (default) | — | ✓ (mini, in card) | — | — | — |
| Top Movers | ✓ | — | ✓ (kpi-no-spark, RTH/EXT) | — | — | — | — |
| Bubble Map controls | — | — | — | — | ✓ (outline+accent for filter pills) | — | — |
| Bubble Map legend | — | — | — | — | ✓ (sm) | — | — |
| Viewport (left rail) | ✓ | ✓ (compact, no spark) | — | — | — | — | — |
| Active Trader Kanban cards | ✓ | ✓ (compact, with mini spark) | — | ✓ (mini) | — | — | — |
| Active Trader lane labels | — | — | — | — | ✓ (md, accent-tinted per stage) | — | — |
| Right Rail | — | — | ✓ (KPI panel: rank, conviction, R:R) | ✓ (wide, in price chart panel) | ✓ (sm) | ✓ (per section) | ✓ |
| Daily Brief — hero metrics | — | — | ✓ (with-spark, large) | — | — | — | — |
| Daily Brief — index cards | ✓ (glass) | ✓ (default with sparkline + GG bars) | — | ✓ (card-bg) | ✓ (sm for prob badge) | — | — |
| Daily Brief — Game Plan | ✓ | — | — | — | ✓ (sm, direction-colored) | — | — |
| Trades — Monthly Performance | — | — | ✓ (kpi grid) | — | — | — | — |
| Trades — P&L Calendar | ✓ | — | — | — | — | — | — |
| Tab segments (Analysis / Active Trader / etc.) | — | — | — | — | ✓ (lg, accent on active) | — | — |

The matrix doubles as a checklist: every cell with a ✓ must use that component (not a one-off implementation).

## 5 · Motion

Two rules:
1. **Snappy by default** — `--ds-dur-fast` (160ms) `--ds-ease-out` for hovers, focus, expand/collapse.
2. **The one slow gesture** — price-update flash (600ms decay from `--ds-accent-glow` to transparent) is the ONLY animation longer than 200ms. It earns its time because it conveys real-time freshness.

Explicitly NO: card entrance animations on page load, parallax, tooltip fade-ins longer than 80ms, decorative loops.

## 6 · Cohesion enforcement (the hard part)

- **All inline `style={{ background: "rgba(...)" }}` and color hex codes in JSX get replaced with token references**. Component PRs that use one-off colors get rejected.
- **No new chip / card / button rolled by hand.** Use Ds*. If something doesn't fit, propose a new variant on the existing component, not a new component.
- **Single tailwind layer for spacing**. The 8-step DS spacing scale maps to tailwind's spacing units 1-8. No arbitrary `p-[13px]`.
- **One ticker-logo provider** (`ds-ticker-logo.js`) — falls back to a colored monogram tile if no logo is available. All surfaces import the same provider; no per-surface `<img>` tags.

## 7 · Build & deploy

- v2 tokens land in `react-app/tt-tokens.css` (no new file — append to keep the cascade simple). Existing `--tt-*` tokens stay as legacy aliases.
- v2 components ship in `react-app/ds-components.js` (new file). Vanilla DOM-creator factory pattern + thin React wrappers.
- Apply surface-by-surface in this order: Market Pulse → Top Movers → Bubble Map controls → Viewport cards → Kanban cards → Right Rail → Daily Brief → Trades.
- Each surface is one commit. Each commit has a screenshot reference in the body.
- Final commit rebuilds `react-app-dist/` and pushes; Cloudflare Pages auto-deploys.

## 8 · What "done" looks like

A single screenshot of *any* page should obviously belong to the same product as a screenshot of any other page. The eye should land on hero numbers first; secondary metadata second; sparklines / decoration last. Gold appears at most once per visible region. No two adjacent components have identical visual weight.
