# Today Page Redesign — Plan & Scope (2026-05-28)

## User request

> 1. Today Page: This page needs to be more inviting.
>    A. Can we utilize the space next to "What the Model is Watching today",
>       with prediction cards for SPY, QQQ, IWM and smaller cards with
>       Kanban lanes style descriptions for Open positions across Active
>       Traders and Investor?
>    B. Ranked By Score needs to standout more, right now it looks pretty plain.

## Current layout (top to bottom)

1. **Daily Brief hero** — "What the model is watching today" + top 3 picks (full-width card)
2. **Market Pulse row** — SPY/QQQ/IWM/VIXY/USO/GLD/BTCUSD tiles (separate section)
3. Macro on the Tape
4. **Focus rail** — Ranked-by-Score lanes (top ranks, R:R, squeeze, corridor)
5. Top Movers
6. Earnings This Week
7. Analysis (bubble map)

## Target layout (after redesign)

1. **Hero — 2-column on desktop, stacked on mobile**
   - LEFT (~60%): Daily Brief (unchanged)
   - RIGHT (~40%): Index Predictions Strip (SPY/QQQ/IWM with model bias + R:R + key levels)
2. **Live Positions strip** — compact mini-cards for open positions, grouped by lane:
   - Active Trader: Hold · Defend · Trim · Exit
   - Investor: Accumulate · Hold · Reduce
   - One row per group; each ticker shows ticker + bias + lane chip + P&L%
3. Market Pulse row (kept; full set of macro tiles)
4. Macro on the Tape
5. **Focus rail — visual lift** (bigger section header with accent rule, lane cards with hero metric tile, brighter lane accents)
6. Top Movers
7. Earnings This Week
8. Analysis

## Implementation phases

### Phase 1 — Index Predictions Strip (this PR)

New component: `IndexPredictionCard` (one per index)
- Reuses existing `MarketPulseTile` shape (logo, symbol, price, day change, sparkline)
- Adds: model bias chip (LONG/SHORT/NEUTRAL), R:R, key support/resistance level, conviction tier
- Data sources already available:
  - `/timed/all` for SPY/QQQ/IWM rows
  - `/timed/prediction-contract?ticker=SPY&mode=trader` for bias + targets
- Lazy-fetch contracts on mount; cache 5min

New layout wrapper: `TodayHero` (2-column flex)
- Wraps DailyBrief on left, IndexPredictionStrip on right
- Collapses to stacked single-column at <980px

### Phase 2 — Live Positions strip

New component: `LivePositionsStrip`
- Pulls from `/timed/ledger/trades?status=open&limit=30` (both modes: trader + investor)
- Groups: Active Trader (Hold/Defend/Trim/Exit), Investor (Accumulate/Hold/Reduce)
- Each mini-card: ticker logo + symbol + bias chip + lane chip + live P&L%
- Click → opens the rail overlay for that ticker (reuses existing rail mount on today.html)

### Phase 3 — Focus rail visual lift

CSS-only changes (no data changes):
- Bigger section header with accent rule
- Lane card hero metric tile (e.g. "Top Rank: AAPL 100/100")
- Brighter per-lane accent colors (already exist but desaturated)
- Hover state with subtle lift + accent shadow

## Out of scope (this PR)

- Investor Dashboard redesign
- Active Trader page redesign
- Bubble map changes
- Anything backend (no new endpoints needed; data is already there)
