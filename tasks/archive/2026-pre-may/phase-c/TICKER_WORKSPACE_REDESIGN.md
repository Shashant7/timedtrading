# Ticker Workspace Redesign — Phase 4 Design

**Date:** 2026-05-06
**Status:** Design + Phase 1 implementation plan
**Inspired by:** Edward Tufte's principles (data-ink ratio, small multiples, layering & separation, removing chartjunk)
**User vision:** *"How does this ticker look and what is its near-term trajectory" — for serious desktop users who already hold positions and want our model's read on every ticker, not just ones we're trading.*

---

## Problem

Today, when a user clicks a ticker in the kanban or watchlist:
- The Right Rail slides in at 520-600px wide
- The chart is *inside* the Setup tab, competing with cards for vertical space
- Switching to Snapshot / Technicals / Fundamentals / History **hides the chart**
- Users lose visual context of price action when reading model commentary
- The chart is small, the levels are hard to read, the data-density is poor

The user's mental model is: *"I want to see the chart + levels with the model's read living next to it, not stacked on top of it. Switching tabs should change the analytical lens, not blank the chart."*

This is exactly the model used by Bloomberg Terminal, Stratoshare, and TradingView's chart-with-side-panel layout. It's also the layout pattern the user pointed at via the SNDK Setup screenshot — chart hero + key levels stack — but currently that only renders when you're on the Setup tab.

---

## Solution — Ticker Workspace

A persistent two-pane layout that takes over the viewport when a ticker is selected:

```
┌─────────────────────────────────────────────────────────┬───────────────────────┐
│  Sticky header: SNDK · LONG BIAS · ENTRY WATCH          │  Tab nav (vertical    │
│  $1,406.32  +11.98%   ★  ⤴  ✕                          │  on desktop, horiz    │
├─────────────────────────────────────────────────────────┤  on tablet)           │
│                                                         │                       │
│  CHART HERO (always visible across all tabs)            │  ┌─────────────────┐  │
│   - 60-70% of viewport height                           │  │ SNAPSHOT        │  │
│   - Daily-Brief style: clean candles, no chartjunk      │  │ Today's read    │  │
│   - Right-anchored Y-axis with large readable price     │  │                 │  │
│   - Levels overlaid: PrevClose, ATR fibs, S/R, GG       │  │ ── Active tab ──│  │
│   - Pattern annotations (Double Bottom, etc.)           │  │ SETUP (always)  │  │
│   - Compact OHLC line above chart                       │  │ • Bias          │  │
│   - Timeframe pills: 5m/15m/1H/D                        │  │ • Game Plan     │  │
│                                                         │  │ • Key Levels    │  │
│                                                         │  │   (sortable)    │  │
│                                                         │  │                 │  │
│                                                         │  │ TECHNICALS      │  │
│                                                         │  │ FUNDAMENTALS    │  │
│                                                         │  │ HISTORY         │  │
│                                                         │  │ JOURNEY         │  │
│                                                         │  └─────────────────┘  │
│                                                         │                       │
└─────────────────────────────────────────────────────────┴───────────────────────┘
   Chart pane: flex-1 (~65-70vw on a 1440px display)        Rail pane: 380-420px
```

**Key behavior:** the chart pane never disappears. The rail pane swaps content as the user clicks tabs. Setup-tab content (bias + game plan + levels) is shown by default because it's the most-used analytical lens and the original Setup card was already chart-adjacent.

---

## Layout breakpoints

| Viewport | Behavior |
|---|---|
| `≥ 1440px` (desktop pro) | Workspace mode: chart-hero left (~65vw), rail right (420px) |
| `1024-1440px` (desktop) | Workspace mode: chart-hero left (~60vw), rail right (380px) |
| `768-1024px` (tablet) | Workspace mode: chart-hero top, rail below (vertical stack), tabs become horizontal |
| `< 768px` (mobile) | Current behavior: rail-only modal slide-in (preserves existing UX) |

The user asked for "serious desktop deserves serious presentation." Mobile keeps the existing slide-in rail behavior so we don't regress that surface.

---

## Tufte principles applied per tab

Tufte's core ideas applied to a trading dashboard:
1. **Maximize data-ink** — every pixel should carry information. Strip decorative borders, gradients, padding excess.
2. **Erase non-data ink** — no shadow effects, no decorative chips, no gradient fills behind numbers.
3. **Small multiples** — rather than a single chart with many indicators piled on, use 4-6 small clear charts each showing one thing.
4. **Layering & separation** — when annotations cross each other, use opacity/weight not bright colors.
5. **Show comparison** — every data point should be relative to a reference (yesterday, peer, sector, model expectation).

### Snapshot tab (Tuftefied)

**Today**: a one-line bias sentence + 3-4 chips (regime, state, stage). No card chrome.

**Model Guidance**: a single sparkline showing the model's bias evolution over the last N hours, with current direction + invalidation level inline. Replace the current 3-section "Strengths / Watch / Invalidations" block with:
- One sentence: *"LONG bias holds while above $1,346.42. Above $1,443.34 unlocks $1,503 next."*
- Below: a compact spider chart (already exists) showing the 6 dimensions

**Conviction**: replace the 3 separate Rank/Score/Conviction tiles with a **small multiple** — 3 horizontal sparklines stacked, each 20px tall, showing the metric's evolution over the last 30 days. Below: today's value + percentile vs the ticker's own 90-day distribution. This tells you both *how strong is conviction* and *is conviction unusually strong*.

**Position** (only when held): a single tile with shares/notional/% of acct + entry vs current line, color-banded by SL ↔ TP zones.

### Setup tab (always-visible default)

**Bias card**: one sentence, one direction chip, one invalidation price.

