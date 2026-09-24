// 2026-09-23 — A day of index day trades produced zero broker positions.
//
// Two limit buys were placed 74 seconds apart at the open (QQQ 741P at
// 13:46:23, SPY 768P at 13:47:00). Both came back `working`. Both counted
// against the 2/day `long_put` cap, which is correct — a live limit does
// occupy the broker. Neither ever filled, neither was ever re-read, and
// neither was ever cancelled. The next nine entries of the day were rejected
// with `vehicle_daily_cap_2_reached_for_long_put`, and both buys were still
// live hours after the model had exited the thesis on paper.
//
// The gap was structural: the ONLY thing that re-read a pending entry was a
// close event for the SAME signal id, and the signal whose entry never filled
// is precisely the one that stops producing events.
//
// These tests pin the three properties that failure needed:
//   1. a pending entry is resolved on a schedule, not on an event
//   2. an entry that never became a position gives its money back
//   3. a working buy does not outlive the model's EXIT / STOP
import { describe, it, expect } from "vitest";
import {
  commitEntryCounters,
  resolvePendingIndexDtEntry,
  sweepPendingIndexDtEntries,
  PENDING_ENTRY_STALE_MS,
  runPendingIndexDtReconcileLoop,
  indexDtMirrorKey,
  vehicleCounterKeyFor,
  maybeAutoMirrorIndexDayTradeEvent,
} from "./options-auto-mirror.js";
import { RISK_STATE_KEY, riskBudgetSnapshot, commitRisk } from "./options-risk-budget.js";

const OP = "op@x.com";
const CAPS = { vehicleCap: 2, globalCap: 6 };
const DAY = "2026-09-23";
const NOW = Date.parse(`${DAY}T17:46:23Z`);

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const meta = new Map();
  return {
    store,
    meta,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v, opts) => {
      store.set(k, v);
      if (opts && "metadata" in opts) meta.set(k, opts.metadata);
    },
    delete: async (k) => { store.delete(k); meta.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => (meta.has(k) ? { name: k, metadata: meta.get(k) } : { name: k })),
      list_complete: true,
    }),
  };
}

function pendingMirror(over = {}) {
  return {
    signal_id: "dt:SPY:2026-09-23:2026-09-24:P:768",
    ticker: "SPY",
    entry_placed: true,
    entry_pending: true,
    entry_fired: false,
    entry_order_id: "I3I87Q92ISRM5FPJMMU0LMR38A",
    entry_fill_status: "working",
    contracts: 2,
    contracts_remaining: 0,
    flavor: "put",
    vehicle: "long_put",
    entry_placed_at: NOW,
    ts: NOW,
    ...over,
  };
}

/** A fake bridge poll that answers with one fixed status. */
const pollsWith = (status, extra = {}) => async () => ({ status, order_id: "OID", ...extra });

function seedCounters(kv, { vehicle = 2, global: g = 2 } = {}) {
  kv.store.set(vehicleCounterKeyFor(OP, "long_put", DAY), String(vehicle));
  kv.store.set(`timed:options:auto-mirror:count:${OP}:${DAY}`, String(g));
}
const readVehicle = (kv) => Number(kv.store.get(vehicleCounterKeyFor(OP, "long_put", DAY)));
const readGlobal = (kv) => Number(kv.store.get(`timed:options:auto-mirror:count:${OP}:${DAY}`));

/** The $118 this order put at risk, and what is left of the day's budget. */
const seedRisk = (kv, id = "sig", usd = 118) => commitRisk({ KV_TIMED: kv }, OP, id, { usd, now: NOW });
const riskOpen = (kv) => {
  const raw = kv.store.get(RISK_STATE_KEY(OP, DAY));
  return raw ? riskBudgetSnapshot(JSON.parse(raw), 1000).open_usd : 0;
};

