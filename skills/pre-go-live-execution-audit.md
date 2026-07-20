# Pre-Go-Live Execution Audit (before enabling real broker orders)

**WHEN to use:** Before flipping the Broker Bridge from advisory/shadow to
**real orders**, or any time a trade enters/exits on a price that "never
traded" (ghost/stale mark). This is the checklist that proves the
signal → execution → lifecycle → reconcile path cannot enter or exit on a
systematic fault.

Born from **AMZN 2026-07-20**: a fabricated `$236` mark (real market ~`$252`,
+6.3% away) hard-closed a LONG **three times** via `sl_breached`, and the
UI kept showing it CLOSED after each admin reopen. Root causes were a
poisoned `max_adverse_excursion` used as a live PnL-implied price, an RTH
fast path that skipped fresh-quote confirmation, and a KV cache the reconcile
cron never healed from D1.

---

## The three fault classes (and the guards that now catch them)

### 1. Ghost / stale price drives an exit
A close price that no live source supports must never flatten a position.

- **Central backstop:** `evaluateClosePriceSanity()` in
  `worker/feed/sl-hard-exit.js`. Every LIVE close funnels through it inside
  `closeTradeAtPrice` (`worker/index.js`). If the close price diverges
  > 3.5% from `timed:prices.p` and no fresh `/quote` corroborates it →
  **defer** (log `[CLOSE_SKIPPED] … close-price sanity …`), do NOT close,
  do NOT forward to the bridge. Self-corrects next tick.
- **SL candidate hygiene:** `collectStopCheckPriceCandidates` never uses
  `max_adverse_excursion`; spike-filters quotes vs the live anchor; ignores
  stale `pnlPct` that disagrees with the live mark.
- **Excursions:** `bumpOpenTradeExcursions` spike-filters `dh`/`dl` (>2.5%
  from `pxNow`) so one bad print can't permanently poison MAE/MFE.
- **Reopen suppress:** `timed:sl:reopen-suppress:<tradeId>` blocks repeat
  `sl_breached` closes for 45 min after an admin reopen.

**Verify:**
```bash
# No close should ever fire >3.5% off the feed without a fresh quote.
cd worker && ../node_modules/.bin/wrangler tail tt-engine --format pretty \
  | grep -E "CLOSE_SKIPPED|close-price sanity"
```

### 2. D1 ↔ KV divergence ("keeps showing closed")
D1 is authoritative. KV `timed:trades:all` is a cache.

- **Self-heal:** the TRADE UPDATE reconcile now **promotes D1-OPEN trades
  over stale KV-CLOSED rows** (was one-directional: only closed phantoms).
  `[TRADE RECONCILE] … healed N D1-open`.
- **Manual reopen:** `POST /timed/admin/reopen-stale-exits` /
  `restore-open-position` fix D1 + KV + purge artifacts + set suppress key.

**Verify a reopened trade stays open across a full */5 cycle:**
```bash
KEY=$TIMED_API_KEY; BASE=https://timed-trading-ingest.shashant.workers.dev
for i in $(seq 1 6); do sleep 60
  cd worker && ../node_modules/.bin/wrangler d1 execute timed-trading-ledger --remote --env production \
    --command "SELECT status FROM trades WHERE trade_id='<TID>';" 2>/dev/null | grep status
  curl -s "$BASE/timed/admin/kv/get?k=timed:trades:all&key=$KEY" \
    | python3 -c "import sys,json;[print('KV',t.get('status')) for t in json.load(sys.stdin)['value'] if '<TID>' in str(t.get('id'))]"
done
```
D1 and KV must both read OPEN every tick.

### 3. Real-order safety (the actual go-live gate)
See `skills/broker-bridge.md` for architecture. The bridge is
**simulation-primary, bridge-secondary**; both can run at once.

- **Idempotency:** entry/exit forwards now carry a stable
  `client_order_id` (`tt-entry-<tid>` / `tt-exit-<tid>`). The bridge
  `claimOrderIdempotency` drops a repeat within 24h → one erroneous decision
  can never become multiple real orders.
- **Exit qty fixed:** exit forwards send `remainingShares` (was
  `trade.size`/`trade.qty` → 0 or full-size on trimmed positions).
- **Every close is gated (class 1)** BEFORE `forwardOrderToBridge`, so a
  ghost-priced exit never reaches the broker.

