# Worker as Source of Truth: Kanban → Execution → Trade History → Discord

**Goal:** Make the worker the single source of truth and executioner. Track every action (entry, additional entry, trim, exit) as a first-class execution with clear action type, date/time, qty, executed price, value, and net P&L. Use lot-based accounting (additional entries = new lots; VWAP for display; trim/exit from specific lots with verifiable P&L). Tie kanban lane transitions → trade executions → trade history → Discord alerts into one verifiable pipeline.

---

## 1. Current State (Gaps)

### 1.1 Data and flow
- **KV `timed:trades:all`**: In-memory list of trades; worker updates on ingest. **GET /timed/trades** reads from KV only.
- **D1 `trades`**: One row per trade (trade_id, ticker, direction, entry_ts, entry_price, status, trimmed_pct, pnl, …). Worker writes here “best-effort” after KV.
- **D1 `trade_events`**: event_id, trade_id, ts, type (ENTRY/TRIM/EXIT/SCALE_IN), price, qty_pct_delta, qty_pct_total, pnl_realized, reason, meta_json. No **qty** (shares) or **value**; TRIM uses percentage only. No **lot_id**.
- **Two sources of truth**: KV drives the live UI; D1 is ledger. Replay/backfill can desync them. No single canonical store.

### 1.2 Execution semantics
- **Entry**: Creates a new trade (new trade_id). Second entry on same ticker = second trade (or SCALE_IN merges into one trade and averages price). No explicit “lots.”
- **Trim**: Single `entry_price` for whole position; P&L = (trim_price - entry_price) × trim_shares × sign. Cannot attribute P&L to a specific purchase.
- **Exit**: Same: one entry_price for full close. No lot-level audit.

### 1.3 Discord and history
- Alerts for TRADE_ENTRY, TRADE_TRIM, TRADE_EXIT (and SCALE_IN in some path). Event payloads don’t consistently include: executed qty, value, net P&L per action. History in UI is derived from `trade_events` + trade row; missing qty/value on events makes it hard to verify.

---

## 2. Target Architecture

### 2.1 Single source of truth: D1
- **All trade state and history live in D1.** Worker is the only writer for executions.
- **KV**: Optional cache for “open positions” or hot path; if used, it is populated from D1. **GET /timed/trades** (and any consumer) should read from D1, or from a cache that is filled from D1.
- **Ingest flow**: On each ingest, worker loads **open positions** (and any needed context) from D1, decides ENTRY / ADD_ENTRY / TRIM / EXIT, writes **only to D1** (execution actions + updated position state), then sends Discord. No “write to KV first, then best-effort D1.”

### 2.2 Execution model: positions + lots + actions
- **Position**: One per (ticker, direction). Identified by `position_id` (e.g. `{ticker}-{direction}-{first_entry_ts}` or a UUID).
- **Lot**: One row per buy. Columns: lot_id, position_id, ts (execution time), qty, price, value (= qty × price), optional cost_basis_adj for fees. Lots are immutable once created.
- **Execution action**: Every execution is one row: action_id, position_id, ts, action_type (ENTRY | ADD_ENTRY | TRIM | EXIT), qty, price, value, pnl_realized, lot_id (for TRIM/EXIT: which lot was reduced/closed), reason, meta. ENTRY creates position + first lot. ADD_ENTRY creates a new lot. TRIM/EXIT reduce lot qty and record pnl_realized from that lot’s cost vs executed price.
- **P&L**: ENTRY/ADD_ENTRY: no realized P&L. TRIM: pnl_realized = (trim_price - lot_price) × trim_qty × sign (per lot, FIFO or explicit lot). EXIT: same per remaining lot(s). Position-level P&L = sum of action pnl_realized.

### 2.3 Backward compatibility with existing UI
- **Option A (recommended):** Add new D1 tables (`positions`, `lots`, `execution_actions`). Keep `trades` and `trade_events` as **derived views** or a sync layer: worker writes to positions/lots/actions, and a small layer (trigger or worker code) maintains `trades` / `trade_events` for existing GET /timed/ledger/trades and GET /timed/trades until UI is migrated.
- **Option B:** Evolve `trades` to be “one row per position” (not per entry), and add a `lots` table; `trade_events` gains qty, value, lot_id. Worker writes only to D1; GET /timed/trades reads from D1 and returns one “trade” per position with derived VWAP and total qty.

---

## 3. Schema Additions / Changes (D1)

### 3.1 New tables (if Option A)

