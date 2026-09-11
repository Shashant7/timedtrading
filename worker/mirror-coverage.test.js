import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyActionCoverage,
  relativeQtyOk,
  computeTradeRelativeQty,
  buildCoverageRows,
  coverageAnomalies,
  evaluateModelBrokerCoverage,
  coverageHealPlan,
  healForCoverageRow,
  modelActionFromInvestorLot,
  modelActionFromIndexTrend,
  modelActionFromIndexDt,
  snapshotMirrorCoverage,
  summarizeCoverageForDesk,
  coverageDeskHeadline,
  coverageDeskPlainLines,
  renderCoverageEmailBlock,
  notifyCoverageCleanIfDue,
  nyDateKey,
  COVERAGE_CLEAN_DAY_KEY,
  HEAL_PAGE_ONLY,
  HEAL_INVESTOR,
  HEAL_TRADER_EXIT,
  HEAL_INDEX_ENTRY,
  HEAL_INDEX_EXIT,
  HEAL_INTENT_DRAIN,
  COVERAGE_SNAPSHOT_KEY,
} from "./mirror-coverage.js";

const NOW = Date.UTC(2026, 8, 11, 16, 0, 0); // 12:00 ET
const OLD = NOW - 10 * 60 * 1000;

function stEntry(over = {}) {
  return {
    lane: "trader",
    event: "ENTRY",
    ticker: "TWLO",
    trade_id: "TWLO-1",
    position_id: "TWLO-1",
    ts: OLD,
    qty: 54.75,
    ...over,
  };
}

function ringOk(over = {}) {
  return {
    ticker: "TWLO",
    side: "buy",
    trade_id: "TWLO-1",
    ts: OLD + 1000,
    status: "ok",
    http_status: 200,
    order_id: "B-1",
    qty: 54.75,
    ...over,
  };
}