---

## Go-live checklist (do NOT skip)

1. **Tests green:** `npx vitest run` (deploy gate). Confirm
   `feed/sl-hard-exit.test.js` covers close-price sanity.
2. **Deploy order:** monolith (default + production) → `tt-engine` →
   `tt-feed` → `tt-broker-bridge`. All four share the monolith bundle except
   the bridge (separate). See `skills/deploy.md` + `skills/worker-topology.md`.
3. **Bridge still gated:** confirm `broker_integration_enabled=false` per
   user until dry-run audit is clean; `BROKER_BRIDGE_MOCK` intentional;
   `BROKER_MANIFEST_ENFORCE` start at `log`, flip to `on` only after a clean
   week; `EXECUTION_MODE` — decide sim-only mirror vs broker-only (today BOTH
   run; document the intent).
4. **Kill switch works:** `POST /timed/admin/broker-bridge/killswitch` →
   confirm `preflightOrder` rejects.
5. **Idempotency proven:** POST the same `client_order_id` twice to
   `/bridge/order` (mock or dry-run) → second returns `{deduped:true}`.
6. **No ghost closes in tail:** watch `tt-engine`/`tt-feed` for one RTH
   session; zero unexplained `sl_breached` at prices off the feed.
7. **D1/KV parity:** `/timed/trades` (D1) and `timed:trades:all` (KV) agree
   on open count.

## Broker-agnostic layer + per-account ledger (2026-07-20)

The gaps around "which account" and "market vs OCO" are now addressed at the
architecture level — see [`broker-bridge.md`](broker-bridge.md):

- **Capability registry + order planner** (`bridge-brokers.js`,
  `bridge-order-plan.js`) translate one model signal into a concrete plan per
  broker and downgrade protection to `synthetic_engine` (never silently drop a
  stop). Verify a plan: the `order_plan` audit row + `summarizeOrderPlan`.
- **Per-account ledger** (`broker_account_ledger` / `broker_account_snapshot`)
  ties every real fill + position snapshot to a specific `broker_account_id`
  (Webull no longer collapses to `"default"`). Reads: `GET /bridge/account-ledger`,
  `GET /bridge/account-snapshots`.

## Order-type sending + fan-out (2026-07-20 — wired)

- **Limit + IBKR native bracket send** are live (`GET /bridge/health` →
  `supported_brokers[].sends`). IBKR: market/limit/bracket. Webull: market/limit.
  RH: market. Webull/RH protection stays `synthetic_engine` (engine-managed).
- **Multi-account fan-out** behind `BROKER_FANOUT_ENABLED` (default off): one
  signal → all enabled accounts, per-account idempotency + ledger.

## Fill reconciliation + Webull OCO (2026-07-20 — wired)

- **Fill reconciliation** (`bridge-fills.js`) polls `adapter.listOrders` each
  reconcile cycle and records real fills to `broker_account_ledger` (idempotent).
  Verify: `GET /bridge/account-ledger` shows `FILL` rows after a broker fill.
- **Webull OCO** places SL+TP children after a filled entry (gated by
  `BROKER_OCO_ENABLED`); a filled child cancels its sibling. IBKR uses native
  bracket. Robinhood stays market/synthetic.

## Known residual gaps (track before full autonomy)

- **Robinhood** limit/bracket (agentic wire format unpublished); IBKR standalone
  stop order (bracket STP children done).
- **Dual ledger:** sim + broker both execute; reconciler detects drift but
  cannot un-send. Decide the source of truth explicitly.
- **Fire-and-forget forward:** sim state commits even if the bridge call
  fails; no fill webhook back into `trades`/`positions` (reconciler snapshot is
  the periodic truth).
- **Kanban SL classification** still reads headline `tickerData.price`; the
  central close gate + `applySlHardExitSafetyNet` are the backstops.

## Source
- `worker/feed/sl-hard-exit.js` — `evaluateClosePriceSanity`,
  `collectStopCheckPriceCandidates`, `applySlHardExitSafetyNet`
- `worker/index.js` — `closeTradeAtPrice` gate, TRADE UPDATE reconcile heal,
  bridge forward payloads
- `worker-bridge/bridge-index.js` + `bridge-storage.js` — `claimOrderIdempotency`
- Lessons: `tasks/lessons.md` → AMZN false SL entries
