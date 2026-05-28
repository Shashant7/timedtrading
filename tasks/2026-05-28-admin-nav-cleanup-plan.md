# Admin Nav Cleanup — 2026-05-28

User: *"When I click on Admin pages, I get a duplicate Nav. But one that is missing items. Admin Nav should include: Screener, Tickers, Trade Autopsy, Admin Clients, System Intelligence, Mission Control, Brand Kit. Other pages are outdated and the Admin pages still maintain those links."*

## Audit

**Admin pages currently include `tt-nav-extras.js`:**
- `admin-clients.html`, `screener.html`, `ticker-management.html`, `system-intelligence.html`, `trade-autopsy.html`, `calibration.html`, `model-dashboard.html`, `simulation-dashboard.html`

**Admin pages that DON'T:**
- `mission-control.html`, `brand-kit.html`, `debug-dashboard.html` — these have either no nav at all or a stripped-down one. **Mission Control is invisible to the Admin dropdown** because of this.

**Current `ADMIN_LINKS` in `tt-nav-extras.js`:**
```js
Operations:  Screener, Ticker Management, Admin Clients
Engine:      System Intelligence, Model Dashboard, Calibration
Analysis:    Trade Autopsy, Simulation Dashboard, Debug Dashboard
Misc:        Brand Kit, Legacy Dashboard
```
12 items grouped into 4 buckets. User wants this culled to 7 items with no group headers.

**Outdated inline href targets on every admin page's hardcoded nav:**
- `<a href="index-react.html">Analysis</a>` — `index-react.html` is the legacy monolith; canonical analysis surface is `/today.html`
- `<a href="simulation-dashboard.html">Trades</a>` — Trades view canonical lives at `/portfolio.html` now
- `<a href="index-react.html" title="Restart tour">Tour</a>` — same legacy target

The journey strip injected at the top (`Today / Active Trader / Investor / Portfolio / Insights / Learn / FAQ`) is NOT a literal duplicate of the inline nav (different items) — it's two separate nav rows. User perceives this as "duplicate" because of the cognitive load. Not removing it in this PR — it's the universal app entry strip and is intentional per the `tt-nav-extras.js` design. If user wants it removed in a follow-up, easy change.

## Fix

### 1. Curate `ADMIN_LINKS` in `tt-nav-extras.js`

Drop group headers. Drop: Model Dashboard, Calibration, Simulation Dashboard, Debug Dashboard, Legacy Dashboard. Keep + add: the user's exact 7 items in their stated order.

```js
const ADMIN_LINKS = [
  { href: "/screener.html",            label: "Screener" },
  { href: "/ticker-management.html",   label: "Tickers" },           // renamed from "Ticker Management"
  { href: "/trade-autopsy.html",       label: "Trade Autopsy" },
  { href: "/admin-clients.html",       label: "Admin Clients" },
  { href: "/system-intelligence.html", label: "System Intelligence" },
  { href: "/mission-control.html",     label: "Mission Control" },   // NEW
  { href: "/brand-kit.html",           label: "Brand Kit" },
];
```

### 2. Make Mission Control + Brand Kit + Debug Dashboard reachable via the admin dropdown

They currently don't include `tt-nav-extras.js`. Add the script + a minimal nav scaffold that `injectAdminMenu()` can attach to.

Mission Control is a full standalone admin page and should clearly be on the admin nav. Brand Kit was already in the dropdown but its own page didn't include the script (so it couldn't open the dropdown to navigate elsewhere). Debug Dashboard is in the user's "outdated" bucket — we keep it accessible from somewhere but drop it from the curated dropdown (per the user's list).

### 3. Update outdated inline-nav href targets on every admin page

Replace across `admin-clients.html`, `screener.html`, `ticker-management.html`, `system-intelligence.html`, `trade-autopsy.html`, `calibration.html`, `model-dashboard.html`, `simulation-dashboard.html`:

| Label | Old href | New href |
|---|---|---|
| Analysis | `index-react.html` | `/today.html` |
| Trades | `simulation-dashboard.html` | `/portfolio.html` |
| Tour (Restart tour button) | `index-react.html` | `/today.html` |

Same replacements applied to both desktop nav AND the mobile-menu nav block in each page.

## Out of scope (intentional)

- Restructuring the inline nav row vs the Admin dropdown — the current "inline nav for top-level + dropdown for admin" two-row layout is intentional per `tt-nav-extras.js` line 342 design. Restructuring to a single-row layout is a bigger UX call.
- Removing the journey strip on admin pages — same reason; flag for follow-up if user wants it.
- Adding admin nav to `debug-dashboard.html` — it's not in the user's curated 7 list, and the page itself is partly deprecated.

## Rollback

Each change is independent and code-only:
- ADMIN_LINKS: revert that constant in `tt-nav-extras.js`
- Mission Control nav infra: revert the HTML additions to `mission-control.html` + `brand-kit.html`
- Inline href targets: revert per file