describe("resolvePendingIndexDtEntry", () => {
  it("ignores a mirror that is not a pending entry", async () => {
    const kv = kvMock();
    let polled = false;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror({ entry_pending: false, entry_fired: true }),
      { deps: { pollFill: async () => { polled = true; } } },
    );
    expect(r.outcome).toBe("not_pending");
    expect(polled).toBe(false);
  });

  it("promotes a fill to a real position and KEEPS the money committed", async () => {
    const kv = kvMock();
    await seedRisk(kv);
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      { now: NOW, deps: { pollFill: pollsWith("filled", { filled_qty: 2 }) } },
    );
    expect(r.outcome).toBe("filled");
    expect(r.mirror.entry_fired).toBe(true);
    expect(r.mirror.entry_pending).toBe(false);
    expect(r.mirror.contracts_remaining).toBe(2);
    // A fill IS a position. The money behind it stays at risk.
    expect(riskOpen(kv)).toBe(118);
  });

  it("gives the money back when the broker rejected the order", async () => {
    const kv = kvMock();
    await seedRisk(kv);
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      { now: NOW, deps: { pollFill: pollsWith("rejected") } },
    );
    expect(r.outcome).toBe("gone");
    expect(r.mirror.entry_placed).toBe(false);
    expect(riskOpen(kv)).toBe(0);
  });

  it("never touches the counters the Trader lane still gates on", async () => {
    // The day-trade lane has no count cap of its own any more. If it kept
    // bumping the shared tallies it would eat the Trader lane's allowance
    // and lock it out for the rest of the day.
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    await seedRisk(kv);
    await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      { now: NOW, deps: { pollFill: pollsWith("rejected") } },
    );
    expect(readVehicle(kv)).toBe(2);
    expect(readGlobal(kv)).toBe(2);
  });

  it("leaves a fresh working order alone — no cancel, no refund", async () => {
    const kv = kvMock();
    await seedRisk(kv);
    let cancels = 0;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror({ entry_placed_at: NOW - 60_000 }),
      { now: NOW, deps: { pollFill: pollsWith("working"), cancelOrder: async () => { cancels++; return { ok: true }; } } },
    );
    expect(r.outcome).toBe("working");
    expect(cancels).toBe(0);
    expect(riskOpen(kv)).toBe(118);
  });

  it("cancels an order that has been working past the stale window", async () => {
    const kv = kvMock();
    await seedRisk(kv);
    let cancelledId = null;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror({ entry_placed_at: NOW - PENDING_ENTRY_STALE_MS - 1 }),
      {
        now: NOW,
        deps: {
          pollFill: pollsWith("working"),
          cancelOrder: async (_e, _u, { order_id }) => { cancelledId = order_id; return { ok: true, response: { ok: true, cancelled: true } }; },
        },
      },
    );
    expect(r.outcome).toBe("cancelled");
    expect(cancelledId).toBe("I3I87Q92ISRM5FPJMMU0LMR38A");
    expect(riskOpen(kv)).toBe(0);
  });

  it("cancels a still-fresh order when the caller says the thesis is over", async () => {
    const kv = kvMock();
    await seedRisk(kv);
    let cancels = 0;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror({ entry_placed_at: NOW - 30_000 }),
      {
        now: NOW,
        cancelIfWorking: true,
        deps: { pollFill: pollsWith("working"), cancelOrder: async () => { cancels++; return { ok: true, response: { cancelled: true } }; } },
      },
    );
    expect(r.outcome).toBe("cancelled");
    expect(cancels).toBe(1);
    expect(riskOpen(kv)).toBe(0);
  });

  it("does NOT release when a cancel loses the race with a fill", async () => {
    // The dangerous case: cancel comes back not-ok because the order just
    // filled. Refunding here would free money against a real position.
    const kv = kvMock();
    await seedRisk(kv);
    let polls = 0;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      {
        now: NOW,
        cancelIfWorking: true,
        deps: {
          pollFill: async () => (++polls === 1 ? { status: "working", order_id: "OID" } : { status: "filled", filled_qty: 2, order_id: "OID" }),
          cancelOrder: async () => ({ ok: false, response: { ok: false, error: "already_filled" } }),
        },
      },
    );
    expect(r.outcome).toBe("filled");
    expect(polls).toBe(2);
    expect(riskOpen(kv)).toBe(118);
  });

  it("does NOT release when the cancel is refused and the order is still working", async () => {
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      {
        now: NOW,
        cancelIfWorking: true,
        deps: { pollFill: pollsWith("working"), cancelOrder: async () => ({ ok: false, response: { ok: false } }) },
      },
    );
    expect(r.outcome).toBe("working");
    expect(readVehicle(kv)).toBe(2);
  });

  it("treats a bridge cancel that reports cancelled:false as a failed cancel", async () => {
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", pendingMirror(),
      {
        now: NOW,
        cancelIfWorking: true,
        deps: { pollFill: pollsWith("working"), cancelOrder: async () => ({ ok: true, response: { ok: false, cancelled: false } }) },
      },
    );
    expect(r.outcome).toBe("working");
    expect(readVehicle(kv)).toBe(2);
  });

  it("resolves a mirror written before any of these fields existed", async () => {
    // The two orders that were stuck all of 2026-09-23 predate the budget
    // entirely. They must still resolve, and a refund for money that was
    // never committed must be a no-op rather than free allowance.
    const kv = kvMock();
    await seedRisk(kv, "other", 200);
    const legacy = pendingMirror();
    delete legacy.vehicle;
    delete legacy.entry_placed_at;
    delete legacy.entry_premium;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", legacy,
      { now: NOW, deps: { pollFill: pollsWith("cancelled") } },
    );
    expect(r.outcome).toBe("gone");
    expect(riskOpen(kv)).toBe(200);
  });

  it("refunds once even if two passes resolve the same order", async () => {
    // A close event and the reconcile loop can reach the same order at the
    // same moment. Both see `working` and both cancel. A counter needed a
    // re-read guard to survive that; a delete keyed by signal id does not.
    const kv = kvMock();
    await seedRisk(kv, "sig", 118);
    await seedRisk(kv, "untouched", 200);
    kv.store.set(indexDtMirrorKey("sig"), JSON.stringify(pendingMirror()));
    const opts = { now: NOW, cancelIfWorking: true, deps: { pollFill: pollsWith("working"), cancelOrder: async () => ({ ok: true, response: { cancelled: true } }) } };
    const a = await resolvePendingIndexDtEntry({ KV_TIMED: kv }, OP, "sig", pendingMirror(), opts);
    const b = await resolvePendingIndexDtEntry({ KV_TIMED: kv }, OP, "sig", pendingMirror(), opts);
    expect(a.outcome).toBe("cancelled");
    expect(b.outcome).toBe("cancelled");
    expect(riskOpen(kv)).toBe(200);
  });

  it("uses ts as the staleness clock when entry_placed_at is absent", async () => {
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    const legacy = pendingMirror({ ts: NOW - PENDING_ENTRY_STALE_MS - 1 });
    delete legacy.entry_placed_at;
    let cancels = 0;
    const r = await resolvePendingIndexDtEntry(
      { KV_TIMED: kv }, OP, "sig", legacy,
      { now: NOW, deps: { pollFill: pollsWith("working"), cancelOrder: async () => { cancels++; return { ok: true, response: { cancelled: true } }; } } },
    );
    expect(cancels).toBe(1);
    expect(r.outcome).toBe("cancelled");
  });
});

