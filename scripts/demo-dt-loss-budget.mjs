// scripts/demo-dt-loss-budget.mjs
//
// Drives the REAL index day-trade mirror (worker/options-auto-mirror.js)
// against an in-memory KV and prints the decision for each entry, so the
// difference between "2 trades a day" and "one loss limit" is legible.
//
//   node scripts/demo-dt-loss-budget.mjs
//
// Replays 2026-09-23: eleven day-trade BUY signals, 0/1 DTE index puts, of
// which the first two never filled.

import { maybeAutoMirrorIndexDayTradeEvent, resolvePendingIndexDtEntry, indexDtMirrorKey } from "../worker/options-auto-mirror.js";
import { RISK_STATE_KEY, riskBudgetSnapshot } from "../worker/options-risk-budget.js";

const OP = "op@example.com";
const TODAY = new Date().toISOString().slice(0, 10);
const LIMIT = 1000;

function kvMock() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function envFor(kv, fillStatus) {
  return {
    ADMIN_EMAIL: OP,
    KV_TIMED: kv,
    BROKER_BRIDGE_HMAC_KEY: "secret",
    BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
    BROKER_BRIDGE: {
      fetch: async () => new Response(JSON.stringify({
        ok: true, order_id: "OID",
        fill: fillStatus === "filled"
          ? { status: "filled", filled_qty: 1, order_id: "OID" }
          : { status: "working", filled_qty: 0, order_id: "OID" },
      }), { status: 200 }),
    },
  };
}

const buyCtx = (n, ceil) => ({
  event: "BUY", ticker: "SPY", signal_id: `dt:SPY:trade-${n}`,
  indicesFlagOn: true, tier: "gamma", strike: 768,
  execution: { premium_band: { display_buy_ceil: ceil } },
  play: {
    archetype: "day_trade_put", _day_trade_flavor: "put",
    strikes: { primary: 768 }, expiration: { iso: "2026-09-24" },
    legs: [{ action: "BUY", optionType: "PUT", strike: 768, expiration: "2026-09-24", qty: 1 }],
    premium: { mid: ceil - 0.09 }, contracts: 1, max_loss_usd: ceil * 100,
  },
});

const snap = (kv) => {
  const raw = kv.store.get(RISK_STATE_KEY(OP, TODAY));
  return riskBudgetSnapshot(raw ? JSON.parse(raw) : { open: {}, realized_pnl_usd: 0 }, LIMIT);
};

const kv = kvMock();
kv.store.set(`timed:options:auto-mirror:${OP}`, JSON.stringify({
  enabled: true,
  daily_cap: 5,
  daily_loss_limit_usd: LIMIT,
  vehicles: { long_put: { enabled: true, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 250 } },
}));

console.log(`Daily loss limit: $${LIMIT}. Per-vehicle count cap still set to 2/day in prefs (now telemetry only).\n`);
console.log("  #  ceiling   risk   result                                              open   lost   left");
console.log("  ─  ───────  ─────   ──────────────────────────────────────────────────  ─────  ─────  ─────");

const ceilings = [0.68, 0.59, 1.24, 0.92, 2.10, 1.55, 0.74, 1.88, 2.40, 1.10, 0.85];
let placed = 0;

for (let i = 0; i < ceilings.length; i++) {
  const ceil = ceilings[i];
  // The first two are the 2026-09-23 orders that sat `working` all day.
  const neverFills = i < 2;
  const r = await maybeAutoMirrorIndexDayTradeEvent(envFor(kv, neverFills ? "working" : "filled"), buyCtx(i + 1, ceil));
  let result;
  if (r.skipped) {
    result = `BLOCKED  ${r.reason}`;
  } else {
    placed++;
    result = neverFills ? "placed   (limit working, will not fill)" : "placed   FILLED";
  }
  const s = snap(kv);
  console.log(
    `  ${String(i + 1).padStart(2)}  $${ceil.toFixed(2).padStart(6)}  $${String(Math.round(ceil * 100)).padStart(4)}   ${result.padEnd(50)}  $${String(s.open_usd).padStart(4)}  $${String(s.realized_loss_usd).padStart(4)}  $${String(s.remaining_usd).padStart(4)}`,
  );
}

console.log(`\n${placed} of ${ceilings.length} entries reached the broker. The old 2/day count cap allowed 2.\n`);

// Now resolve the two that never filled — the exact 2026-09-23 state.
console.log("Reconciling the two orders that never filled:\n");
for (const n of [1, 2]) {
  const sig = `dt:SPY:trade-${n}`;
  const mirror = JSON.parse(kv.store.get(indexDtMirrorKey(sig)));
  const before = snap(kv).remaining_usd;
  const r = await resolvePendingIndexDtEntry({ KV_TIMED: kv }, OP, sig, mirror, {
    deps: { pollFill: async () => ({ status: "cancelled", filled_qty: 0 }) },
  });
  const after = snap(kv);
  console.log(`  ${sig}  ->  ${r.outcome.padEnd(10)}  budget left $${before} -> $${after.remaining_usd}`);
}

const final = snap(kv);
console.log(`\nEnd of day: $${final.open_usd} still at risk, $${final.realized_loss_usd} realised loss, $${final.remaining_usd} of $${LIMIT} left.`);
console.log(`Day trades that reached the broker: ${final.placed_count}`);

// The Trader lane still gates on these. An uncapped day-trade lane that kept
// bumping them would spend its allowance and lock it out for the rest of the day.
const shared = [...kv.store.keys()].filter((k) => k.startsWith("timed:options:auto-mirror:count:"));
console.log(`Shared daily counters touched by this lane: ${shared.length === 0 ? "none" : shared.join(", ")}`);
console.log(`KV key: ${RISK_STATE_KEY(OP, TODAY)}`);
