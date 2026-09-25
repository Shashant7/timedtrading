// worker/mirror-intent-stream.test.js
import { describe, it, expect } from "vitest";
import {
  buildIndexDtIntent,
  indexDtIntentKey,
  publishIndexDtIntent,
  listCloseOwedIndexDtIntents,
  markIndexDtIntentSettled,
} from "./mirror-intent-stream.js";

function kvMock() {
  const store = new Map();
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

describe("buildIndexDtIntent", () => {
  it("marks flat remaining as close_owed", () => {
    expect(buildIndexDtIntent({ signalId: "dt:SPY:x", event: "STOP", remainingQty: 0 }))
      .toMatchObject({ status: "close_owed", target_remaining: 0, last_event: "STOP" });
  });
  it("marks held remaining as open", () => {
    expect(buildIndexDtIntent({ signalId: "dt:SPY:x", event: "BUY", remainingQty: 2 }))
      .toMatchObject({ status: "open", target_remaining: 2 });
  });
});

describe("publishIndexDtIntent + drain", () => {
  it("lists close_owed rows for the cron to consume", async () => {
    const env = { KV_TIMED: kvMock() };
    await publishIndexDtIntent(env, { signalId: "dt:A", event: "BUY", remainingQty: 2, ticker: "SPY" });
    await publishIndexDtIntent(env, { signalId: "dt:B", event: "STOP", remainingQty: 0, ticker: "QQQ" });
    const owed = await listCloseOwedIndexDtIntents(env);
    expect(owed.map((r) => r.signal_id)).toEqual(["dt:B"]);
    expect(env.KV_TIMED.store.has(indexDtIntentKey("dt:A"))).toBe(true);
  });

  it("settles a close so it leaves the owed list", async () => {
    const env = { KV_TIMED: kvMock() };
    await publishIndexDtIntent(env, { signalId: "dt:C", event: "STOP", remainingQty: 0 });
    await markIndexDtIntentSettled(env, "dt:C");
    expect(await listCloseOwedIndexDtIntents(env)).toEqual([]);
    expect(JSON.parse(env.KV_TIMED.store.get(indexDtIntentKey("dt:C"))).status).toBe("settled");
  });
});