describe("sweepPendingIndexDtEntries", () => {
  const put = (kv, id, mirror, meta) => {
    kv.store.set(indexDtMirrorKey(id), JSON.stringify(mirror));
    if (meta) kv.meta.set(indexDtMirrorKey(id), meta);
  };

  it("resolves a pending entry with no close event in sight", async () => {
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    put(kv, "dt:SPY:p", pendingMirror({ entry_placed_at: NOW - PENDING_ENTRY_STALE_MS - 1 }), { pe: 1 });
    const r = await sweepPendingIndexDtEntries(
      { KV_TIMED: kv }, OP,
      { now: NOW, deps: {} },
    );
    // No injected deps here: the real poll path runs, the bridge call throws
    // (no binding, no HMAC key) and pollFillIfNeeded swallows it, leaving the
    // order `working` and therefore stale -> cancel is attempted.
    expect(r.checked).toBe(1);
  });

  it("skips mirrors that are not pending entries", async () => {
    const kv = kvMock();
    put(kv, "dt:QQQ:filled", pendingMirror({ entry_pending: false, entry_fired: true }), { pe: 0 });
    put(kv, "dt:IWM:none", { ticker: "IWM", entry_placed: false }, { pe: 0 });
    const r = await sweepPendingIndexDtEntries({ KV_TIMED: kv }, OP, { now: NOW });
    expect(r.checked).toBe(0);
    expect(r.resolved).toEqual([]);
  });

  it("reads mirrors with no metadata rather than assuming they are settled", async () => {
    // Pre-deploy mirrors carry no `pe` flag. Absent must mean "go look".
    const kv = kvMock();
    put(kv, "dt:SPY:legacy", pendingMirror());
    const r = await sweepPendingIndexDtEntries({ KV_TIMED: kv }, OP, { now: NOW });
    expect(r.checked).toBe(1);
  });

  it("does not touch the decision log, which shares the key stem", async () => {
    // `timed:opt-dt-mirror-log` vs the `timed:opt-dt-mirror:` prefix. The
    // colon is load-bearing.
    const kv = kvMock();
    kv.store.set("timed:opt-dt-mirror-log", JSON.stringify([{ signal_id: "x" }]));
    const r = await sweepPendingIndexDtEntries({ KV_TIMED: kv }, OP, { now: NOW });
    expect(r.checked).toBe(0);
    expect(JSON.parse(kv.store.get("timed:opt-dt-mirror-log"))).toHaveLength(1);
  });

  it("is a no-op without KV or an operator", async () => {
    expect(await sweepPendingIndexDtEntries({}, OP)).toEqual({ checked: 0, resolved: [], fresh: 0, youngestMs: Infinity });
    expect(await sweepPendingIndexDtEntries({ KV_TIMED: kvMock() }, "")).toEqual({ checked: 0, resolved: [], fresh: 0, youngestMs: Infinity });
  });

  it("survives a KV list failure without throwing into the cron", async () => {
    const kv = kvMock();
    kv.list = async () => { throw new Error("kv down"); };
    await expect(sweepPendingIndexDtEntries({ KV_TIMED: kv }, OP)).resolves.toEqual({ checked: 0, resolved: [], fresh: 0, youngestMs: Infinity });
  });

  it("bounds how many orders one pass will resolve", async () => {
    const kv = kvMock();
    for (let i = 0; i < 12; i++) put(kv, `dt:SPY:${i}`, pendingMirror({ entry_order_id: `O${i}` }), { pe: 1 });
    const r = await sweepPendingIndexDtEntries({ KV_TIMED: kv }, OP, { now: NOW, maxResolve: 3 });
    expect(r.checked).toBe(3);
  });
});

