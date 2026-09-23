// `kvPutJSONIfFits` — the guard on KV writes that scale with the universe.
//
// Two production incidents motivate it, both from values that outgrew their key:
//
//   - `timed:all:snapshot` reached 26,195,645 bytes on 2026-08-14 against KV's
//     26,214,400 ceiling. Writes stopped landing, nothing said so, and every
//     reader served 2026-08-14 scores for 40 days.
//   - The `/timed/all` micro-cache put a 30,790,510-byte value every five
//     minutes. It 413'd every time, and because it rides `ctx.waitUntil` the
//     whole value stayed alive until the rejection settled -- on top of the
//     copy `sendJSON` was already stringifying. That is what put the isolate
//     over 128 MB (`outcome: exceededMemory`, around the clock).
//
// So the contract is: measure before the put, skip with a log rather than
// attempt one that cannot succeed, and never throw at the caller.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kvPutJSONIfFits, KV_MAX_VALUE_BYTES } from "./storage.js";

function fakeKV() {
  const store = new Map();
  return {
    store,
    put: vi.fn(async (k, v, opts) => { store.set(k, { v, opts }); }),
  };
}

describe("KV_MAX_VALUE_BYTES", () => {
  it("is the ceiling the 413 actually names", () => {
    // "413 Value length of 30790510 exceeds limit of 26214400."
    expect(KV_MAX_VALUE_BYTES).toBe(26214400);
  });
});

describe("kvPutJSONIfFits", () => {
  let warn;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("writes a value that fits and reports its size", async () => {
    const KV = fakeKV();
    const res = await kvPutJSONIfFits(KV, "k", { a: 1 });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(false);
    expect(res.bytes).toBe(JSON.stringify({ a: 1 }).length);
    expect(KV.store.get("k").v).toBe('{"a":1}');
  });

  it("skips the put entirely when the value is over budget", async () => {
    const KV = fakeKV();
    const res = await kvPutJSONIfFits(KV, "k", { blob: "x".repeat(500) }, null, { budgetBytes: 100 });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    // The point: no put is attempted, so there is no 413 and no request body
    // held alive by a pending rejection.
    expect(KV.put).not.toHaveBeenCalled();
  });

  it("says how far over, and does not suggest raising the budget", async () => {
    const KV = fakeKV();
    await kvPutJSONIfFits(KV, "timed:all:micro", { blob: "x".repeat(500) }, null, {
      budgetBytes: 100, label: "/timed/all micro full",
    });
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain("/timed/all micro full");
    expect(msg).toContain("SKIPPED");
    expect(msg).toContain("100");
    expect(msg).toContain(String(KV_MAX_VALUE_BYTES));
    expect(msg).toContain("narrow it");
  });

  it("would have skipped the real 30,790,510-byte micro-cache value", async () => {
    const KV = fakeKV();
    // Approximate the live value's size without allocating 30 MB of objects.
    const res = await kvPutJSONIfFits(KV, "timed:all:micro", "y".repeat(30790510 - 2));
    expect(res.bytes).toBe(30790510);
    expect(res.skipped).toBe(true);
    expect(KV.put).not.toHaveBeenCalled();
  });

  it("would have skipped the 2026-08-14 snapshot, instead of freezing silently", async () => {
    const KV = fakeKV();
    const res = await kvPutJSONIfFits(KV, "timed:all:snapshot", "y".repeat(26195645 - 2), null, {
      budgetBytes: 12 * 1024 * 1024,
    });
    expect(res.bytes).toBe(26195645);
    expect(res.skipped).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("defaults to the KV ceiling, and a value just under it still writes", async () => {
    const KV = fakeKV();
    const res = await kvPutJSONIfFits(KV, "k", "y".repeat(KV_MAX_VALUE_BYTES - 2));
    expect(res.bytes).toBe(KV_MAX_VALUE_BYTES);
    expect(res.ok).toBe(true);
  });

  it("passes the TTL through, and omits it when absent", async () => {
    const KV = fakeKV();
    await kvPutJSONIfFits(KV, "a", { x: 1 }, 420);
    expect(KV.store.get("a").opts).toEqual({ expirationTtl: 420 });
    await kvPutJSONIfFits(KV, "b", { x: 1 });
    expect(KV.store.get("b").opts).toEqual({});
    await kvPutJSONIfFits(KV, "c", { x: 1 }, 0);
    expect(KV.store.get("c").opts).toEqual({});
  });

  it("does not throw when the put itself rejects", async () => {
    const KV = { put: vi.fn(async () => { throw new Error("413 Value length of 1 exceeds limit of 0."); }) };
    const res = await kvPutJSONIfFits(KV, "k", { a: 1 });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("put failed");
  });

  it("does not throw on a value that cannot be serialized", async () => {
    const KV = fakeKV();
    const cyclic = {};
    cyclic.self = cyclic;
    const res = await kvPutJSONIfFits(KV, "k", cyclic);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(KV.put).not.toHaveBeenCalled();
  });

  it("is safe to hand to ctx.waitUntil -- the returned promise never rejects", async () => {
    const KV = { put: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(kvPutJSONIfFits(KV, "k", { a: 1 })).resolves.toBeTruthy();
    await expect(kvPutJSONIfFits(KV, "k", "y".repeat(99), null, { budgetBytes: 1 })).resolves.toBeTruthy();
  });
});
