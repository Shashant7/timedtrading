// worker-bridge/bridge-list-users-paging.test.js
//
// `listConnectedUsers` was one uncursored KV.list with a limit, and every
// scheduled bridge path passed 100 (the participant fan-out 200, the Webull
// token refresh 50). Account rows past the limit were silently never
// reconciled, never fanned out to, and never token-refreshed.

import { describe, it, expect, vi } from "vitest";
import { listConnectedUsers, LIST_USERS_MAX } from "./bridge-storage.js";

vi.mock("./bridge-webull-api.js", () => ({
  ensureWebullAccessToken: vi.fn(async (_env, user) => ({ ok: true, refreshed: true, user })),
}));
vi.mock("./bridge-webull-config.js", () => ({ webullLiveEnabled: () => true }));

/** A KV that pages like Cloudflare's: `page` keys at a time with a cursor. */
function pagedKv(n, { page = 1000 } = {}) {
  const rows = new Map();
  for (let i = 0; i < n; i++) {
    const id = `u${String(i).padStart(5, "0")}@x.com`;
    rows.set(`bridge:user:${id}`, JSON.stringify({
      user_id: id, status: "connected", broker: "webull", webull_account_id: `ACC${i}`,
    }));
  }
  const names = [...rows.keys()].sort();
  const list = vi.fn(async ({ prefix, limit = 1000, cursor } = {}) => {
    const start = cursor ? Number(cursor) : 0;
    const size = Math.min(limit, page);
    const slice = names.filter((k) => k.startsWith(prefix)).slice(start, start + size);
    const next = start + slice.length;
    const done = next >= names.length;
    return { keys: slice.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(next) };
  });
  return { list, get: vi.fn(async (k) => rows.get(k) ?? null) };
}

describe("listConnectedUsers", () => {
  it("reads past the old 100-row limit", async () => {
    const env = { BRIDGE_KV: pagedKv(250) };
    const users = await listConnectedUsers(env);
    expect(users).toHaveLength(250);
  });

  it("follows the cursor across KV pages", async () => {
    const kv = pagedKv(2500);
    const users = await listConnectedUsers({ BRIDGE_KV: kv });
    expect(users).toHaveLength(2500);
    expect(kv.list.mock.calls.length).toBe(3);
    expect(kv.list.mock.calls[1][0].cursor).toBe("1000");
  });

  it("still honours an explicit smaller limit", async () => {
    const users = await listConnectedUsers({ BRIDGE_KV: pagedKv(300) }, 40);
    expect(users).toHaveLength(40);
  });

  it("stops at the ceiling rather than reading forever", async () => {
    expect(LIST_USERS_MAX).toBeGreaterThanOrEqual(2000);
  });

  it("works against a KV mock that returns no cursor fields", async () => {
    const env = {
      BRIDGE_KV: {
        list: async () => ({ keys: [{ name: "bridge:user:a" }] }),
        get: async () => JSON.stringify({ user_id: "a" }),
      },
    };
    expect(await listConnectedUsers(env)).toEqual([{ user_id: "a" }]);
  });

  it("skips a corrupt row without losing the rest", async () => {
    const env = {
      BRIDGE_KV: {
        list: async () => ({ keys: [{ name: "bridge:user:a" }, { name: "bridge:user:b" }] }),
        get: async (k) => (k.endsWith("a") ? "{not json" : JSON.stringify({ user_id: "b" })),
      },
    };
    expect(await listConnectedUsers(env)).toEqual([{ user_id: "b" }]);
  });
});

describe("refreshWebullTokensIfNeeded", () => {
  it("reaches every account, not the first 50", async () => {
    const { refreshWebullTokensIfNeeded } = await import("./bridge-webull-tokens.js");
    const { ensureWebullAccessToken } = await import("./bridge-webull-api.js");
    ensureWebullAccessToken.mockClear();
    const out = await refreshWebullTokensIfNeeded({ BRIDGE_KV: pagedKv(120) });
    expect(out.total).toBe(120);
    expect(ensureWebullAccessToken).toHaveBeenCalledTimes(120);
  });

  it("keeps rows for the same broker account serial", async () => {
    const { refreshWebullTokensIfNeeded } = await import("./bridge-webull-tokens.js");
    const { ensureWebullAccessToken } = await import("./bridge-webull-api.js");
    let inFlight = 0;
    let maxSameAccount = 0;
    ensureWebullAccessToken.mockImplementation(async (_env, user) => {
      if (user.webull_account_id === "SHARED") {
        inFlight++;
        maxSameAccount = Math.max(maxSameAccount, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }
      return { ok: true, refreshed: true, user };
    });
    const rows = {
      "bridge:user:op@x.com": { user_id: "op@x.com", webull_account_id: "SHARED" },
      "bridge:user:op@x.com#webull#roth-ira": { user_id: "op@x.com#webull#roth-ira", webull_account_id: "SHARED" },
      "bridge:user:p@x.com": { user_id: "p@x.com", webull_account_id: "OTHER" },
    };
    const env = {
      BRIDGE_KV: {
        list: async () => ({ keys: Object.keys(rows).map((name) => ({ name })) }),
        get: async (k) => JSON.stringify({ status: "connected", broker: "webull", ...rows[k] }),
      },
    };
    await refreshWebullTokensIfNeeded(env);
    expect(maxSameAccount).toBe(1);
  });
});
