# Entangled Mirror: model action to broker action, for any number of accounts

Status: **decided; Phase 0 and Phase 1 shipped** (2026-09-24, PR #1499). Pilot lane: index day-trade options.
Target: every mirrored lane (Short Term equity, index-trend LETF, day trades).

## 1. The requirement

The model decides; every connected account follows. With two accounts today
and 20, 200 or 2,000 later:

1. **Traceable both ways.** From any model action, list every broker order it
   caused in every account. From any broker order, name the one model action
   it serves.
2. **No orphans, by construction.** Not "found and healed later" — a model
   action cannot exist without a durable per-account intent, and a broker
   order cannot exist without a back-link.
3. **Trims and exits are mirror images.** After the model trims a position to
   a third of its size, every account holds a third of *its* sleeve. After the
   model exits, every account is flat.
4. **A mismatch always has a name, and the names are few.** Insufficient
   funds, a cap, a lot too small to divide, or the account holder acting on
   their own. Anything else is a defect and pages.

The word for this is entanglement: each account's sleeve is not a copy that
gets updated, it is the same position observed at a different size. Measuring
one tells you the other.

## 2. Why today's paths cannot get there

Both mirrored paths were read end to end for this design. The Short Term
equity path is the closer of the two and is the one to build from, but
neither meets the requirement, and the reasons are structural rather than
bugs to patch.

### 2.1 Day-trade options

| Property | Today | Consequence |
|---|---|---|
| Per-account state | Only the operator has a record (`timed:opt-dt-mirror:<signal>`, KV). Partners have none. | "What does account N hold for signal S?" has no answer except asking the broker. |
| Operator | Special-cased through `env.ADMIN_EMAIL` in the gate, the reconciler, prefs and the risk ledger. | The design does not generalise to account #3. |
| Reduce sizing | Operator: `min(trimSellQty(mirroredTotal), paperQty, remaining)`. Partner: rides on the operator's order — the operator's qty, clamped to whatever the account holds (`clampReduceToHeld`). | When the operator's 1-lot mirror skips a trim (`mirror_single_lot_no_trim`), no request reaches the bridge, so no partner trims either, whatever it holds. When one does go out, a partner holding 3 on a model trim from 3 to 1 sells the operator's 1, where the mirror image is 2. |
| Fan-out | `Promise.all` over every target inside one HTTP request (`fanOutOptionsMirrors`). | One request's subrequest and CPU budget carries every account; one slow broker call holds all of them. |
| Risk budget | A separately stored ledger per account per day. | Drifts from the positions it describes. 2026-09-24: $448 of a $500 budget charged to positions that no longer existed, which blocked QQQ 744C. |
| Healing | Reconciler compares the operator's mirror only; partners heal only if an operator re-fire happens to fan out again. | No invariant is checked for any account but one. |
| Identity | The signal id *is* the contract, and a re-entry on the same contract reuses it; `roundReset` clears round one's flags so round two can trade. | A position id that is not unique per round cannot be a join key. |
| Durable intent | None. An event dispatches directly; if the isolate dies, nothing remembers the order was owed. | The 2026-09-24 working-reduce and stuck-pending incidents were all "nobody asked again". |

### 2.2 Short Term equity (the reference)

This path already has most of the shape: a stable `trade_id`, a per-account
sleeve (`mirror_trade_manifest`, keyed `(user_id, trade_id,
broker_account_id)`), relational entry sizing, reduces that act on the
account's own sleeve, a live-holdings clamp, a durable retry outbox for
reduces (`broker_intents`), and a reconciler with orphan states. Four gaps
keep it from being the answer as-is:

- **Reduces are deltas, and the units disagree.** This is a live defect, not
  a scaling concern. The model sends `reduce_pct = tgt - oldTrim` — a
  fraction of the *original* position — on every trim
  (`worker/index.js`, TRIM dispatch). The bridge computes
  `intended = broker_remaining × pct` — a fraction of the *current* sleeve
  (`reconcileReducerQty`, `worker-bridge/bridge-guards.js`), and the pct
  branch runs before the full-exit branch. Worked through for one account
  holding 100 shares:

  | Model step | Model sends | Bridge sells | Account holds | Should hold |
  |---|---|---|---|---|
  | Trim to 50% | `trim`, pct 0.50 | 0.50 × 100 = 50 | 50 | 50 |
  | Trim to 75% | `trim`, pct 0.25 | 0.25 × 50 = 12.5 | 37.5 | 25 |
  | Trim to 100% | `exit`, pct 0.25 | 0.25 × 37.5 = 9.4 | 28.1 | 0 |

  A single trim followed by a trim-to-full (pct 0.50, side `exit`) leaves
  25 of 100 behind. The model is flat, the manifest reads `broker_orphan`,
  and `catchup-trader-exits` sells the leftover later at a different price.
  That is the orphan-then-heal loop this design exists to remove.
- **The sleeve table disagrees with the brokers.** On 2026-09-24 the
  manifest held 178 Short Term rows: 83 `in_sync`, 67 `rejected`, 24
  `broker_orphan`, 4 `mothership_orphan`. Twenty-seven rows were trades the
  model had closed that still recorded broker shares — and 25 of those were
  in tickers neither mirrored account holds at all (UNP, XYZ, FLR, IYT,
  NBIS, USO, RBLX, PH, LULU, XLRE and others). The table meant to be the
  per-account truth carries phantom sleeves, which is also why the
  `reduce_pct` defect's live footprint cannot be measured from it. Its
  arithmetic is certain; its count is not.
- **The sleeve table is equity-only and has accreted.** Options never write
  `mirror_trade_manifest`. Its `sync_state` vocabulary (`in_sync`,
  `partial_fill`, `broker_orphan`, `mothership_orphan`, `expired`,
  `reconcile_error`, `untracked`, `rejected`, `mirror_suppressed`) mixes
  outcomes, divergences and defects in one column.
- **It stops seeing accounts at a fixed count.** `listConnectedUsers` makes
  one `KV.list` call with a limit and no cursor, and every scheduled bridge
  path (the manifest reconciler, the daily digest) calls it with 100. The
  101st `bridge:user:` key is never reconciled — always the same ones,
  lexicographically, silently. One owner already has five account rows, so
  this cliff is roughly twenty owners away, not two thousand. The options
  fan-out (`listMirrorParticipants`) reads the first 200 account rows and
  only then filters to mirror participants.

## 3. The model

Five records. Everything else is derived.

```
 model_position ──1:N──▶ model_leg              (what the model did)
       │                     │
      1:N                   1:N
       ▼                     ▼
 mirror_sleeve ──1:N──▶ mirror_sleeve_leg ──1:N──▶ mirror_order_attempt
 (one per account)      (one per account per     (one per client_order_id
                         model leg)               sent to the broker)
```

- **model_position** — one round of one model trade. For day trades:
  `position_id = <signal_id>#r<round>`, so a re-entry on the same contract is
  a new position rather than a reset of the old one.
- **model_leg** — one model action on that position, numbered `seq = 0,1,2…`.
  It records the model's **remaining quantity after the action**, not the
  amount sold. BUY is seq 0.
- **mirror_sleeve** — the entangled twin of a model position in one account.
  Created for every eligible account when seq 0 is recorded, whether or not
  the account ends up buying.
- **mirror_sleeve_leg** — the twin of one model leg in one account. Created
  for every open sleeve in the same write that creates the model leg.
- **mirror_order_attempt** — one `client_order_id` sent to a broker for one
  sleeve leg. More than one per sleeve leg is normal: a rejected or expired
  order is re-placed under a new id, because Webull refuses a reused one.

### 3.1 Target state, never deltas

The mirror-image rule is one pure function, and it is the only thing allowed
to decide a broker quantity after entry:

```js
// Contracts this account should hold now.
function sleeveTarget(model, sleeve) {
  if (!(sleeve.opened_qty > 0)) return 0;          // never bought
  if (!(model.remaining_qty > 0)) return 0;        // model is flat
  const raw = sleeve.opened_qty * (model.remaining_qty / model.opened_qty);
  // Never flat while the model is still in: a 1-lot sleeve on a model trim
  // keeps its contract (see indivisible_lot).
  return Math.min(sleeve.opened_qty, Math.max(1, Math.round(raw)));
}
```

Every leg, every retry and every reconciliation pass does the same thing:
compute the target from the model's *current* remaining fraction, read what
the account holds, and sell the difference. Consequences:

- **Laddered trims compose correctly by construction.** The model's
  remaining fraction is the only input; there is no delta to be expressed in
  the wrong unit (§2.2).
- **Idempotent.** Running it twice sells nothing the second time. The event
  path and the reconciler become the same call, so "re-fire the missing
  reduce" stops being a separate mechanism with its own bugs.
- **Self-healing from any state.** A missed trim followed by an exit simply
  converges to zero; nothing has to replay the trim first.

Worked for the day-trade book sizes (model opens 3, trims 2, keeps 1 — the
model's own `trimSellQty(3) = 2`):

| Sleeve opened | raw target | target | Sells on the trim | Divergence |
|---|---|---|---|---|
| 3 | 1.00 | 1 | 2 | — |
| 2 | 0.67 | 1 | 1 | — |
| 1 | 0.33 | 1 | 0 | `indivisible_lot` |

The 1-lot row is not a special case bolted on. It is the model's own rule
for a book of that size: a 1-lot paper book does not sell at 1R either — it
PROTECTs (stop to breakeven). The sleeve behaves exactly as the model would
if the model had been that size, and later exits coincide, because a trimmed
book and a protected book both carry the breakeven floor and the giveback
trail.

### 3.2 Entry is the only place sizes differ

Sleeves differ in size by design; the ratio locks when the entry settles.

```
proportional = model.opened_qty × account_scale      // equity / model book
opened_qty   = min(proportional, every cap that applies), rounded to lots
```

Whatever cuts `opened_qty` below `proportional` is recorded on the sleeve as
its divergence reason. After the entry window closes, `opened_qty` is the
quantity actually filled (a partial fill cancels the remainder and locks the
ratio at what filled). From then on only §3.1 moves the sleeve.

### 3.3 The closed set of divergence reasons

A sleeve or sleeve leg that does not match its target carries exactly one
reason from this table. The table is the contract: a reason not in it is a
defect by definition.

| Reason | Legs | Evidence required | Seen 2026-09-24 |
|---|---|---|---|
| `insufficient_buying_power` | OPEN | Broker or bridge BP read below cost | Investor DCA buys at $0 cash |
| `daily_loss_budget` | OPEN | Account's derived budget (§5) short of the entry's risk | QQQ 744C |
| `vehicle_daily_cap` | OPEN | Account prefs | 14 entries on 09-23 |
| `per_order_cap` / `max_loss_cap` | OPEN | Account prefs | — |
| `account_too_small` | OPEN | Proportional size rounds below one lot | Partner NVDA |
| `lane_disabled` | OPEN | Account has the lane off | — |
| `unfilled_at_limit` | OPEN | Entry window expired with the limit working | QQQ 741P on 09-23 |
| `indivisible_lot` | REDUCE | `sleeveTarget` clamped up to 1 | Every 1-lot trim |
| `external_reduction` | REDUCE, CLOSE | Holdings read cleanly and show less than the sleeve, with no filled attempt of ours to explain it | IWM 280P, flattened by hand |

Note what is **not** in it: an unreadable account, a rejected sell with an
unmapped reason, a `client_order_id` collision (the IWM 278P stop), an order
the broker cannot find. Those are defects. Transient ones are retried; all
of them page if they outlive their window.

`external_reduction` is the reason the account holder always wins: if a
person sells in their own account, the sleeve re-anchors to what they hold
and the system stops trying to sell contracts that are gone. It requires a
clean holdings read — exactly the distinction the SELL guard already draws
between `no_held_position` and `positions_unavailable`.

## 4. Traceability: the write path

The rule that eliminates orphans: **intent is durable before anything is
sent, and every send is recorded before it leaves.**

```
paper book event (BUY / TRIM / EXIT / STOP)
  │
  ▼  one D1 batch — all or nothing
  INSERT model_leg (position_id, seq, remaining_after, …)
  INSERT mirror_sleeve_leg × every open sleeve   status = pending
  (BUY only: INSERT mirror_sleeve × every eligible account)
  │
  ▼  enqueue one message per batch of sleeve legs (Cloudflare Queue)
  │
consumer, per sleeve leg:
  target  = sleeveTarget(model, sleeve); held = holdings(account)
  current = min(sleeve.remaining_qty, held)   -- never the holder's own contracts
  qty     = current - target                  (≤ 0 → settle, no order)
  INSERT mirror_order_attempt (client_order_id, …)   status = sending
  place order at broker with that client_order_id
  UPDATE attempt → working / filled / rejected (+ broker_order_id)
  UPDATE sleeve_leg, sleeve
```

- **No model action without per-account intents.** The model leg and its
  sleeve legs are one batch. A crash after it leaves `pending` rows that the
  reconciler owns.
- **No broker order without a back-link.** The attempt row is written before
  the order is placed. A crash between the two leaves a `sending` attempt
  whose `client_order_id` is known, so the reconciler asks the broker for it
  by id: it either exists (adopt it) or it does not (mark it dead, place a
  new attempt).
- **One attempt in flight per sleeve.** Because the event path and the
  reconciler run the same converge, two of them can reach the same sleeve at
  once. A new attempt is only inserted when the sleeve has none `sending` or
  `working` (a conditional insert in D1 is the lock), and a working order is
  resolved or cancelled before a replacement goes out. Without this, the
  idempotence of `sleeveTarget` is defeated by two orders both computed
  from the same stale holdings read.
- **`client_order_id` is derived, not composed from fields.** `tt-` plus a
  hash of `(position_id, seq, account_id, attempt)`, fixed length inside
  Webull's 10–40 window. The IWM 278P stop failed because a composed id was
  truncated and two closes collided; a hash cannot collide on shared
  prefixes, and the attempt counter means a retry never reuses an id.
- **Backward lookup is an index, not a search.** `mirror_order_attempt` is
  indexed on `client_order_id` and `broker_order_id`. Any order seen in any
  account's activity with our prefix resolves to its model leg in one read.

### 4.1 Tables

All in the shared `timed-trading-ledger` D1 database, which both the main
worker and the bridge already bind. Lane-agnostic from day one so Short Term
and index-trend can move onto them.

```sql
model_position (
  position_id TEXT PRIMARY KEY,     -- dt:IWM:2026-09-24:2026-09-25:P:279#r1
  lane TEXT, ticker TEXT, instrument TEXT,   -- occ symbol for options
  opened_qty REAL, remaining_qty REAL, status TEXT,
  opened_at INTEGER, closed_at INTEGER, close_reason TEXT
)
model_leg (
  position_id TEXT, seq INTEGER, event TEXT,  -- BUY|TRIM|EXIT|STOP
  remaining_after REAL, paper_price REAL, ts INTEGER,
  PRIMARY KEY (position_id, seq)
)
mirror_sleeve (
  position_id TEXT, account_id TEXT,          -- broker_account_id, never email
  owner_id TEXT,
  proportional_qty REAL, opened_qty REAL, remaining_qty REAL,
  entry_avg REAL, stop_fraction REAL,
  status TEXT,                  -- planned|open|closed|diverged|defect
  divergence_reason TEXT,
  updated_at INTEGER,
  PRIMARY KEY (position_id, account_id)
)
mirror_sleeve_leg (
  position_id TEXT, seq INTEGER, account_id TEXT,
  target_remaining REAL, order_qty REAL, filled_qty REAL, avg_price REAL,
  status TEXT,                  -- pending|working|settled|diverged|defect
  divergence_reason TEXT, lag_ms INTEGER,
  PRIMARY KEY (position_id, seq, account_id)
)
mirror_order_attempt (
  client_order_id TEXT PRIMARY KEY,
  position_id TEXT, seq INTEGER, account_id TEXT, attempt INTEGER,
  broker_order_id TEXT, status TEXT, broker_reason TEXT,
  placed_at INTEGER, settled_at INTEGER
)
-- indexes: sleeve(account_id, status); sleeve_leg(status);
--          attempt(broker_order_id); attempt(position_id, seq)
```

Keys are `account_id` (the broker account), never an email: today the bare
operator email and `#webull#roth-ira` point at the same Webull account, and
only the broker account id is a reliable join.

## 5. Derived, not stored

Anything that can be computed from sleeves must be, because every stored copy
of it has drifted:

- **Daily loss budget per account** =
  `Σ open sleeves (remaining × entry_avg × stop_fraction × 100)` +
  `Σ realised losses from today's settled sleeve legs`. No
  `timed:options:auto-mirror:risk:*` ledger, no `settle`/`release` calls to
  forget — the $448 phantom of 2026-09-24 cannot occur because there is
  nothing separate to fall out of step.
- **Coverage** = a query: sleeve legs not `settled` or `diverged` past their
  window. It replaces joining the model against a 200-row KV ring.
- **Per-account P&L and slippage** = sleeve leg fills against the model leg's
  paper price, per account, per leg.

## 6. The reconciler is the same function

```
every minute during the sell window, for each non-terminal sleeve (sharded):
  converge(sleeve)            -- §3.1 + §4 consumer, unchanged
every N minutes, for each account (sharded by hash):
  holdings sweep: Σ sleeve.remaining per instrument  vs  broker held
    held < sleeves  →  external_reduction (clean read) | defect (unclean)
    held > sleeves  →  unattributed position: labelled, never sold
```

There is no separate "heal" path. A sleeve that missed its trim and then its
exit is converged to zero by the next pass; a `working` order is resolved by
asking for it by `client_order_id`; a `sending` attempt is adopted or retired.
The fixed point of repeated passes is: every sleeve `settled`, or `diverged`
with a reason from §3.3. Anything else after its window is a `defect`.

### 6.1 Invariants

Checked by a property-based test suite against the pure functions, and by a
live `entanglement_integrity` sanity check that reports a count per invariant.

1. Every model leg has exactly one sleeve leg for every sleeve open at that
   seq.
2. Every attempt references a sleeve leg; every order in any account carrying
   our prefix resolves to an attempt.
3. A settled sleeve's `remaining_qty` equals `sleeveTarget` for its latest
   model leg.
4. Per account and instrument, broker held equals the sum of open sleeves
   plus labelled unattributed quantity.
5. Model closed implies every sleeve at zero or `external_reduction` within
   the reduce window.
6. Every divergence reason belongs to §3.3 and to the right leg kind.
7. No stored risk figure exists to disagree with the sleeves.

## 7. Scaling to 2,000 accounts

| Concern | Design |
|---|---|
| Fan-out | Cloudflare Queue, messages of ~50 sleeve legs; consumer concurrency bounded. Never `Promise.all` over every account in one request. The main worker produces, the bridge (which holds credentials) consumes. |
| Broker rate limits | Each connection carries its own credentials, so limits are per account; a per-credential token bucket (Durable Object) paces retries. Measure Webull's actual limits before choosing numbers. |
| Fairness | Dispatch order is rotated per leg (`hash(position_id, seq, account_id)`), so the same accounts are not always last into a fast 1-DTE market. Lag is recorded per sleeve leg. |
| Reduce latency | Exits and stops go out as marketable limits, re-priced on each retry, and every reduce on a position is dispatched before any new entry. |
| Account discovery | A D1 participant index with paging. No `KV.list` without a cursor. |
| Polling cost | Order status is polled only for attempts in `working`, by id. Holdings sweeps are sharded so each account is read every N minutes, not every minute. No 300-order history scans per account. |
| Alerting | One message per model leg, not per account: `STOP SPY 771C: 1,987 settled, 9 insufficient_buying_power (at entry), 4 working, 0 defects`. Pages only on defects, or on `working` past the window. |
| Storage | ~2,000 accounts × ~12 day-trade entries × ~2.5 legs ≈ 60k sleeve legs a day, plus attempts. Retain 90 days hot in D1, archive after. |

## 8. Decisions (operator, 2026-09-24)

1. **Two lots.** Approved. The paper book's minimum is two lots (light 2 /
   medium 2 / heavy 3) and the mirror follows it, inside each account's own
   caps. An account whose caps allow only one lot takes one and carries
   `indivisible_lot` through the trim.
2. **The operator is an ordinary sleeve.** Approved. Partners with their own
   ceilings are sized exactly like the operator's account; the equity ratio
   remains only for an account that set none.
3. **Market orders.** Approved in intent — the index chains are liquid — but
   Webull's OpenAPI refuses `MARKET` on options (only `LIMIT`,
   `STOP_LOSS` and `STOP_LOSS_LIMIT`). The shipped equivalent is a limit
   priced through the touch by max(2 ticks, 3% of mid), for entries and
   every reduce including trims. Fills are booked at the broker's average
   price, never at the cushioned limit. `unfilled_at_limit` stays in the
   closed set for the rare quote that moves past the cushion.
