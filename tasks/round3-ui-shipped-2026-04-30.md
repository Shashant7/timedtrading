# Round 3 UI — shipped 2026-04-30 (PR #49, P0.7.42 + P0.7.43)

## TL;DR

Round 3 UI work landed in branch `cursor/round3-ui-relaunch-2e87` → PR #49.
Display-layer changes only; engine entry/exit logic untouched. UI changes were
deployed via Cloudflare Pages preview; production cutover is the merge.

Preview URLs (auto-built per push):
- Branch: <https://cursor-round3-ui-relaunch-2e.timedtrading.pages.dev/>
- Pinned commit: <https://eeb1fa17.timedtrading.pages.dev/>

## What shipped

### Daily Brief (P0.7.42)

- **Day-Gate close-probability heuristic** — combines distance-to-target +
  ATR-used + session elapsed; surfaced as `HIGH/MODERATE/LOW` with %.
- **Multi-day (Weekly) ATR Levels** — 5-day TR ATR anchored to start-of-week,
  parallel structure to `atrFibLevels`. Brief sees both day and swing context.
- **Week-Gate close-probability** — blends ATR-used + days-remaining-this-week.
- **Index card** — stacked Day-Gate + Week-Gate bars with prob % and
  color tier (green/amber/grey) on each gate.
- **Game Plan triggers card** — per-index visual bull/bear `trigger → target`
  rows with %change pill on the right.
- **Sectors heatmap** — grouped by theme (Risk-On/Cyclical, Defensive/Yield,
  Energy/Materials) with per-group avg %chg badges and intensity-scaled
  coloring for at-a-glance breadth read.
- **LLM prompt** — new "Golden Gate Status" + "Multi-Day ATR Levels" sections
  so prose surfaces both views.
- **Catalyst chips** — bigger font, bold ticker symbol, more padding.
- **MiniChart header** — real-time SPY/QQQ/IWM/VIX price polling
  (15s during RTH, 60s otherwise) replaces stale prev-close.
- **Earnings Watch** — TwelveData fallback for non-universe tickers
  ("$data unavailable" gone).

Files: `worker/daily-brief.js`, `react-app/daily-brief.html`.

### Bubble Map / Analysis View (P0.7.43)

- **Default filter = Focus** (Kanban + Market Pulse + Saved + open trades).
  localStorage-persisted user override (key: `tt_bubble_active_insight`).
  Per user: "by default, we should select a filter that doesn't clutter the
  bubble map with everything, but something more actionable."
- **Tabular filter pills** regrouped into rows: Focus / Now / Setups /
  Momentum / Structure / Context. Each row has a fixed-width left label and
  horizontally-scrolling chips. Cohesive with the Market Pulse pill pattern.
- **"How is this scored?" tooltip** on the legend explains HTF/LTF blends,
  R:R × upside-left sizing, conviction-tier bump, pulse-glow trigger.
  Y/X/size axis labels are now color-keyed (green / cyan / amber).
- **Conviction-tier bubble bump** — bubble radius adds A +1.5, B +0.8,
  C +0.3 so size reflects setup quality, not just R:R + completion.

Files: `react-app/index-react.source.html` (`computeBubbleRadiusModel`,
`insightChips` useMemo, render block ~lines 19140-19260).

### Tab Badges — View segmented control (P0.7.43)

- **Active Trader** — live count (actionable + hold) + amber pulsing dot
  when actionable count > 0 (enter/trim/defend/exit). Hover-title explains
  the breakdown.
- **Investor** — live count of ETF + saved + long-term tickers.
- **All** — total tickers in scope.

Files: `react-app/index-react.source.html` (~lines 12580-12608, 18510-18585).

### Kanban Polish (P0.7.43)

- Per-lane vertical accent bar with semantic colors:
  - Setup: violet
  - In Review: amber
  - Initiated: cyan
  - Hold: green
  - Defend: orange
  - Trim: gold
  - Exit: slate
- Soft glow background scaled to lane color when count > 0.
- Lane count rendered as a colored pill — tinted/bordered for actionable
  lanes (enter/trim/defend/exit), neutral for others.
- Pipeline + Badges legends compacted; pipeline uses inline color swatches
  that map directly to lane bars for instant pattern match.

Files: `react-app/index-react.source.html` (`KanbanColumn` ~lines 13396-13460,
legend block ~13710-13735).

### Discord (P0.7.42)

- Entry embed: surfaces 1H VWAP context as a "Signals" line when meaningfully
  aligned with direction (>0.5%). PDZ premium-stack, TD9/13, RSI divergence,
  ST flip, conviction tier all already surfaced from prior pass.
- All embed code-paths share the unified `_SETUP_MAP` with friendly names.
- Webhook payload includes `username` ("Timed Trading") and `avatar_url`
  (watch-face logo) — configurable via `DISCORD_WEBHOOK_USERNAME` /
  `DISCORD_WEBHOOK_AVATAR_URL` env vars.

