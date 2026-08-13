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
      { user_id: "op@x.com#webull#roth-ira", broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_label: "Roth IRA", webull_account_id: "LJJ84", user_caps: {} },
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
      { ts: NOW - 5 * 86400e3, mode: "investor", event: "DCA_BUY", ticker: "AMD", qty: 2, price: 160, value: 320, realized_pnl: 0, mirror: "mirrored", mirror_reason: null, fills: [{ account: "Roth IRA", qty: 0.3, price: 160, value: 48, status: "filled" }], rejects: [] },
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
        mirror_events: [{ ts: NOW - 2 * 86400e3, on: true }],
        summary: { positions_value: 3120.5, unrealized_pnl: 84.2, day_pnl: 22.81 },
        items: [
          { ticker: "AXON", managed: true, model_status: "OPEN", sync_state: "in_sync", broker_qty: 0.09136, avg_cost: 597.25, last_price: 601.16, price: 601.16, prev_close: 598.0, day_change: 3.16, day_change_pct: 0.53, day_pnl: 0.29, market_value: 54.9, unrealized_pnl: 0.36, unrealized_pnl_pct: 0.65, model_open: true, model_entry: 596.89, model_sl: 554.29, model_tp: 667.36, model_direction: "LONG", model_horizon: "trader", history: [{ ts: NOW - 3600e3, side: "trim", event_type: "EXIT", qty: 0.09135, price: 601.16, value: 54.92, status: "filled" }, { ts: NOW - 4 * 3600e3, side: "buy", event_type: "ENTRY", qty: 0.18271, price: 597.25, value: 109.13, status: "ok" }, { ts: NOW - 10 * 86400e3, side: "buy", event_type: "ENTRY", qty: 0.18, price: 590, value: 106.2, status: "filled" }] },
          { ticker: "PLTR", managed: true, model_status: "OPEN", sync_state: "in_sync", broker_qty: 1.5, avg_cost: 122.26, last_price: 171.04, price: 171.04, day_pnl: 4.12, market_value: 255.06, unrealized_pnl: 71.67, unrealized_pnl_pct: 0.4, model_open: true, model_entry: 127.44, model_sl: null, model_peak: 182.5, model_horizon: "investor", sync_note: "match within tolerance (0.00 <= 0.1)", history: [{ ts: NOW - 3 * 86400e3, side: "buy", event_type: "ENTRY", qty: 2, price: 122.26, value: 244.52, status: "filled" }] },
          { ticker: "PANW", managed: true, model_status: "OPEN", sync_state: "mothership_orphan", broker_qty: 0, avg_cost: null, price: 172.4, prev_close: 171.0, day_change: 1.4, day_change_pct: 0.82, model_open: true, auto_sync: true, sync_note: "model_open expected 1.00754 but broker holds 0", history: [{ ts: NOW - 10000e3, side: "buy", event_type: "ENTRY", qty: 1.045, price: 170.2, value: 177.8, status: "rejected", reject_reason: "Parameter error, invalid client order id, value: tt-lt-dca-inv-inv-PANW-auto-1784300543401, length should be between 10" }] },
          { ticker: "CRS", managed: false, sync_state: "untracked", broker_qty: 5, avg_cost: 570.1, price: 552.4, prev_close: 555.0, day_change: -2.6, day_change_pct: -0.47, day_pnl: -13.0, market_value: 2762, unrealized_pnl: -88.5, unrealized_pnl_pct: -3.1, model_open: true, adoptable: true },
          { ticker: "BMNR", managed: false, sync_state: "untracked", broker_qty: 400, avg_cost: 17.06, price: 18.2, prev_close: 18.0, day_change: 0.2, day_change_pct: 1.1, day_pnl: 31.4, market_value: 7280, unrealized_pnl: 456, unrealized_pnl_pct: 6.7 },
        ],
      },
      {
        account_id: "op@x.com#webull#rollover-ira", broker: "webull", label: "Rollover IRA", mirror_enabled: false,
        equity_usd: 5000, cash_usd: 1200,
        positions_stale: true, positions_stale_reason: "Too many requests", positions_as_of: NOW - 9 * 60e3,
        summary: { positions_value: 3800, unrealized_pnl: 10, day_pnl: 4.5 },
        // Mirror-off: leftover auto_sync orphans must NOT render.
        items: [
          { ticker: "IONQ", managed: false, model_open: true, model_stage: "accumulate", sync_state: "not_synced", broker_qty: 0, avg_cost: null, auto_sync: true, price: 43.68 },
          { ticker: "AAPL", managed: false, sync_state: "untracked", broker_qty: 2, avg_cost: 190, price: 195, market_value: 390, unrealized_pnl: 10, day_pnl: 4.5 },
        ],
      },
    ],
  },
  "/timed/broker/equity-curve": {
    ok: true,
    accounts: [
      {
        broker_account_id: "LJJ84", user_id: "op@x.com#webull#roth-ira", label: "Roth IRA",
        mirror_enabled: true, equity: 16830.37, since_mirror_gain: 412.2,
        markers: [
          { ts: NOW - 20 * 86400e3, on: true },
          { ts: NOW - 12 * 86400e3, on: false },
          { ts: NOW - 10 * 86400e3, on: true },
        ],
        // Flat overnight samples (production shape) — 1D chart must rebuild
        // from day_pnl so the header matches Today's P&L instead of +$0.00.
        points: [
          { ts: NOW - 40 * 86400e3, equity: 15000 },
          { ts: NOW - 20 * 86400e3, equity: 16830.37 },
          { ts: NOW - 10 * 86400e3, equity: 16830.37 },
          { ts: NOW - 3600e3, equity: 16830.37 },
          { ts: NOW, equity: 16830.37 },
        ],
      },
      {
        broker_account_id: "QIJ6P", label: "Rollover IRA", mirror_enabled: false, equity: 5000,
        markers: [{ ts: NOW - 30 * 86400e3, on: true }, { ts: NOW - 25 * 86400e3, on: false }],
        points: [{ ts: NOW - 40 * 86400e3, equity: 4800 }, { ts: NOW, equity: 5000 }],
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
// Client-side pct recompute safety-net check: PLTR arrives at 0.4 (decimal)
// but the frontend must display it as ~39.9% (never 0.4%).
const checks = [
  ["header", /Broker Connections/],
  ["timeline section", /Model actions (&amp;|&) mirror outcomes/],
  ["AXON trim row mirrored", /AXON/],
  ["mirrored chip", /MIRRORED/],
  ["rejected chip", /REJECTED/],
  ["inline fill (no expand)", /Roth IRA/],
  ["humanized vehicle cap reason", /vehicle dollar limit/],
  ["managed row collapsed toggle", /▸|▾/],
  ["positions section", /Holdings (&amp;|&) sync manifest/],
  ["in-sync pill", /IN SYNC/],
  ["untracked pill", /NOT MIRRORED/],
  ["auto-sync pill (mirror-on)", /AUTO-SYNC/],
  ["adoptable hint chip", /CAN SYNC/],
  // Detail is collapsed by default now; timeline still shows fills inline.
  ["timeline inline fill FILLED chip", /FILLED/],
  ["stale as-of pill", /AS OF 9M AGO/],
  ["KPI strip", /Mirrored value/],
  ["KPI mirrored value populated", /\$55|\$54\.9/],
  ["KPI mirrored value sleeve copy", /sleeve/],
  ["day pnl", /Today's P(&amp;|&)L/],
  ["model pnl kpi", /Model P(&amp;|&)L/],
  ["model pnl net label", /net · model/],
  ["model pnl realized row", /Realized/],
  ["model pnl unrealized row", /Unrealized/],
  ["model pnl unrealized dollar", /\+\$72\.|\+\$71\./],
  ["model pnl net includes scaled realized", /\+\$74\.|\+\$72\./],
  ["model actions kpi", /Model actions/],
  ["model actions count from 72h", />4</],
  ["portfolio growth", /Portfolio growth/],
  ["account performance row", /Account performance/],
  ["all connected account copy", /Every connected account/],
  ["mirror-on account card", /MIRROR ON/],
  ["not-mirrored account card", /NOT MIRRORED/],
  ["since first mirror row", /Since first mirror on/],
  ["truthful longer-range disclaimer", /cash transfers can affect/],
  ["all accounts filter", /All accounts/],
  ["Roth account history filter", /Roth IRA · ON/],
  ["Rollover account history filter", /Rollover IRA · OFF/],
  ["growth defaults to 1D", /Day change|class="on"[^>]*>1D|>1D</],
  ["1D chart mirrors Today's P&L", /\+\$22\.81/],
  ["1D chart day-pnl copy", /matches Today's P(&amp;|&)L|Day change matches/],
  ["ticker research button", /Open research for AXON/],
  ["timeline default 3 days", /Last 3 days/],
  ["collapsed older day", /AMD/],
  ["pltr pct recomputed to \u224840%", /\+39\.\d%|\+40\.\d%/],
  ["plan bar for managed AXON", /Stop \/ invalidation|Target|Peak/],
  ["humanized tolerance sync note", /broker shares match the model/],
  ["guidance text on managed row", /Model guidance|Accumulating|Riding|Holding|Fresh entry|Underwater/],
  ["horizon chip on managed row", />SHORT TERM<|>LONG TERM</],
  ["open long chip", />Open Long</],
  ["accounts section", /Mirror settings/],
  ["no daily-cap UI", /no daily order cap/],
  ["kill switch", /Pause all mirroring/],
  ["twelvedata footer", /Twelve Data/],
];
let failed = 0;
for (const [name, re] of checks) {
  const pass = re.test(html);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}
// Mirror-off account must not show AUTO-SYNC / IONQ model orphan.
if (/IONQ/.test(html)) {
  failed++;
  console.log("FAIL  mirror-off hides IONQ auto_sync orphan");
} else {
  console.log("PASS  mirror-off hides IONQ auto_sync orphan");
}
if (/Max orders \/ day|Max \$ \/ order/.test(html)) {
  failed++;
  console.log("FAIL  caps inputs removed from account cards");
} else {
  console.log("PASS  caps inputs removed from account cards");
}
const perfCards = [...window.document.querySelectorAll(".acct-perf-card")];
const statusOrderOk = perfCards.length >= 2
  && /MIRROR ON/.test(perfCards[0].textContent)
  && /NOT MIRRORED/.test(perfCards[1].textContent);
if (!statusOrderOk) {
  failed++;
  console.log("FAIL  account cards sort mirror-on before not-mirrored");
} else {
  console.log("PASS  account cards sort mirror-on before not-mirrored");
}
const mirrorCardMath = perfCards[0]
  && /\$16,830/.test(perfCards[0].textContent)
  && /\+\$22\.81/.test(perfCards[0].textContent)
  && /\+\$412\.20/.test(perfCards[0].textContent);
if (!mirrorCardMath) {
  failed++;
  console.log("FAIL  mirrored account value / day P&L / since-mirror math");
} else {
  console.log("PASS  mirrored account value / day P&L / since-mirror math");
}
const offCardMath = perfCards[1]
  && /\$5,000/.test(perfCards[1].textContent)
  && /NOT MIRRORED/.test(perfCards[1].textContent)
  && /\+\$4\.50/.test(perfCards[1].textContent);
if (!offCardMath) {
  failed++;
  console.log("FAIL  not-mirrored account value / history math");
} else {
  console.log("PASS  not-mirrored account value / history math");
}
const compareText = window.document.querySelector(".acct-compare")?.textContent || "";
if (!/Mirror on · \+\$22\.81/.test(compareText) || !/Not mirrored · \+\$4\.50/.test(compareText)) {
  failed++;
  console.log("FAIL  mirror group totals match account-period data");
} else {
  console.log("PASS  mirror group totals match account-period data");
}
if (/-100\.00%/.test(window.document.body.innerHTML)) {
  failed++;
  console.log("FAIL  no bogus -100% on near-zero equity baselines");
} else {
  console.log("PASS  no bogus -100% on near-zero equity baselines");
}
if (renderError) {
  console.error("RENDER ERROR:", renderError);
  process.exit(1);
}
if (failed) {
  console.error(`\n${failed} check(s) failed. Body snapshot:\n`, html.slice(0, 2000));
  process.exit(1);
}
// Account cards focus that account's value history.
const rolloverCard = perfCards.find((b) => /Rollover IRA/.test(b.textContent));
if (!rolloverCard) {
  failed++;
  console.log("FAIL  Rollover account performance card missing");
} else {
  rolloverCard.click();
  await new Promise((r) => setTimeout(r, 80));
  if (!/Rollover IRA · day P(&amp;|&)L/.test(window.document.body.innerHTML)) {
    failed++;
    console.log("FAIL  account card focuses account value history");
  } else {
    console.log("PASS  account card focuses account value history");
  }
}
const mirrorGroupBtn = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "Mirror-on group");
mirrorGroupBtn?.click();
await new Promise((r) => setTimeout(r, 50));
// Switch growth chart to 1W — must not collapse to a blank same-day line.
const weekBtn = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "1W");
if (!weekBtn) {
  failed++;
  console.log("FAIL  1W range button missing");
} else {
  weekBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  const weekHtml = window.document.body.innerHTML;
  const weekOk = /\+\$22\.81/.test(weekHtml)
    && /flat across this window|Today's P(&amp;|&)L/.test(weekHtml)
    && /1W account value change/.test(weekHtml);
  if (!weekOk) {
    failed++;
    console.log("FAIL  1W chart rebuilds from day_pnl");
  } else {
    console.log("PASS  1W chart rebuilds from day_pnl");
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed after 1W switch.`);
  process.exit(1);
}
console.log("\nAll checks passed — page renders with canned data.");
// EquityCurve polls on an interval; force-exit so the harness does not hang.
process.exit(0);
