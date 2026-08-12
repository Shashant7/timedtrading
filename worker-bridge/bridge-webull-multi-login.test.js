import { describe, it, expect } from "vitest";
import {
  normalizeWebullLoginLabel,
  resolveWebullUserCreds,
  syncWebullPersonalAccounts,
  webullCredsEnvSuffix,
  webullEnvCredsFor,
  webullSubUserId,
} from "./bridge-webull-api.js";
import { wrapSecret } from "./bridge-crypto.js";
import { resolveNotifyRecipients } from "./bridge-notifications.js";
import { listMirrorParticipants, resolveBridgeAccounts } from "./bridge-storage.js";

// In-memory BRIDGE_KV stub (get/put/list) shared by storage helpers.
function makeKv(rows = []) {
  const map = new Map();
  for (const r of rows) map.set(`bridge:user:${String(r.user_id).toLowerCase()}`, JSON.stringify(r));
  return {
    async get(k) { return map.get(k) || null; },
    async put(k, v) { map.set(k, v); },
    async list({ prefix = "", limit = 100 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys };
    },
    _map: map,
  };
}

// Deterministic 32-byte AES key for wrap/unwrap round-trips.
const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function makeEnv(rows = []) {
  return {
    BRIDGE_KV: makeKv(rows),
    BRIDGE_ENCRYPTION_KEY: TEST_KEY_B64,
    WEBULL_AUTH_MODE: "personal",
    WEBULL_APP_KEY: "env_key",
    WEBULL_APP_SECRET: "env_secret",
  };
}

const OWNER = "op@x.com";
const ACCOUNTS = [
  { account_id: "WB-100", account_type: "CASH", account_label: "Individual Cash", account_class: "INDIVIDUAL_CASH", account_number: "A100" },
  { account_id: "WB-200", account_type: "MARGIN", account_label: "Individual Margin", account_class: "INDIVIDUAL_MARGIN", account_number: "A200" },
];

describe("webullSubUserId — login label prefix", () => {
  it("no label keeps the legacy id shape", () => {
    expect(webullSubUserId(OWNER, ACCOUNTS[0])).toBe("op@x.com#webull#individual-cash");
  });

  it("label prefixes the slug so two logins with the same account class never collide", () => {
    const primary = webullSubUserId(OWNER, ACCOUNTS[0]);
    const secondary = webullSubUserId(OWNER, ACCOUNTS[0], "acct2");
    expect(secondary).toBe("op@x.com#webull#acct2-individual-cash");
    expect(secondary).not.toBe(primary);
  });

  it("normalizeWebullLoginLabel kebab-cases arbitrary input", () => {
    expect(normalizeWebullLoginLabel("Wife's Account!")).toBe("wife-s-account");
    expect(normalizeWebullLoginLabel("  ")).toBe("");
    expect(normalizeWebullLoginLabel(null)).toBe("");
  });
});

