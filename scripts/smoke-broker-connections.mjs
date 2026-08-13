// One-shot runtime smoke render of react-app-dist/broker-connections.compiled.js
// under jsdom with canned API payloads (shapes captured from the live
// endpoints on 2026-08-13). Fails loudly if the page throws during render
// or key sections fail to appear. Run: node scripts/smoke-broker-connections.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
  url: "https://timed-trading.com/broker-connections.html",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;
global.window = window;
global.document = window.document;

const NOW = Date.now();
const CANNED = {
  "/timed/broker/accounts": {
    ok: true,
    accounts: [
      { user_id: "op@x.com#webull#roth-ira", broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_label: "Roth IRA", webull_account_id: "LJJ84", user_caps: { max_per_order_usd: 500, max_orders_per_day: 10 } },
      { user_id: "op@x.com#webull#rollover-ira", broker: "webull", status: "connected", broker_integration_enabled: false, webull_account_label: "Rollover IRA", webull_account_id: "QIJ6P", user_caps: {} },
    ],
  },
  "/timed/broker/day-actions": {
    ok: true, since: NOW - 8 * 3600e3,
    actions: [
      { ts: NOW - 3600e3, mode: "trader", event: "TRIM", ticker: "AXON", qty: 0.54281, price: 601.16, value: 326.3, realized_pnl: 12.4, mirror: "mirrored", mirror_reason: null, fills: [{ account: "Roth IRA", qty: 0.09135, price: 601.16, value: 54.92, status: "filled" }], rejects: [] },
      { ts: NOW - 5400e3, mode: "investor", event: "DCA_BUY", ticker: "TWLO", qty: 8.167, price: 245.69, value: 2006.5, realized_pnl: 0, mirror: "mirrored", mirror_reason: null, fills: [{ account: "Roth IRA", qty: 1.37458, price: 245.69, value: 337.72, status: "filled" }], rejects: [] },
      { ts: NOW - 7200e3, mode: "investor", event: "EXIT", ticker: "CRS", qty: 9.45, price: 552.1, value: 5217.3, realized_pnl: -282.5, mirror: "rejected", mirror_reason: "mirror_suppressed:bypass_no_broker_position", fills: [], rejects: [{ account: "Roth IRA", qty: 0, status: "rejected", reject_reason: "mirror_suppressed:bypass_no_broker_position" }] },
      { ts: NOW - 9000e3, mode: "trader", event: "ENTRY", ticker: "SPHB", qty: 9.7, price: 145.2, value: 1408.4, realized_pnl: 0, mirror: "rejected", mirror_reason: "vehicle_equity_long_notional_869_exceeds_cap_300", fills: [], rejects: [{ account: "Roth IRA", qty: 0, status: "rejected", reject_reason: "vehicle_equity_long_notional_869_exceeds_cap_300" }] },
    ],
    summary: { actions: 4, mirrored: 2, rejected: 2, skipped: 0, not_mirrored: 0, realized_pnl: -270.1 },
    accounts: [{ account_id: "op@x.com#webull#roth-ira", label: "Roth IRA", mirror_enabled: true }],
  },
  "/timed/broker/positions": {
    ok: true, prices_included: true, market_open: false,
    accounts: [
      {
        account_id: "op@x.com#webull#roth-ira", broker: "webull", label: "Roth IRA", mirror_enabled: true,
        equity_usd: 16830.37, positions_as_of: NOW - 40e3,
        summary: { positions_value: 3120.5, unrealized_pnl: 84.2, day_pnl: -12.6 },
        items: [
          { ticker: "AXON", managed: true, model_status: "OPEN", sync_state: "in_sync", broker_qty: 0.09136, avg_cost: 597.25, price: 601.16, prev_close: 598.0, day_change: 3.16, day_change_pct: 0.53, market_value: 54.9, unrealized_pnl: 0.36, unrealized_pnl_pct: 0.65, model_open: true, syncable: false, history: [{ ts: NOW - 3600e3, side: "trim", event_type: "EXIT", qty: 0.09135, price: 601.16, value: 54.92, status: "filled" }, { ts: NOW - 4 * 3600e3, side: "buy", event_type: "ENTRY", qty: 0.18271, price: 597.25, value: 109.13, status: "ok" }] },
          { ticker: "PANW", managed: true, model_status: "OPEN", sync_state: "mothership_orphan", broker_qty: 0, avg_cost: null, price: 172.4, prev_close: 171.0, day_change: 1.4, day_change_pct: 0.82, model_open: true, syncable: false, sync_blocked_reason: "outside_market_hours", sync_note: "model_open expected 1.00754 but broker holds 0" },
          { ticker: "BMNR", managed: false, sync_state: "untracked", broker_qty: 400, avg_cost: 17.06, price: 18.2, prev_close: 18.0, day_change: 0.2, day_change_pct: 1.1, market_value: 7280, unrealized_pnl: 456, unrealized_pnl_pct: 6.7 },
        ],
      },
      {
        account_id: "op@x.com#webull#rollover-ira", broker: "webull", label: "Rollover IRA", mirror_enabled: false,
        positions_stale: true, positions_stale_reason: "Too many requests", positions_as_of: NOW - 9 * 60e3,
        summary: { positions_value: null, unrealized_pnl: null, day_pnl: null },
        items: [{ ticker: "IONQ", managed: false, model_open: true, model_stage: "accumulate", sync_state: "not_synced", broker_qty: 0, avg_cost: null, syncable: false, sync_blocked_reason: "mirror_off", price: 43.68 }],
      },
    ],
  },
};

