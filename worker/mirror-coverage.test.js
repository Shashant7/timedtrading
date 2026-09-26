import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyActionCoverage,
  relativeQtyOk,
  computeTradeRelativeQty,
  describePartialMirror,
  buildCoverageRows,
  coverageAnomalies,
  evaluateModelBrokerCoverage,
  coverageHealPlan,
  healForCoverageRow,
  modelActionFromInvestorLot,
  modelActionFromIndexTrend,
  modelActionFromIndexTrendBook,
  loadIndexTrendBookActions,
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
  HEAL_INDEX_DT_EXIT,
  HEAL_INTENT_DRAIN,
  COVERAGE_SNAPSHOT_KEY,
} from "./mirror-coverage.js";
import { _healModelBrokerCoverage } from "./coo/coo-orchestrator.js";

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

  it("ST EXIT no_broker_position is known-why external_reduction", () => {
    const a = { ...stEntry(), event: "EXIT" };
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "TWLO",
        side: "exit",
        trade_id: a.trade_id,
        ts: OLD + 1000,
        status: "error",
        reject_reason: "no_broker_position",
      }],
      nowMs: NOW,
    });
    expect(cov).toMatchObject({
      status: "rejected_terminal",
      reason: "external_reduction",
      known_why: true,
    });
    expect(healForCoverageRow({ ...a, ...cov })).toBeNull();
  });

  it("ST EXIT client_order_id_collision is a defect + trader exit heal", () => {
    const a = { ...stEntry(), event: "EXIT" };
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "TWLO",
        side: "exit",
        trade_id: a.trade_id,
        ts: OLD + 1000,
        status: "error",
        reject_reason: "client_order_id_collision",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toMatch(/^defect:client_order_id_collision/);
    expect(healForCoverageRow({ ...a, ...cov })).toBe(HEAL_TRADER_EXIT);
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

  it("12. index-trend EXIT generic bridge_reject is a defect (healable unmatched)", () => {
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
    expect(cov.reason).toMatch(/^defect:bridge_reject/);
    expect(cov.known_why).toBe(false);
    expect(healForCoverageRow({ ...a, ...cov })).toBe(HEAL_INDEX_EXIT);
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

  it("index DT ENTRY order_rejected is terminal (nothing to heal)", () => {
    // 2026-09-26 — DIA P511 sat unmatched for the full 48h window and
    // re-paged #system-alerts every cycle. Broker already refused; ENTRIES
    // must re-qualify, so unmatched forever is spam.
    const a = modelActionFromIndexDt({
      event: "BUY",
      signal_id: "dt:DIA:2026-09-25:2026-09-28:P:511",
      ticker: "DIA",
      contracts: 2,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "DIA",
        side: "buy",
        trade_id: "dt:DIA:2026-09-25:2026-09-28:P:511",
        ts: OLD + 1000,
        status: "error",
        reject_reason: "order_rejected",
      }],
      nowMs: NOW,
    });
    expect(cov).toMatchObject({
      status: "rejected_terminal",
      reason: "order_rejected",
      known_why: true,
    });
    expect(healForCoverageRow({ ...a, ...cov })).toBeNull();
  });

  it("index DT EXIT no_held_position is known-why external_reduction", () => {
    const a = modelActionFromIndexDt({
      event: "STOP",
      signal_id: "dt:SPY:2026-09-25:P:763",
      ticker: "SPY",
      contracts: 1,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "SPY",
        side: "exit",
        trade_id: "dt:SPY:2026-09-25:P:763",
        ts: OLD + 1000,
        status: "error",
        reject_reason: "no_held_position",
      }],
      nowMs: NOW,
    });
    expect(cov).toMatchObject({
      status: "rejected_terminal",
      reason: "external_reduction",
      known_why: true,
    });
  });

  it("index DT EXIT unnamed reject is a defect (healable unmatched)", () => {
    const a = modelActionFromIndexDt({
      event: "STOP",
      signal_id: "dt:QQQ:2026-09-25:P:740",
      ticker: "QQQ",
      contracts: 1,
      ts: OLD,
    });
    const cov = classifyActionCoverage(a, {
      ring: [{
        ticker: "QQQ",
        side: "exit",
        trade_id: "dt:QQQ:2026-09-25:P:740",
        ts: OLD + 1000,
        status: "error",
        reject_reason: "client_order_id_collision",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toMatch(/^defect:client_order_id_collision/);
    expect(cov.known_why).toBe(false);
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

  // 2026-09-24 — GS / DINO / EMR. A DCA'd position is built from adds that
  // are each sized against that day's cash, so the opening buy's ratio is a
  // sample of one and the true ratio moves off it.
  it("bases the ratio on ALL mirrored opens, not just the first", () => {
    const rel = computeTradeRelativeQty([
      { event: "BUY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e1" },
      { event: "DCA_BUY", status: "mirrored", model_qty: 100, broker_qty: 8, key: "e2" },
      // 200 model / 10 broker = 0.05. The exit sells the whole sleeve.
      { event: "SELL", status: "mirrored", model_qty: 200, broker_qty: 10, key: "x" },
    ]);
    expect(rel.ratio).toBeCloseTo(0.05);
    expect(rel.ok).toBe(true);
  });

  it("would have called that same exit drift on the first-open ratio", () => {
    // Guards the fix: measured against the opening 0.02 the broker's 10
    // shares are 5x the 4 "expected", which is what paged three times.
    expect(relativeQtyOk({ modelQty: 200, brokerQty: 10, basisRatio: 0.02 }).ok).toBe(false);
  });

  it("does not size-check a reduce that left the broker flat", () => {
    const rows = [
      { event: "BUY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e", ticker: "GS" },
      { event: "TRIM", status: "mirrored", model_qty: 100, broker_qty: 50, key: "x", ticker: "GS" },
    ];
    expect(computeTradeRelativeQty(rows).ok).toBe(false);
    // Same rows, but the account holds nothing afterwards: the model closed
    // out and the broker went flat with it.
    const rel = computeTradeRelativeQty(rows, { held: { AAPL: { qty: 3 } } });
    expect(rel.ok).toBe(true);
    expect(rel.drifts).toHaveLength(0);
  });

  it("still size-checks a reduce that left shares behind", () => {
    const rows = [
      { event: "BUY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e", ticker: "GS" },
      { event: "TRIM", status: "mirrored", model_qty: 100, broker_qty: 50, key: "x", ticker: "GS" },
    ];
    expect(computeTradeRelativeQty(rows, { held: { GS: { qty: 4 } } }).ok).toBe(false);
  });

  it("still size-checks when holdings could not be read", () => {
    // A null map means the call failed. Nothing may be concluded from it.
    const rows = [
      { event: "BUY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e", ticker: "GS" },
      { event: "TRIM", status: "mirrored", model_qty: 100, broker_qty: 50, key: "x", ticker: "GS" },
    ];
    expect(computeTradeRelativeQty(rows, { held: null }).ok).toBe(false);
  });

  it("does not exempt an OPEN just because the ticker reads flat", () => {
    const rows = [
      { event: "BUY", status: "mirrored", model_qty: 100, broker_qty: 2, key: "e", ticker: "GS" },
      { event: "DCA_BUY", status: "mirrored", model_qty: 100, broker_qty: 90, key: "d", ticker: "GS" },
    ];
    // Both are opens, so the basis is their sum and neither is exempt.
    expect(computeTradeRelativeQty(rows, { held: {} }).ratio).toBeCloseTo(0.46);
  });
});

describe("describePartialMirror", () => {
  it("says the ENTRY was suppressed, not the sell", () => {
    expect(describePartialMirror({
      ticker: "EMR",
      event: "TRIM",
      reason: "mirror_suppressed:insufficient_cash_for_one_unit_0_lt_154.73",
    })).toBe("EMR TRIM sold against a sleeve whose ENTRY was suppressed"
      + " (insufficient_cash_for_one_unit_0_lt_154.73)");
  });

  it("leaves an ordinary partial alone", () => {
    expect(describePartialMirror({
      ticker: "ANET",
      event: "DCA_BUY",
      reason: "broker_scaled_to_1.1_of_9.8_11pct_cash_buffer",
    })).toBe("ANET DCA_BUY mirrored only in part (broker_scaled_to_1.1_of_9.8_11pct_cash_buffer)");
  });

  it("does not reword an OPEN — a buy really can be cash-capped", () => {
    expect(describePartialMirror({
      ticker: "EMR",
      event: "DCA_BUY",
      reason: "mirror_suppressed:insufficient_cash_for_one_unit_0_lt_154.73",
    })).toContain("mirrored only in part");
  });

  it("survives a missing reason", () => {
    expect(describePartialMirror({ ticker: "KO", event: "TRIM" }))
      .toBe("KO TRIM mirrored only in part (partial)");
  });
});

describe("declined entry vs never attempted", () => {
  const dtEntry = (ts) => ({
    lane: "index_dt", ticker: "QQQ", event: "BUY", qty: 1, ts,
    trade_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
  });

  it("a loss-budget decline is terminal, carrying its reason", () => {
    const cov = classifyActionCoverage(dtEntry(OLD), {
      ring: [],
      mirrorLogs: [{
        signal_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
        event: "BUY",
        decision: "skipped",
        reason: "daily_loss_budget_52_left_of_500_needs_108",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("rejected_terminal");
    expect(cov.reason).toContain("daily_loss_budget");
  });

  it("a vehicle daily cap decline is terminal", () => {
    const cov = classifyActionCoverage(dtEntry(OLD), {
      ring: [],
      mirrorLogs: [{
        signal_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
        event: "BUY",
        decision: "skipped",
        reason: "vehicle_daily_cap_2_reached_for_long_put",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("rejected_terminal");
  });

  it("an entry with no decision record stays unmatched / never_attempted", () => {
    const cov = classifyActionCoverage(dtEntry(OLD), {
      ring: [], mirrorLogs: [], nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toBe("never_attempted");
  });

  it("an unrecognised skip reason stays unmatched but reports the reason", () => {
    const cov = classifyActionCoverage(dtEntry(OLD), {
      ring: [],
      mirrorLogs: [{
        signal_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
        event: "BUY",
        decision: "skipped",
        reason: "some_new_gate_nobody_has_mapped",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(cov.reason).toBe("some_new_gate_nobody_has_mapped");
  });

  it("a declined-entry reason does NOT excuse a reduce", () => {
    // The whole point of the check is that an unsold position pages.
    const cov = classifyActionCoverage({
      lane: "index_dt", ticker: "QQQ", event: "EXIT", qty: 1, ts: OLD,
      trade_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
    }, {
      ring: [],
      mirrorLogs: [{
        signal_id: "dt:QQQ:2026-09-24:2026-09-25:C:744",
        event: "EXIT",
        decision: "skipped",
        reason: "daily_loss_budget_52_left_of_500_needs_108",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
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
    // A day-trade entry that missed is gone with the setup; a close that
    // missed is a live contract the model thinks it is out of (IWM 279P).
    expect(healForCoverageRow({ lane: "index_dt", event: "EXIT", status: "rejected" })).toBe(HEAL_INDEX_DT_EXIT);
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

  // The healer fans out to five lanes and its verdict decides whether the
  // check is marked healed and takes a 4h cooldown. `some(row => row.ok)`
  // was unconditionally true because `broker-intents/drain` answers ok:true
  // with nothing to drain — so four lanes could throw while the page stayed
  // suppressed for four hours. That is "the signal never went through and
  // nothing told the desk", which is the whole point of this contract.
  it("the coverage healer's verdict requires every lane, not any lane", async () => {
    // Asserted on behaviour rather than on the source text: the earlier
    // version sliced the function body out of the file and broke the moment
    // the healer grew a loop, while proving nothing about what it returns.
    const store = new Map();
    const env = {
      KV_TIMED: {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
      },
      ADMIN_API_KEY: "k",
      TIMED_API_KEY: "k",
      SELF_BASE_URL: "https://worker.test",
    };
    // Only the drain lane answers ok — the shape that used to mark the whole
    // check healed and take a 4h cooldown while four lanes were throwing.
    globalThis.fetch = async (url) => {
      const ok = String(url).includes("broker-intents/drain");
      return new Response(JSON.stringify({ ok }), {
        status: ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    };
    const out = await _healModelBrokerCoverage(env);
    expect(out.ok).toBe(false);
    // The failing lanes must be named, or the operator cannot triage.
    expect(out.failed).toContain("index_entries");
    expect(out.failed).toContain("trader_exits");
    expect(out.failed).not.toContain("intents");
    // And the reason the desk sees has to carry them.
    const coo = readFileSync(join(root, "coo/coo-orchestrator.js"), "utf8");
    expect(coo).toMatch(/lanes:\$\{action\.failed\.join\(","\)\}/);
  });
});

describe("index_trend lane reads the paper book, not just the tape", () => {
  function bookEnv(books = {}) {
    const store = new Map(Object.entries(books));
    return {
      KV_TIMED: {
        get: async (k) => store.get(k) ?? null,
        put: async (k, v) => { store.set(k, v); },
      },
    };
  }

  const openBook = (over = {}) => ({
    status: "open",
    shares: 42,
    entry_ts: NOW - 6 * 3600 * 1000,
    entry_letf_price: 69.65,
    ...over,
  });

  // Same shape persistIndexTrendBook writes: the carry key inlines the book.
  const carry = (letf, signalId, book) => ({
    [`timed:idx-trend-carry:${letf}`]: JSON.stringify({
      signal_id: signalId,
      book_key: `timed:idx-trend-book:${signalId}`,
      book,
      ts: book.entry_ts,
    }),
    [`timed:idx-trend-book:${signalId}`]: JSON.stringify(book),
  });

  it("surfaces a live book whose tape row was never written (2026-09-14)", async () => {
    // timed:idx-trend-actions stopped gaining rows on 2026-09-10 while
    // UDOW W38 opened and ran unmirrored.
    const env = bookEnv(carry("UDOW", "it:DIA:UDOW:LONG:2026-W38", openBook()));
    const actions = await loadIndexTrendBookActions(env, { sinceMs: NOW - 48 * 3600 * 1000, nowMs: NOW });
    const udow = actions.find((a) => a.ticker === "UDOW");
    expect(udow).toBeTruthy();
    expect(udow.lane).toBe("index_trend");
    expect(udow.event).toBe("ENTRY");
    expect(udow.trade_id).toBe("it:DIA:UDOW:LONG:2026-W38");
    expect(udow.qty).toBe(42);
    expect(udow.source).toBe("idx-trend-book");
  });

  it("keeps a book older than the coverage window while a heal can still act", async () => {
    // TNA W37 opened 2026-09-11 and was still open + unmirrored on 09-14.
    const env = bookEnv(carry("TNA", "it:IWM:TNA:LONG:2026-W37", openBook({
      shares: 46,
      entry_ts: NOW - 3 * 86400 * 1000,
    })));
    const actions = await loadIndexTrendBookActions(env, { sinceMs: NOW - 2 * 3600 * 1000, nowMs: NOW });
    expect(actions.map((a) => a.ticker)).toContain("TNA");
  });

  it("ignores closed books", async () => {
    const env = bookEnv(carry("TQQQ", "it:QQQ:TQQQ:LONG:2026-W37", openBook({ status: "closed" })));
    const actions = await loadIndexTrendBookActions(env, { sinceMs: 0, nowMs: NOW });
    expect(actions).toEqual([]);
  });

  it("classifies a book-derived entry with no broker place as unmatched", () => {
    const action = modelActionFromIndexTrendBook(
      { status: "open", shares: 42, entry_ts: OLD, entry_letf_price: 69.65 },
      { letf: "UDOW", signalId: "it:DIA:UDOW:LONG:2026-W38" },
    );
    const cov = classifyActionCoverage(action, {
      ring: [],
      intents: [],
      // The live mirror log only ever recorded an unnamed pipeline drop —
      // a known-why cap skip is rejected_terminal (canonicalDivergence).
      mirrorLogs: [{
        signal_id: "it:DIA:UDOW:LONG:2026-W38",
        side: "buy",
        decision: "skipped",
        reason: "pipeline_dropped_no_reason",
      }],
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(healForCoverageRow({ ...action, ...cov })).toBe(HEAL_INDEX_ENTRY);
  });

  it("names a known-why cap skip as rejected_terminal (not a healable miss)", () => {
    const action = modelActionFromIndexTrendBook(
      { status: "open", shares: 42, entry_ts: OLD, entry_letf_price: 69.65 },
      { letf: "UDOW", signalId: "it:DIA:UDOW:LONG:2026-W38b" },
    );
    const cov = classifyActionCoverage(action, {
      ring: [],
      intents: [],
      mirrorLogs: [{
        signal_id: "it:DIA:UDOW:LONG:2026-W38b",
        side: "buy",
        decision: "skipped",
        reason: "notional_2925_exceeds_cap_2000",
      }],
      nowMs: NOW,
    });
    expect(cov).toMatchObject({
      status: "rejected_terminal",
      reason: "per_order_cap",
      known_why: true,
    });
    expect(healForCoverageRow({ ...action, ...cov })).toBeNull();
  });

  // SPYU W38: the broker filled 9 shares, the ring row never got its
  // response written back, and the sleeve was later adopted from the live
  // position. Coverage must read that as mirrored or it pages forever on a
  // sleeve that is genuinely held.
  it("reads a sleeve adopted from a live broker position as mirrored", async () => {
    const signalId = "it:SPY:SPYU:LONG:2026-W38";
    const env = bookEnv({
      ...carry("SPYU", signalId, openBook({ shares: 90, entry_letf_price: 33.42 })),
      [`timed:idx-trend-mirror:${signalId}`]: JSON.stringify({
        entry_fired: true,
        entry_fired_ts: NOW - 3600 * 1000,
        adopted_from_broker: true,
        adopted_broker_qty: 9,
        shares: 9,
        shares_remaining: 9,
      }),
    });

    const [action] = await loadIndexTrendBookActions(env, { sinceMs: 0, nowMs: NOW });
    expect(action.broker_confirmed).toBe(true);
    expect(action.adopted).toBe(true);

    const cov = classifyActionCoverage(action, {
      // The ring is still stuck on the pre-fetch breadcrumb.
      ring: [{
        ticker: "SPYU", side: "buy", status: "pending",
        trade_id: signalId, ts: NOW - 5 * 3600 * 1000,
      }],
      intents: [],
      mirrorLogs: [],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
    expect(cov.broker_qty).toBe(9);
  });

  it("still pages a live book that no mirror row claims", async () => {
    const signalId = "it:IWM:TNA:LONG:2026-W37";
    const env = bookEnv(carry("TNA", signalId, openBook({ shares: 46 })));
    const [action] = await loadIndexTrendBookActions(env, { sinceMs: 0, nowMs: NOW });
    expect(action.broker_confirmed).toBeUndefined();
    const cov = classifyActionCoverage(action, {
      ring: [], intents: [], mirrorLogs: [], nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
  });
});

// 2026-09-14 — four trader EXITs paged `unmatched / ring_not_a_place`.
// The broker held 0 of U and 0 of MNST (nothing left to sell) and still
// held 0.2714 DPZ and 3.55262 KO (a real miss). A page that fires on all
// four teaches the desk to ignore it.
describe("a reduce is settled by what the broker still holds", () => {
  const exitAction = (ticker) => ({
    lane: "trader",
    event: "EXIT",
    ticker,
    trade_id: `${ticker}-1789136631694-x`,
    ts: OLD,
    qty: 3,
  });

  const HELD = {
    DPZ: { qty: 0.2714 },
    KO: { qty: 3.55262 },
  };

  it("stops paging an EXIT on a ticker the account is already flat in", () => {
    for (const ticker of ["U", "MNST"]) {
      const cov = classifyActionCoverage(exitAction(ticker), {
        ring: [], intents: [], mirrorLogs: [], held: HELD, nowMs: NOW,
      });
      expect(cov.status).toBe("rejected_terminal");
      expect(cov.reason).toBe("external_reduction");
      expect(cov.known_why).toBe(true);
    }
  });

  it("still pages an EXIT on a position the broker really holds", () => {
    for (const ticker of ["DPZ", "KO"]) {
      const cov = classifyActionCoverage(exitAction(ticker), {
        ring: [], intents: [], mirrorLogs: [], held: HELD, nowMs: NOW,
      });
      expect(cov.status).toBe("unmatched");
      expect(healForCoverageRow({ ...exitAction(ticker), ...cov })).toBe(HEAL_TRADER_EXIT);
    }
  });

  // Same DPZ and KO, one layer deeper. The Roth really held 0.2714 and
  // 3.55262 — but of two older DPZ lots and an `inv-KO-auto` DCA sleeve.
  // Neither exited trade had a manifest sleeve, so its entry never
  // mirrored and its exit has nothing of its own to sell.
  it("stops paging an EXIT whose sleeve the broker never held", () => {
    const sleeves = {
      "dpz-1787578665830-9812wt90w": { filled: 0.40942, remaining: 0.2714, accounts: 1 },
      "ko-auto-1782223315559": { filled: 3.55262, remaining: 3.55262, accounts: 1 },
    };
    for (const ticker of ["DPZ", "KO"]) {
      const cov = classifyActionCoverage(exitAction(ticker), {
        ring: [], intents: [], mirrorLogs: [], held: HELD, sleeves, nowMs: NOW,
      });
      expect(cov.status).toBe("rejected_terminal");
      expect(cov.reason).toBe("external_reduction");
      expect(cov.known_why).toBe(true);
    }
  });

  it("calls a sleeve the broker already sold down terminal", () => {
    const action = exitAction("DPZ");
    const cov = classifyActionCoverage(action, {
      ring: [],
      intents: [],
      mirrorLogs: [],
      held: HELD,
      sleeves: { [action.trade_id.toLowerCase()]: { filled: 0.40942, remaining: 0, accounts: 1 } },
      nowMs: NOW,
    });
    expect(cov.status).toBe("rejected_terminal");
    expect(cov.reason).toBe("external_reduction");
    expect(cov.known_why).toBe(true);
  });

  it("keeps paging an EXIT whose sleeve still holds shares", () => {
    const action = exitAction("DPZ");
    const cov = classifyActionCoverage(action, {
      ring: [],
      intents: [],
      mirrorLogs: [],
      held: HELD,
      sleeves: { [action.trade_id.toLowerCase()]: { filled: 0.40942, remaining: 0.2714, accounts: 1 } },
      nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
    expect(healForCoverageRow({ ...action, ...cov })).toBe(HEAL_TRADER_EXIT);
  });

  // SPYU W38 was adopted from a broker-only position, so the manifest has
  // never heard of the signal. An absent sleeve must not silence its close.
  it("ignores sleeves for a paper lane that closes off its own mirror row", () => {
    const cov = classifyActionCoverage({
      lane: "index_trend",
      event: "EXIT",
      ticker: "SPYU",
      trade_id: "it:SPY:SPYU:LONG:2026-W38",
      ts: OLD,
      qty: 9,
    }, {
      ring: [], intents: [], mirrorLogs: [], held: { SPYU: { qty: 9 } }, sleeves: {}, nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
  });

  it("pages as before when holdings could not be read", () => {
    const cov = classifyActionCoverage(exitAction("U"), {
      ring: [], intents: [], mirrorLogs: [], held: null, nowMs: NOW,
    });
    expect(cov.status).toBe("unmatched");
  });

  it("does not silence a missed ENTRY just because the broker is flat", () => {
    const cov = classifyActionCoverage(
      { lane: "trader", event: "ENTRY", ticker: "TNA", trade_id: "t-1", ts: OLD, qty: 46 },
      { ring: [], intents: [], mirrorLogs: [], held: {}, nowMs: NOW },
    );
    expect(cov.status).toBe("unmatched");
  });

  it("treats sub-share dust as flat", () => {
    const cov = classifyActionCoverage(exitAction("XLRE"), {
      ring: [], intents: [], mirrorLogs: [], held: { XLRE: { qty: 1e-9 } }, nowMs: NOW,
    });
    expect(cov.status).toBe("rejected_terminal");
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

// 2026-09-15 — a place that only took part of the sleeve used to report a
// clean "mirrored". The bridge scales a buy to fit the account, so the heal
// sent TNA W37 for 31 shares and UDOW W38 for 28 and the concentration
// ceiling on a $14.8k Roth placed 5 of each. Coverage is the one surface the
// operator reads to decide whether a signal reached the broker, and it said
// yes without qualification for a 16%-filled sleeve.
describe("a broker-scaled place is partial, not a clean mirror", () => {
  it("flags the shortfall with the accepted/requested pair and the cause", () => {
    const cov = classifyActionCoverage(stEntry({ ticker: "TNA", qty: 31 }), {
      ring: [ringOk({
        ticker: "TNA",
        qty: 31,
        bridge_scaled_qty: 5,
        bridge_scale_reason: "concentration",
      })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored_partial");
    expect(cov.reason).toBe("broker_scaled_to_5_of_31_16pct_concentration");
    // broker_qty must be what the broker took, not what we asked for —
    // this is the number an operator reconciles against the account.
    expect(cov.broker_qty).toBe(5);
  });

  it("still reports a full place as mirrored", () => {
    const cov = classifyActionCoverage(stEntry({ ticker: "TNA", qty: 31 }), {
      ring: [ringOk({ ticker: "TNA", qty: 31 })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
    expect(cov.reason).toBeNull();
  });

  it("does not call fractional-share rounding a partial", () => {
    // Every successful reduce in the live ring is a fractional share count
    // (0.2599, 1.3538, 6.3851). A dust-level delta is not a shortfall.
    const cov = classifyActionCoverage(stEntry({ qty: 54.75 }), {
      ring: [ringOk({ qty: 54.75, bridge_scaled_qty: 54.7499 })],
      nowMs: NOW,
    });
    expect(cov.status).toBe("mirrored");
  });

  it("warns rather than pages, and describes the real cause", () => {
    const rows = [{
      ...stEntry({ ticker: "TNA" }),
      status: "mirrored_partial",
      reason: "broker_scaled_to_5_of_31_16pct_concentration",
      key: "k1",
    }];
    const an = coverageAnomalies(rows, { nowMs: NOW });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("warn");
    // The old copy asserted a fan-out reject, which is not what happened.
    expect(an[0].detail).toContain("mirrored only in part");
    expect(an[0].detail).toContain("broker_scaled_to_5_of_31");
  });
});