**Game Plan**: 2 rows, structured as `[Trigger price] → [Target price] (+x.xx%)` for bull and bear scenarios. Each row shows a tiny inline chart of the last 5 days.

**Key Levels table**: the existing levels table is good, but Tuftefy:
- Right-justify all prices for tabular alignment
- Add a tiny "distance bar" between each level and current price (small horizontal bar from 0 to 5% width = 0%-100% distance)
- Replace the bright LONG/SHORT chips with weighted typography (heavier for support, lighter for distant)
- Group by source: 52W / PDZ / Pivots / Swings / ATR fibs (already done somewhat)

### Technicals tab

Currently mostly empty for many tickers. Tufteify:
- **EMA stack**: replace the colored bars with a small multiples grid — one mini-line per timeframe (3m/15m/30m/1H/4H/D/W) showing EMA-21 vs price ratio. Spot trends across timeframes at a glance.
- **RSI/Stoch/MACD**: 3 small charts side by side, each ~80px tall, showing the last 30 bars with the indicator value.
- **Volume profile**: small horizontal histogram on the right side of the chart pane (this lives in the chart, not the tab)
- **Single sentence summary**: "Daily/4H/1H all bullish. 30m bearish. 1m noise."

### Fundamentals tab

Already decent. Tufteify:
- The earnings table can become a small-multiples grid: 8 quarters, each shown as a tiny bar chart of estimate vs actual EPS, with surprise % below
- Replace P/E + Forward P/E + Margin tiles with a small dot-plot showing each metric vs sector median + S&P 500 median (3 dots per row)

### History tab

Should be the killer tab and barely is. Replace with:
- **Trade timeline strip**: horizontal swimlane of past trades with this ticker — entry+exit candles + PnL color
- **Win/loss anatomy**: small multiples — for each past trade, a 6-bar mini-chart showing the candles around entry, with entry/exit markers
- **What worked / what didn't**: aggregated stats — "On this ticker: 11 trades, 73% WR, +$4,034. Best setup: Gap Reversal Long (n=8, 88% WR). Worst: N-Test Support (n=3, 33% WR)."

### Journey tab (currently exists in some pages)

Best understood as a Tufte slope chart: the trade's MFE/MAE/PnL evolution over its hold period, with annotations for every system event (TP hit, trim, defend, exit reason).

---

## Phase 1 (this commit) — what ships now

Time-boxed to the "highest user-visible win" subset:

1. **New layout shell** — `TickerWorkspace` component that renders chart-hero left + rail right when viewport ≥ 1024px and a ticker is selected.
2. **Chart pane is persistent** — chart lives in the chart pane, NOT inside the Setup tab. Switching tabs changes what's in the rail, not what's in the chart pane.
3. **Setup tab content is the default rail content** — bias + game plan + levels are always visible to the right of the chart.
4. **Mobile preserves existing slide-in modal** behavior unchanged.

Phase 1 explicitly **does not** Tuftefy the per-tab content — that's Phase 2 work. Phase 1 is the architectural change (chart out of tab body, into persistent pane).

---

## Phase 2 (next session) — Tufte polish per tab

Sequence in order of user impact:

1. **Snapshot tab — Tuftefy** (sparklines, percentile distributions, bias-evolution micro-chart). Highest ROI; this is the tab most users land on.
2. **History tab — rewrite** (trade-timeline swimlane, per-trade small multiples). Currently the weakest tab; biggest delta possible.
3. **Technicals tab — small multiples grid** for EMA stack across timeframes.
4. **Setup tab — distance bars on levels, sentence-style game plan**.
5. **Fundamentals tab — EPS surprise small multiples + sector dot-plots**.

---

## Implementation notes for Phase 1

### Files touched

- `react-app/index-react.source.html` — replace the right-rail mount block with a `TickerWorkspace` shell that switches between modal-mode (mobile) and workspace-mode (desktop ≥ 1024px).
- `react-app/shared-right-rail.js` — extract the chart-rendering subtree into a separate `TickerChartPane` component callable from outside the rail. The rail's Setup tab body keeps a placeholder note ("chart shown to the left") on desktop and renders the chart inline on mobile.

### State sharing

The chart and the rail both need:
- `chartTf` (selected timeframe) — currently lives inside the rail; needs to be lifted to the workspace shell so it persists when the user clicks tab buttons in the rail.
- `chartCandles` (loaded candle data) — same; lift to workspace shell.
- `levels` (the canonical scenario levels we wired in P0.7.72) — chart pane reads from the same `_rrFetchChartLevels` cache; rail tabs read from it for the Levels card.

### Risk: breaking mobile

Solution: gate the entire workspace-mode layout behind `viewport >= 1024px`. Below that, keep the existing modal+rail behavior pixel-for-pixel.

### Rough effort

- Phase 1 shell + state lift: contained — touches 2 files, ~200 net lines.
- Tab content unchanged; just rendered on the right side instead of below the chart.
- Mobile path unchanged.

This is small enough to ship in a single focused session. Phase 2 (Tufte polish) is a per-tab sweep that can be parallelized across multiple sessions.

---

## Open questions for user

1. **Default rail tab.** Setup makes sense. Confirm?
2. **Chart-pane height.** ~70vh on desktop seems right. Should it be user-resizable (drag handle)?
3. **Tab position.** Vertical tabs on the right (like VS Code activity bar) or horizontal across the top of the rail? Vertical saves vertical space but requires icons; horizontal is clearer but eats one row.
4. **History tab investment.** This is the tab with the most upside but biggest rebuild. Is it worth a focused session of its own?
5. **Tuftefy aggressiveness.** Some users like dense data (Bloomberg-style). Some prefer minimal whitespace + breathing room. Where on the spectrum should we land?
