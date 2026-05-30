# Mission Control Tour

**WHEN to use:** A user describes a Mission Control issue ("the X tile is
red" / "AI CIO numbers are off" / "broker bridge not deployed") and you
need to know what each tile actually shows and what to do about it.

**Path:** `/mission-control.html` (admin-only, gated by CF Access + Pages
worker admin check)

---

## Status Grid (top, 10 tiles)

Each tile is a 1-glance health metric. Click a tile to scroll to the
section that owns it.

| Tile | Healthy state | If unhealthy → |
|---|---|---|
| **Data Capture** | "captured N minutes ago" (< 5) | Cron stalled. Check `/timed/health → captureMinutesSinceLast`. Most often the cron 0 22 * * * (discovery) overlap. |
| **Scoring** | "ran N min ago" (< 30) | Scoring cron stalled. Check `*/5 * * * *` cron + `/timed/health → minutesSinceScoring`. |
| **Worst Stale Ticker** | "no stale tickers" or < 60 min | Click the **Refresh** button → triggers alpaca-backfill for that ticker. See [backfill-candles.md](backfill-candles.md). |
| **AI CIO** | "N decisions today (live only)" | If 0, the AI CIO is gated off or `model_config.ai_cio_enabled` is false. |
| **Realized P&L (7d)** | Number > 0 in green | Negative is informational, not broken. |
| **Unrealized P&L** | Mark-to-market of open positions | If $0 and there are open trades, `timed:prices` KV unwrap bug — check `worker/index.js` mission-control endpoint. |
| **Open Positions** | Live count | If huge (>50), check trade lifecycle isn't stuck. |
| **Weekly Retro** | "ran N hours ago" | Click **Generate now** to fire the AI weekly retrospective. |
| **Broker Bridge** | "LIVE" (green) | See [broker-bridge.md](broker-bridge.md) for full triage. |
| **Trades Last 24h** | Number (any) | Sanity check that the system is trading. |

---

## Sections below the grid

All sections are wrapped in a collapsible `DetailSectionsToggle` so
operators can ignore them by default. Open them when triaging.

### 1. AI CIO Decisions
- Recent CIO decisions table (last 24h)
- Operator tasks (`manual_review`, `lifecycle_live_first`, `autosnap_safeguard`)
- **Decision Review** panel: rate individual decisions good/bad/meh
- Hitting 20 reviews in 14d auto-flips the `manual_review` operator gate

### 2. Open Trades + Recent Lifecycle Events

### 3. Calibration Reports + Promotion Candidates

### 4. Scheduled Crons
Lists every cron registered in `wrangler.toml` and whether it fired
this hour.

### 5. TT Universe Changes
Recent admin overlays, upticks, scheduled additions/removals. The cap
was raised to 200 entries (PR #380).

### 6. KV / D1 Storage
Used to sanity-check namespace sizes.

### 7. Email & Discord Health
DMARC, Discord embed delivery counts.

### 8. Broker Bridge
The triage section for IBKR/Robinhood automation. See
[broker-bridge.md](broker-bridge.md).

---

## "I clicked a button and nothing happens"

Most common cause: optimistic UI didn't surface the error. As of PR after
2026-05-30, the AI CIO Decision Review buttons now:

- Show a small "saved ✓" chip on success
- Show a "⚠ <error>" chip on failure
- Log full diagnostics to `console.warn` (`[ai-cio/review] failed`)

Open DevTools → Console; the warn line tells you the HTTP status + body.

---

## "I see red errors in the browser console"

The most frequent class: failed fetches from a section the operator
isn't even looking at (e.g. broker-bridge poll firing on every MC load).

As of PR after 2026-05-30, the broker-bridge `/status` and `/audit`
endpoints always return **HTTP 200 with a structured error payload**
instead of 4xx/5xx — so a not-configured bridge no longer pollutes the
console. If you see fresh red errors there, either:

1. A NEW endpoint was added that returns 4xx for an expected-but-empty
   state — wrap it the same way (return 200 + `{ ok: false, error_kind }`).
2. The user's browser is loading a stale Mission Control bundle —
   [cache-bust-rail.md](cache-bust-rail.md).

## Source

- `react-app/mission-control.html` → all React components (CioDecisionReview, BridgeSection, StatusGrid, …)
- `worker/index.js` → `/timed/admin/mission-control` aggregator
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "Mission Control" entries