Files: `worker/index.js` (`createTradeEntryEmbed` ~lines 32814+,
`createTradeTrimmedEmbed` ~32953+, `createTradeClosedEmbed` ~33082+),
`worker/alerts.js` (`notifyDiscord` ~lines 22-26).

### Setup-Name Cleanup, UI-only display layer (P0.7.42)

Display-layer rename across all dashboards. Raw `entry_path` values in the
DB are unchanged. Per user: "We need to clean up the Setup names, they look
like TT Tt and they also mirror too much of Ripster language."

| Old | New |
| --- | --- |
| TT Pullback | Pullback Reclaim |
| TT Ath Breakout | ATH Breakout |
| TT Mean Revert TD9 | TD9 Mean Reversion |
| TT Mean Reversion | Discount Mean Reversion |
| TT N Test Support / Resistance | Support Bounce / Resistance Fade |
| TT Range Reversal Long/Short | Range Reversal (Long/Short) |
| TT Gap Reversal Long/Short | Gap Reversal (Long/Short) |
| `ripster_*` | mapped to Timed Trading tone equivalents |

Files: `simulation-dashboard.html`, `shared-right-rail.js` (+ recompiled
`.compiled.js`), `trade-autopsy.html`, `system-intelligence.html`,
`calibration.html`, `model-dashboard.html`.

### Right Rail (Phase 3b — P0.7.35 / P0.7.37)

- Conviction row added under Score with color banding + tier label.
- Jargon-free labels:
  - "Take Profit 1/2/3" → "First/Main/Stretch Target"
  - "TSL" → "Trailing Stop"
- Wider on XL screens (`w-[450px] xl:w-[560px]` etc.) with corresponding
  parent margin updates so content doesn't get clipped.
- Improved tooltips on Stop Loss, Rank, and section headers.

Files: `react-app/shared-right-rail.js` + recompiled `.compiled.js`.

### Trades Page (Phase 3f — P0.7.36)

- New `react-app/trades-performance.js` factory component:
  - Top-line summary stripe (Closed Trades, WR, PnL)
  - Monthly Performance Table (per-month metrics, best/worst trades)
  - Setup Breakdown (rolled-up per-setup performance)
  - P&L Calendar Heatmap (90-day GitHub-style grid)
- Mounted at the top of `simulation-dashboard.html` main content.

### Other (background, finalized)

- ETF history + Apr 2026 Core Ideas D1 schema (P0.7.30) — append-only
  `etf_rebalance_history` + `etf_core_ideas` tables with `getETFHoldingsAsOf` /
  `getCoreIdeasAsOf` lookups.
- Logo refresh: watch-face favicon + Discord webhook avatar (P0.7.31).
- Top Movers converted to two-column table-like grid (P0.7.39).
- Earnings cap on Market Pulse lifted 12 → 50 (P0.7.34).
- Kanban / Viewport sort by rank then conviction-score then R:R (P0.7.32).

## How to validate live

| Page | Check |
|------|-------|
| `/` (Analysis) | Bubble Map opens with **Focus filter selected by default**; pills are tabular rows; legend has "How is this scored?" hover popover; tab control shows Active Trader count + amber pulsing dot when actionable; clear-filter X works |
| `/` (Active Trader) | Per-lane vertical accent bar with semantic colors; lane count pills tinted on actionable lanes; compact pipeline + badges legend with color swatches |
| `/` (Investor) | Tab badge with count |
| `/` (All) | Tab badge with total ticker count |
| `/daily-brief.html` | Index card with stacked Day + Week gate bars + probability pill; Game Plan card; Sectors grouped by theme; SPY/QQQ/IWM mini-charts polling real-time prices; catalyst chips bigger/bolder |
| `/simulation-dashboard.html` | Setup names cleaned up; Monthly Performance Overview at top; P&L calendar heatmap |
| `/trade-autopsy.html` | Setup names cleaned up; setup details surface TD/PDZ/Divergence/VWAP if present |
| Right rail | "Conviction" row under Score; jargon-free labels (First/Main/Stretch Target, Trailing Stop); wider on XL |

## Out of scope (deferred)

- Investor-mode live event detection (current `investorTotalCount` is a
  soft proxy; will land richer when ETF rebalance + core-idea event streams
  are wired).
- "Status pulse strip" above the segmented control surfacing the *one*
  most-actionable thing per non-active view — punted to keep this PR scoped.
- Full kanban-card visual refresh (current changes are at the lane level;
  the compact-card body has a separate redesign queued).

## Risk note

All UI changes are **display-layer only**. Raw `entry_path` strings in the
DB are unchanged, the engine sees no rename, and no entry/exit logic was
modified. Backtest fidelity is unchanged.
