# Trade-Aware Mirror Sync — Design (Full Scope) — v2

**Created:** 2026-06-01 · **Last revised:** 2026-06-01 (v2) · **Status:** Design (no code yet) · **Owner:** TBD

**v2 changes (operator feedback after v1):**
- **No naked shorts** — Trader-side `SHORT` mode is OUT of scope for the
  initial mirror. Removed from action taxonomy + manifest defaults to
  `direction='LONG'` for equity. Re-introducing shorts is a separate
  future workstream with its own risk review.
- **Per-vehicle toggles** — the auto-mirror prefs now have one
  toggle per supported vehicle: `equity_long`, `long_call`,
  `long_put`, `vertical_spread`, `leaps`, `straddle`, `moonshot`.
  Each independently on/off. Equity-long defaults ON, every option
  archetype defaults OFF.
- **LEAPs as a first-class options vehicle** — long-dated options
  (>365d expiration) get their own archetype + reconciler treatment
  (slower cadence, no SL/TP, theta-decay milestones).
- **Daily owner email** — each connected broker user gets a
  per-account daily digest: trades executed today, current open
  positions, day P&L, outlook from Daily Brief.
- **Explicit IBKR action mapping** — every model action now
  documents the corresponding IBKR API calls including OCO order
  lifecycle (cancel-before-trim, modify-SL flow, TP/SL fill
  detection).
- **User-modified broker order handling** — operator preference
  is to ADJUST BACK to model state (revert SL changes, restore
  TP qty) but treat user-initiated CLOSES as a valid exit signal.
  Documented in §14.

The portfolio-aware guard shipped in PR #409 prevents the worst-case
(naked short on an unheld ticker). The user correctly pointed out that
**position-awareness ≠ trade-awareness**: a user can hold TSLA shares
from manual buys, but the model's trade `ABC-TSLA-1780...` is a
separate object the bridge has to track per-fill.

This design covers the full trade-aware sync system across all four
mode × instrument combinations and every simulation action.

