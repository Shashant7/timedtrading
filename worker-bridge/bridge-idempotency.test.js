import { describe, it, expect, beforeEach } from "vitest";
import { claimOrderIdempotency, releaseOrderIdempotency } from "./bridge-storage.js";

function makeKv() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    _map: map,
  };
}

describe("order idempotency — release after failed mid-flight exit", () => {
  let env;
  beforeEach(() => {
    env = { BRIDGE_KV: makeKv() };
  });

  it("claim then release allows a fresh claim (DE abort retry)", async () => {
    const id = "tt-exit-DE-1785351897700-5d1dzat80";
    const first = await claimOrderIdempotency(env, id);
    expect(first.fresh).toBe(true);
    const second = await claimOrderIdempotency(env, id);
    expect(second.fresh).toBe(false);
    const rel = await releaseOrderIdempotency(env, id);
    expect(rel.ok).toBe(true);
    const third = await claimOrderIdempotency(env, id);
    expect(third.fresh).toBe(true);
  });

  it("release is a no-op when id missing", async () => {
    const rel = await releaseOrderIdempotency(env, "");
    expect(rel.ok).toBe(false);
    expect(rel.skipped).toBe("no_id");
  });
});
