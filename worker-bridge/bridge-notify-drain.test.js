import { describe, it, expect } from "vitest";
import { drainNotifyQueue } from "./bridge-notifications.js";

// In-memory BRIDGE_KV stub with prefix-aware list/get/delete.
function makeKv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    _map: map,
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
      return { keys: keys.map((name) => ({ name })) };
    },
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async delete(k) { map.delete(k); },
  };
}

const driftKey = "bridge:notify:queue:1700000000000:partner@y.com#webull#cash:AXON-1";
const dailyKey = "bridge:notify:daily:partner@y.com#webull#cash:2026-08-13";

describe("drainNotifyQueue — both producers", () => {
  it("drains drift AND daily digest items", async () => {
    const env = {
      BRIDGE_KV: makeKv({
        [driftKey]: JSON.stringify({
          user_id: "partner@y.com#webull#cash",
          user_email: "partner@y.com",
          severity: "warn",
        }),
        [dailyKey]: JSON.stringify({
          user_id: "partner@y.com#webull#cash",
          user_email: "partner@y.com",
          kind: "daily_owner_digest",
          content: { subject: "[Timed Trading] Daily account digest" },
        }),
      }),
    };
    const items = await drainNotifyQueue(env, {});
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.kind === "daily_owner_digest")).toBe(true);
    expect(items.some((i) => i.severity === "warn")).toBe(true);
    // One-shot: both keys consumed.
    expect(env.BRIDGE_KV._map.size).toBe(0);
  });

  it("peek leaves both queues intact", async () => {
    const env = {
      BRIDGE_KV: makeKv({
        [driftKey]: JSON.stringify({ user_id: "a", user_email: "a@b.com" }),
        [dailyKey]: JSON.stringify({ user_id: "a", user_email: "a@b.com", kind: "daily_owner_digest" }),
      }),
    };
    const items = await drainNotifyQueue(env, { peek: true });
    expect(items).toHaveLength(2);
    expect(env.BRIDGE_KV._map.size).toBe(2);
  });

  it("each queue item carries its own recipient (no cross-owner mixing)", async () => {
    const env = {
      BRIDGE_KV: makeKv({
        "bridge:notify:daily:partner@y.com#webull#cash:2026-08-13": JSON.stringify({
          user_id: "partner@y.com#webull#cash", user_email: "partner@y.com", kind: "daily_owner_digest",
        }),
        "bridge:notify:daily:op@x.com#webull#roth:2026-08-13": JSON.stringify({
          user_id: "op@x.com#webull#roth", user_email: "op@x.com", kind: "daily_owner_digest",
        }),
      }),
    };
    const items = await drainNotifyQueue(env, {});
    const byEmail = new Map(items.map((i) => [i.user_email, i.user_id]));
    expect(byEmail.get("partner@y.com")).toBe("partner@y.com#webull#cash");
    expect(byEmail.get("op@x.com")).toBe("op@x.com#webull#roth");
  });

  it("no KV binding is a safe no-op", async () => {
    expect(await drainNotifyQueue({}, {})).toEqual([]);
  });
});
