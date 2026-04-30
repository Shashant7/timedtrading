# Trades Performance Component — wiring guide

**Status:** Component built and ready (`react-app/trades-performance.js`). Wiring into `simulation-dashboard.html` deferred to a fresh session for careful integration.

## What it provides

A self-contained React component that renders three complementary views:

1. **Top-line summary stripe** — Closed Trades count, Win Rate, Total PnL %, Total PnL $
2. **Monthly Performance Table** — per-month rows: Month / Trades / WR / PnL% / PnL$ / Best winner / Worst loser
3. **Setup Breakdown** — rolled-up per-setup performance (e.g. "Pullback / 12 trades / 75% WR / +47.3%")
4. **P&L Calendar Heatmap** — last 90 days, GitHub-style green/red cells with daily PnL tooltips, summary footer (active days / green days / red days / total PnL)

Color bands match the rest of the app:
- WR: emerald ≥65%, sky 50-65%, amber <50%
- PnL: emerald positive, rose negative

## How to wire it in

### Step 1 — load the script

In `react-app/simulation-dashboard.html` `<head>` (after React/ReactDOM load), add:
```html
<script src="trades-performance.js"></script>
```

### Step 2 — instantiate the component

Inside the App component (around line 6700-6800 where other hooks are), add:
```javascript
const TradesPerformance = useMemo(
  () => window.TradesPerformanceFactory?.({ React, API_BASE }),
  []
);
```

### Step 3 — render in the layout

Find the existing portfolio/equity-curve section and insert:
```jsx
{TradesPerformance && filteredTrades && (
  <div className="mb-8 p-5 rounded-xl"
    style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
    <h2 className="text-lg font-semibold text-white mb-4">Performance Overview</h2>
    <TradesPerformance trades={filteredTrades} loading={tradesLoading} />
  </div>
)}
```

Recommended placement: above the existing Open Trades / Closed Trades tables, below the equity curve, so users see the high-level summary before diving into individual trades.

## Why this was built as a standalone factory

`simulation-dashboard.html` is 8,463 lines of intermixed JSX, hooks, helper functions, and styling — embedded surgery requires very careful context. By isolating the trades-performance logic into its own file and exporting via window factory pattern (matching `shared-right-rail.js`), we get:

- Clean single-purpose code that's easy to maintain
- No risk of breaking the existing dashboard during the wire-up
- Same pattern as other shared components in the app
- Easy to unit-test or swap implementations later

## Acceptance criteria for the wire-up session

- [ ] Component renders without errors when `filteredTrades` is empty (shows "No trades yet")
- [ ] Component renders correctly with closed trades (Win Rate, PnL%, summary cards populate)
- [ ] Monthly table sorts newest-first and shows accurate Best/Worst per month
- [ ] Setup breakdown shows pretty names (no "tt_pullback" — should read "Pullback")
- [ ] P&L Calendar covers last 90 days, weekend cells slightly muted, hover tooltips work
- [ ] No console errors on page load
- [ ] Mobile responsive (heatmap cells should still be tappable; summary cards stack 2x2)

## After wire-up

Once the component is rendering, we can iterate on:
1. **Custom date range** for the calendar (default 90 days; allow 30/180/YTD)
2. **Click-through** on monthly rows to filter the trades table to that month
3. **Compare to backtest baseline** (current canonical run will produce 9 months of v16-fix4 data — could overlay actual vs simulated)
4. **Drill-down** on Setup Breakdown rows to show the trades behind each setup