describe("classifyActionCoverage — Short Term", () => {
  it("1. unmatched ST ENTRY is unmatched", () => {
    const cov = classifyActionCoverage(stEntry(), { ring: [], nowMs: NOW });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toBe("never_attempted");
  });

  it("2. ST ENTRY with a real order_id is mirrored", () => {
    const cov = classifyActionCoverage(stEntry(), { ring: [ringOk()], nowMs: NOW });
    expect(cov.status).toBe("mirrored");
    expect(cov.order_id).toBe("B-1");
    expect(cov.broker_qty).toBe(54.75);
  });

  it("3. ST ENTRY false-ok HTTP 200 with no id is unmatched", () => {
    const cov = classifyActionCoverage(stEntry(), {
      ring: [ringOk({ order_id: null, rh_order_id: null, broker_order_id: null })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toBe("false_ok_no_order_id");
  });

  it("4. ST EXIT ring sell/exit is mirrored", () => {
    const cov = classifyActionCoverage({
      ...stEntry(), event: "EXIT", qty: 54.75,
    }, {
      ring: [ringOk({ side: "exit", order_id: "B-EXIT" })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
    expect(cov.order_id).toBe("B-EXIT");
  });

  it("5. ST EXIT with no ring but a pending intent is pending", () => {
    const cov = classifyActionCoverage({
      ...stEntry(), event: "EXIT",
    }, {
      ring: [],
      intents: [{ trade_id: "TWLO-1", side: "exit", status: "pending", qty: 54.75 }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("pending_intent");
  });

  it("6. ST EXIT with no ring and no intent is unmatched", () => {
    const cov = classifyActionCoverage({
      ...stEntry(), event: "EXIT",
    }, { ring: [], intents: [], nowMs: NOW });
    expect(cov.status).toBe("unmatched");
  });

  it("16. {ok:true, deduped:true} is not a buy fill", () => {
    const cov = classifyActionCoverage(stEntry(), {
      ring: [ringOk({ deduped: true, order_id: null })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toBe("deduped_not_a_fill");
  });

  it("TWLO-class fan-out: owner fill + partner cash reject is mirrored_partial", () => {
    const cov = classifyActionCoverage({
      ...stEntry(), event: "EXIT",
    }, {
      ring: [ringOk({
        side: "exit",
        order_id: "B2GOO3VT0GP16A83VK8FBGK9NB",
        reject_reason: "mirror_suppressed:insufficient_cash_for_one_unit_0_lt_233.85",
      })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored_partial");
  });
});

describe("classifyActionCoverage — Long Term", () => {
  const lot = {
    lane: "investor",
    event: "DCA_BUY",
    ticker: "PLTR",
    trade_id: "inv-PLTR-auto-1",
    position_id: "inv-PLTR-auto-1",
    lot_id: "lot-PLTR-dca-1",
    ts: OLD,
    qty: 11.93,
  };

  it("7. unmatched investor DCA is unmatched", () => {
    expect(classifyActionCoverage(lot, { ring: [], nowMs: NOW }).status).toBe("unmatched");
  });

  it("8. investor DCA with inv-* ring + lot_id is mirrored", () => {
    const cov = classifyActionCoverage(lot, {
      ring: [{
        ticker: "PLTR",
        side: "buy",
        trade_id: "inv-PLTR-auto-1",
        lot_id: "lot-PLTR-dca-1",
        ts: OLD + 500,
        status: "ok",
        order_id: "WB-DCA",
        qty: 0.24,
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
    expect(cov.broker_qty).toBe(0.24);
  });

  it("9. investor TRIM ring side=trim matches a SELL lot", () => {
    const trim = { ...lot, event: "TRIM", lot_id: "lot-PLTR-sell-1" };
    const cov = classifyActionCoverage(trim, {
      ring: [{
        ticker: "PLTR",
        side: "trim",
        trade_id: "inv-PLTR-auto-1",
        lot_id: "lot-PLTR-sell-1",
        ts: OLD + 500,
        status: "ok",
        http_status: 200,
        order_id: null,
        qty: 0.12,
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
  });

  it("17. a prior BUY on the same position does not cover a later DCA", () => {
    const cov = classifyActionCoverage(lot, {
      ring: [{
        ticker: "PLTR",
        side: "buy",
        trade_id: "inv-PLTR-auto-1",
        ts: OLD - 7 * 86400000,
        status: "ok",
        order_id: "WB-OLD",
        qty: 2,
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
  });

  it("modelActionFromInvestorLot maps invalidation SELL to EXIT", () => {
    const a = modelActionFromInvestorLot({
      id: 9,
      position_id: "inv-KO-auto-1",
      ticker: "KO",
      action: "SELL",
      shares: 4,
      ts: OLD,
      reason: "PRIMARY_INVALIDATION_BREACH",
    });
    expect(a.event).toBe("EXIT");
    expect(a.trade_id).toBe("inv-KO-auto-1");
    expect(a.lot_id).toBe("9");
  });
});

describe("classifyActionCoverage — index-trend / index DT / convexity", () => {
  it("10. index-trend BUY never-attempted is unmatched", () => {
    const a = modelActionFromIndexTrend({
      event: "BUY",
      signal_id: "it:IWM:TNA:LONG:2026-W37",
      letf_ticker: "TNA",
      shares: 30,
      ts: OLD,
    });
    expect(a.event).toBe("ENTRY");
    expect(classifyActionCoverage(a, { ring: [], nowMs: NOW }).status).toBe("unmatched");
  });

  it("11. index-trend EXIT no_broker_position is rejected_terminal", () => {
    const a = modelActionFromIndexTrend({
      event: "STOP",
      signal_id: "it:IWM:TNA:LONG:2026-W36",
      letf_ticker: "TNA",
      shares: 4,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "TNA",
        side: "exit",
        trade_id: "it:IWM:TNA:LONG:2026-W36",
        ts: OLD + 1000,
        status: "error",
        reject_reason: "no_broker_position",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("rejected_terminal");
  });

  it("12. index-trend EXIT generic bridge_reject stays unmatched", () => {
    const a = modelActionFromIndexTrend({
      event: "EXIT",
      signal_id: "it:IWM:TNA:LONG:2026-W36",
      letf_ticker: "TNA",
      shares: 4,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "TNA",
        side: "exit",
        trade_id: "it:IWM:TNA:LONG:2026-W36",
        ts: OLD + 1000,
        status: "error",
        reject_reason: "bridge_reject",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toMatch(/bridge_reject/);
  });

  it("13. index DT BUY unmatched", () => {
    const a = modelActionFromIndexDt({
      event: "BUY",
      signal_id: "dt:SPY:2026-09-11",
      ticker: "SPY",
      contracts: 2,
      ts: OLD,
    });
    expect(classifyActionCoverage(a, { ring: [], nowMs: NOW }).status).toBe("unmatched");
  });

  it("convexity close with a pending options intent is pending, not an anomaly", () => {
    const a = {
      lane: "convexity",
      event: "EXIT",
      ticker: "DELL",
      trade_id: "cx:DELL:2026-09-18:475C",
      ts: OLD,
      qty: 1,
    };
    const cov = classifyActionCoverage(a, {
      ring: [],
      intents: [{
        trade_id: "cx:DELL:2026-09-18:475C",
        side: "sell",
        status: "pending",
        qty: 1,
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("pending_intent");
  });

  it("mirror-log placed EXIT counts as mirrored when the ring is empty", () => {
    const a = modelActionFromIndexTrend({
      event: "EXIT",
      signal_id: "it:QQQ:TQQQ:LONG:2026-W36",
      letf_ticker: "TQQQ",
      shares: 8,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [],
      mirrorLogs: [{
        signal_id: "it:QQQ:TQQQ:LONG:2026-W36",
        event: "EXIT",
        side: "sell",
        decision: "placed",
        ts: OLD + 2000,
        qty: 8,
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
  });
});

describe("relative qty contract", () => {
  it("14. entry 100/2 and exit 100/2 is ok", () => {
    const rel = computeTradeRelativeQty([
      { event: "ENTRY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e" },
      { event: "EXIT", status: "mirrored", model_qty: 100, broker_qty: 2, key: "x" },
    ]);
    expect(rel.ok).toBe(true);
    expect(rel.ratio).toBeCloseTo(0.02);
  });

  it("15. entry 100/2 and exit 100/100 is drift", () => {
    const rel = computeTradeRelativeQty([
      { event: "ENTRY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e" },
      { event: "EXIT", status: "mirrored", model_qty: 100, broker_qty: 100, key: "x" },
    ]);
    expect(rel.ok).toBe(false);
    expect(rel.drifts).toHaveLength(1);
    expect(rel.drifts[0].expected).toBeCloseTo(2);
  });

  it("relativeQtyOk tolerates 0.05 shares or 10%", () => {
    expect(relativeQtyOk({ modelQty: 100, brokerQty: 2.04, basisRatio: 0.02 }).ok).toBe(true);
    expect(relativeQtyOk({ modelQty: 100, brokerQty: 3, basisRatio: 0.02 }).ok).toBe(false);
  });
});

describe("coverageAnomalies / evaluateModelBrokerCoverage", () => {
  it("18. quiet book produces no anomalies", () => {
    expect(coverageAnomalies([], { nowMs: NOW })).toEqual([]);
    expect(evaluateModelBrokerCoverage({ rows: [], nowMs: NOW })).toEqual([]);
  });

  it("in-flight unmatched ST ENTRY is not an anomaly", () => {
    const rows = buildCoverageRows([stEntry({ ts: NOW - 30_000 })], { ring: [], nowMs: NOW });
    expect(rows[0].status).toBe("in_flight");
    expect(coverageAnomalies(rows, { nowMs: NOW })).toEqual([]);
  });

  it("unmatched ST ENTRY older than grace is a fail + page_only heal", () => {
    const rows = buildCoverageRows([stEntry()], { ring: [], nowMs: NOW });
    const an = coverageAnomalies(rows, { nowMs: NOW });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("fail");
    expect(an[0].heal).toBe(HEAL_PAGE_ONLY);
  });

  it("pending intent EXIT is not an anomaly", () => {
    const rows = buildCoverageRows([{
      ...stEntry(), event: "EXIT",
    }], {
      ring: [],
      intents: [{ trade_id: "TWLO-1", side: "sell", status: "pending" }],
      nowMs: NOW,
    });
    expect(rows[0].status).toBe("pending_intent");
    expect(coverageAnomalies(rows, { nowMs: NOW })).toEqual([]);
  });

  it("terminal EXIT reject is not an anomaly", () => {
    const rows = buildCoverageRows([{
      lane: "index_trend",
      event: "EXIT",
      ticker: "TNA",
      trade_id: "it:IWM:TNA:LONG:2026-W36",
      ts: OLD,
      qty: 4,
    }], {
      ring: [{
        ticker: "TNA",
        side: "exit",
        trade_id: "it:IWM:TNA:LONG:2026-W36",
        ts: OLD + 1,
        status: "error",
        reject_reason: "already_flat",
      }],
      nowMs: NOW,
    });
    expect(rows[0].status).toBe("rejected_terminal");
    expect(coverageAnomalies(rows, { nowMs: NOW })).toEqual([]);
  });

  it("qty drift pages even when both legs mirrored", () => {
    const rows = buildCoverageRows([
      { ...stEntry(), qty: 100 },
      { ...stEntry(), event: "EXIT", qty: 100 },
    ], {
      ring: [
        ringOk({ qty: 2, order_id: "E" }),
        ringOk({ side: "exit", qty: 100, order_id: "X" }),
      ],
      nowMs: NOW,
    });
    const an = coverageAnomalies(rows, { nowMs: NOW });
    expect(an.some((a) => /qty drift/.test(a.detail))).toBe(true);
  });

  it("older unmatched trim is quiet when a later EXIT already mirrored", () => {
    const rows = buildCoverageRows([
      {
        lane: "investor",
        event: "TRIM",
        ticker: "PNC",
        trade_id: "inv-PNC-auto-1",
        position_id: "inv-PNC-auto-1",
        lot_id: "old-trim",
        ts: OLD - 3600000,
        qty: 1,
      },
      {
        lane: "investor",
        event: "EXIT",
        ticker: "PNC",
        trade_id: "inv-PNC-auto-1",
        position_id: "inv-PNC-auto-1",
        lot_id: "new-exit",
        ts: OLD,
        qty: 10,
      },
    ], {
      ring: [{
        ticker: "PNC",
        side: "exit",
        trade_id: "inv-PNC-auto-1",
        lot_id: "new-exit",
        ts: OLD + 1000,
        status: "ok",
        http_status: 200,
        qty: 0.2,
      }],
      nowMs: NOW,
    });
    const an = coverageAnomalies(rows, { nowMs: NOW });
    expect(an.filter((a) => a.event === "TRIM")).toHaveLength(0);
  });

  it("a later unmatched DCA still pages after a prior mirrored BUY", () => {
    const rows = buildCoverageRows([
      {
        lane: "investor",
        event: "ENTRY",
        ticker: "PLTR",
        trade_id: "inv-PLTR-auto-1",
        position_id: "inv-PLTR-auto-1",
        lot_id: "old-buy",
        ts: OLD - 7 * 86400000,
        qty: 10,
      },
      {
        lane: "investor",
        event: "DCA_BUY",
        ticker: "PLTR",
        trade_id: "inv-PLTR-auto-1",
        position_id: "inv-PLTR-auto-1",
        lot_id: "today-dca",
        ts: OLD,
        qty: 12,
      },
    ], {
      ring: [{
        ticker: "PLTR",
        side: "buy",
        trade_id: "inv-PLTR-auto-1",
        lot_id: "old-buy",
        ts: OLD - 7 * 86400000 + 1000,
        status: "ok",
        order_id: "OLD",
        qty: 0.2,
      }],
      nowMs: NOW,
    });
    const an = coverageAnomalies(rows, { nowMs: NOW });
    expect(an.some((a) => a.event === "DCA_BUY" && a.status === "unmatched")).toBe(true);
  });
});

describe("heal routing — existing lanes only, never a new ST buy path", () => {
  it("maps each unmatched lane to the healer that already exists", () => {
    expect(healForCoverageRow({ lane: "investor", event: "DCA_BUY", status: "unmatched" })).toBe(HEAL_INVESTOR);
    expect(healForCoverageRow({ lane: "trader", event: "EXIT", status: "unmatched" })).toBe(HEAL_TRADER_EXIT);
    expect(healForCoverageRow({ lane: "trader", event: "ENTRY", status: "unmatched" })).toBe(HEAL_PAGE_ONLY);
    expect(healForCoverageRow({ lane: "index_trend", event: "ENTRY", status: "unmatched" })).toBe(HEAL_INDEX_ENTRY);
    expect(healForCoverageRow({ lane: "index_trend", event: "EXIT", status: "unmatched" })).toBe(HEAL_INDEX_EXIT);
    expect(healForCoverageRow({ lane: "convexity", event: "EXIT", status: "unmatched" })).toBe(HEAL_INTENT_DRAIN);
    expect(healForCoverageRow({ lane: "index_dt", event: "ENTRY", status: "unmatched" })).toBe(HEAL_PAGE_ONLY);
  });

  it("heal plan de-dupes and drops page_only", () => {
    expect(coverageHealPlan([
      { heal: HEAL_INVESTOR },
      { heal: HEAL_INVESTOR },
      { heal: HEAL_PAGE_ONLY },
      { heal: HEAL_TRADER_EXIT },
    ])).toEqual([HEAL_INVESTOR, HEAL_TRADER_EXIT]);
  });
});

describe("ETH deferred EXIT is not an unmatched fail", () => {
  it("classifies extended-hours limit-only as deferred", () => {
    const rows = buildCoverageRows([{
      lane: "trader",
      event: "EXIT",
      ticker: "TWLO",
      trade_id: "TWLO-1",
      ts: OLD,
      qty: 1,
    }], {
      ring: [{
        ticker: "TWLO",
        side: "exit",
        trade_id: "TWLO-1",
        ts: OLD + 1,
        status: "error",
        reject_reason: "only limit orders are supported for extended-hours trading",
      }],
      nowMs: NOW,
    });
    expect(rows[0].status).toBe("deferred");
    expect(coverageAnomalies(rows, { nowMs: NOW })).toEqual([]);
  });
});

describe("source contract — coverage is wired fail-closed", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  it("sanity sweep and index cron/admin expose the contract", () => {
    const sweep = readFileSync(join(root, "sanity-sweep.js"), "utf8");
    expect(sweep).toMatch(/checkModelBrokerCoverage/);
    expect(sweep).toMatch(/model_broker_coverage/);
    const index = readFileSync(join(root, "index.js"), "utf8");
    expect(index).toMatch(/GET \/timed\/admin\/broker\/coverage/);
    expect(index).toMatch(/snapshotMirrorCoverage/);
    expect(index).toMatch(/overlayLiveCoverage/);
    expect(index).toMatch(/paged_clean/);
    expect(index).toMatch(/ADMIN_EMAIL/);
    expect(index).toMatch(/POST \/timed\/admin\/index-trend\/heal-entries/);
    const coo = readFileSync(join(root, "coo/coo-orchestrator.js"), "utf8");
    expect(coo).toMatch(/model_broker_coverage/);
    expect(coo).toMatch(/_healModelBrokerCoverage/);
  });
});

describe("snapshotMirrorCoverage", () => {
  it("writes the snapshot and pages only when the fail set changes", async () => {
    const store = new Map();
    const env = {
      KV_TIMED: {
        async get(k) { return store.get(k) ?? null; },
        async put(k, v) { store.set(k, v); },
      },
      DB: {
        prepare() {
          return {
            bind() {
              return { async all() { return { results: [] }; } };
            },
          };
        },
      },
    };
    const pages = [];
    const first = await snapshotMirrorCoverage(env, {
      nowMs: NOW,
      sinceMs: NOW - 86400000,
      notify: async (embed) => { pages.push(embed); },
    });
    expect(first.summary.actions).toBe(0);
    expect(first.paged).toBe(false);
    expect(first.paged_clean).toBe(false);
    expect(store.has(COVERAGE_SNAPSHOT_KEY)).toBe(true);
    expect(pages).toHaveLength(0);
  });
});

describe("coverage desk helpers", () => {
  it("summarizes a healthy snapshot and renders the dark email block", () => {
    const desk = summarizeCoverageForDesk({
      ts: NOW,
      summary: { actions: 4, mirrored: 4, unmatched: 0, pending_intent: 0, rejected_terminal: 0, fails: 0 },
      anomalies: [],
    });
    expect(desk.healthy).toBe(true);
    expect(coverageDeskHeadline(desk)).toBe("4 model actions mirrored");
    expect(coverageDeskPlainLines(desk)).toContain("mirrored 4");
    const html = renderCoverageEmailBlock(desk, { href: "https://timed-trading.com/execution-review.html" });
    expect(html).toContain("Model vs broker");
    expect(html).toContain("#00c853");
    expect(html).toContain("Open Execution Review");
    expect(html).toContain("#0b0e11");
  });

  it("lists unmatched samples and escapes HTML", () => {
    const desk = summarizeCoverageForDesk({
      ts: NOW,
      summary: { actions: 2, mirrored: 1, unmatched: 1, pending_intent: 0, rejected_terminal: 0, fails: 1 },
      anomalies: [{
        severity: "fail", ticker: "TWLO", lane: "trader", event: "ENTRY",
        reason: "never_attempted <script>",
      }],
    });
    expect(desk.healthy).toBe(false);
    expect(coverageDeskHeadline(desk)).toBe("1 unmatched model action");
    const html = renderCoverageEmailBlock(desk);
    expect(html).toContain("TWLO");
    expect(html).toContain("never_attempted &lt;script&gt;");
    expect(html).not.toContain("never_attempted <script>");
  });

  it("pages a clean Discord line once per NY day", async () => {
    const store = new Map();
    const env = {
      KV_TIMED: {
        async get(k) { return store.get(k) ?? null; },
        async put(k, v) { store.set(k, v); },
      },
    };
    const pages = [];
    const desk = { healthy: true, actions: 3, quiet: false };
    const first = await notifyCoverageCleanIfDue(env, desk, {
      nowMs: NOW,
      notify: async (embed) => { pages.push(embed); },
    });
    const again = await notifyCoverageCleanIfDue(env, desk, {
      nowMs: NOW,
      notify: async (embed) => { pages.push(embed); },
    });
    expect(first).toBe(true);
    expect(again).toBe(false);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("BROKER COVERAGE · clean");
    expect(store.get(COVERAGE_CLEAN_DAY_KEY)).toBe(nyDateKey(NOW));
  });
});
