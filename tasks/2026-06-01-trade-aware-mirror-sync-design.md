# Trade-Aware Mirror Sync — Design (Full Scope)

**Created:** 2026-06-01 · **Status:** Design (no code yet) · **Owner:** TBD

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
| **Active Trader** | LONG / SHORT positions, hard SL + TP1/TP2/TP3 ladder. Cadence: minutes-to-days. | Long call / put / vertical spread / straddle / moonshot. Defined-risk; expiration cliff. Cadence: days-to-weeks. |
| **Investor** | Zone-based: accumulate / hold / reduce / distribute. DCA on entries. No hard SL. Cadence: weeks-to-months. | Rare in TT today (LEAPs only). Design touches it but does not lead. |

The design treats each combination as a first-class flow with the same
manifest backbone but mode/instrument-specific:
- entry shape (single fill vs multi-leg vs DCA tranche)
- reducer semantics (whole-position vs lot-by-lot vs leg-by-leg)
- drift tolerance (tight for Trader options, looser for Investor DCA)
- reconciler cadence (5 min for Trader, hourly for Investor)

---

## 2. Action taxonomy — what each simulation event means at the broker

Every TT trade has a deterministic lifecycle. Each event maps to a
concrete broker action (or a no-op). The bridge MUST handle each
combination correctly.

### 2.1 Trader · Shares

| Event | Broker action | Quantity semantics | Lock-tight rules |
|---|---|---|---|
| **entry** | `BUY` (long) or `SELL_SHORT` (short) — market or limit | Full intended qty | Manifest row created with `model_intended_qty`. If broker rejects → manifest `sync_state=rejected`, `mirror_suppressed=1`. |
| **trim** | `SELL` (long) or `BUY_TO_COVER` (short) of N% of remaining | qty = `floor(broker_remaining_qty × trim_pct)` | Bridge reads `broker_remaining_qty` from manifest (last-known-good); never trusts what's there at request time without portfolio check. **Trim NEVER acts on more than was originally opened by THIS trade**. |
| **update SL** | Default: **no broker action** (TT manages SL in-process). Operator config: place/modify OCO stop order at broker. | n/a | If OCO mode: track `broker_stop_order_id` in manifest. Modify replaces previous order; bridge first cancels then re-places. |
| **take profit hit (TP1/TP2/TP3)** | `SELL` of TP-tier qty (e.g. 33%/33%/34% or 50%/25%/25% — model-defined) | qty per-tier from model | TP tier is recorded on manifest. If broker already executed the OCO TP, recognize fill and update manifest without a duplicate close. |
| **SL hit** | `SELL` of entire remaining position | qty = `broker_remaining_qty` | Bypasses normal "scale by partial fill" because it's a hard stop. **NEVER scaled** — if model fills 6 of 10 and SL hits, bridge sells all 6. |
| **exit** (model-driven, not SL/TP) | `SELL` of entire remaining position | qty = `broker_remaining_qty` | Same as SL hit qty-wise; different reason code in audit. |

### 2.2 Trader · Options