describe("syncWebullPersonalAccounts — secondary login creds stamping", () => {
  it("stamps login label + creds wraps on every synced row", async () => {
    const env = makeEnv();
    const credsWrap = {
      key_wrap: await wrapSecret(env, "second_key"),
      secret_wrap: await wrapSecret(env, "second_secret"),
    };
    const synced = await syncWebullPersonalAccounts(env, OWNER, ACCOUNTS, {
      credsWrap,
      loginLabel: "acct2",
    });
    expect(synced.map((s) => s.user_id)).toEqual([
      "op@x.com#webull#acct2-individual-cash",
      "op@x.com#webull#acct2-individual-margin",
    ]);
    expect(synced.every((s) => s.has_own_app_creds)).toBe(true);
    expect(synced.every((s) => s.webull_login_label === "acct2")).toBe(true);

    // The stored rows unwrap back to the original key pair.
    const raw = JSON.parse(await env.BRIDGE_KV.get("bridge:user:op@x.com#webull#acct2-individual-cash"));
    const creds = await resolveWebullUserCreds(env, raw);
    expect(creds).toEqual({ appKey: "second_key", appSecret: "second_secret" });
  });

  it("re-sync without credsWrap preserves existing wraps (rotation only on explicit re-connect)", async () => {
    const env = makeEnv();
    const credsWrap = {
      key_wrap: await wrapSecret(env, "second_key"),
      secret_wrap: await wrapSecret(env, "second_secret"),
    };
    await syncWebullPersonalAccounts(env, OWNER, ACCOUNTS, { credsWrap, loginLabel: "acct2" });
    await syncWebullPersonalAccounts(env, OWNER, ACCOUNTS, { loginLabel: "acct2" });
    const raw = JSON.parse(await env.BRIDGE_KV.get("bridge:user:op@x.com#webull#acct2-individual-cash"));
    const creds = await resolveWebullUserCreds(env, raw);
    expect(creds).toEqual({ appKey: "second_key", appSecret: "second_secret" });
  });

  it("primary login sync leaves wraps empty (env-key fallback)", async () => {
    const env = makeEnv();
    await syncWebullPersonalAccounts(env, OWNER, ACCOUNTS);
    const raw = JSON.parse(await env.BRIDGE_KV.get("bridge:user:op@x.com#webull#individual-cash"));
    expect(raw.webull_app_key_wrap).toBeNull();
    expect(await resolveWebullUserCreds(env, raw)).toBeNull();
  });

  it("both logins coexist under the owner and both appear in the fan-out set", async () => {
    const env = makeEnv();
    await syncWebullPersonalAccounts(env, OWNER, ACCOUNTS);
    const credsWrap = {
      key_wrap: await wrapSecret(env, "second_key"),
      secret_wrap: await wrapSecret(env, "second_secret"),
    };
    await syncWebullPersonalAccounts(env, OWNER, [ACCOUNTS[0]], { credsWrap, loginLabel: "acct2" });

    // Enable all synced accounts, then resolve the fan-out set.
    for (const [k, v] of env.BRIDGE_KV._map.entries()) {
      const row = JSON.parse(v);
      env.BRIDGE_KV._map.set(k, JSON.stringify({ ...row, broker_integration_enabled: true }));
    }
    const accounts = await resolveBridgeAccounts(env, OWNER, { enabledOnly: true });
    const ids = accounts.map((a) => a.user_id).sort();
    expect(ids).toEqual([
      "op@x.com#webull#acct2-individual-cash",
      "op@x.com#webull#individual-cash",
      "op@x.com#webull#individual-margin",
    ]);
  });
});

describe("env-secret credentials (worker-level, preferred)", () => {
  it("webullCredsEnvSuffix maps labels to secret suffixes", () => {
    expect(webullCredsEnvSuffix("acct2")).toBe("ACCT2");
    expect(webullCredsEnvSuffix("wife-s-account")).toBe("WIFE_S_ACCOUNT");
    expect(webullCredsEnvSuffix("")).toBe("");
  });

  it("webullEnvCredsFor reads the labeled key pair from env, null when unset", () => {
    const env = { WEBULL_APP_KEY_ACCT2: "k2", WEBULL_APP_SECRET_ACCT2: "s2" };
    expect(webullEnvCredsFor(env, "ACCT2")).toEqual({ appKey: "k2", appSecret: "s2" });
    expect(webullEnvCredsFor(env, "OTHER")).toBeNull();
    expect(webullEnvCredsFor({ WEBULL_APP_KEY_ACCT2: "k2" }, "ACCT2")).toBeNull();
  });

  it("resolveWebullUserCreds prefers webull_creds_env and names the missing secret", async () => {
    const env = { ...makeEnv(), WEBULL_APP_KEY_ACCT2: "k2", WEBULL_APP_SECRET_ACCT2: "s2" };
    expect(await resolveWebullUserCreds(env, { webull_creds_env: "ACCT2" }))
      .toEqual({ appKey: "k2", appSecret: "s2" });
    await expect(resolveWebullUserCreds(makeEnv(), { webull_creds_env: "ACCT2" }))
      .rejects.toThrow(/WEBULL_APP_KEY_ACCT2/);
  });

  it("sync with credsEnv stamps the suffix, clears wraps, and stamps notify_emails", async () => {
    const env = { ...makeEnv(), WEBULL_APP_KEY_ACCT2: "k2", WEBULL_APP_SECRET_ACCT2: "s2" };
    // First connect via inline creds (wraps), then re-connect via env secrets.
    const credsWrap = {
      key_wrap: await wrapSecret(env, "old_key"),
      secret_wrap: await wrapSecret(env, "old_secret"),
    };
    await syncWebullPersonalAccounts(env, OWNER, [ACCOUNTS[0]], { credsWrap, loginLabel: "acct2" });
    await syncWebullPersonalAccounts(env, OWNER, [ACCOUNTS[0]], {
      credsEnv: "ACCT2",
      loginLabel: "acct2",
      notifyEmails: ["Partner@Example.com"],
    });
    const raw = JSON.parse(await env.BRIDGE_KV.get("bridge:user:op@x.com#webull#acct2-individual-cash"));
    expect(raw.webull_creds_env).toBe("ACCT2");
    expect(raw.webull_app_key_wrap).toBeNull();
    expect(raw.notify_emails).toEqual(["partner@example.com"]);
    expect(await resolveWebullUserCreds(env, raw)).toEqual({ appKey: "k2", appSecret: "s2" });
  });

  it("re-sync without opts preserves credsEnv and notify_emails", async () => {
    const env = { ...makeEnv(), WEBULL_APP_KEY_ACCT2: "k2", WEBULL_APP_SECRET_ACCT2: "s2" };
    await syncWebullPersonalAccounts(env, OWNER, [ACCOUNTS[0]], {
      credsEnv: "ACCT2", loginLabel: "acct2", notifyEmails: ["partner@example.com"],
    });
    await syncWebullPersonalAccounts(env, OWNER, [ACCOUNTS[0]], { loginLabel: "acct2" });
    const raw = JSON.parse(await env.BRIDGE_KV.get("bridge:user:op@x.com#webull#acct2-individual-cash"));
    expect(raw.webull_creds_env).toBe("ACCT2");
    expect(raw.notify_emails).toEqual(["partner@example.com"]);
  });
});