describe("runPendingIndexDtReconcileLoop — every second counts", () => {
  const put = (kv, id, mirror, meta) => {
    kv.store.set(indexDtMirrorKey(id), JSON.stringify(mirror));
    if (meta) kv.meta.set(indexDtMirrorKey(id), meta);
  };

  function harness() {
    let t = NOW;
    const sleeps = [];
    return {
      clock: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      sleeps,
      advance: (ms) => { t += ms; },
    };
  }

  it("costs one KV list when nothing is pending", async () => {
    const kv = kvMock();
    let lists = 0;
    const realList = kv.list;
    kv.list = async (a) => { lists++; return realList(a); };
    const h = harness();
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    expect(r.passes).toBe(1);
    expect(r.reason).toBe("settled");
    expect(lists).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("keeps polling within the same minute while an order could still fill", async () => {
    // Cloudflare's cron floor is 60s. A 0/1 DTE fill that goes unnoticed
    // for a minute has already missed its first management decision.
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    put(kv, "dt:SPY:p", pendingMirror({ entry_placed_at: NOW }), { pe: 1 });
    const h = harness();
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    expect(r.passes).toBeGreaterThan(5);
    expect(r.reason).toBe("budget_exhausted");
    expect(h.sleeps.every((ms) => ms === 5000)).toBe(true);
  });

  it("backs off once the order is past its first minute", async () => {
    // A marketable limit either fills in seconds or it is not going to.
    // After that, asking every five seconds for the rest of the order's
    // life would triple the load on a broker LIST endpoint for nothing,
    // and getting rate-limited would stop reconciliation altogether.
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    put(kv, "dt:SPY:p", pendingMirror({ entry_placed_at: NOW - 120_000 }), { pe: 1 });
    const h = harness();
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    expect(h.sleeps.every((ms) => ms === 15000)).toBe(true);
    expect(r.passes).toBeGreaterThan(1);
    expect(r.passes).toBeLessThan(5);
  });

  it("stops the moment the order resolves, rather than burning the budget", async () => {
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    const mirror = pendingMirror({ entry_placed_at: NOW });
    put(kv, "dt:SPY:p", mirror, { pe: 1 });
    const h = harness();
    // Flip the mirror to filled after the second pass, the way a real fill
    // landing between polls would.
    let passes = 0;
    const realGet = kv.get;
    kv.get = async (k) => {
      if (k === indexDtMirrorKey("dt:SPY:p") && ++passes > 2) {
        return JSON.stringify({ ...mirror, entry_pending: false, entry_fired: true });
      }
      return realGet(k);
    };
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    expect(r.reason).toBe("settled");
    expect(r.passes).toBeLessThan(5);
  });

  it("does not spin on an order that is already past the stale window", async () => {
    // Re-asking every five seconds will not un-stick it; the once-per-pass
    // cancel is what resolves it.
    const kv = kvMock();
    seedCounters(kv, { vehicle: 2, global: 2 });
    put(kv, "dt:SPY:p", pendingMirror({ entry_placed_at: NOW - PENDING_ENTRY_STALE_MS - 1 }), { pe: 1 });
    const h = harness();
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    expect(r.passes).toBe(1);
    expect(r.reason).toBe("settled");
    expect(h.sleeps).toEqual([]);
  });

  it("refuses to run two loops at once in the same isolate", async () => {
    const kv = kvMock();
    put(kv, "dt:SPY:p", pendingMirror({ entry_placed_at: NOW }), { pe: 1 });
    const h = harness();
    const first = runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, h);
    const second = await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, harness());
    expect(second.reason).toBe("already_running");
    await first;
  });

  it("releases the busy guard even when a pass throws", async () => {
    const kv = kvMock();
    kv.list = async () => { throw new Error("kv down"); };
    await runPendingIndexDtReconcileLoop({ KV_TIMED: kv }, OP, harness());
    const again = await runPendingIndexDtReconcileLoop({ KV_TIMED: kvMock() }, OP, harness());
    expect(again.reason).toBe("settled");
  });

  it("is a no-op without an operator", async () => {
    const r = await runPendingIndexDtReconcileLoop({ KV_TIMED: kvMock() }, "");
    expect(r.reason).toBe("not_configured");
  });
});

