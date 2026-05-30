# Right Rail v2 — Restructure Spec (2026-05-01)

## What's wrong with the current rail

Per the audit (50 sections across 6 tabs, ~7000 lines):

1. **Duplicate "Model Guidance"** panels (Investor + Analysis tabs ship the same `predictionContract` content twice)
2. **Three large dead blocks** still in source (`{false && ...}`)
3. **Zero design system usage** — 100% legacy Tailwind / inline styles, so the rail looks visually distinct from the rest of the v2-refreshed surfaces
4. **Vertical weight** — Technicals tab alone has 8 sections, several of which are dense narrative blocks
5. **Tab fragmentation** — same data visible in Analysis "Model Intelligence" and Model tab; same `predictionContract` in Investor + Analysis
6. **No clear hierarchy** — every section uses the same visual weight; eye doesn't know where to land first

## Design v2 principles

- **One eye-magnet per scroll** — Hero card up top, rest are equal-weight panels below
- **Inspiration 4 sectioning** — each panel is its own ds-glass card with title + optional action; gap between panels carries the rhythm
- **Tabs reduced from 6 → 4**: **Snapshot** / **Setup** / **Technicals** / **History** (consolidates Investor + Analysis into "Snapshot" + "Setup", merges Model tab content into "Setup", merges Journey + Trades into "History")
- **Numbers as headlines** — every panel has at most 2-3 hero numbers; rest is supporting context
- **Sparkline as wash** — every panel that holds price history shows a faded sparkline beneath the headline number
- **Voice consistency** — captions are uppercase tracked; values are JBM tabular-nums; secondary text is muted body

## v2 rail structure

```
┌─────────────────────────────────────────┐
│ STICKY HEADER (always visible)          │
│  · Ticker + direction badge             │
│  · Live price (admin) + day change      │
│  · Tab nav (4 tabs, ds-tab pattern)     │
└─────────────────────────────────────────┘

  ── Snapshot tab (default) ──────────────
  [Hero Card]                              ← Inspiration 5: logo + symbol + price + change + faded sparkline + GG indicator
  [Conviction Panel]                       ← Spider chart (Inspiration 3) + 3 ds-metric tiles (Rank / Score / Conviction)
  [Today Panel]                            ← intraday performance: ATR levels, prev close, today range, regime chip
  [Model Guidance Panel]                   ← predictionContract — single source, no duplicate
  [Position Panel]                         ← only when open trade: entry / current / P&L / SL / TP / R:R as ds-metric grid

  ── Setup tab ───────────────────────────
  [Setup Header]                           ← setup name + grade + entry path + thesis
  [Risk & Targets]                         ← entry / SL / TPs / R:R as 4-col ds-metric grid; mini chart with overlays
  [Trade Plan]                             ← invalidation, TP rules, position sizing
  [Profile Panel]                          ← ticker personality + behavior type + ATR/vol stats
  [Sector & Market]                        ← sector signal + market regime + breadth context

  ── Technicals tab ──────────────────────
  [Multi-TF Stack]                         ← single dense table: TF rows × indicator cols (EMA / ATR / RSI / Squeeze / Phase / VWAP)
  [TD & Divergence]                        ← TD9/13 sequential + RSI/phase divergence in one consolidated panel
  [Patterns & Clouds]                      ← detected patterns + EMA cloud states
  [Fundamentals]                           ← only if data; PE/PEG/EPS growth + valuation signal

  ── History tab ─────────────────────────
  [Journey Timeline]                       ← scoring timeline (per Inspiration 3 social-platform style)
  [Trade Ledger]                           ← past trades on this ticker
  [Performance vs Market]                  ← rs1m/3m/6m bars
```

## Mapping current sections → v2 panels