describe("resolveNotifyRecipients — partner + admin routing", () => {
  const envWithAdmin = { BRIDGE_ADMIN_NOTIFY_EMAIL: "timedtrading@gmail.com" };

  it("null without notify_emails (legacy single-recipient behavior preserved)", () => {
    expect(resolveNotifyRecipients(envWithAdmin, { user_id: "op@x.com#webull#roth-ira" })).toBeNull();
    expect(resolveNotifyRecipients(envWithAdmin, null)).toBeNull();
    expect(resolveNotifyRecipients(envWithAdmin, { notify_emails: [] })).toBeNull();
  });

  it("partner accounts notify partner + admin, deduped", () => {
    expect(resolveNotifyRecipients(envWithAdmin, { notify_emails: ["Partner@Example.com"] }))
      .toEqual(["partner@example.com", "timedtrading@gmail.com"]);
    expect(resolveNotifyRecipients(envWithAdmin, { notify_emails: ["timedtrading@gmail.com"] }))
      .toEqual(["timedtrading@gmail.com"]);
  });

  it("no admin configured → partner only; junk entries filtered", () => {
    expect(resolveNotifyRecipients({}, { notify_emails: ["partner@example.com", "", "not-an-email"] }))
      .toEqual(["partner@example.com"]);
  });
});

describe("listMirrorParticipants — self-service cross-owner dispatch set", () => {
  const rows = [
    // Admin owner's own accounts — never participants (excluded by owner).
    { user_id: "op@x.com#webull#roth-ira", owner_email: "op@x.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true },
    // Self-service user, enabled + opted in.
    { user_id: "partner@y.com#webull#individual-cash", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true },
    // Self-service user, connected but mirror disabled.
    { user_id: "partner@y.com#webull#individual-margin", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: false, mirror_participant: true },
    // Enabled but never opted in via the self-service flow (operator-managed).
    { user_id: "other@z.com#webull#individual-cash", owner_email: "other@z.com", broker: "webull", status: "connected", broker_integration_enabled: true },
    // Opted in but disconnected.
    { user_id: "gone@z.com#webull#individual-cash", owner_email: "gone@z.com", broker: "webull", status: "disconnected", broker_integration_enabled: true, mirror_participant: true },
  ];

  it("returns only connected + enabled + opted-in rows of OTHER owners", async () => {
    const env = { BRIDGE_KV: makeKv(rows) };
    const out = await listMirrorParticipants(env, "op@x.com");
    expect(out.map((u) => u.user_id)).toEqual(["partner@y.com#webull#individual-cash"]);
  });

  it("empty when nobody opted in (legacy dispatch path preserved)", async () => {
    const env = { BRIDGE_KV: makeKv(rows.filter((r) => !r.mirror_participant)) };
    expect(await listMirrorParticipants(env, "op@x.com")).toEqual([]);
  });
});

describe("resolveWebullUserCreds — error surface", () => {
  it("throws on a corrupt wrap (caller maps to webull_app_creds_unwrap_failed)", async () => {
    const env = makeEnv();
    const user = {
      webull_app_key_wrap: { alg: "A256GCM", iv_b64: "AAAAAAAAAAAAAAAA", ct_b64: "AAAA" },
      webull_app_secret_wrap: { alg: "A256GCM", iv_b64: "AAAAAAAAAAAAAAAA", ct_b64: "AAAA" },
    };
    await expect(resolveWebullUserCreds(env, user)).rejects.toThrow(/unwrap_failed/);
  });
});
