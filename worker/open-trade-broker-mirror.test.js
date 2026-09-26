import { describe, it, expect } from "vitest";
import {
  classifyEquitySleeveMirror,
  classifyPaperOpenMirror,
  latestOpenMirrorLog,
  attachOpenTradeBrokerMirror,
} from "../worker/open-trade-broker-mirror.js";

describe("classifyEquitySleeveMirror", () => {
  it("marks remaining sleeve as mirrored", () => {
    expect(classifyEquitySleeveMirror({ remaining: 2.5, filled: 2.5 }).status).toBe("mirrored");
  });

  it("marks empty known sleeve as not_mirrored", () => {
    expect(classifyEquitySleeveMirror({ remaining: 0, filled: 0 })).toEqual({
      status: "not_mirrored",
      reason: "no_sleeve",
      remaining: 0,
      filled: 0,
    });
  });

  it("marks flat-but-previously-filled as not_mirrored for open-book question", () => {
    expect(classifyEquitySleeveMirror({ remaining: 0, filled: 5 }).status).toBe("not_mirrored");
  });

  it("returns unknown when sleeves map was unavailable", () => {
    expect(classifyEquitySleeveMirror(null).status).toBe("unknown");
  });
});

describe("classifyPaperOpenMirror", () => {
  it("maps mirrored / placed decisions", () => {
    expect(classifyPaperOpenMirror({ decision: "mirrored" }).status).toBe("mirrored");
    expect(classifyPaperOpenMirror({ decision: "placed" }).status).toBe("mirrored");
  });

  it("maps skipped with reason", () => {
    const r = classifyPaperOpenMirror({ decision: "skipped", reason: "vehicle_disabled" });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("vehicle_disabled");
  });

  it("defaults to not_mirrored when no log", () => {
    expect(classifyPaperOpenMirror(null).status).toBe("not_mirrored");
  });
});

describe("latestOpenMirrorLog", () => {
  it("picks latest BUY for the signal", () => {
    const hit = latestOpenMirrorLog([
      { signal_id: "s1", side: "buy", decision: "skipped", ts: 100, reason: "old" },
      { signal_id: "s1", side: "sell", decision: "mirrored", ts: 300 },
      { signal_id: "s1", side: "buy", decision: "mirrored", ts: 200 },
    ], "s1");
    expect(hit.decision).toBe("mirrored");
    expect(hit.ts).toBe(200);
  });
});

describe("attachOpenTradeBrokerMirror", () => {
  it("attaches equity sleeve status from mocked sleeves via env bridge failure → unknown", async () => {
    const env = { KV_TIMED: { async get() { return null; } } };
    // No bridge → loadBrokerSleeves returns null → unknown
    const out = await attachOpenTradeBrokerMirror(env, [{ id: "t1", trade_id: "t1", ticker: "AAPL" }], { lane: "equity" });
    expect(out[0].broker_mirror).toBe("unknown");
  });

  it("attaches day-trade status from mirror log", async () => {
    const store = {
      "timed:opt-dt-mirror-log": JSON.stringify([
        { signal_id: "sig-1", side: "buy", decision: "mirrored", ts: 1 },
      ]),
    };
    const env = { KV_TIMED: { async get(k) { return store[k] ?? null; } } };
    const out = await attachOpenTradeBrokerMirror(
      env,
      [{ id: "sig-1", trade_id: "sig-1", ticker: "SPY" }],
      { lane: "index_day_trade" },
    );
    expect(out[0].broker_mirror).toBe("mirrored");
  });
});