```sql
-- Positions: one per (ticker, direction), current state
CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,  -- OPEN, CLOSED
  total_qty REAL NOT NULL DEFAULT 0,
  cost_basis REAL NOT NULL DEFAULT 0,  -- sum(lot.qty * lot.price)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  script_version TEXT
);

-- Lots: each buy is one lot (immutable)
CREATE TABLE IF NOT EXISTS lots (
  lot_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  remaining_qty REAL NOT NULL,  -- after trims/exits
  FOREIGN KEY (position_id) REFERENCES positions(position_id)
);

-- Execution actions: every entry/trim/exit with full execution details
CREATE TABLE IF NOT EXISTS execution_actions (
  action_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action_type TEXT NOT NULL,  -- ENTRY, ADD_ENTRY, TRIM, EXIT
  qty REAL NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  pnl_realized REAL,
  lot_id TEXT,  -- for TRIM/EXIT: which lot (or null if FIFO applied)
  reason TEXT,
  meta_json TEXT,
  FOREIGN KEY (position_id) REFERENCES positions(position_id)
);
```

- **ENTRY**: Insert position, insert lot, insert execution_actions row (action_type=ENTRY, pnl_realized=null).
- **ADD_ENTRY**: Insert new lot, insert execution_actions row (ADD_ENTRY), update position total_qty and cost_basis.
- **TRIM**: Insert execution_actions row (TRIM, qty, price, value, pnl_realized, lot_id). Update lot.remaining_qty (FIFO: reduce oldest lots first). Update position total_qty/cost_basis/updated_at.
- **EXIT**: For each remaining lot (or aggregate), insert EXIT action(s) with pnl_realized; set lot.remaining_qty=0; set position status=CLOSED, closed_at.

### 3.2 Extending existing tables (if Option B)
- **trades**: Becomes “one per position”: trade_id = position_id, entry_ts = first ENTRY ts, entry_price = VWAP (cost_basis / total_qty), add total_qty, cost_basis; keep status, exit_ts, exit_price, pnl for closed state.
- **trade_events**: Add columns qty REAL, value REAL, lot_id TEXT. Populate for every ENTRY, ADD_ENTRY (as SCALE_IN or new type), TRIM, EXIT. event_id remains unique (e.g. trade_id:type:ts or action_id).
- **New lots table** as above, referenced by trade_events.lot_id.

---

## 4. Worker Logic Changes

### 4.1 Ingest pipeline (single writer)
1. **Load open positions from D1** (and optionally cache in KV with short TTL) for the ticker.
2. **Compute kanban stage** (unchanged).
3. **EXIT lane**: If position open, close via **EXIT** action(s): compute P&L per lot (FIFO), write execution_actions, update lots and position, then send Discord TRADE_EXIT with full details.
4. **TRIM lane**: If position open and trim conditions OK, create **TRIM** action: qty/price/value, deduct from lots (FIFO), pnl_realized per lot, write execution_actions + update position, then Discord TRADE_TRIM.
5. **ENTER_NOW lane**:
   - No open position → **ENTRY**: create position, first lot, ENTRY action; write to D1; Discord TRADE_ENTRY.
   - Open position (same ticker+dir) → **ADD_ENTRY**: new lot, ADD_ENTRY action; update position; Discord TRADE_ADD_ENTRY (or equivalent).
6. **Mark-to-market**: Update only current price / trailing logic in memory or in a “snapshot” table; no new execution rows. Optionally persist to D1 for audit (e.g. current_price_ts).

### 4.2 Remove KV as source of truth for trades
- **Option 1:** GET /timed/trades reads from D1 only (positions + lots + execution_actions aggregated into “trades” list). Worker stops writing to `timed:trades:all` for canonical state (or deletes that key).
- **Option 2:** Worker, after every D1 write, updates KV from D1 so existing clients that poll GET /timed/trades keep working; treat KV as a cache and document that D1 is canonical.

### 4.3 Idempotency and dedupe
- Execution actions: use (position_id, action_type, ts) or (position_id, action_id) to avoid duplicate ENTRY/ADD_ENTRY/TRIM/EXIT from repeated ingest or replay.
- Discord: keep existing dedupe (e.g. by alert_id or trade_id+type+ts) so each execution sends one alert.

---

## 5. Discord Alerts (Unified and Verifiable)

Every execution should send one Discord alert with:

- **Action**: ENTRY | ADD_ENTRY | TRIM | EXIT
- **Ticker, direction**
- **Date/time** (execution ts)
- **Qty, executed price, value** (qty × price)
- **Net P&L** (for TRIM/EXIT: realized on that action)
- **Cumulative position** (optional): total qty, VWAP, unrealized P&L after this action

Payload should match what is stored in D1 (action_id, position_id, ts, action_type, qty, price, value, pnl_realized) so history is verifiable from Discord + D1.

---

## 6. API and UI Alignment

### 6.1 GET /timed/trades
- Return list derived from D1: one item per **position** (or per “trade” if we keep that term), with:
  - position_id (or trade_id), ticker, direction, status
  - total_qty, entry_price (VWAP), cost_basis
  - current_price (from latest ingest or separate feed), unrealized_pnl, realized_pnl
  - first_entry_ts, last_action_ts