4. **No broker-native stops — but confirm the stop at the broker.** The
   model stays the only actor; the kernel's converge (§6) follows every trim
   and stop through to each account's live holdings until verified, and
   pages once per position if any account is still not there after ten
   minutes.
5. **New tables.** Approved, and live: `model_position`, `model_leg`,
   `mirror_sleeve`, `mirror_order_attempt`. `mirror_sleeve_leg` (§4.1) is
   deferred: converge over every sleeve of a position after each leg gives
   the same per-account follow-through, and the per-leg row adds only
   history.

### Broker limits to design against

From Webull's published limits: place, replace and cancel are 600 per
minute, but order detail, open orders and order history are **2 requests
per 2 seconds**. Converge therefore resolves in-flight orders by id only
when an attempt is actually in flight, and holdings reads — not order
history scans — are what verify a sleeve. Whether these limits are per app
or per connected account decides how far sequential converge scales, and
must be measured before the queue design in §7 is sized.

Out of scope here but worth stating: placing orders in thousands of
third-party accounts is discretionary management, with consent, disclosure
and record-retention obligations. The traceability in §4 is also what an
auditor would ask to see.

## 9. Delivery

Each phase ships behind a flag and has an exit criterion measured on live
data, not asserted.

**Status after PR #1499:** Phase 0 shipped in full, plus two defects found
while doing it (investor trims sharing one client_order_id; the equity
fan-out truncating trim ids into collisions). Phase 1 shipped live rather
than in shadow — the operator's decisions made converge the stop-out check —
so its exit criterion is now the first five sessions of both accounts'
sleeves verifying every trim and stop. The KV mirror and risk ledger still
run alongside; retiring them is Phase 2. A D1 `mirror_dispatch_outbox`
dual-write on every model reduce is live as the Phase 2 producer side —
converge settles those rows today; Cloudflare Queue fan-out is still deferred.

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Fix the reference** | Short Term: send the reduce as a fraction of the *remaining* sleeve (`delta / (1 − oldTrim)`) and no pct on a full exit. Page `listConnectedUsers` with a cursor. Audit the 27 model-closed trader sleeves against live holdings and close the phantom rows. Day trades: `position_id` per round. | Trim-to-full leaves zero at the broker in a replay of the §2.2 table; no `catchup-trader-exits` leftover for laddered trims over a week; every manifest row with `broker_remaining_qty > 0` matches a live holding. |
| **1. Kernel, shadow mode** | Tables, `sleeveTarget`, the §3.3 reason set, invariants as tests. Write model positions, legs and sleeves for both live accounts from existing events, but dispatch nothing. | The shadow report explains every live day-trade position in both accounts with no unexplained difference for five sessions. |
| **2. Day trades on the kernel** | Outbox + queue dispatch for all accounts; operator as an ordinary sleeve; budget derived from sleeves; KV mirror, risk ledger and partner fan-out retired for this lane. | Invariants 1–7 at zero defects for five sessions; every trim and exit converges in both accounts inside the reduce window. |
| **3. Reconciler and scale** | Converge loop, sharded holdings sweep, paged participant index, rotated dispatch, per-leg alerts. Load test with synthetic accounts against a broker sandbox. | 2,000 synthetic sleeves converge a STOP inside the reduce window; alert volume is one per model leg. |
| **4. Other lanes** | Short Term equity and index-trend LETF onto the kernel; `mirror_trade_manifest`, `broker_intents` and the catch-up runners retired. | Coverage becomes a query and reports zero defects across all lanes. |

