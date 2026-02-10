# Auth + Open Positions + Screener

## Status: COMPLETE

---

## Workstream 1: Auth Gate ✅

### Files Created
- `react-app/auth-gate.js` — Shared auth gate component (AuthGate + UserBadge + helpers)

### Behavior
1. On page load, checks `localStorage` for cached session (7-day TTL)
2. If cached and valid, proceeds immediately (device remembering)
3. If no cache, calls `GET /timed/me` to verify Cloudflare Access JWT
4. If not authenticated, shows login screen (triggers CF Access SSO on click)
5. On successful auth, caches user info + access timestamp in localStorage
6. Backend automatically records email + access time via `authenticateUser()` in D1 users table

### Integration
- Added to all pages: index-react.html, simulation-dashboard.html, model-dashboard.html, ticker-management.html, screener.html
- UserBadge component shows user avatar in nav bar with dropdown (name, email, tier, sign out)

---

## Workstream 2: Open Positions Enhancement ✅

### Files Modified
- `react-app/simulation-dashboard.html` — Redesigned position cards
- `worker/index.js` — Added `stop_loss`, `take_profit`, `day_change_pct` to portfolio endpoint

### Changes
- **Current price + daily change**: Shown next to ticker name in position card header
- **SL / EP / TP Progress Bar**: Visual bar showing where current price sits between SL and TP
  - Red zone (SL side) → Yellow (EP) → Green (TP side)
  - White tick mark at Entry Price (EP)
  - Bright dot marker at current price with glow effect
  - Labels show exact SL, EP, TP dollar values
  - Falls back to center-anchored P&L bar if SL/TP data unavailable
- **Portfolio endpoint**: Now includes `sl`, `tp`, `day_change`, `day_change_pct`, `prev_close` for each open position

---

## Workstream 3: Screener Page ✅

### Files Created
- `react-app/screener.html` — Full screener page

### Features
- **Scan Type Toggles**: All, Daily Momentum, Top Gainers, Top Losers, Weekly
- **Filters**: Sector dropdown, sort options (change %, market cap, volume, ticker, recency), search
- **Results Table**: Ticker, name, price, change %, volume, RSI, market cap, sector
- **Add to Universe**: Per-ticker "Add" button + bulk select with checkboxes
  - Uses `POST /timed/watchlist/add` (now supports CF Access JWT auth)
  - Shows "In Universe" badge for already-tracked tickers
  - Shows "Added ✓" confirmation after successful add
- **Summary Stats**: Total candidates, already tracked, new discoveries

### Nav Bar Updates
- Added "Screener" link to nav bar on all pages

### Worker Changes
- `POST /timed/watchlist/add` now accepts both API key AND CF Access JWT (admin) via `requireKeyOrAdmin()`