describe("no count caps on the day-trade lane, one loss limit instead", () => {
  const SIG = "dt:SPY:2026-09-23:2026-09-24:P:768";
  const today = new Date().toISOString().slice(0, 10);

  const prefsWith = (over = {}) => JSON.stringify({
    enabled: true,
    daily_cap: 5,
    vehicles: { long_put: { enabled: true, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 250 } },
    ...over,
  });

  function buyCtx() {
    return {
      event: "BUY",
      ticker: "SPY",
      signal_id: SIG,
      indicesFlagOn: true,
      tier: "gamma",
      strike: 768,
      execution: { premium_band: { display_buy_ceil: 0.68 } },
      play: {
        archetype: "day_trade_put",
        _day_trade_flavor: "put",
        strikes: { primary: 768 },
        expiration: { iso: "2026-09-24" },
        legs: [{ action: "BUY", optionType: "PUT", strike: 768, expiration: "2026-09-24", qty: 1 }],
        premium: { mid: 0.59 },
        contracts: 1,
        max_loss_usd: 59,
      },
    };
  }

  function env(kv, calls, fillStatus = "working") {
    return {
      ADMIN_EMAIL: OP,
      KV_TIMED: kv,
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
      BROKER_BRIDGE: {
        fetch: async (req) => {
          const path = new URL(req.url).pathname;
          calls.push(path);
          return new Response(
            JSON.stringify({ ok: true, order_id: "OID", fill: { status: fillStatus, filled_qty: 0, order_id: "OID" } }),
            { status: 200 },
          );
        },
      },
    };
  }

  const budget = (kv) => {
    const raw = kv.store.get(RISK_STATE_KEY(OP, today));
    return raw ? riskBudgetSnapshot(JSON.parse(raw), 1000) : null;
  };

  it("leaves the shared counters alone — the Trader lane still gates on them", async () => {
    // With no count cap of its own, a day-trade lane that kept bumping the
    // shared tallies would spend the Trader lane's allowance and lock it out
    // for the rest of the day.
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith());
    kv.store.set(vehicleCounterKeyFor(OP, "long_put", today), "1");
    kv.store.set(`timed:options:auto-mirror:count:${OP}:${today}`, "1");
    await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());
    expect(Number(kv.store.get(vehicleCounterKeyFor(OP, "long_put", today)))).toBe(1);
    expect(Number(kv.store.get(`timed:options:auto-mirror:count:${OP}:${today}`))).toBe(1);
  });

  it("counts the day's placements on the budget instead", async () => {
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith());
    await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());
    await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());   // same signal id
    expect(budget(kv).placed_count).toBe(1);
  });

  it("places the eleventh trade of the day — a count cap no longer blocks anything", async () => {
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith());
    // Both legacy counters already blown past their caps. On 2026-09-23
    // this exact state refused nine entries in a row.
    kv.store.set(vehicleCounterKeyFor(OP, "long_put", today), "10");
    kv.store.set(`timed:options:auto-mirror:count:${OP}:${today}`, "10");
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, calls), buyCtx());
    expect(r.skipped).toBe(false);
    expect(calls).toContain("/bridge/options/order");
  });

  it("charges the budget the debit it is willing to pay, not the mid", async () => {
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith());
    await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());
    // Ceiling $0.68 x 100 x 1 lot. The $0.59 mid is a price we might not get.
    expect(budget(kv).open_usd).toBe(68);
    expect(budget(kv).remaining_usd).toBe(932);
  });

  it("refuses the entry that would breach the day's loss limit", async () => {
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith({ daily_loss_limit_usd: 100 }));
    await commitRisk({ KV_TIMED: kv }, OP, "earlier", { usd: 60 });
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, calls), buyCtx());
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/^daily_loss_budget_40_left_of_100_needs_68$/);
    expect(calls).toEqual([]); // nothing reached the broker
  });

  it("never blocks when the operator sets the limit to 0", async () => {
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith({ daily_loss_limit_usd: 0 }));
    await commitRisk({ KV_TIMED: kv }, OP, "earlier", { usd: 99999 });
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());
    expect(r.skipped).toBe(false);
  });

  it("gives the money back when the order never becomes a position", async () => {
    // The whole 2026-09-23 failure, end to end: place, never fill, resolve.
    const kv = kvMock();
    kv.store.set(`timed:options:auto-mirror:${OP}`, prefsWith());
    await maybeAutoMirrorIndexDayTradeEvent(env(kv, []), buyCtx());
    expect(budget(kv).open_usd).toBe(68);

    const mirror = JSON.parse(kv.store.get(indexDtMirrorKey(SIG)));
    expect(mirror.entry_pending).toBe(true);
    await resolvePendingIndexDtEntry({ KV_TIMED: kv }, OP, SIG, mirror, {
      deps: { pollFill: pollsWith("cancelled") },
    });
    expect(budget(kv).open_usd).toBe(0);
    expect(budget(kv).remaining_usd).toBe(1000);
  });
});