## 10. References

- Short Term dispatch: `processTradeSimulation` and the TRIM/EXIT forwards in
  `worker/index.js`; `forwardOrderToBridge` in `worker/broker-bridge-client.js`.
- Bridge equity path: `handleOrderWebhook`, `handleSingleAccountOrder`,
  `reconcileReducerQty` (`worker-bridge/bridge-guards.js`),
  `worker-bridge/bridge-manifest.js`, `worker-bridge/bridge-reconciler.js`.
- Day-trade model: `worker/option-day-trade-plan.js`
  (`classifyPaperEvent`, `trimSellQty`, `MIN_CONTRACTS_FOR_TRIM`),
  `worker/option-day-trade-alerts.js`.
- Day-trade mirror: `worker/options-auto-mirror.js`
  (`runIndexDayTradeMirror`, `targetMirrorRemaining`,
  `reconcileIndexDtMirrorPositions`); the pending-reduce resolver and the
  partner fan-out grading land with PR #1497.
- Bridge options path: `handleOptionsOrderWebhook`, `fanOutOptionsMirrors`
  (`worker-bridge/bridge-index.js`), `worker-bridge/bridge-options-fanout.js`,
  `worker-bridge/bridge-options-risk.js`.
- Account listing: `listConnectedUsers` (`worker-bridge/bridge-storage.js`).
- Incidents that shaped the reason set and the write path:
  `tasks/lessons.md`, entries dated 2026-09-24.
