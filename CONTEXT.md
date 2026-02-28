# Timed Trading — Context (Refresh Here)

Single reference for agents. Read this first to avoid context overload.

## Workflow

- **Plan first**: Non-trivial (3+ steps) → write to `tasks/todo.md` before coding
- **Stop on sideways**: If stuck, re-plan; don't push through
- **Verify before done**: Prove it works; "Would a staff engineer approve?"
- **Lessons**: After user corrections → add to "Lessons" below; review at session start
- **Simplicity**: Minimal impact, no temporary fixes

## Deploy

```bash
npm run deploy          # build:rail + embed dashboard + worker (both envs)
npm run deploy:worker   # worker only (skip right-rail)
```

- **Worker**: `cd worker && wrangler deploy` + `wrangler deploy --env production` — deploy BOTH
- **Pages**: Auto-deploys on `git push main` (static files from `react-app/`)
- **CRITICAL**: `simulation-dashboard.html` and all `react-app/*.html` files are served by **Pages**, NOT the worker. `deploy:worker` does NOT update them. Must `git commit && git push` to trigger Pages deploy.
- **Trades page JSX**: App's return must have a single root. Use `return ( <> <div className="tt-root"> ... <GoProModal /> ... </div> </> );` — no extra `</div>` before GoProModal.
- **Right rail**: Edit `shared-right-rail.js` → run `node scripts/compile-right-rail.js` → update `?v=` cache busters

## Global nav (header + right side)

- **Canonical source**: `index-react.html` — "Unified Nav Bar" comment. All pages must match this structure.
- **Nav links (order)**: Analysis, Trades, System Intelligence, Screener, Tickers, Trade Autopsy, Admin (conditional), Daily Brief.
- **Right side (order)**: Guide, Tour, FAQ, Ask AI, NotificationCenter (bell), UserBadge (avatar), hamburger (md:hidden). No Admin link and no "Paper · $1k/trade" in the right block; Admin lives only in the center nav tabs. Analysis uses buttons for Guide/Tour/Ask AI; other pages use links. Mobile menu includes same links + Contact.
- **Breakpoint**: Use `md` (768px) for desktop nav and `md:hidden` for mobile menu so the full nav is visible on typical desktop widths.
- **Styling**: `border-white/[0.06]`, `background: rgba(10,10,15,0.95)`, same logo and link styles. When adding a new page, copy the nav block from `index-react.html` and set the active link only.
- **Global component**: Nav is currently duplicated per page. A future shared component (e.g. `shared-nav.js` mounting into `#global-nav-root`) would allow one place to edit; not yet implemented.

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React 18, Tailwind, Babel (index-react, simulation-dashboard, daily-brief, trade-autopsy, etc.) |
| API      | Cloudflare Worker (`worker/index.js`), routes under `/timed/*` |
| Data     | D1 (ticker_candles, trades, positions), KV (timed:latest, timed:prices) |
| External | TwelveData (primary), Alpaca (execution, backfill) |

## Key Paths

- `worker/index.js` — routes, cron, trade logic
- `worker/indicators.js` — scoring, Alpaca
- `react-app/shared-price-utils.js` — `getDailyChange(t)` (single source for daily change)
- `react-app/auth-gate.js` — auth, paywall
- `tasks/todo.md` — current tasks

## Lessons (Critical)

**Deploy**
- Deploy worker to BOTH default + production envs
- ROUTES array must include new endpoints
- Worker routes use `/timed/` prefix

**D1**
- Batch reads: `db.batch()` max ~500 per call
- No unbounded `ROW_NUMBER() OVER (PARTITION BY ticker)` on large tables
- ALTER TABLE: wrap in try/catch (column may exist)

**Price / Frontend**
- `getDailyChange(t)` from shared-price-utils.js — never inline daily change
- TwelveData native fields over manual `price - prevClose`
- `timed:prices` keys: `p`, `pc`, `dc`, `dp`, `ahp`, `ahdc`, `ahdp`

**Trades**
- `exit_ts` on ALL exit paths
- Replay: load candles with `beforeTs` (ts <= replay date), not latest
- Backfill before replay; 10m candles required for trades

**Inspecting candles**
- `TICKER=FIX DATE=2025-09-18 TIME=12:10 node scripts/inspect-candles.js` — API
- Add `--d1` to query D1 directly via wrangler

**Alpaca**
- BRK.B not BRK-B; one bad symbol fails batch
- Multi-symbol `limit` is TOTAL not per-symbol

**UI**
- Never "you/your" in copy (compliance)
- `window._ttIsPro` for feature gating
- Admin-gate live prices

## Full Lessons

See `tasks/lessons.md` for the complete list (170+ items). Use CONTEXT for quick refresh.
