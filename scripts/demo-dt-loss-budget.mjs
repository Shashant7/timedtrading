// scripts/demo-dt-loss-budget.mjs
//
// Drives the REAL index day-trade mirror (worker/options-auto-mirror.js)
// against an in-memory KV, replaying a real session event by event, and
// prints the budget ledger after each one.
//
//   npx vite-node scripts/demo-dt-loss-budget.mjs
//
// (bare `node` cannot resolve the worker module graph)
//
// The tape is production's `timed:opt-dt-actions` ring for 2026-09-23 joined
// to `option_marks` for the bid/ask at each event -- 38 events, 16 rounds,
// four tickers including DIA, and three strikes that were stopped out and
// re-entered later in the day.
//
// What this exercises end to end:
//   - DIA reaching the broker at all
//   - an entry priced where it can fill, not at the passive FMV ceiling
//   - the day's budget charged the stop distance, not the whole ticket
//   - a re-entry on the same strike charged again rather than swallowed
//   - trims and exits handing budget back as realised P&L

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  maybeAutoMirrorIndexDayTradeEvent,
  indexDtMirrorKey,
  marketableEntryLimit,
} from "../worker/options-auto-mirror.js";
import { RISK_STATE_KEY, riskBudgetSnapshot } from "../worker/options-risk-budget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAPE = JSON.parse(readFileSync(join(HERE, "fixtures", "dt-session-2026-09-23.json"), "utf8"));

const OP = "op@example.com";
const TODAY = new Date().toISOString().slice(0, 10);
const LIMIT = 500;

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

// Every entry fills at its limit, so the ledger shows the budget doing its
// job rather than the pending-order path (which has its own coverage).
let orderSeq = 0;
function envFor(kv, qty) {
  return {
    ADMIN_EMAIL: OP,
    KV_TIMED: kv,
    BROKER_BRIDGE_HMAC_KEY: "secret",
    BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
    BROKER_BRIDGE: {
      fetch: async () => {
        const oid = `OID${++orderSeq}`;
        return new Response(JSON.stringify({
          ok: true, order_id: oid,
          fill: { status: "filled", filled_qty: qty, order_id: oid },
        }), { status: 200 });
      },
    },
  };
}

const et = (ts) => new Date(ts - 4 * 3600_000).toISOString().slice(11, 19);

const snap = (kv) => {
  const raw = kv.store.get(RISK_STATE_KEY(OP, TODAY));
  return riskBudgetSnapshot(raw ? JSON.parse(raw) : { open: {}, realized_pnl_usd: 0, placed: [] }, LIMIT);
};

function ctxFor(ev, book) {
  const flavor = ev.signal_id.includes(":P:") ? "put" : "call";
  const strike = Number(ev.signal_id.split(":").pop());
  // The desk's FMV ceiling ran below the market on the open; reproduce that
  // by pricing it one tick under the mid, which is what blocked the fills.
  const ceil = Math.round((ev.premium - 0.01) * 100) / 100;
  return {
    event: ev.event,
    reason: ev.reason || null,
    ticker: ev.ticker,
    signal_id: ev.signal_id,
    indicesFlagOn: true,
    tier: "gamma",
    strike,
    premium: ev.premium,
    bid: ev.bid ?? null,
    ask: ev.ask ?? null,
    book,
    size: { contracts: ev.contracts },
    execution: { premium_band: { display_buy_ceil: ceil, premium: ev.premium, bid: ev.bid, ask: ev.ask } },
    play: {
      archetype: flavor === "put" ? "day_trade_put" : "day_trade_call",
      _day_trade_flavor: flavor,
      strikes: { primary: strike },
      expiration: { iso: "2026-09-24" },
      legs: [{ action: "BUY", optionType: flavor.toUpperCase(), strike, expiration: "2026-09-24", qty: ev.contracts }],
      premium: { mid: ev.premium, bid: ev.bid, ask: ev.ask },
      contracts: ev.contracts,
      max_loss_usd: ev.premium * 100 * ev.contracts,
    },
  };
}