describe("close path — a working buy must not outlive the model's exit", () => {
  const PREFS = JSON.stringify({
    enabled: true, daily_cap: 6,
    vehicles: { long_put: { enabled: true, daily_cap: 2, max_per_order_usd: 300, max_loss_per_order_usd: 250 } },
  });
  const SIG = "dt:SPY:2026-09-23:2026-09-24:P:768";

  function exitCtx(event) {
    return {
      event,
      ticker: "SPY",
      signal_id: SIG,
      premium: 0.42,
      book: { contracts: 2, contracts_remaining: 2 },
      play: {
        archetype: "day_trade_put",
        _day_trade_flavor: "put",
        strikes: { primary: 768 },
        expiration: { iso: "2026-09-24" },
        legs: [{ action: "BUY", optionType: "PUT", strike: 768, expiration: "2026-09-24", qty: 2 }],
        premium: { mid: 0.42 },
        max_loss_usd: 118,
      },
      indicesFlagOn: true,
    };
  }

  function env(kv, calls) {
    return {
      ADMIN_EMAIL: OP,
      KV_TIMED: kv,
      BROKER_BRIDGE_HMAC_KEY: "secret",
      BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
      BROKER_BRIDGE: {
        fetch: async (req) => {
          const path = new URL(req.url).pathname;
          calls.push(path);
          if (path === "/bridge/options/order/status") {
            return new Response(JSON.stringify({ ok: true, fill: { status: "working", order_id: "OID" } }), { status: 200 });
          }
          if (path === "/bridge/options/order/cancel") {
            return new Response(JSON.stringify({ ok: true, cancelled: true, order_id: "OID" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, order_id: "OID" }), { status: 200 });
        },
      },
    };
  }

  function seed(kv) {
    kv.store.set(`timed:options:auto-mirror:${OP}`, PREFS);
    kv.store.set(indexDtMirrorKey(SIG), JSON.stringify(pendingMirror({ signal_id: SIG, entry_placed_at: Date.now() })));
    kv.store.set(vehicleCounterKeyFor(OP, "long_put", new Date().toISOString().slice(0, 10)), "2");
  }

  it("EXIT cancels the working buy instead of skipping it forever", async () => {
    const kv = kvMock();
    seed(kv);
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, calls), exitCtx("EXIT"));
    expect(calls).toContain("/bridge/options/order/cancel");
    expect(r.reason).toBe("entry_order_cancelled_unfilled");
    const after = JSON.parse(kv.store.get(indexDtMirrorKey(SIG)));
    expect(after.entry_pending).toBe(false);
    expect(after.entry_placed).toBe(false);
    // No SELL was sent — there was never a position to close.
    expect(calls).not.toContain("/bridge/options/order");
  });

  it("STOP cancels it too", async () => {
    const kv = kvMock();
    seed(kv);
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, calls), exitCtx("STOP"));
    expect(calls).toContain("/bridge/options/order/cancel");
    expect(r.reason).toBe("entry_order_cancelled_unfilled");
  });

  it("TRIM is not terminal — a fresh working buy is left alone", async () => {
    const kv = kvMock();
    seed(kv);
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(env(kv, calls), exitCtx("TRIM"));
    expect(calls).not.toContain("/bridge/options/order/cancel");
    expect(r.reason).toBe("entry_fill_pending");
  });
});
