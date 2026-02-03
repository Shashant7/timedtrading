# Time Travel, Right Rail Parity & Kanban/Trade Sync

## 1. Right Rail Parity (Position Card vs Kanban/Viewport)

**Goal:** When you click an **Open Position Card** on the Trade Tracker, the right rail should be the **same** Right Rail Ticker Detail as when you click a kanban or viewport card on the main dashboard. The only difference: **Trade History** tab is auto-selected.

**Current state:**
- **Dashboard (index-react):** Right rail = `TickerDetailRightRail` with ticker from viewport data, `trade=null`; fetches ledger/candles; tabs Analysis, Technicals, Journey, Trade History.
- **Trade Tracker (simulation-dashboard):** Right rail = same component name but in a different file; receives `ticker` (from `/timed/latest`), `trade`, `positionEvents`; defaults to Trade History when opened from position card.

**Implemented (right rail parity):**
- Trade Tracker’s right rail now uses the **same data and UI** for all four tabs as the Dashboard:
  - **Trade History:** Fetches `/timed/ledger/trades?ticker=X` and shows the same ledger trade cards (OPEN/WIN/LOSS, entry/exit, P&L) as the Dashboard.
  - **Journey:** Fetches `/timed/trail` with `normalizeTrailPoints` and `limit=250`, same as Dashboard; Bubble Journey (15m) renders with the same shape.
  - **Technicals:** Uses the same `tickerData` (from TickerDetailsLoader’s `/timed/latest` fetch) for Triggers and Timeframes; same layout.
- Default to Trade History when opened from a position card is unchanged.
- Optional future: share one right-rail implementation (e.g. shared bundle or iframe) so both pages use the same component.

---

## 2. Kanban Lanes vs Trade Status (Implemented)

**Problem:** Contradictory states — e.g. AMZN in HOLD lane but system exited at 12:40; EXPE shown as OPEN but in Exit lane.

**Fix (in place):** Kanban stage is **overridden from trades** on the dashboard:

- **Trades** are passed from App → ActionCenterPanel → EarlyMoversPanel.
- **Per-ticker map:** Latest trade per ticker (by `exit_ts` or `entry_ts`).
- **Override rules:**
  - If the ticker has a **closed** trade (`status === 'WIN'` or `'LOSS'`, or `exit_ts` set) → force stage to **exit** (Exit lane).
  - If the ticker has an **open** trade (`OPEN` or `TP_HIT_TRIM`) but backend sent `exit`/`archive` → force stage to **hold** (so OPEN positions don’t sit in Exit lane).

So: **exited** positions move to Exit; **OPEN** positions are never shown in Exit. Worker/D1 remains source of truth for trade status; the UI uses it to correct lane assignment.

---

## 3. Time Travel: Replay a Day (Bubbles + Kanban)

**Goal:** Time Travel controls everything: pick a day, replay it, and see:
- How **bubbles** moved (existing Time Travel on the bubble chart).
- How **cards** (or the filtered set) moved through **kanban lanes** over that day.

**Data and plumbing:**
- **Bubbles:** Time-series or snapshots of ticker state (rank, score, position) over time — from ingest/replay or historical KV/D1.
- **Kanban:** Lane assignment over time can be derived from:
  - **Trade events** (ENTRY → enter_now/just_entered/hold, TRIM → trim, EXIT → exit) with timestamps.
  - **Viewport/ingest snapshots** (e.g. stored or replayed per bucket) that include `kanban_stage` or enough fields to recompute it.

**Steps to get there:**

1. **Replay data for a day**
   - Either: replay ingest for that day and produce timestamped snapshots (per ticker: price, score, state, etc.).
   - Or: use existing replay scripts + D1/trail/ledger to get trade events and, where available, viewport snapshots for that day.

2. **Time Travel = “current time”**
   - Time Travel scrubber sets a single **replay time** (e.g. 9:45 AM on Feb 3).
   - All views respect this time:
     - **Bubble chart:** Show bubble positions (and trails) as of that time.
     - **Kanban:** Show lane membership as of that time (from trade events + optional snapshot).

3. **Kanban at time T**
   - **Option A (event-driven):** For each ticker, replay trade events up to T; compute “effective” status (open/trimmed/closed) and map to stage (enter_now, hold, trim, exit).
   - **Option B (snapshot):** If you store or replay viewport payloads per bucket, use `kanban_stage` (or equivalent) at the bucket that contains T.
   - **Option C (hybrid):** Use trade events for exit/trim/entry timing; use snapshots for “watch/enter_now” style state if needed.

4. **Single control**
   - One “replay date” + one “replay time” (or scrubber) drives:
     - Bubble chart time
     - Kanban lane state
     - Any other time-aware UI (e.g. Trade History for that ticker at that time).

5. **Implementation order**
   - Ensure **replay pipeline** for a day produces (or has access to) trade events and, if needed, viewport snapshots.
   - Extend **Time Travel** to accept a “replay time” and pass it to both bubble and kanban (and any other consumers).
   - Implement **kanban-at-time**: either event-driven stage from trade history up to T, or snapshot-based stage at T.
   - Wire the **UI**: date picker + time scrubber → update replay time → bubbles and kanban refresh from that time.

Once this is in place, replaying a given day will show both how bubbles moved and how cards moved through kanban lanes, with one shared time control.