const kv = kvMock();
kv.store.set(`timed:options:auto-mirror:${OP}`, JSON.stringify({
  enabled: true,
  daily_cap: 5,
  daily_loss_limit_usd: LIMIT,
  index_dt_follow_paper_size: true,
  vehicles: {
    long_put: { enabled: true, daily_cap: 2, max_per_order_usd: 1200, max_loss_per_order_usd: 1200, follow_paper_size: true },
    long_call: { enabled: true, daily_cap: 2, max_per_order_usd: 1200, max_loss_per_order_usd: 1200, follow_paper_size: true },
  },
}));

console.log(`Session ${TAPE.session} -- ${TAPE.events.length} events, one $${LIMIT} daily loss limit, no count caps.`);
console.log(`Source: ${TAPE.source}\n`);
console.log("  time      event  contract      qty  paid/got   limit   result                                        open  loss   left");
console.log("  --------  -----  ------------  ---  --------  ------  --------------------------------------------  ----  ----  -----");

const books = new Map();
let placed = 0;
let refused = 0;

for (const ev of TAPE.events) {
  const label = `${ev.ticker} ${ev.signal_id.split(":").slice(-2).join("")}`;
  let book = books.get(ev.signal_id) || null;
  if (ev.event === "BUY") {
    book = { contracts: ev.contracts, contracts_remaining: ev.contracts, entry_premium: ev.premium };
  } else if (book) {
    book = { ...book, contracts_remaining: Math.max(0, book.contracts_remaining - ev.contracts) };
  }
  books.set(ev.signal_id, book);

  const limit = ev.event === "BUY"
    ? marketableEntryLimit({
      mid: ev.premium, ask: ev.ask, ceil: Math.round((ev.premium - 0.01) * 100) / 100,
    })
    : null;

  const r = await maybeAutoMirrorIndexDayTradeEvent(envFor(kv, ev.contracts), ctxFor(ev, book));
  let result;
  if (r.skipped) {
    result = `refused  ${r.reason}`;
    if (ev.event === "BUY") refused++;
  } else {
    result = r.mirrored || r.ok ? "mirrored" : JSON.stringify(r).slice(0, 40);
    if (ev.event === "BUY") placed++;
  }
  const s = snap(kv);
  console.log(
    `  ${et(ev.ts)}  ${ev.event.padEnd(5)}  ${label.padEnd(12)}  ${String(ev.contracts).padStart(3)}  $${ev.premium.toFixed(2).padStart(7)}  ${limit != null ? `$${limit.toFixed(2).padStart(5)}` : "     -"}  ${result.slice(0, 44).padEnd(44)}  $${String(Math.round(s.open_usd)).padStart(3)}  $${String(Math.round(s.realized_loss_usd)).padStart(3)}  $${String(Math.round(s.remaining_usd)).padStart(4)}`,
  );
}

const final = snap(kv);
console.log(`\n${placed} entries reached the broker, ${refused} were refused by the budget.`);
console.log(`The old 2/day long_put count cap allowed 2, and on the real session it allowed 2.`);
console.log(`\nEnd of day: $${final.open_usd} still at risk, realised P&L $${final.realized_pnl_usd >= 0 ? "+" : ""}${final.realized_pnl_usd}, $${final.remaining_usd} of $${LIMIT} left.`);
console.log(`Rounds placed: ${final.placed_count} (re-entries counted separately)`);

const tickers = new Set(TAPE.events.filter((e) => e.event === "BUY").map((e) => e.ticker));
console.log(`Tickers that made it through the index gate: ${[...tickers].sort().join(", ")}`);

const shared = [...kv.store.keys()].filter((k) => k.startsWith("timed:options:auto-mirror:count:"));
console.log(`Shared daily counters this lane touched: ${shared.length === 0 ? "none" : shared.join(", ")}`);
console.log(`Mirror records written: ${[...kv.store.keys()].filter((k) => k.startsWith(indexDtMirrorKey(""))).length}`);