The mothership (TT's model state in D1) MUST stay in lockstep with its
spawns (each user's broker account). When they drift, the system MUST
detect it, suppress further mirror activity for the affected trades,
and notify the user.

---

## 1. Scope matrix

|  | **Shares (equity)** | **Options** |
|---|---|---|
| **Active Trader** | **LONG only** (SHORT deferred — see v2 notes). Hard SL + TP1/TP2/TP3 ladder. Cadence: minutes-to-days. | Long call / put / vertical spread / **LEAPs** / straddle / moonshot. Defined-risk; expiration cliff (except LEAPs which are long-dated). Cadence: days-to-weeks (options); months-to-years (LEAPs). |
| **Investor** | Zone-based: accumulate / hold / reduce / distribute. DCA on entries. No hard SL. **Long-only.** Cadence: weeks-to-months. | LEAPs are the second-most-popular vehicle for our user base (per operator). Treated first-class in v2. |

**Deferred (NOT in initial mirror):**
- **Naked shorts** (any flavour: equity SELL_SHORT, options selling-to-open without owning the underlying, cash-secured puts, covered calls without an existing long). All require margin / borrow / additional regulatory considerations and have unbounded loss profiles. Re-introducing is its own workstream with its own risk review + operator consent flow.

The design treats each ENABLED combination as a first-class flow with
the same manifest backbone but mode/instrument-specific:
- entry shape (single fill vs multi-leg vs DCA tranche vs LEAPs long-dated)
- reducer semantics (whole-position vs lot-by-lot vs leg-by-leg)
- drift tolerance (tight for Trader options, looser for Investor DCA, looser still for LEAPs)
- reconciler cadence (5 min for Trader, hourly for Investor, daily for LEAPs)

## 1.5 Per-vehicle toggle structure

The auto-mirror prefs (`worker/options-auto-mirror.js` → KV
`timed:options:auto-mirror:<email>`) gain a flat per-vehicle toggle
map so the operator can independently enable each vehicle from
Mission Control:

```js
DEFAULT_PREFS = {
  enabled: false,        // master switch — must be true for any vehicle to mirror

  // Equity (Trader + Investor share this toggle)
  vehicles: {
    equity_long:       { enabled: true,  daily_cap: 3, max_per_order_usd: 300 },

    // Options archetypes — each independently toggleable.
    // ALL DEFAULT OFF — operator must explicitly enable each one.
    long_call:         { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
    long_put:          { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
    vertical_spread:   { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
    leaps:             { enabled: false, daily_cap: 1, max_per_order_usd: 500, max_loss_per_order_usd: 500 },
    straddle:          { enabled: false, daily_cap: 1, max_per_order_usd: 300, max_loss_per_order_usd: 200 },
    moonshot:          { enabled: false, daily_cap: 1, max_per_order_usd: 100, max_loss_per_order_usd: 100 },
  },

  // Cross-cutting
  modes_allowed: ["RIDE"],
  require_st_freshness: ["fresh", "in_motion"],
  ticker_blocklist: [],
  ticker_allowlist: null,  // null = all; array = only these tickers eligible
};
```

Each vehicle has its own daily-cap + max-notional + max-loss because
the risk profile differs sharply (a $500 LEAPs trade with 6-month
horizon ≠ a $200 long call with 30-day horizon ≠ a $300 equity buy
with 5-day horizon).

Mission Control's Options Auto-Mirror sub-card extends to a per-vehicle
table:

```
┌─ Options Auto-Mirror ─────────────────────────────────────────┐
│ Vehicle           Today  Cap  Max Notional  Max Loss  Status   │
│ Equity (long)        0    3        $300         —     ON       │
│ Long Call            0    2        $200       $75     OFF [On] │
│ Long Put             0    2        $200       $75     OFF [On] │
│ Vertical Spread      0    2        $200       $75     OFF [On] │
│ LEAPs                0    1        $500      $500     OFF [On] │
│ Straddle             0    1        $300      $200     OFF [On] │
│ Moonshot             0    1        $100      $100     OFF [On] │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Action taxonomy — what each simulation event means at the broker

Every TT trade has a deterministic lifecycle. Each event maps to a
concrete broker action (or a no-op). The bridge MUST handle each
combination correctly.

### 2.1 Trader · Shares (LONG only — shorts deferred)

> **IBKR API column** lists the exact REST or Web API call. All paths
> are under the IBKR Client Portal Web API base.
> OCO order-id columns assume operator opted into broker-side OCO
> (default OFF — TT manages SL/TP in-process by default).

| Event | Broker action | IBKR API | Quantity semantics | OCO order lifecycle |
|---|---|---|---|---|
| **entry** | Market or limit `BUY` | `POST /iserver/account/{acct}/orders` `{side:"BUY", orderType:"MKT"\|"LMT"}` | Full intended qty | If OCO opt-in: also place TP `SELL LMT` + SL `SELL STP` as bracketed siblings (`parentId` linkage). Manifest stores all three order IDs. |
| **trim** | `SELL` of N% remaining | `POST /iserver/account/{acct}/orders` `{side:"SELL", orderType:"MKT", quantity: trimQty}` | `qty = floor(broker_remaining_qty × trim_pct)` | **Critical: cancel existing OCO TP+SL FIRST** (they reserve full position; if not cancelled the trim may be rejected or the OCO will close MORE than intended). Then place trim. Then re-place SL+TP for the new (reduced) qty. Manifest is updated atomically. |
| **update SL** | Default: no broker action (in-process). OCO mode: modify or replace SL order | `POST /iserver/account/{acct}/order/{id}` (modify) OR `DELETE /iserver/account/{acct}/order/{id}` + new place (replace) | n/a | Must know `manifest.broker_sl_order_id`. Modify is preferred (avoids brief unprotected window); replace falls back if broker doesn't support modify for this order type. Manifest updated with new order ID if replaced. |
| **TP1/TP2/TP3 hit** | Auto-fill by broker (if OCO live) OR explicit `SELL` (if in-process) | In-process: same as trim. OCO: broker fires the order; we DETECT via `/iserver/orders` poll or webhook | qty per-tier from model | OCO branch: detect fill → cancel the SL (now stale, sized for full pre-trim qty) → re-place SL for remaining qty → mark `tp_tier_hit[N]=ts`. In-process branch: standard trim flow above. |
| **SL hit** | Auto-fill by broker (OCO) OR explicit `SELL` (in-process) of entire remaining | OCO: detect fill. In-process: `POST /iserver/account/{acct}/orders` `{side:"SELL", orderType:"MKT"}` | `qty = broker_remaining_qty` | **NEVER scaled by partial-fill ratio.** OCO branch: also cancel TP orders. In-process: cancel all OCO siblings then sell remaining. |
| **exit** (model-driven) | `SELL` entire remaining | Cancel OCO + `POST /iserver/account/{acct}/orders` | `qty = broker_remaining_qty` | Same as SL hit. Different `model_exit_reason` audit string. |

**Key OCO lifecycle invariant:** at any moment the manifest's open
OCO orders MUST sum to ≤ `broker_remaining_qty`. After every model
action (entry/trim/exit) and every detected broker fill (TP/SL hit),
the bridge enforces this by cancelling stale orders and re-placing
correctly-sized ones in a single atomic sequence.

### 2.2 Trader · Options

> Includes **LEAPs** as a first-class archetype (option contracts
> with > 365 day expiration). LEAPs share the options manifest
> shape but get a slower reconciler cadence and a different
> lifecycle treatment (see §2.5).

| Event | Broker action | IBKR API | Quantity semantics | Lock-tight rules |
|---|---|---|---|---|
| **entry** (single-leg) | `BUY_TO_OPEN` contract | `POST /iserver/account/{acct}/orders` `{secType:"OPT", conid:<contract>, side:"BUY", orderType:"MKT"\|"LMT"}` | qty in contracts | Manifest stores contract symbol (root + exp + strike + put/call). |
| **entry** (multi-leg, e.g. vertical spread) | Combo order — atomic all-legs-or-nothing | `POST /iserver/account/{acct}/orders` with `legs:[{conid, ratio, side}, ...]` (IBKR combo syntax) | Equal across legs (spread ratios) | If broker doesn't support combo for this spread shape OR if any leg fails to fill in atomic mode → REJECT entire trade. Mark `partial_fill` + `mirror_suppressed=1`. NEVER auto-unwind a partial-leg fill — operator manual recovery only. |
| **trim** (single-leg) | `SELL_TO_CLOSE` partial | `POST /iserver/account/{acct}/orders` `{side:"SELL", orderType:"MKT", quantity: trimContracts}` | Single-leg only | Cancel any pending TP/SL OCO for this contract first (same as equity flow). |
| **trim** (spread) | All-or-nothing close of full spread (default) | Combo SELL or per-leg SELLs in lockstep | Spreads: `BROKER_OPTIONS_TRIM_SPREAD_MODE` controls. Default `reject` (operator manual only). | Auto-trimming a spread risks one leg filling and the other not → uncovered position. Refuse by default. |
| **update SL** | Almost never used for options | If enabled: modify OCO STP order | n/a | Same OCO-modify logic as equity (cancel + re-place). |
| **TP hit** | OCO auto-fill OR explicit close | Detect via `/iserver/orders` poll | qty per-tier (single-leg); all-or-nothing (spread) | Same OCO-rebalance logic as equity. |
| **SL hit** | `SELL_TO_CLOSE` all contracts (single-leg) OR close-spread (multi-leg) | Cancel TP, then close | All contracts / all legs | NEVER partial. If any leg can't be closed (no liquidity, market closed) → critical alert + `sync_state='broker_orphan'`. |
| **exit** (model-driven) | Same as SL hit | Same | All | Different reason code. |
| **expiration approaching** | Auto-close at T-1 day if `BROKER_OPTIONS_AUTO_CLOSE_BEFORE_EXP=true` (default off) | Standard sell-to-close | All | Default OFF for non-LEAPs. **For LEAPs:** override is `BROKER_LEAPS_AUTO_CLOSE_BEFORE_EXP_DAYS=30` (close 30 days before expiration to avoid theta cliff). |

### 2.3 LEAPs — special case within Trader · Options

LEAPs (Long-term Equity Anticipation Securities) are options with
expirations > 365 days. They behave more like equity than short-dated
options:
- Time decay is minimal far from expiration
- Held for months-to-years
- Usually entered as long call (bullish thesis) or long put (bearish)
- Rarely trimmed mid-life; usually held to thesis-resolution
- Auto-close window is LARGER (30 days before expiration vs 1 day)

**Manifest extensions for LEAPs:**
- `instrument_subtype = 'leaps'`
- `expiration_ts` >= entry_ts + 365 days
- Reconciler cadence: **daily** (not 5-min); positions don't move
  on intraday scale
- `BROKER_LEAPS_AUTO_CLOSE_BEFORE_EXP_DAYS = 30` (operator override)
  triggers auto-exit 30d before expiration regardless of model state
- Per-vehicle daily-cap default: **1** (LEAPs are capital-intensive;
  one new position per day is plenty)
- Per-vehicle max-loss-per-order default: **$500** (same as max-notional
  because LEAPs can theoretically lose 100% of premium)
- TP/SL not used for LEAPs by default — operator config

**Action mapping for LEAPs (delta from §2.2):**

| Event | LEAPs-specific behaviour |
|---|---|
| entry | Same as long_call / long_put entry. Manifest tagged with `instrument_subtype='leaps'`. |
| trim | DEFER unless explicitly requested by operator — LEAPs are conviction trades; trimming defeats the thesis. Default config: `BROKER_LEAPS_TRIM_MODE='reject'`. |
| update SL | Almost never set on LEAPs. Default OFF. |
| TP hit | DEFER similarly — let the thesis play out. Default config: `BROKER_LEAPS_TP_MODE='reject'`. |
| SL hit | If model decides catastrophic exit (underlying fundamentally broken), close all. |
| exit | Standard `SELL_TO_CLOSE` all contracts. |
| expiration approaching | Auto-close 30 days before expiration (vs 1 day for short-dated). Avoids theta cliff. |

### 2.4 Trader · Options — combined IBKR-API reference table

For quick reference when implementing the bridge dispatch:

| Model action | IBKR Web API endpoint | Method | Key params |
|---|---|---|---|
| Place single-leg option order | `/iserver/account/{acct}/orders` | POST | `secType=OPT, conid, side, orderType, quantity` |
| Place combo order (spread) | `/iserver/account/{acct}/orders` | POST | `legs:[{conid, ratio, side}, ...]` |
| Cancel order | `/iserver/account/{acct}/order/{orderId}` | DELETE | — |
| Modify order (price/qty) | `/iserver/account/{acct}/order/{orderId}` | POST | partial body |
| List user orders | `/iserver/account/orders` | GET | filter by status |
| Get specific order detail | `/iserver/account/order/status/{orderId}` | GET | — |
| List positions | `/portfolio/{acct}/positions/0` | GET | (page 0 for first 100) |
| Get account summary | `/portfolio/{acct}/summary` | GET | returns `netliquidation, totalcashvalue, ...` |
| Get contract by symbol+expiry+strike | `/iserver/secdef/search` then `/iserver/secdef/info` | GET | resolve contract → `conid` |

The bridge's existing `worker-bridge/bridge-ibkr.js → callIbkr()`
already signs requests via OAuth 1.0a Extended + LST. Each new
endpoint above just adds a new entry to the dispatch table; the
auth/signing layer doesn't change.

### 2.5 Investor · Shares

| Event | Broker action | Quantity semantics | Lock-tight rules |
|---|---|---|---|
| **entry** (accumulate zone) | `BUY` — may be one of several DCA tranches | qty per tranche; total tracked across the DCA series | Manifest tracks the DCA series as ONE logical trade with multiple `entry_tranches[]`. Each tranche has its own broker_order_id. |
| **trim** (reduce zone) | `SELL` partial — typically 25% of current position | qty = `broker_remaining_qty × 0.25` | Investor positions can grow through DCA; trim percentages compound against current holding, not original intent. |
| **update SL** | n/a — investors don't use hard SL | — | Skip. |
| **take profit hit** | Re-mapped to "distribute zone" close — partial or full | Model-defined zone exit | Investor's "TP" is a zone state change, not a price hit. Manifest stores `distribute_zone_entry_ts`. |
| **SL hit** | Rare — only fires on catastrophic fundamentals (e.g. delisting risk). Maps to full close. | All remaining | Treated as critical operator-attention event regardless of size. |
| **exit** (distribute zone) | `SELL` of full remaining position | All remaining | Same as Trader exit. |

### 2.6 Investor · Options

Out of scope for v1. The design accommodates it via the manifest's
generic `instrument_type` field; semantics deferred.

LEAPs are technically a long-horizon options vehicle that overlaps
with Investor mode philosophically, but in our codebase LEAPs are
emitted by the Trader · Options engine (`worker/options-plays.js`).
Investor mode does not currently emit LEAPs — if it ever does, the
manifest schema already supports it (`mode='investor', instrument_type='options', instrument_subtype='leaps'`).

---

## 3. Manifest schema (instrument-aware)

### 3.1 D1 table — `mirror_trade_manifest`

One row per (user_id, model trade_id, broker_account_id). The
`instrument_type` + `mode` columns drive per-flow behaviour.

```sql
CREATE TABLE mirror_trade_manifest (
  -- Composite identity
  user_id                  TEXT NOT NULL,
  trade_id                 TEXT NOT NULL,
  broker_account_id        TEXT NOT NULL,
  broker                   TEXT NOT NULL,           -- 'ibkr' | 'robinhood'

  -- Mode + instrument
  mode                     TEXT NOT NULL,           -- 'trader' | 'investor'
  instrument_type          TEXT NOT NULL,           -- 'equity' | 'options'
  options_structure        TEXT,                    -- 'long_call' | 'vertical_spread' | … (instrument_type='options' only)

  -- Mothership state
  ticker                   TEXT NOT NULL,
  direction                TEXT NOT NULL,           -- 'LONG' | 'SHORT'
  setup_name               TEXT,                    -- 'tt_pullback' / 'accumulate' / etc.
  model_intended_qty       REAL NOT NULL,           -- shares OR contracts
  model_intended_legs      TEXT,                    -- JSON array of legs (options only)
  model_entry_ts           INTEGER NOT NULL,
  model_status             TEXT NOT NULL,           -- 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'EXPIRED'
  model_exit_ts            INTEGER,
  model_exit_reason        TEXT,                    -- 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'EXIT_REQUEST' | 'EXPIRED' | …

  -- Investor-specific: DCA tracking
  dca_tranches             TEXT,                    -- JSON array: [{ts, qty, broker_order_id, filled_qty, avg_cost}]

  -- Broker state (reconciler-updated)
  broker_filled_qty        REAL DEFAULT 0,          -- total filled across all entry tranches
  broker_remaining_qty     REAL DEFAULT 0,
  broker_avg_cost          REAL,
  broker_realized_pnl_usd  REAL DEFAULT 0,
  broker_last_known_state  TEXT,                    -- JSON snapshot of last successful position read
  broker_last_seen_at      INTEGER,

  -- Per-action order ID tracking
  broker_entry_order_ids   TEXT,                    -- JSON: [{order_id, ts, requested_qty, filled_qty}]
  broker_trim_order_ids    TEXT,                    -- JSON: same shape
  broker_exit_order_ids    TEXT,                    -- JSON: same shape
  broker_sl_order_id       TEXT,                    -- OCO stop order at broker (Trader equity only, opt-in)
  broker_tp_order_ids      TEXT,                    -- JSON map: { TP1: id, TP2: id, TP3: id }

  -- Sync state machine
  sync_state               TEXT NOT NULL DEFAULT 'pending',
  sync_last_checked_at     INTEGER,
  sync_last_drift_at       INTEGER,
  sync_drift_count         INTEGER DEFAULT 0,
  sync_note                TEXT,

  -- Mirror suppression
  mirror_suppressed        INTEGER DEFAULT 0,
  mirror_suppressed_at     INTEGER,
  mirror_suppressed_reason TEXT,

  -- Notification
  last_user_notified_at    INTEGER,
  notification_severity    TEXT,                    -- 'info' | 'warn' | 'critical'

  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,

  PRIMARY KEY (user_id, trade_id, broker_account_id)
);

CREATE INDEX idx_mtm_user_state   ON mirror_trade_manifest(user_id, sync_state);
CREATE INDEX idx_mtm_user_open    ON mirror_trade_manifest(user_id, mode) WHERE model_status != 'CLOSED' AND model_status != 'EXPIRED';
CREATE INDEX idx_mtm_ticker_user  ON mirror_trade_manifest(user_id, ticker);
CREATE INDEX idx_mtm_drift        ON mirror_trade_manifest(sync_last_drift_at DESC) WHERE sync_state != 'in_sync';
CREATE INDEX idx_mtm_options_exp  ON mirror_trade_manifest(user_id, model_status) WHERE instrument_type = 'options';
```

### 3.2 sync_state values

| Value | Trigger | Bridge behaviour for new emits on this trade |
|---|---|---|
| `pending` | Entry submitted, fill not yet confirmed | Accept TRIM/EXIT only after fill confirmed (within tolerance window) |
| `in_sync` | Model qty matches broker qty (within tolerance) | Normal — accept all emits |
| `partial_fill` | Broker filled less than model intended | Scale future emits by `broker_filled_qty / model_intended_qty` (operator config) |
| `expired` | Options trade past expiration | Reject all emits; manifest archived |
| `broker_orphan` | Model CLOSED, broker still has qty > 0 | Auto-retry exit (N attempts), then critical alert |
| `mothership_orphan` | Model OPEN, broker has qty = 0 (user closed manually) | Suppress all future emits on this trade |
| `rejected` | Entry was rejected at the bridge | Suppress all future emits permanently |
| `untracked` | Broker has shares for ticker but no manifest row | Informational — no action (manual user position) |
| `mirror_suppressed` | Operator-flagged | Reject all emits with explicit reason in audit |
| `reconcile_error` | Last sync attempt failed | Hold last known state; retry next cycle. After N consecutive failures → escalate |

---

## 4. Action validation — decision matrix

Every order arriving at the bridge runs through this matrix. The
columns enumerate each (mode, instrument, action) cell.

### 4.1 Trader · Equity flow

```
ENTRY:
  manifest row not yet present → CREATE { sync_state: 'pending' }
  run preflight guards (kill, enable, $-cap, daily-cap, portfolio-cap)
  place order
  on response: UPDATE manifest broker_entry_order_ids, broker_filled_qty
  
TRIM (qty = model_intended_qty * trim_pct):
  manifest must exist
  manifest.sync_state in {in_sync, partial_fill}: proceed
  manifest.sync_state == 'pending': REJECT (entry not yet confirmed at broker)
  manifest.sync_state in {rejected, mothership_orphan, mirror_suppressed, expired, untracked}: REJECT
  if sync_state == 'partial_fill' AND mode == 'scale':
    actual_qty := round_down(qty * broker_filled_qty / model_intended_qty)
  portfolio check (PR #409 — defense in depth, must still pass)
  place order
  on response: UPDATE manifest broker_trim_order_ids, broker_remaining_qty

UPDATE_SL:
  if OCO mode OFF (default): no broker action, manifest unchanged
  if OCO mode ON:
    if manifest.broker_sl_order_id exists: cancel it
    place new stop order
    UPDATE manifest.broker_sl_order_id = new_id

TP1/TP2/TP3 HIT:
  same flow as TRIM with model-specified tier qty
  manifest.tp_tier_hit[N] = ts
  
SL HIT:
  same flow as EXIT (full close) with reason='sl_hit'
  NEVER scaled — sells all broker_remaining_qty
  
EXIT:
  manifest must exist
  manifest.sync_state in {in_sync, partial_fill, broker_orphan}: proceed (we're TRYING to close)
  manifest.sync_state in {pending, rejected, mothership_orphan, mirror_suppressed, expired, untracked}: REJECT
  if broker has SL/TP orders at the broker: cancel them first
  place SELL for broker_remaining_qty
  on success: manifest.model_status='CLOSED', model_exit_ts=now
  if broker_remaining_qty != 0 after exit fill: sync_state='broker_orphan', notify
```

### 4.2 Trader · Options flow

```
ENTRY (single-leg, e.g. long_call):
  same as equity but BUY_TO_OPEN with contract symbol (incl. strike + exp)
  manifest.model_intended_legs = [{contract, qty, side}]

ENTRY (multi-leg, e.g. vertical_spread):
  SUBMIT as combo order (broker-supported atomic multi-leg)
  on success: manifest.broker_entry_order_ids = [{combo_id, leg_fills: [...]}]
  on partial: ANY leg unfilled → REJECT entire trade, mark sync_state='partial_fill', mirror_suppressed=1
    (operator must manually unwind partial position — automated unwind is too risky)

TRIM (single-leg only):
  manifest.options_structure == 'long_call' or 'long_put':
    same as equity trim
  manifest.options_structure is spread:
    BROKER_OPTIONS_TRIM_SPREAD_MODE:
      'reject' (default): REJECT — spread trims are operator-only
      'legs_in_lockstep': trim all legs proportionally
      'allow_unequal': operator escape hatch

UPDATE_SL: not used by default for options. If enabled: equivalent to equity OCO.

TP1/TP2/TP3 HIT:
  same as TRIM but with TP-tier qty
  Spread trades: prefer all-or-nothing (per BROKER_OPTIONS_TRIM_SPREAD_MODE)

SL HIT:
  SELL_TO_CLOSE all contracts / all legs
  NEVER partial — if any leg can't be closed (no liquidity, market closed):
    sync_state='broker_orphan', notify operator IMMEDIATELY (critical)

EXIT (model-driven):
  Same as SL hit (close all legs)

EXPIRATION (T-1 day, operator opt-in):
  if model_status == 'OPEN' AND today >= expiration - 1:
    if BROKER_OPTIONS_AUTO_CLOSE_BEFORE_EXP == true:
      auto-send EXIT
    else:
      notify operator (warn): "Options trade ABC expires tomorrow, still open"
  on expiration:
    if not closed: manifest.model_status='EXPIRED', notify user (info or warn depending on ITM/OTM)
```

### 4.3 Investor · Equity flow

```
ENTRY (accumulate zone, tranche):
  manifest row may already exist for this trade_id (DCA tranches)
  if exists: APPEND to dca_tranches[], model_intended_qty += tranche qty
  if not: CREATE row, dca_tranches = [first tranche]
  place BUY for tranche qty
  on response: update tranche.broker_order_id, tranche.filled_qty, recompute broker_avg_cost

TRIM (reduce zone):
  qty = broker_remaining_qty * trim_pct (typically 25%)
  same checks as Trader trim
  proceeds REDUCE broker_remaining_qty proportionally

UPDATE_SL: not used by investors.

TAKE PROFIT (distribute zone, partial):
  same as TRIM with zone-defined exit pct

SL HIT (catastrophic):
  EXTREMELY RARE — fundamentals collapse / delisting risk
  full close, critical operator alert regardless of size

EXIT (full distribute):
  SELL all broker_remaining_qty
  manifest.model_status='CLOSED'
```

### 4.4 Investor · Options

Deferred to v2. Manifest accommodates via the same shape; behaviour
defaults to Trader · Options flow if such a trade appears.

---

## 5. Reconciler design (instrument-aware)

### 5.1 Cadence

| Mode × instrument | Cadence | Tolerance |
|---|---|---|
| Trader · Equity | Every 5 min (operating hours) | abs(diff) > 0.01 shares |
| Trader · Options | Every 5 min (operating hours) | abs(diff) > 0 contracts (any drift = action) |
| Investor · Equity | Every 60 min (24/7) | abs(diff) > 0.1 shares OR > 1% of position |
| Investor · Options | Every 60 min | Treated as Trader Options |

### 5.2 Per-instrument special checks

**Equity:**
- Compare `manifest.broker_remaining_qty` vs `getEquityPositions[ticker]`
- Classify per §6 mismatch taxonomy

**Options:**
- Compare each leg of `manifest.model_intended_legs` vs broker's options positions
- Lookup by `contract_symbol` (ticker + exp + strike + put/call)
- Spread trades: ALL legs must be present and in correct qty ratio
- Approaching expiration: special handling per §4.2

### 5.3 Drift escalation

```
reconciler detects drift on (user, trade_id):
  manifest.sync_state = <classified>
  manifest.sync_drift_count += 1
  manifest.sync_last_drift_at = now

  if first detection AND severity in {warn, critical}:
    enqueue user notification
    record manifest.last_user_notified_at, manifest.notification_severity

  if drift count > 3 on same trade:
    set mirror_suppressed = 1 (auto-suppress chronic drift)
    elevate notification to operator level

  if drift class is 'broker_orphan' AND > 24h since model close:
    elevate to critical
    operator-level alert (Discord + email)
```

---

## 6. Mismatch taxonomy (extended for options + investor)

| Symptom | Diagnosis | sync_state | Default action | User notification severity |
|---|---|---|---|---|
| Equity entry rejected; model OPEN | Bridge rejected | `rejected` | Suppress future mirror | info |
| Options entry partial-leg fill | One or more legs didn't fill | `partial_fill` | Auto-suppress; operator unwind | **critical** (uncovered leg = risk) |
| Equity partial fill (e.g. liquidity) | Broker filled < model intended | `partial_fill` | Scale future actions OR reject (config) | warn |
| Investor DCA tranche rejected | One tranche failed but others succeeded | `partial_fill` (with per-tranche detail) | Continue mirroring future tranches; close at proportional scale | info |
| Model CLOSED, broker still holds | Exit failed | `broker_orphan` | Auto-retry exit N times; then critical | **critical** |
| Model OPEN, broker has qty=0 | User closed manually | `mothership_orphan` | Suppress | warn |
| Options expired ITM, not closed | Auto-exercise pending | `expired` | Alert user; if auto-close enabled, would have prevented this | warn |
| Options expired OTM | Normal — contracts worth 0 | `expired` | Archive manifest; account-level loss already reflected | info (digest) |
| Spread missing one leg at reconciler | Leg disappeared (broker action without TT visibility) | `mothership_orphan` (for the leg) | Suppress trade; operator manual review of remaining legs | **critical** |
| Investor position growth beyond DCA plan | User added shares manually | (tracked as `untracked` delta) | Ignore extra; don't act on it | none |
| Broker API failure | Network or broker down | `reconcile_error` | Hold last state; retry; escalate after 3 fails | operator-only |
| Operator manual override | Flagged in MC | `mirror_suppressed` | All emits rejected | info (on set + clear) |

---

## 7. User notification flow

### 7.1 Severity tiers

| Tier | Trigger | Channel | Frequency |
|---|---|---|---|
| `info` | Trade rejected at entry, user-closed-outside-TT, OTM expiration | Daily digest email | Once per day |
| `warn` | Partial fill, drift > tolerance, Trader · Options expiration approaching | Immediate email + in-app banner | Immediate, dedup'd per trade per day |
| `critical` | Broker-orphan > 24h, options partial-leg fill, options ITM expiration miss, reconciler down > 3 cycles | Immediate email + SMS (if configured) + in-app modal + operator Discord ping | Immediate, no dedup |

### 7.2 Email content per scenario

**Trader · Equity partial fill (warn):**
```
Subject: [Timed Trading] Trade ABC TSLA partial fill — future actions will scale
[…model wanted 10sh, broker filled 6sh. Future trims/exits scale to 60%.…]
```

**Trader · Options partial-leg fill (critical):**
```
Subject: [Timed Trading] URGENT — Options spread ABC has an uncovered leg
[…leg 1 (long 500C) filled. Leg 2 (short 510C) did NOT fill. You have
   a naked long call instead of the intended vertical spread. This
   trade is now suppressed; please review immediately…]
```

**Investor · DCA tranche rejected (info, digest):**
```
Subject: [Timed Trading] Daily activity digest — 1 DCA tranche skipped
[…AMZN DCA tranche 3/4 was skipped (rejected: order_exceeds_cap). Other
   tranches landed. Total DCA fill so far: 75% of plan…]
```

**Broker-orphan > 24h (critical):**
```
Subject: [Timed Trading] URGENT — closed model trade still has open position at broker
[…trade ABC closed at the model 26 hours ago, but you still have 7 shares
   of TSLA in your broker account. We've retried the exit 3 times. Please
   manually close at IBKR or contact support…]
```

### 7.3 In-app banner

`/today.html` shows a banner when ANY of the user's manifest rows is
in a non-`in_sync` state needing attention:

```
⚠ 2 mirror trades need your attention  [ View ]
```

Click → `/account/brokers#mirror-sync` shows the affected trades.

---

## 8. Mission Control surface

New "Mirror Sync — Per-User" section under Section 8 (Broker Bridge):

```
┌─ Mirror Sync — Per-User (T = Trader · I = Investor) ──────────┐
│ User      Mode  Trades  In Sync  Drift  Orphan  Last Sync     │
│ operator  T-eq      7        5      1       1   2m ago        │
│ operator  T-opt     2        2      0       0   2m ago        │
│ operator  I-eq      4        4      0       0   12m ago       │
│                                                                │
│ ⚠ Trader · Equity drift:                                       │
│   ABC TSLA  model: 10sh  broker: 6sh  (partial_fill)           │
│   [ View ]  [ Force Sync ]  [ Suppress Mirror ]                │
│                                                                │
│ 🚨 Trader · Equity broker-orphan:                              │
│   DEF NVDA  model: CLOSED  broker: 5sh open                    │
│   [ View ]  [ Force Exit ]  [ Mark Manual ]                    │
│                                                                │
│ (no drift in Options or Investor lanes)                        │
└────────────────────────────────────────────────────────────────┘
```

Operator controls per trade:
- **View** — drawer with full manifest row + bridge audit history + per-leg detail (options)
- **Force Sync** — re-run reconciliation immediately
- **Suppress Mirror** — flip `mirror_suppressed=1`
- **Force Exit** — send a manual exit through the bridge (uses today's `placeOrder` path with override flag)
- **Mark Manual** — for `untracked` positions, acknowledge they're not TT-managed
- **Force Re-Sync from Broker** — pull the broker's view as truth, update manifest to match (use when operator KNOWS broker is right)

---

## 9. Shipping plan (5 phases, incremental)

Each phase is independently useful and adds defense.

### Phase A — Manifest table + Trader equity entry tracking (~2 days)

- [ ] Create `mirror_trade_manifest` D1 table with all columns
- [ ] On every `POST /bridge/order` for ENTRY/ADD: INSERT row
- [ ] On successful place: UPDATE with order IDs, filled qty
- [ ] On preflight rejection: INSERT row with `sync_state='rejected'`, `mirror_suppressed=1`
- [ ] Mission Control "Manifest" debug table (operator-only) showing recent rows

**Scope:** Trader · Equity only. Options + Investor flows accepted but
recorded as `untracked` for now.

### Phase B — Reducer consults manifest (Trader equity) (~2 days)

- [ ] `preflightOrder` reads manifest BEFORE portfolio check
- [ ] Decision matrix from §4.1 implemented
- [ ] New reject reasons (`no_manifest_for_trade`, `mirror_suppressed`, etc.)
- [ ] Operator runbook: how to interpret each reject reason

**Scope:** Trader · Equity TRIM/EXIT/SL hit/TP hit all gated by manifest.

### Phase C — Reconciler cron + drift detection (Trader equity) (~3 days)

- [ ] `worker-bridge/bridge-reconciler.js`
- [ ] Cron every 5 min (operating hours)
- [ ] Drift classification per §6
- [ ] Manifest state machine updates
- [ ] Auto-suppress on `mothership_orphan` + `partial_fill`
- [ ] On-demand `POST /bridge/reconcile?user_id=X`

**Scope:** Trader · Equity. Drift detected within 5 min.

### Phase D — Options (incl. LEAPs) + Investor reconciler extensions (~5 days)

- [ ] Options leg-aware reconciliation
- [ ] Options expiration cron (T-1 day check + post-expiration archival)
- [ ] **LEAPs special handling**: daily cadence reconciler, 30-day pre-expiration auto-close, default-reject for trim/TP
- [ ] **Per-vehicle toggles** in auto-mirror prefs schema + bridge enforcement
- [ ] Mission Control per-vehicle toggle table (§1.5)
- [ ] Investor DCA tranche tracking in `dca_tranches[]`
- [ ] Investor 60-min reconciler cadence
- [ ] Per-mode decision matrix from §2.1-§2.6 implemented

**Scope:** All ENABLED (mode × instrument) cells covered including
LEAPs. Per-vehicle toggle UI live. Naked shorts still out of scope
(deferred).

### Phase E — User notification + Mission Control surface + Daily Owner Email (~4 days)

- [ ] Email templates for each severity tier (info / warn / critical)
- [ ] `notifyUserOfDrift(user, manifest_row, severity)` in reconciler
- [ ] In-app banner on `/today.html` for affected users
- [ ] Mission Control "Mirror Sync — Per-User" section per §8
- [ ] Operator buttons: Force Sync, Suppress, Force Exit, Mark Manual, Force Re-Sync
- [ ] Daily digest cron for `info`-tier events
- [ ] Operator Discord webhook for `critical` tier
- [ ] **Daily owner email per §13** — per-broker-account digest cron
  at 21:30 UTC with executed trades / open positions / day P&L /
  tomorrow's outlook (Daily Brief integration)
- [ ] User opt-in/out controls in `/account/email-preferences`

### Phase F — User-modification handling per §14 (~2 days)

- [ ] Reconciler-side detection of user SL/TP/qty modifications
- [ ] Auto-revert flow (cancel user's order + re-place model's order)
- [ ] Acceptance flow for user-initiated CLOSES (mark `mothership_orphan`, suppress mirror)
- [ ] Notification escalation ladder per §14.4 (info → warn → critical → auto-suppress after 5 reverts)
- [ ] Mission Control per-trade "Accept user modifications" toggle

### Phase G — Polish (later, post-BYOB launch)

- [ ] Auto-retry broker-orphan exits (exponential backoff)
- [ ] Tax-lot tracking (when broker returns lot IDs)
- [ ] Per-trade kill switch UI on each user's `/account/brokers` page
- [ ] Cross-trade pyramiding detection (warn when same ticker has N concurrent open trades)
- [ ] Reconciler runtime metrics + per-user health score in MC
- [ ] Optional: re-introduce shorts (separate workstream + risk review)

---

## 10. Operator config knobs (consolidated)

All env vars on the bridge worker.

### 10.1 Position + manifest safety

| Var | Default | Meaning |
|---|---|---|
| `BROKER_POSITION_CHECK_MODE` | `reject` | (PR #409) `reject` / `cap` / `off` for position-level guard |
| `BROKER_MANIFEST_REDUCE_NO_ROW` | `reject` | Reducing order with no manifest row. `reject` / `allow_if_position` / `off` |
| `BROKER_PARTIAL_FILL_MODE` | `scale` | `scale` / `reject` / `literal` |

### 10.2 OCO order lifecycle

| Var | Default | Meaning |
|---|---|---|
| `BROKER_OCO_ENABLED_EQUITY` | `false` | Place actual broker-side stop+TP orders for equity trades (vs in-process management) |
| `BROKER_OCO_ENABLED_OPTIONS` | `false` | Same for options |
| `BROKER_OCO_TRIM_SEQUENCE` | `cancel_first` | When trimming with OCO live: `cancel_first` (cancel SL/TP, trim, re-place) / `parallel` (risky) |

### 10.3 Options + LEAPs

| Var | Default | Meaning |
|---|---|---|
| `BROKER_OPTIONS_TRIM_SPREAD_MODE` | `reject` | Spread trim: `reject` / `legs_in_lockstep` / `allow_unequal` |
| `BROKER_OPTIONS_AUTO_CLOSE_BEFORE_EXP` | `false` | Auto-close short-dated options 1 day before expiration |
| `BROKER_OPTIONS_LEG_FAIL_MODE` | `suppress` | Any leg unfilled: `suppress` / `auto_unwind` (dangerous, default off) |
| `BROKER_LEAPS_TRIM_MODE` | `reject` | LEAPs are conviction trades; default refuse to trim |
| `BROKER_LEAPS_TP_MODE` | `reject` | LEAPs default refuse to take partial profits |
| `BROKER_LEAPS_AUTO_CLOSE_BEFORE_EXP_DAYS` | `30` | Larger window than short-dated to avoid theta cliff |

### 10.4 Investor

| Var | Default | Meaning |
|---|---|---|
| `BROKER_INVESTOR_DCA_PARTIAL_MODE` | `continue` | DCA tranche fails: `continue` (mirror future) / `suppress` (halt series) |

### 10.5 Reconciler

| Var | Default | Meaning |
|---|---|---|
| `BROKER_RECONCILE_INTERVAL_SEC_TRADER` | `300` | Trader reconciler cadence |
| `BROKER_RECONCILE_INTERVAL_SEC_INVESTOR` | `3600` | Investor reconciler cadence |
| `BROKER_RECONCILE_INTERVAL_SEC_LEAPS` | `86400` | LEAPs daily |
| `BROKER_RECONCILE_FAIL_THRESHOLD` | `3` | Consecutive failures before operator escalation |
| `BROKER_DRIFT_TOLERANCE_EQUITY_SHARES` | `0.01` | Below this absolute diff, not flagged |
| `BROKER_DRIFT_TOLERANCE_OPTIONS_CONTRACTS` | `0` | Any options drift is flagged |
| `BROKER_ORPHAN_RETRY_HOURS` | `24` | How long before broker-orphan escalates to critical |
| `BROKER_ORPHAN_AUTO_RETRY_MAX` | `3` | Max auto-retry attempts before manual intervention |

### 10.6 User-modification policy (v2)

| Var | Default | Meaning |
|---|---|---|
| `BROKER_USER_SL_MOD_MODE` | `revert` | User changed SL price: `revert` / `accept` / `notify_only` |
| `BROKER_USER_TP_MOD_MODE` | `revert` | User changed TP price/qty: `revert` / `accept` / `notify_only` |
| `BROKER_USER_OCO_CANCEL_MODE` | `restore` | User cancelled OCO orders: `restore` / `accept` |
| `BROKER_USER_PARTIAL_CLOSE_MODE` | `accept` | User trimmed manually: `accept` (scale future) / `reject_future_actions` |
| `BROKER_USER_FULL_CLOSE_MODE` | `accept_and_suppress` | User closed fully: `accept_and_suppress` (default) / `reject_close` (extreme) |
| `BROKER_USER_REVERT_MAX_PER_TRADE_PER_DAY` | `5` | Auto-suppress mirror after this many reverts on same trade |

### 10.7 Daily owner email

| Var | Default | Meaning |
|---|---|---|
| `BROKER_DAILY_DIGEST_ENABLED` | `true` | Master switch for the per-broker-owner email |
| `BROKER_DAILY_DIGEST_CRON_UTC` | `30 21 * * *` | When to send (21:30 UTC = 4:30 PM ET) |
| `BROKER_DAILY_DIGEST_SKIP_IF_QUIET` | `true` | Skip the email if no trades + no position changes in 24h |

---

## 11. Design principles

1. **Manifest is the source of truth for "should we mirror this trade?"**, broker positions are the source of truth for "is the underlying state still what we expect?". Both must agree before any reducing order goes out.
2. **Fail closed on any mirror decision.** When in doubt, refuse to act. Refusing a sell against unknown state is far safer than placing one.
3. **Per-trade isolation.** A drift on trade ABC must NOT affect mirror activity for trade DEF on the same ticker. The manifest is keyed by (user, trade_id, broker_account).
4. **Mode + instrument + vehicle awareness.** Each cell of the (Trader/Investor × Shares/Options) matrix has its own decision rules, reconciler cadence, and toggle. Within Options, each archetype (long_call, long_put, vertical_spread, LEAPs, straddle, moonshot) is independently toggleable. **All option archetypes default OFF**; only equity_long defaults ON.
5. **User in the loop for anything materially wrong.** Drift, orphan, suppression are all user-visible events. We never silently change their broker state.
6. **Operator override always available.** Mission Control has Force Sync, Suppress, Force Exit, Mark Manual, Force Re-Sync, and Accept-User-Modifications for every trade.
7. **Defense in depth.** Manifest check + portfolio check + per-order $ cap + per-vehicle daily cap + global kill switch. Each layer fails independently; each layer is logged in the audit.
8. **Reconcile loud, mirror quiet.** Reconciler logs every compare, every drift, every state change. Mirror logs the minimum (decision + outcome). Different cadences, different verbosity.
9. **All-or-nothing for options spreads.** Multi-leg trades NEVER end up with one leg open and one closed via automation. Operator manually unwinds if it ever happens.
10. **SL hits are sacred.** Never scale an SL hit by partial-fill ratio. If the model says stop-out, sell everything we hold for that trade (capped at actual broker qty, never to short).
11. **No naked shorts.** Equity SELL_SHORT, options selling-to-open without the underlying, cash-secured puts, covered calls — all OUT of scope. Re-introducing requires its own workstream with risk review + operator consent flow. **v2 addition.**
12. **OCO orders are model-managed property.** If the operator opts into broker-side OCO, the bridge owns the SL + TP order lifecycle. User-initiated changes to those orders revert by default. Users CAN close positions early (treated as exit); they cannot modify model-managed orders without us noticing + restoring. **v2 addition.**
13. **Per-broker-owner accountability.** The user whose IBKR / RH account is connected receives a daily digest summarizing the day's activity on THEIR account, including a tomorrow-outlook section. This makes the user a stakeholder, not just a permission-grantor. **v2 addition.**

---

## 12. Open questions for design review

1. **Where does the manifest live?** Main worker D1 (joins to `trades`) vs bridge KV (closer to decisions). Lean: main worker D1 with a bridge-side 60-second read-through cache.
2. **What happens to existing operator trades that pre-date the manifest?** Grandfather them as `untracked` with operator manual confirm to convert each one. Document the transition runbook.
3. **DCA tranche identity.** Does a model "tranche" map 1:1 to a broker order, or do we batch multiple tranches into one broker order if they fire within seconds? Lean: 1:1 for traceability; performance is not a concern at our volume.
4. **Spread leg correlation.** If the broker returns a combo order ID but no per-leg fill detail, how do we verify each leg landed? Need to call `getOrderDetail` after fill confirmation. Add to Phase D scope.
5. **Reconciler cost.** Calling `getEquityPositions` every 5 min per user adds N×288 API calls/day. For 100 users that's 28,800/day. IBKR's Client Portal has no documented daily cap but is rate-limited per-second. Validate before Phase C ships.
6. **Investor DCA + Trader trade on same ticker.** What if the operator has an Investor LONG AMZN position AND a Trader trade fires for AMZN? Two manifest rows, two distinct broker order ID sets, but they share the underlying position. Reconciler must reconcile against the SUM of both manifest rows' expected qty. Document.
7. **OCO orders at broker.** When does the bridge place actual stop/TP orders at IBKR vs manage them in-process? Lean: in-process by default (operator config to opt into OCO). Avoid drift from broker-side modifications.

---

## 13. Daily owner email — per-broker-account digest

Each connected broker user (the OWNER of the connected portfolio —
not just any TT user) receives a daily digest email summarizing
what happened on THEIR account. Different from the existing TT
daily brief, which is market-wide; this is account-specific.

### 13.1 Recipient + cadence

- **Recipient:** `user.email` of every user with at least one
  successfully-connected broker (`user.status='connected'` AND
  `user.broker_integration_enabled=true`)
- **Send time:** 30 minutes after US equity market close (4:30 PM ET = 21:30 UTC)
- **Skip rule:** no trades executed AND no open positions changed in the last 24h → skip the email (avoid noise). Configurable per-user opt-in for "always send."

### 13.2 Email content

```
Subject: [Timed Trading] Your account today — 2 trades, +$45.20 (+2.9%)

Hi [user_display_name],

Here's what happened in your IBKR account U15118548 today.

══════════════════════════════════════════════════════════
EXECUTED TRADES (2)
══════════════════════════════════════════════════════════
  09:31 ET   BUY  10 sh  TSLA @ $250.10   = $2,501.00
             (Trader entry · trade ABC-TSLA-...)
  14:22 ET   SELL  5 sh  TSLA @ $258.40   = $1,292.00
             (Trader TP1 hit · realized +$41.50)

══════════════════════════════════════════════════════════
OPEN POSITIONS (3)
══════════════════════════════════════════════════════════
  TSLA   5 sh    avg $250.10   last $258.40   +$41.50  (+3.32%)
  AMZN  12 sh    avg $182.40   last $185.90   +$42.00  (+1.91%)
  NVDA  AAPL  long call $180  exp 2026-09-19  bought $4.20 → mark $3.85  ($35.00 / contract)

══════════════════════════════════════════════════════════
DAY P&L
══════════════════════════════════════════════════════════
  Realized:    +$41.50
  Unrealized:  +$83.50 (TSLA + AMZN + NVDA marks)
  Total day:   +$125.00  (+2.9% of starting equity)

  Equity start: $4,275.00
  Equity end:   $4,400.00

══════════════════════════════════════════════════════════
TOMORROW'S OUTLOOK
══════════════════════════════════════════════════════════
  Market context: Daily Brief headline — "Resilient tape, breadth
    improving into close. Mega-cap leadership intact; small-caps
    consolidating."

  Trades you're watching:
    • TSLA — at TP1, runner half left. Next TP at $268. SL trailed to $254.
    • AMZN — at hold zone, no model action expected.
    • NVDA (LEAPS) — held; long-thesis intact, 8 months to expiration.

  No new entries expected pre-market (no setup-quality tickers in
  the model's current top-30).

══════════════════════════════════════════════════════════
QUICK LINKS
══════════════════════════════════════════════════════════
  → View today's full audit log: https://timed-trading.com/account/brokers#audit
  → Pause auto-mirror: https://timed-trading.com/account/brokers
  → Daily brief in full: https://timed-trading.com/today

— The Timed Trading System

You're receiving this because your IBKR account is connected to
Timed Trading. To stop these digests: settings → email preferences
→ daily account digest.
```

### 13.3 Generation pipeline

```pseudo
Daily cron at 21:30 UTC:
  for user in users WHERE status='connected' AND broker_integration_enabled=true:
    # 1. Pull today's bridge audit log entries for this user.
    audit = await readAudit(env, { user_id: user.user_id, since: midnight_ET })
    executed_trades = audit.filter(a => a.action == 'place' && a.status == 'ok')

    # 2. Pull current positions snapshot.
    portfolio = await brokerAdapter.getPortfolio(env, user)
    positions = await brokerAdapter.getEquityPositions(env, user)
    options_positions = await brokerAdapter.getOptionsPositions(env, user)

    # 3. Skip-if-quiet check.
    if executed_trades.length == 0 AND positions are unchanged from yesterday:
       if user.daily_digest_always_send != true:
         continue  # skip

    # 4. Compute day P&L.
    realized = sum(audit where exit_realized_pnl)
    unrealized = sum(positions.unrealizedPnl) + sum(options_positions.unrealizedPnl)
    equity_start = await readKv(`timed:user:${user_id}:equity_open_${today}`)  # captured at 09:30 ET cron
    equity_end = portfolio.equity_usd

    # 5. Build tomorrow's outlook section.
    outlook = await buildOutlookFor(user, env)
    # Outlook source:
    #   - Today's Daily Brief headline (already generated by existing
    #     cron) for market context
    #   - User's open manifest rows for "what we're watching"
    #   - Top-30 scoring queue for "no new entries expected"

    # 6. Render email + send.
    email = renderDailyOwnerDigest(user, executed_trades, positions, options_positions, day_pnl, outlook)
    await sendEmail(env, user.email, email)

    # 7. Record sent timestamp.
    await writeKv(`timed:user:${user_id}:daily_digest_sent_${today}`, Date.now())
```

### 13.4 User control

In `/account/email-preferences` (a new page or section in
`/account/brokers`), the user can:
- Opt in / out of the daily account digest
- Toggle "Send even on quiet days"
- Set timezone (default America/New_York, controls send-time format only)

### 13.5 Privacy + compliance

- The digest is sent to the user's EMAIL ON FILE (verified at Stripe checkout). It does NOT cc the operator.
- Operator can see the SEND LOG in Mission Control (when, to whom, what subject) for audit purposes but NOT the body.
- The "Tomorrow's Outlook" section explicitly says "expected" and "watching" — never advice. Disclaimers identical to the public Daily Brief.

---

## 14. User-modified broker orders — handling

The operator's preference: **revert user changes to model-managed
orders by default**, but **accept user-initiated closes as a valid
exit signal**.

This is enforced via two distinct flows in the reconciler.

### 14.1 Detection during reconciliation

Every reconciler cycle (per §5), for each manifest row with model_status
in `OPEN | PARTIALLY_CLOSED`, the bridge also queries the broker's
open orders (`GET /iserver/account/orders`) and checks for:

- **Manifest's OCO SL order ID still exists**, but `stopPrice` differs from `manifest.expected_sl_price` → user modified the SL
- **Manifest's OCO TP order ID still exists**, but `limitPrice` or qty differs from `manifest.expected_tp_price` → user modified the TP
- **Manifest's OCO orders are missing entirely** AND broker still has position → user cancelled them
- **Position qty has dropped below `manifest.broker_remaining_qty` AND no model-emitted SELL is in flight** → user manually closed (or trimmed)

### 14.2 Per-detection action

| Detection | Default action | Operator config knob |
|---|---|---|
| User modified SL price | **Revert** — cancel user's SL order, re-place at `manifest.expected_sl_price`. Log to audit. Email the user info-tier: "We restored the model's SL on TSLA. Please don't modify model-managed orders." | `BROKER_USER_SL_MOD_MODE = revert` (default) / `accept` / `notify_only` |
| User modified TP price/qty | **Revert** — cancel user's TP order, re-place at model's expected TP. Same notification. | `BROKER_USER_TP_MOD_MODE = revert` (default) / `accept` / `notify_only` |
| User cancelled OCO SL/TP entirely | **Re-place** — restore both orders at model's expected prices. Same notification. | `BROKER_USER_OCO_CANCEL_MODE = restore` (default) / `accept` |
| User partially trimmed (broker qty < manifest qty, no model SELL in flight) | **Accept as user-initiated close** — update `manifest.broker_remaining_qty` to actual, mark `sync_state='in_sync'` with note "user-trimmed". Future model TRIM/EXIT scales to the new (reduced) qty. Email user info-tier: "We detected you closed 3 of 10 TSLA shares outside Timed Trading. The model will now act on your reduced position size." | `BROKER_USER_PARTIAL_CLOSE_MODE = accept` (default) / `reject_future_actions` |
| User fully closed position | **Accept as user-initiated full exit** — mark `manifest.model_status='CLOSED', model_exit_reason='USER_MANUAL_EXIT', sync_state='mothership_orphan', mirror_suppressed=1`. Email user info-tier: "You closed TSLA outside Timed Trading. We've marked the model trade as closed; no future actions on this trade will be mirrored." | `BROKER_USER_FULL_CLOSE_MODE = accept_and_suppress` (default) / `reject_close` (extreme — never recommended) |

### 14.3 Why "revert SL/TP changes" but "accept early close"

| Aspect | SL/TP modification | Full / partial close |
|---|---|---|
| User intent | Often a knee-jerk reaction to short-term volatility | Considered decision — user pulled the trigger |
| Reversibility | Easy — just re-place the order | Hard — buying back would slip + restart cost-basis tracking |
| Risk if accepted | Model's setup may be invalidated (model thought there was 30% room to SL, now there's 5%) | User accepted the outcome — they got their fill |
| Lock-tight principle | Model-managed order should remain model-managed | User has the ultimate right to their own broker account |

### 14.4 Notification cadence for revert events

- **First revert per user per day:** immediate info email with "what we did and why"
- **Repeated reverts on same trade (3+ in a session):** escalate to warn — "We've reverted your changes to trade ABC's SL 3 times today. Please pause the trade or contact support if you want to take it over manually."
- **After 5 reverts on same trade:** auto-suppress the trade mirror (`mirror_suppressed=1`) and send a critical email — "We've stopped mirroring trade ABC because we keep restoring your changes. Take it over fully or re-enable mirror in the dashboard."

### 14.5 Operator override

Mission Control's "Mirror Sync — Per-User" section adds a per-trade
toggle: **"Accept user modifications"** (default OFF — revert). When
the operator flips this ON for a specific trade, the bridge stops
reverting and treats user changes as authoritative. Useful for cases
where the user has explicitly told support "I'm taking over this
trade."

---

## 15. Reference docs

- `tasks/2026-05-29-broker-bridge-phase1-plan.md` — original bridge plan
- `tasks/2026-06-01-byob-broker-connect-plan.md` — BYOB plan (depends on this manifest)
- `skills/broker-bridge.md` — operator runbook
- `worker-bridge/bridge-guards.js` — current preflight + portfolio guard (PR #409)
- `worker-bridge/bridge-storage.js` — current per-user storage shape
- PR #409 — current portfolio-aware (position-level) guard
- `worker/index.js` — `processTradeSimulation` is the central dispatch for Trader actions
- `worker/options-plays.js` — options structure definitions
- `worker/investor-*.js` — investor mode logic