window.fetch = async (path) => {
  const key = String(path).split("?")[0];
  const body = CANNED[key];
  return {
    ok: !!body,
    json: async () => body || { ok: false, error: "not_canned:" + key },
  };
};
global.fetch = window.fetch;

const load = (p) => {
  const src = readFileSync(join(root, p), "utf8");
  window.eval(src);
};

load("react-app/vendor/react.production.min.js");
load("react-app/vendor/react-dom.production.min.js");
load("react-app/shared-price-utils.js");

// AuthGate stub: render children(user) with a provisioned user.
window.TimedAuthGate = ({ children }) => children({
  email: "op@x.com", tier: "pro", broker_connections_enabled: true,
});

let renderError = null;
window.addEventListener("error", (e) => { renderError = e.error || e.message; });
try {
  load("react-app-dist/broker-connections.compiled.js");
} catch (e) {
  renderError = e;
}

// React 18 concurrent rendering + effects settle asynchronously.
await new Promise((r) => setTimeout(r, 400));

const html = window.document.body.innerHTML;
const checks = [
  ["header", /Broker Connections/],
  ["timeline section", /Model actions (&amp;|&) mirror outcomes/],
  ["AXON trim row mirrored", /AXON/],
  ["mirrored chip", /MIRRORED/],
  ["rejected chip", /REJECTED/],
  ["humanized cap reason", /per-order dollar cap/],
  ["positions section", /Holdings (&amp;|&) sync manifest/],
  ["in-sync pill", /IN SYNC/],
  ["untracked pill", /NOT MIRRORED/],
  ["not-synced pill", /NOT SYNCED/],
  ["stale as-of pill", /AS OF 9M AGO/],
  ["KPI strip", /Mirrored value/],
  ["day pnl", /Today's P(&amp;|&)L/],
  ["accounts section", /Mirror settings/],
  ["kill switch", /Pause all mirroring/],
  ["twelvedata footer", /Twelve Data/],
];
let failed = 0;
for (const [name, re] of checks) {
  const pass = re.test(html);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}
if (renderError) {
  console.error("RENDER ERROR:", renderError);
  process.exit(1);
}
if (failed) {
  console.error(`\n${failed} check(s) failed. Body snapshot:\n`, html.slice(0, 2000));
  process.exit(1);
}
console.log("\nAll checks passed — page renders with canned data.");
