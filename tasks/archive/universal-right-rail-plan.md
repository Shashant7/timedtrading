# Universal Right Rail Ticker Details — Plan

## Goal
One shared component used by both Dashboard (`index-react.html`) and Trade Tracker (`simulation-dashboard.html`) so the right rail looks and behaves identically everywhere.

## Approach
- **Shared file:** `react-app/shared-right-rail.js`
- **Factory pattern:** `window.TickerDetailRightRailFactory = function(deps) { ... return function TickerDetailRightRail(props) { ... }; };`
- Each page loads the script and calls the factory with its own `deps` (React, API_BASE, and all helper functions). The returned component is used as today.
- **New prop:** `initialRailTab` — when provided (e.g. `"TRADE_HISTORY"` from Trade Tracker), the rail opens on that tab.

## Dependencies (injected via `deps`)
- `React` (for useState, useEffect, useMemo, useRef; also React.useMemo in body)
- `API_BASE`
- `fmtUsd`, `fmtUsdAbs`
- `getDailyChange`, `getStaleInfo`, `isNyRegularMarketOpen`
- `isPrimeBubble`, `entryType`, `getActionDescription`, `summarizeEntryDecision`
- `rankScoreForTicker`, `getRankedTickers`, `getRankPosition`, `getRankPositionFromMap`
- `detectPatterns`, `normalizeTrailPoints`, `phaseToColor`, `completionForSize`
- `computeHorizonBucket`, `computeEtaDays`, `computeReturnPct`, `computeRiskPct`, `computeTpTargetPrice`, `computeTpMaxPrice`
- `getDirectionFromState`, `getDirection`, `numFromAny`
- `groupsForTicker`, `GROUP_ORDER`, `GROUP_LABELS`
- `TRADE_SIZE`, `FUTURES_SPECS`
- `downsampleByInterval` (used in Journey tab; may be defined in Dashboard only — add to both or to shared)

## Steps
1. Extract TickerDetailRightRail from index-react.html (lines ~14381–18769) into shared-right-rail.js via script.
2. Wrap in factory; add `initialRailTab` prop and useEffect to set initial tab.
3. In index-react.html: remove inline TickerDetailRightRail; add `<script src="shared-right-rail.js">`; call factory with deps; use returned component.
4. In simulation-dashboard.html: remove inline TickerDetailRightRail; add script; call factory with deps (add any missing helpers or pass from page); use returned component with `initialRailTab="TRADE_HISTORY"` when opened from position card.
5. Verify both pages: open rail from Dashboard and from Trade Tracker; confirm same UI and behavior.

## Verification
- Dashboard: click a ticker in viewport/kanban → right rail opens (Analysis default); switch tabs → Technicals, Journey, Trade History load.
- Trade Tracker: click a position card → right rail opens on Trade History; switch tabs → same content as Dashboard.
- No duplicate component code in either HTML file.

## Done (executed)
- Created `react-app/shared-right-rail.js` via `scripts/extract-right-rail.js` (factory + full Dashboard rail; added `initialRailTab` prop).
- Wired `index-react.html`: added `<script src="shared-right-rail.js">`, replaced inline TickerDetailRightRail with `window.TickerDetailRightRailFactory(deps)`.
- Wired `simulation-dashboard.html`: added script tag, added missing helpers (numFromAny, fmtUsdAbs, getDirectionFromState, summarizeEntryDecision, GROUP_ORDER, GROUP_LABELS, groupsForTicker, getRankPosition), replaced inline component with factory call; TickerDetailsLoader passes `initialRailTab={trade ? "TRADE_HISTORY" : null}`.
- Manual check: open both pages and open right rail from a ticker/position to confirm same UI and behavior.
