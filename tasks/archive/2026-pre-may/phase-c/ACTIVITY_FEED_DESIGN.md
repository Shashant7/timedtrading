# Activity Feed — Design Proposal

**Date:** 2026-05-06
**Phase:** 5 (post-Phase-C)
**Status:** Design — implementation deferred to a focused session

## Problem (user-stated)

> "Our main page is lacking a clear order of what was entered, exited,
> trimmed and when. The user has to go to the Active Trade View, to see
> it, but because things are batched, there should be several actions
> happening at an interval, which makes viewing the Active Trader
> Kanban Lane feel like a puzzle to determine what was what before,
> what is new, what moved and where."

The kanban is good for **state** (where each ticker is right now). It's bad for **events** (what happened in the last hour). Users have to mentally diff between page refreshes to figure out what moved.

## Solution — `Recent Activity` strip

A persistent narrow strip rendered just above the kanban (or above the bubble map in Analysis view) showing the **last N system actions in chronological order**. Each row is a single line: time + action + ticker + key facts.

```
┌── Recent Activity ──────────────────────────────────── last 12 actions ─┐
│ 4m ago   TRIM      SNDK   LONG    50% @ $1,365.01    +$125.21 (+1.25%) │
│ 14m ago  ENTRY     SNDK   LONG    14.8 sh @ $1,348.13   Prime  ⚡       │
│ 28m ago  DEFEND    APD    LONG    SL → $295.00         (was $290)      │
│ 1h ago   ENTRY     APD    LONG    25.4 sh @ $303.58    Speculative     │
│ 2h ago   EXIT      CSX    LONG    231 sh → $45.36     -$16.19 (-0.15%) │
│ 3h ago   TRIM      KLAC   SHORT   50% @ $478.20       +$78.55 (+1.6%)  │
│ ─── yesterday ──────────────────────────────────────────────────────── │
│ 6:00pm   EXIT      MTZ    LONG    19 sh → $440.10     +$71.42 (+1.0%)  │
│ 4:30pm   ENTRY     NFLX   LONG    148 sh @ $93.41     Confirmed  📅2d  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Anatomy of each row

| Element | Source | Notes |
|---|---|---|
| **Relative time** | `event_ts` | "4m ago" / "1h ago" / "yesterday 6:00pm" |
| **Action** | `event_type` | ENTRY / TRIM / EXIT / DEFEND / SCALE / ALERT / FLIP_WATCH |
| **Ticker** | `ticker` | Click to open right rail |
| **Direction** | `direction` | LONG / SHORT chip |
| **Quantity / price / level** | event-specific | shares + entry/exit price for ENTRY/EXIT/TRIM; new SL for DEFEND |
| **PnL** | `pnl_realized` (TRIM/EXIT only) | green if positive, red if negative |
| **Setup tier** | `setup_grade` (ENTRY only) | Prime / Confirmed / Speculative chip |
| **Earnings flag** | `_ttEarningsMap[ticker]` | 📅Nd if upcoming |

### Behavior

- **Auto-refresh** every 30s (same cadence as the existing data poll).
- **Click row** → opens the right rail for that ticker, scrolled to the History tab.
- **Group separator** at midnight ET ("─── yesterday ───").
- **Default visible**: last 12 actions. **Expand** button reveals last 50.
- **Filter chips** (collapsed by default): ENTRY / TRIM / EXIT / DEFEND / ALERT.
- **Empty state**: "No activity yet today. Last action was Apr 28, 4:30pm — APD ENTRY."

## Where it lives

Two options to consider:

### Option A (recommended) — above the kanban

```
┌─ Top Header (Regime / VIX / Top Rank / etc.) ─┐
├─ Macro / Earnings ────────────────────────────┤
├─ Market Pulse / Context ──────────────────────┤
├─ View tabs (Analysis / Active Trader / All) ──┤
├─ Recent Activity (last 12 — collapsed: 3) ───┤  ← NEW
├─ Kanban Lanes (Setup / In Review / ... / Exit)┤
└────────────────────────────────────────────────┘
```

- **Pro**: closest to kanban, makes the connection between "what was new" and "what's in each lane" obvious
- **Pro**: lives outside the View tab so it's visible across Analysis / Active Trader / All
- **Con**: pushes the kanban down — needs to default to compact (3 rows) with expand

### Option B — fixed strip docked to the right

```
┌─ Main content ───────────────────┬─ Activity ─┐
│  (kanban / bubble map / table)    │ 4m TRIM   │
│                                   │ 14m ENT   │
│                                   │ 28m DEF   │
│                                   │ 1h ENT    │
│                                   │ 2h EXIT   │
│                                   │ 3h TRIM   │
│                                   │ ────      │
│                                   │ 6pm EXIT  │
│                                   │ 4:30 ENT  │
└───────────────────────────────────┴───────────┘
```

- **Pro**: always visible, no vertical scroll cost
- **Pro**: reads like a Bloomberg ticker
- **Con**: eats screen width on narrow laptops, conflicts with right-rail workspace

**Recommendation**: Start with Option A (compact 3-row default + expand). Move to Option B in a later iteration if user wants more glanceability.

## Data source

The events already exist in D1 in the `execution_actions` table (live cron) and as ENTRY/TRIM/EXIT history within `promoted_trades`/`backtest_run_trades` (post-promotion).

New endpoint: `GET /timed/admin/activity-feed?limit=50&since=YYYY-MM-DD`

Returns a unified chronological list:

```json
{
  "ok": true,
  "events": [
    {
      "ts": 1778090400000,
      "type": "TRIM",
      "ticker": "SNDK",
      "direction": "LONG",
      "qty": 7.4,
      "price": 1365.01,
      "pnl": 125.21,
      "pnl_pct": 1.25,
      "trade_id": "SNDK-1778083200000",
      "setup_grade": "Prime",
      "reason": "atr_week_618_partial_cloud_hold"
    },
    {
      "ts": 1778089600000,
      "type": "ENTRY",
      "ticker": "SNDK",
      "direction": "LONG",
      "qty": 14.8,
      "price": 1348.13,
      "trade_id": "SNDK-1778083200000",
      "setup_grade": "Prime",
      "setup_name": "tt_gap_reversal_long"
    }
  ]
}
```

Server-side query is a UNION of:
- `execution_actions` (action_type, position_id, ts, qty, price, value, pnl_realized, reason)
- joined with `positions` for ticker + direction

Sorted by `ts DESC`, limited to `limit` rows.

## Implementation effort

- **Backend endpoint**: ~1 hour. Single SQL UNION + sort.
- **Frontend strip component**: ~2-3 hours. Mirrors the existing `MacroEarningsRow` pattern (`ds-row` + `ds-row__content` chips).
- **Right-rail History tab integration** (click → open ticker on History tab): trivial, already supported by `initialRailTab="HISTORY"`.

**Total**: 3-4 hours of focused work, low risk.

## Future enhancements (not in v1)

1. **Sparkline** next to each row showing the ticker's last hour of price action
2. **"Smart filter"**: only show actions on tickers the user has saved
3. **Notification toast** on new ENTRY when the user is on the page (with sound/desktop notification opt-in)
4. **Discord-mirror** mode: same content as Discord alerts, in-app
