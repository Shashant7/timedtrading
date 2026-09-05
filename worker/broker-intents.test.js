import { describe, it, expect } from "vitest";
import {
  isReducerOrder,
  classifyBridgeOutcome,
  intentIdFor,
  intentWindowOpen,
  nextIntentState,
  recordBrokerIntent,
  drainBrokerIntents,
  INTENT_MAX_ATTEMPTS,
} from "./broker-intents.js";

// Minimal D1 fake: enough of prepare/bind/run/all/first for the module.
function fakeDb() {
  const rows = new Map();
  const db = {
    _rows: rows,
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = a; return stmt; };
      stmt.run = async () => {
        if (/CREATE (TABLE|INDEX)/i.test(sql)) return { meta: { changes: 0 } };
        if (/INSERT INTO broker_intents/i.test(sql)) {
          const [id, trade_id, ticker, side, qty, user_id, lane, reason, order_json, last_outcome, last_reason, last_client_order_id, created_ts, updated_ts, expires_ts] = stmt.args;
          const prev = rows.get(id);
          rows.set(id, {
            id, trade_id, ticker, side, qty, user_id, lane, reason, order_json,
            status: "pending", attempts: 0, last_outcome, last_reason, last_client_order_id,
            created_ts: prev?.created_ts ?? created_ts, updated_ts, expires_ts, filled_ts: null,
          });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE broker_intents SET status = 'expired'/i.test(sql)) {
          const [now, cutoff] = stmt.args;
          let n = 0;
          for (const r of rows.values()) if (r.status === "pending" && r.expires_ts <= cutoff) { r.status = "expired"; r.updated_ts = now; n++; }
          return { meta: { changes: n } };
        }
        if (/UPDATE broker_intents\s+SET status = \?, attempts = \?/i.test(sql)) {
          const [status, attempts, outcome, reason, coid, now, , , id] = stmt.args;
          const r = rows.get(id);
          if (r && r.status === "pending") {
            Object.assign(r, { status, attempts, last_outcome: outcome, last_reason: reason, last_client_order_id: coid, updated_ts: now });
            if (status === "filled") r.filled_ts = now;
          }
          return { meta: { changes: r ? 1 : 0 } };
        }
        if (/UPDATE broker_intents SET status = \?, updated_ts = \?/i.test(sql)) {
          const [status, now, , , id] = stmt.args;
          const r = rows.get(id);
          if (r && r.status === "pending") { r.status = status; r.updated_ts = now; if (status === "filled") r.filled_ts = now; }
          return { meta: { changes: r ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      };
      stmt.all = async () => {
        if (/SELECT \* FROM broker_intents WHERE status = 'pending'/i.test(sql)) {
          const [now, limit] = stmt.args;
          const out = [...rows.values()].filter((r) => r.status === "pending" && r.expires_ts > now)
            .sort((a, b) => a.created_ts - b.created_ts).slice(0, limit);
          return { results: out };
        }
        return { results: [] };
      };
      stmt.first = async () => null;
      return stmt;
    },
  };
  return db;
}

const RTH = new Date("2026-09-08T14:35:00Z");      // Mon 10:35 ET
const AH_LATE = new Date("2026-09-08T23:05:00Z");  // Mon 19:05 ET
const AH_OK = new Date("2026-09-08T21:30:00Z");    // Mon 17:30 ET

const exitOrder = {
  user_id: "op@x.com", mode: "trader", trade_id: "it:DIA:UDOW:LONG:2026-W36", ticker: "UDOW",
  side: "exit", qty: 6, vehicle: "index_trend_letf", meta: { lane: "index_trend" },
  client_order_id: "tt-it-udow-exit-1",
};

describe("broker intents — classification", () => {
  it("only trader-mode equity reducers become intents", () => {
    expect(isReducerOrder(exitOrder)).toBe(true);
    expect(isReducerOrder({ ...exitOrder, side: "buy" })).toBe(false);
    expect(isReducerOrder({ ...exitOrder, mode: "investor" })).toBe(false);
    expect(isReducerOrder({ ...exitOrder, vehicle: "option_day_trade" })).toBe(false);
  });

  it("classifies bridge outcomes", () => {
    expect(classifyBridgeOutcome({ ok: true })).toBe("placed");
    expect(classifyBridgeOutcome({ ok: false, skip: "equity_ah_too_late_for_broker" })).toBe("deferred");
    expect(classifyBridgeOutcome({ ok: false, skip: "fractional_trim_deferred_to_rth" })).toBe("deferred");
    expect(classifyBridgeOutcome({ ok: false, skip: "no_hmac_key" })).toBe("terminal");
    expect(classifyBridgeOutcome({ ok: false, error: "The operation was aborted" })).toBe("transient");
    expect(classifyBridgeOutcome({ ok: false, http_status: 503, response: {} })).toBe("transient");
    expect(classifyBridgeOutcome({ ok: false, http_status: 200, response: { reject_reason: "no_manifest_for_trade" } })).toBe("terminal");
    expect(classifyBridgeOutcome({ ok: false, http_status: 200, response: { reject_reason: "naked_short_deferred" } })).toBe("terminal");
    expect(classifyBridgeOutcome({ ok: false, http_status: 400, response: { error: "bad qty" } })).toBe("terminal");
  });

  it("window: whole shares until 19:00 ET, sub-share needs RTH", () => {
    expect(intentWindowOpen({ qty: 6 }, RTH)).toBe(true);
    expect(intentWindowOpen({ qty: 6 }, AH_OK)).toBe(true);
    expect(intentWindowOpen({ qty: 6 }, AH_LATE)).toBe(false);
    expect(intentWindowOpen({ qty: 1.62 }, AH_OK)).toBe(false);
    expect(intentWindowOpen({ qty: 1.62 }, RTH)).toBe(true);
    expect(intentWindowOpen({ qty: 3, last_reason: "fractional_trim_deferred_to_rth" }, AH_OK)).toBe(false);
  });

  it("state machine: placed -> filled, terminal -> rejected, cap -> exhausted", () => {
    expect(nextIntentState({ attempts: 0 }, "placed").status).toBe("filled");
    expect(nextIntentState({ attempts: 0 }, "terminal").status).toBe("rejected");
    expect(nextIntentState({ attempts: 0 }, "deferred").status).toBe("pending");
    expect(nextIntentState({ attempts: INTENT_MAX_ATTEMPTS - 1 }, "transient").status).toBe("exhausted");
    expect(intentIdFor(exitOrder)).toBe("op@x.com|it:DIA:UDOW:LONG:2026-W36|exit");
  });
});

describe("broker intents — record + drain (UDOW W36 replay)", () => {
  it("a 19:01 ET skip becomes a pending intent that fills at the next open", async () => {
    const env = { DB: fakeDb() };
    const t0 = AH_LATE.getTime();
    const outcome = await recordBrokerIntent(env, exitOrder, { ok: false, skip: "equity_ah_too_late_for_broker" }, t0);
    expect(outcome).toBe("deferred");
    const row = env.DB._rows.get(intentIdFor(exitOrder));
    expect(row?.status).toBe("pending");
    expect(row?.ticker).toBe("UDOW");

    // Still after the cutoff: drain must not attempt.
    const calls = [];
    const forward = async (_env, order) => { calls.push(order); return { ok: true, http_status: 200, response: { order_id: "WB1" } }; };
    const late = await drainBrokerIntents(env, { forward, now: t0 + 60_000 });
    expect(late.attempted).toBe(0);
    expect(late.deferred).toBe(1);

    // Next RTH: attempt with a fresh client_order_id and intent meta; fills.
    const open = await drainBrokerIntents(env, { forward, now: RTH.getTime() + 86_400_000 });
    expect(open.attempted).toBe(1);
    expect(open.filled).toBe(1);
    expect(calls[0].client_order_id).not.toBe(exitOrder.client_order_id);
    expect(calls[0].meta.intent_id).toBe(row.id);
    expect(calls[0].meta.catch_up).toBe(true);
    expect(env.DB._rows.get(row.id).status).toBe("filled");
  });

  it("a placed reducer settles a pending intent for the same trade/side", async () => {
    const env = { DB: fakeDb() };
    await recordBrokerIntent(env, exitOrder, { ok: false, error: "fetch_error" }, 1);
    expect(env.DB._rows.get(intentIdFor(exitOrder)).status).toBe("pending");
    await recordBrokerIntent(env, exitOrder, { ok: true, http_status: 200 }, 2);
    expect(env.DB._rows.get(intentIdFor(exitOrder)).status).toBe("filled");
  });

  it("drain attempts do not re-record themselves; terminal rejects close the intent", async () => {
    const env = { DB: fakeDb() };
    await recordBrokerIntent(env, exitOrder, { ok: false, skip: "equity_ah_too_late_for_broker" }, RTH.getTime() - 1000);
    const forward = async (_env, order) => {
      // Simulate forwardOrderToBridge calling recordBrokerIntent from inside the drain attempt.
      const res = { ok: false, http_status: 200, response: { reject_reason: "no_manifest_for_trade" } };
      const rec = await recordBrokerIntent(_env, order, res, 5);
      expect(rec).toBeNull();
      return res;
    };
    const out = await drainBrokerIntents(env, { forward, now: RTH.getTime() });
    expect(out.rejected).toBe(1);
    expect(env.DB._rows.get(intentIdFor(exitOrder)).status).toBe("rejected");
  });

  it("entries and options never become intents", async () => {
    const env = { DB: fakeDb() };
    await recordBrokerIntent(env, { ...exitOrder, side: "buy" }, { ok: false, skip: "entry_deferred_to_rth" }, 1);
    await recordBrokerIntent(env, { ...exitOrder, vehicle: "option_day_trade" }, { ok: false, error: "x" }, 1);
    expect(env.DB._rows.size).toBe(0);
  });

  it("stale intents expire instead of firing days later", async () => {
    const env = { DB: fakeDb() };
    await recordBrokerIntent(env, exitOrder, { ok: false, skip: "equity_ah_too_late_for_broker" }, 1);
    const out = await drainBrokerIntents(env, { forward: async () => ({ ok: true }), now: RTH.getTime() });
    // created at ts=1 -> expired long before RTH 2026-09-08
    expect(out.expired).toBe(1);
    expect(out.attempted).toBe(0);
  });
});