- Optional: include `lots[]` and `execution_actions[]` for each position for UI detail.

### 6.2 GET /timed/ledger/trades
- Already D1-backed. Change to query positions + actions (or keep querying `trades` if it’s maintained as a view/sync from positions). Response should allow UI to show:
  - Per-position: all lots (entry time, qty, price, value, remaining_qty)
  - Per-position: all execution actions in time order (ENTRY, ADD_ENTRY, TRIM, EXIT) with ts, qty, price, value, pnl_realized.

### 6.3 Trade Tracker UI (simulation-dashboard)
- Consume GET /timed/trades and GET /timed/ledger/trades so that:
  - Open positions show total qty (sum of lot remaining_qty), VWAP, and current P&L.
  - “Trade Journey” / history is a chronological list of execution actions (entry, additional entry, trim, exit) with date/time, qty, price, value, net P&L each.
- Remove or reduce client-side aggregation of “multiple trades per ticker” once worker returns one position per (ticker, direction) with lots and actions.

---

## 7. Implementation Phases

### Phase 1: D1 as canonical store (no lot model yet)
- [x] Worker: on every ENTRY/TRIM/EXIT (and SCALE_IN), write **first** to D1; only then update KV (if still used). Ensure GET /timed/trades can be switched to read from D1 (e.g. new endpoint or flag).
- [x] Add GET /timed/trades?source=d1 from D1 with trade_events joined so UI has one place for “all history.”
- [x] Discord payloads: add qty, value, and net P&L to TRADE_ENTRY, TRADE_TRIM, TRADE_EXIT (and SCALE_IN) from the execution payload.
- [x] Document “D1 is source of truth” and deprecate KV for trades (or document KV as cache).

### Phase 2: Lot-based model and execution_actions
- [x] Add D1 schema: positions, lots, execution_actions (migration add-positions-lots-actions.sql).
- [x] Worker: ENTRY creates position + first lot + ENTRY action; ADD_ENTRY (SCALE_IN) creates lot + ADD_ENTRY action; TRIM/EXIT write execution_action and update position; dual-write with trades/trade_events.
- [ ] Migrate existing trades/trade_events to positions/lots/actions (one-time script) or run dual-write and backfill.
- [x] GET /timed/trades?source=positions returns from positions + execution_actions (same shape as KV).

### Phase 3: Kanban → execution consistency and alerts
- [ ] Ingest: load open positions from D1 only (no KV for open state). All transitions (ENTER_NOW → ENTRY/ADD_ENTRY, TRIM lane → TRIM, EXIT lane → EXIT) write only to D1 then Discord.
- [ ] Idempotency: enforce (position_id, action_type, ts) or action_id so replays don’t double-execute.
- [ ] Discord: every execution sends one alert with action, date/time, qty, price, value, net P&L; align field names with execution_actions table for verification.

### Phase 4: UI and verification
- [ ] Trade Tracker: show per-position lots and execution timeline (entry, add entry, trim, exit) with full details.
- [ ] **UI cleanup — consistent palette and position cards:**
  - Use a single color palette across the Trade Tracker (and simulation dashboard): only design-system vars (`--tt-bg-base`, `--tt-bg-surface`, `--tt-accent`, `--tt-negative`, `--tt-text`, `--tt-text-muted`, `--tt-border`, etc.). Remove any remaining hardcoded hex or one-off colors so the UI is visually consistent.
  - Expand Open positions grid to **5 columns** on large screens (e.g. `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5`).
  - Apply **background color on each position card** by day (green tint when ticker is up for the day, red tint when down), and show **completion progress on the card itself** (horizontal fill for trim %; show the bar even at 0% so the control is always visible).
- [ ] Optional: export or report “reconciliation” (D1 execution_actions vs Discord log) for auditing.

---

## 8. Success Criteria

- **Single source of truth**: All trade and execution state lives in D1; worker is the only writer; no conflicting state in KV.
- **Clear actions**: Every entry, additional entry, trim, and exit is one row (or one event) with action, date/time, qty, price, value, net P&L.
- **Lot-level P&L**: Trims and exits attribute realized P&L to specific lots (e.g. FIFO); VWAP is derived from lots.
- **Verifiable history**: UI and Discord show the same execution details; both traceable to D1 execution_actions (or trade_events with qty/value/lot_id).
- **Discord**: One alert per execution with full, consistent fields; no missing qty/value/P&L.

---

## 9. References

- Worker: `worker/index.js` (ingest, `processTradeSimulation`, `d1UpsertTrade`, `d1InsertTradeEvent`, Discord helpers).
- D1 schema: `worker/d1-schema.sql` (trades, trade_events).
- UI: `react-app/simulation-dashboard.html` (GET /timed/trades, GET /timed/ledger/trades, positionsWithHistory, open position cards).
- Workflow: `tasks/WORKFLOW_ORCHESTRATION.md` (plan-first, verify, document).