| Event | Broker action | Quantity semantics | Lock-tight rules |
|---|---|---|---|
| **entry** | `BUY_TO_OPEN` (long call/put) or multi-leg combo order (vertical / iron condor) | qty in contracts; for spreads: equal across legs | Manifest stores full multi-leg structure (each leg's contract symbol, strike, expiration). If ANY leg fails to fill → entire trade marked `partial_fill` + `mirror_suppressed=1` (operator manual recovery). |
| **trim** | `SELL_TO_CLOSE` partial. For spreads: usually NOT trimmed (close whole spread or none) | Single-leg only; spreads default `reject` for trim | Operator config `BROKER_OPTIONS_TRIM_SPREAD_MODE` = `reject` (default) / `legs_in_lockstep` / `allow_unequal`. |
| **update SL** | Almost never used (options have intrinsic max-loss). Operator config off by default. | n/a | If on: same OCO-modify logic as shares. |
| **take profit hit** | `SELL_TO_CLOSE` at TP tier | For spreads: close all legs proportionally | Same rule as trim: prefer all-or-nothing for spreads. |
| **SL hit** | `SELL_TO_CLOSE` everything | All contracts / all legs | NEVER partial; if any leg lookup fails, fail-closed and notify operator (orphan leg = uncovered position = catastrophic). |
| **exit** | `SELL_TO_CLOSE` everything | All contracts / all legs | Same as SL hit. |
| **expiration approaching** | Auto-`SELL_TO_CLOSE` at T-1 day if not already closed (operator config) | All | Default OFF — operator opts in. Prevents auto-assignment risk. |

### 2.3 Investor · Shares

| Event | Broker action | Quantity semantics | Lock-tight rules |
|---|---|---|---|
| **entry** (accumulate zone) | `BUY` — may be one of several DCA tranches | qty per tranche; total tracked across the DCA series | Manifest tracks the DCA series as ONE logical trade with multiple `entry_tranches[]`. Each tranche has its own broker_order_id. |
| **trim** (reduce zone) | `SELL` partial — typically 25% of current position | qty = `broker_remaining_qty × 0.25` | Investor positions can grow through DCA; trim percentages compound against current holding, not original intent. |
| **update SL** | n/a — investors don't use hard SL | — | Skip. |
| **take profit hit** | Re-mapped to "distribute zone" close — partial or full | Model-defined zone exit | Investor's "TP" is a zone state change, not a price hit. Manifest stores `distribute_zone_entry_ts`. |
| **SL hit** | Rare — only fires on catastrophic fundamentals (e.g. delisting risk). Maps to full close. | All remaining | Treated as critical operator-attention event regardless of size. |
| **exit** (distribute zone) | `SELL` of full remaining position | All remaining | Same as Trader exit. |

### 2.4 Investor · Options

Out of scope for v1. The design accommodates it via the manifest's
generic `instrument_type` field; semantics deferred.

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

### Phase D — Options + Investor reconciler extensions (~4 days)

- [ ] Options leg-aware reconciliation
- [ ] Options expiration cron (T-1 day check + post-expiration archival)
- [ ] Investor DCA tranche tracking in `dca_tranches[]`
- [ ] Investor 60-min reconciler cadence (cheaper, slower-moving positions)
- [ ] Per-mode decision matrix from §4.2/§4.3 implemented

**Scope:** All 4 (mode × instrument) cells covered. Trader options trim
spread modes implemented. Investor DCA partial-tranche handling.

### Phase E — User notification + Mission Control surface (~3 days)

- [ ] Email templates for each severity tier
- [ ] `notifyUserOfDrift(user, manifest_row, severity)` in reconciler
- [ ] In-app banner on `/today.html` for affected users
- [ ] Mission Control "Mirror Sync — Per-User" section per §8
- [ ] Operator buttons: Force Sync, Suppress, Force Exit, Mark Manual, Force Re-Sync from Broker
- [ ] Daily digest cron for `info`-tier events
- [ ] Operator Discord webhook for `critical` tier

**Scope:** End-to-end. Users informed, operators have full visibility +
manual override controls.

### Phase F — Polish (later, post-BYOB launch)

- [ ] Auto-retry broker-orphan exits (exponential backoff)
- [ ] Tax-lot tracking (when broker returns lot IDs)
- [ ] Per-trade kill switch UI on each user's `/account/brokers` page
- [ ] Cross-trade pyramiding detection (warn when same ticker has N concurrent open trades)
- [ ] Reconciler runtime metrics + per-user health score in MC

---

## 10. Operator config knobs (consolidated)

All env vars on the bridge worker:

| Var | Default | Meaning |
|---|---|---|
| `BROKER_POSITION_CHECK_MODE` | `reject` | (PR #409) `reject` / `cap` / `off` for position-level guard |
| `BROKER_MANIFEST_REDUCE_NO_ROW` | `reject` | Reducing order with no manifest row. `reject` / `allow_if_position` (deferred to portfolio check) / `off` |
| `BROKER_PARTIAL_FILL_MODE` | `scale` | `scale` / `reject` / `literal` |
| `BROKER_OPTIONS_TRIM_SPREAD_MODE` | `reject` | Spread trim handling: `reject` / `legs_in_lockstep` / `allow_unequal` |
| `BROKER_OPTIONS_AUTO_CLOSE_BEFORE_EXP` | `false` | Auto-close T-1 day; default off to give operator manual control |
| `BROKER_OPTIONS_LEG_FAIL_MODE` | `suppress` | Any leg unfilled: `suppress` / `auto_unwind` (dangerous) |
| `BROKER_INVESTOR_DCA_PARTIAL_MODE` | `continue` | DCA tranche fails: `continue` (mirror future tranches) / `suppress` (halt the whole series) |
| `BROKER_RECONCILE_INTERVAL_SEC_TRADER` | `300` | Trader reconciler cadence |
| `BROKER_RECONCILE_INTERVAL_SEC_INVESTOR` | `3600` | Investor reconciler cadence |
| `BROKER_RECONCILE_FAIL_THRESHOLD` | `3` | Consecutive failures before operator escalation |
| `BROKER_DRIFT_TOLERANCE_EQUITY_SHARES` | `0.01` | Below this absolute diff, not flagged |
| `BROKER_DRIFT_TOLERANCE_OPTIONS_CONTRACTS` | `0` | Any options drift is flagged |
| `BROKER_ORPHAN_RETRY_HOURS` | `24` | How long before broker-orphan escalates to critical |
| `BROKER_ORPHAN_AUTO_RETRY_MAX` | `3` | Max auto-retry attempts before manual intervention |

---

## 11. Design principles

1. **Manifest is the source of truth for "should we mirror this trade?"**, broker positions are the source of truth for "is the underlying state still what we expect?". Both must agree before any reducing order goes out.
2. **Fail closed on any mirror decision.** When in doubt, refuse to act. Refusing a sell against unknown state is far safer than placing one.
3. **Per-trade isolation.** A drift on trade ABC must NOT affect mirror activity for trade DEF on the same ticker. The manifest is keyed by (user, trade_id, broker_account).
4. **Mode + instrument awareness.** Trader is fast + tight tolerance; Investor is slow + DCA-aware; Equity is integer-share simple; Options is leg-by-leg, expiration-aware, can-go-to-zero. The reconciler treats each cell of the matrix differently.
5. **User in the loop for anything materially wrong.** Drift, orphan, suppression are all user-visible events. We never silently change their broker state.
6. **Operator override always available.** Mission Control has Force Sync, Suppress, Force Exit, Mark Manual, Force Re-Sync for every trade.
7. **Defense in depth.** Manifest check + portfolio check + per-order $ cap + daily cap + kill switch. Each layer fails independently; each layer is logged in the audit.
8. **Reconcile loud, mirror quiet.** Reconciler logs every compare, every drift, every state change. Mirror logs the minimum (decision + outcome). Different cadences, different verbosity.
9. **All-or-nothing for options spreads.** Multi-leg trades NEVER end up with one leg open and one closed via automation. Operator manually unwinds if it ever happens.
10. **SL hits are sacred.** Never scale an SL hit by partial-fill ratio. If the model says stop-out, sell everything we hold for that trade (capped at actual broker qty, never to short).

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

## 13. Reference docs

- `tasks/2026-05-29-broker-bridge-phase1-plan.md` — original bridge plan
- `tasks/2026-06-01-byob-broker-connect-plan.md` — BYOB plan (depends on this manifest)
- `skills/broker-bridge.md` — operator runbook
- `worker-bridge/bridge-guards.js` — current preflight + portfolio guard (PR #409)
- `worker-bridge/bridge-storage.js` — current per-user storage shape
- PR #409 — current portfolio-aware (position-level) guard
- `worker/index.js` — `processTradeSimulation` is the central dispatch for Trader actions
- `worker/options-plays.js` — options structure definitions
- `worker/investor-*.js` — investor mode logic
