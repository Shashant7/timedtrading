import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isWebullAccessTokenError,
  parsePersonalTokenPayload,
  resolvePersonalWebullAccessToken,
  syncWebullPersonalAccounts,
  ensureWebullAccessToken,
} from "./bridge-webull-api.js";
import { wrapSecret, unwrapSecret } from "./bridge-crypto.js";
import { readUser } from "./bridge-storage.js";

function makeKv() {
  const map = new Map();
  return {
    async get(k) { return map.get(k) || null; },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async list({ prefix = "", limit = 100 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys };
    },
    _map: map,
  };
}

const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function makeEnv() {
  return {
    BRIDGE_KV: makeKv(),
    BRIDGE_ENCRYPTION_KEY: TEST_KEY_B64,
    WEBULL_AUTH_MODE: "personal",
    WEBULL_ENVIRONMENT: "prod",
    WEBULL_APP_KEY: "env_key",
    WEBULL_APP_SECRET: "env_secret",
    BROKER_BRIDGE_MOCK: "false",
  };
}

describe("isWebullAccessTokenError", () => {
  it("detects the Webull header error string", () => {
    expect(isWebullAccessTokenError({ error: "Header x-access-token is missing or invalid." })).toBe(true);
    expect(isWebullAccessTokenError({ response: { message: "Header x-access-token is missing or invalid." } })).toBe(true);
  });

  it("ignores unrelated auth failures", () => {
    expect(isWebullAccessTokenError({ error: "signature invalid" })).toBe(false);
    expect(isWebullAccessTokenError({ error: "Too many requests" })).toBe(false);
  });
});

describe("parsePersonalTokenPayload", () => {
  it("reads flat create/check responses", () => {
    expect(parsePersonalTokenPayload({
      token: "tok-1",
      status: "PENDING",
      expires: 1893456000,
    })).toEqual({
      token: "tok-1",
      status: "PENDING",
      expires_at: 1893456000 * 1000,
      raw: { token: "tok-1", status: "PENDING", expires: 1893456000 },
    });
  });

  it("reads nested data envelopes and ms expires", () => {
    expect(parsePersonalTokenPayload({
      data: { token: "tok-2", status: "normal", expires: 1893456000000 },
    })).toMatchObject({ token: "tok-2", status: "NORMAL", expires_at: 1893456000000 });
  });
});

describe("resolvePersonalWebullAccessToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns webull_2fa_pending and stores the pending token for retry", async () => {
    const env = makeEnv();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ token: "pending-tok", status: "PENDING", expires: 1893456000 });
      },
    }));

    const first = await resolvePersonalWebullAccessToken(env, {
      creds: { appKey: "partner_key_abcdef", appSecret: "partner_secret" },
      ownerEmail: "partner@y.com",
    });
    expect(first.ok).toBe(false);
    expect(first.error).toBe("webull_2fa_pending");
    expect(String(first.note || "")).toMatch(/2FA enabled/i);

    // Retry after the trader approves → check returns NORMAL.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ token: "pending-tok", status: "NORMAL", expires: 1893456000 });
        },
      };
    });
    const second = await resolvePersonalWebullAccessToken(env, {
      creds: { appKey: "partner_key_abcdef", appSecret: "partner_secret" },
      ownerEmail: "partner@y.com",
    });
    expect(second.ok).toBe(true);
    expect(second.token).toBe("pending-tok");
    expect(second.status).toBe("NORMAL");
    expect(calls).toBe(1); // check path, not create
  });

  it("returns NORMAL immediately when create is already verified", async () => {
    const env = makeEnv();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ token: "live-tok", status: "NORMAL", expires: 1893456000 });
      },
    }));
    const out = await resolvePersonalWebullAccessToken(env, {
      creds: { appKey: "k", appSecret: "s" },
      ownerEmail: "a@b.com",
    });
    expect(out).toMatchObject({ ok: true, token: "live-tok", status: "NORMAL" });
  });
});

describe("personal 2FA token persistence on account rows", () => {
  it("stamps accessTokenWrap onto synced rows and ensureWebullAccessToken unwraps it", async () => {
    const env = makeEnv();
    const wrap = await wrapSecret(env, "personal-2fa-token");
    await syncWebullPersonalAccounts(env, "partner@y.com", [
      { account_id: "WB-1", account_type: "CASH", account_label: "Cash", account_class: "INDIVIDUAL_CASH" },
    ], { accessTokenWrap: wrap, accessTokenExpiresAt: 1893456000000 });

    const row = await readUser(env, "partner@y.com#webull#individual-cash");
    expect(row.webull_token_wrap).toBeTruthy();
    expect(row.webull_token_expires_at).toBe(1893456000000);

    const tok = await ensureWebullAccessToken(env, row);
    expect(tok.ok).toBe(true);
    expect(tok.access_token).toBe("personal-2fa-token");
    expect(await unwrapSecret(env, row.webull_token_wrap)).toBe("personal-2fa-token");
  });

  it("clears a prior 2FA wrap when reconnecting with a non-2FA key", async () => {
    const env = makeEnv();
    const wrap = await wrapSecret(env, "old-token");
    await syncWebullPersonalAccounts(env, "partner@y.com", [
      { account_id: "WB-1", account_type: "CASH", account_label: "Cash", account_class: "INDIVIDUAL_CASH" },
    ], { accessTokenWrap: wrap });
    await syncWebullPersonalAccounts(env, "partner@y.com", [
      { account_id: "WB-1", account_type: "CASH", account_label: "Cash", account_class: "INDIVIDUAL_CASH" },
    ], { accessTokenWrap: null, accessTokenExpiresAt: null });
    const row = await readUser(env, "partner@y.com#webull#individual-cash");
    expect(row.webull_token_wrap).toBeNull();
    const tok = await ensureWebullAccessToken(env, row);
    expect(tok.access_token).toBe("");
  });
});