| Current section | New location |
|---|---|
| Sticky ticker + direction | Sticky header (kept) |
| Sticky live price (admin) | Sticky header (kept, but consolidated into single line) |
| Entry stats since entry | Position Panel (Snapshot) |
| Groups / ingest age / stage badges | Sticky header (kept, simplified) |
| Tab row (6 tabs) | Tab row (4 tabs) |
| Investor identity + score | Snapshot Hero Card |
| Investor SignalRadar | Conviction Panel (Snapshot) |
| Investor Model Guidance | Model Guidance Panel (Snapshot) — single source |
| Investor stage + hints | Position Panel (Snapshot) |
| Investor Score Breakdown | Conviction Panel (Snapshot) — collapsed by default |
| Performance vs Market | History tab |
| Buy Zone | Position Panel (Snapshot) |
| Investment Thesis | Model Guidance Panel (Snapshot) |
| Analysis Context (company card) | Snapshot Hero Card (logo + name) |
| Prime Setup banner | Sticky header chip |
| Analysis SignalRadar | Conviction Panel (Snapshot) — same as Investor |
| Analysis Model Guidance | **DELETE** (duplicate of Investor's; Snapshot tab carries the one) |
| Mini Chart | Risk & Targets (Setup tab) |
| Regime | Today Panel (Snapshot) |
| Profile | Profile Panel (Setup tab) |
| Model Intelligence (Analysis) | Sector & Market panel (Setup tab) — merged with Model tab content |
| Trend Alignment | Multi-TF Stack (Technicals) |
| Swing Analysis | Profile Panel (Setup tab) |
| AI CIO Review | Position Panel (Snapshot) — only when blocked |
| Momentum Elite | Conviction Panel (Snapshot) |
| Rank | Conviction Panel (Snapshot) |
| Score | Conviction Panel (Snapshot) |
| Conviction | Conviction Panel (Snapshot) |
| Score Breakdown | Conviction Panel (Snapshot) — accordion |
| Bubble Chart mini | Conviction Panel (Snapshot) — replaces with spider |
| Current Position (state, horizon) | Today Panel (Snapshot) |
| TD Sequential | TD & Divergence (Technicals) |
| Triggers | TD & Divergence (Technicals) |
| Timeframe Analysis | Multi-TF Stack (Technicals) |
| RSI & Divergence | TD & Divergence (Technicals) |
| Detected Patterns | Patterns & Clouds (Technicals) |
| EMA Clouds | Patterns & Clouds (Technicals) |
| Fundamental & Valuation | Fundamentals (Technicals) |
| Trade History | Trade Ledger (History) |
| Model tab | Sector & Market (Setup) |
| Journey Scoring Timeline | Journey Timeline (History) |
| Where Things Stand | Today Panel (Snapshot) |
| Price Performance | Performance vs Market (History) |
| Open in TradingView | Footer (kept) |

**Net**: 50 sections → ~16 panels across 4 tabs. Eliminates 3 dead blocks. Eliminates the Investor/Analysis Model Guidance duplicate. Consolidates Model tab into Setup tab.

## Visual treatment per panel

Every panel uses **ds-glass** as its outer container, with:
- `ds-glass__head` row containing `ds-glass__title` (uppercase tracked caption) + optional action button on the right
- Body padding: `var(--ds-space-4)`
- Gap between panels: `var(--ds-space-3)`

Hero numbers use `ds-metric__value` (32px JBM, tabular-nums).
Captions use `ds-caption`.
Chips use `ds-chip` (with `--accent`/`--up`/`--dn` variants).

## Implementation strategy

1. **Insert new render flow at the top of `TickerDetailRightRail`** (line 1159+) — return v2 layout when `window._dsV2RailEnabled !== false` (default on); fall back to legacy when disabled.
2. **Reuse existing data resolvers** — don't refactor data fetching, just rearrange render output.
3. **Keep helpers (LWChart, SignalRadar, AutopsyChart) unchanged** — these work fine; just wrap them in ds-glass.
4. **Strip the 3 dead `{false && ...}` blocks** entirely.
5. **Recompile shared-right-rail.compiled.js** at the end.

## What "done" looks like

- 4 tabs, ~16 panels, each visually distinct from current rail (matte glass cards, gold accents, JBM numbers)
- Cohesive with the rest of the v2 surfaces (Market Pulse, View tabs, Daily Brief)
- No more duplicate Model Guidance panels
- No dead `{false && ...}` blocks
- Same data, half the visual weight, organized hierarchy
