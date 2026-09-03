import { describe, it, expect } from "vitest";
import {
  findCrossOwnerWebullClash,
  normalizeWebullLoginLabel,
  resolveWebullUserCreds,
  syncWebullPersonalAccounts,
  webullCredsEnvSuffix,
  webullEnvCredsFor,
  webullSubUserId,
} from "./bridge-webull-api.js";
import { handleWebullOauthDisconnect } from "./bridge-webull-auth.js";
import { wrapSecret } from "./bridge-crypto.js";
import { isAdminOwnedRow, ownerEmailForRow, resolveNotifyRecipients } from "./bridge-notifications.js";
import { listMirrorParticipants, pauseOwnerAccounts, readUser, resolveBridgeAccounts } from "./bridge-storage.js";

// In-memory BRIDGE_KV stub (get/put/list) shared by storage helpers.
function makeKv(rows = []) {
  const map = new Map();
  for (const r of rows) map.set(`bridge:user:${String(r.user_id).toLowerCase()}`, JSON.stringify(r));
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

  it("falls back to the row owner when notify_emails is absent", () => {
    // Legacy rows (and the operator's own) carry no notify_emails. Returning
    // null used to queue the item with no address, so grouping keyed on the
    // bare user_id and the mail never went out.
    expect(resolveNotifyRecipients(envWithAdmin, { user_id: "op@x.com#webull#roth-ira" }))
      .toEqual(["op@x.com", "timedtrading@gmail.com"]);
    expect(resolveNotifyRecipients(envWithAdmin, { owner_email: "Partner@Y.com" }))
      .toEqual(["partner@y.com", "timedtrading@gmail.com"]);
  });

  it("null only when no inbox can be derived at all", () => {
    expect(resolveNotifyRecipients(envWithAdmin, null)).toBeNull();
    expect(resolveNotifyRecipients(envWithAdmin, { notify_emails: [] })).toBeNull();
    expect(resolveNotifyRecipients(envWithAdmin, { user_id: "operator" })).toBeNull();
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

  it("partner row never inherits the operator's inbox", () => {
    const out = resolveNotifyRecipients(envWithAdmin, {
      user_id: "partner@y.com#webull#individual-cash",
      owner_email: "partner@y.com",
      notify_emails: ["partner@y.com"],
    });
    expect(out).toContain("partner@y.com");
    expect(out).not.toContain("op@x.com");
  });
});

describe("ownerEmailForRow / isAdminOwnedRow — digest scoping", () => {
  const envWithAdmin = { BRIDGE_ADMIN_NOTIFY_EMAIL: "op@x.com" };

  it("derives the owner inbox from email, owner_email, then user_id", () => {
    expect(ownerEmailForRow({ email: "A@B.com" })).toBe("a@b.com");
    expect(ownerEmailForRow({ owner_email: "Owner@X.com" })).toBe("owner@x.com");
    expect(ownerEmailForRow({ user_id: "partner@y.com#webull#roth-ira" })).toBe("partner@y.com");
    expect(ownerEmailForRow({ user_id: "operator" })).toBeNull();
    expect(ownerEmailForRow(null)).toBeNull();
  });

  it("marks only the admin's own rows as admin-owned", () => {
    expect(isAdminOwnedRow(envWithAdmin, { user_id: "op@x.com#webull#roth-ira" })).toBe(true);
    expect(isAdminOwnedRow(envWithAdmin, { owner_email: "partner@y.com" })).toBe(false);
    // No admin configured → legacy content preserved.
    expect(isAdminOwnedRow({}, { owner_email: "partner@y.com" })).toBe(true);
  });
});

describe("listMirrorParticipants — self-service cross-owner dispatch set", () => {
  const rows = [
    // Admin owner's own accounts — never participants (excluded by owner).
    { user_id: "op@x.com#webull#roth-ira", owner_email: "op@x.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true },
    // Self-service user, enabled + opted in.
    { user_id: "partner@y.com#webull#individual-cash", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true },
    // Futures cannot receive the equity/options model order path.
    { user_id: "partner@y.com#webull#futures", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true, webull_account_class: "FUTURES" },
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

describe("findCrossOwnerWebullClash — one Webull account, one owner", () => {
  const rows = [
    { user_id: "op@x.com#webull#individual-cash", owner_email: "op@x.com", broker: "webull", status: "connected", webull_account_id: "WB-100" },
    { user_id: "gone@z.com#webull#individual-cash", owner_email: "gone@z.com", broker: "webull", status: "disconnected", webull_account_id: "WB-900" },
  ];

  it("blocks a different owner connecting an already-connected account", () => {
    const clash = findCrossOwnerWebullClash(rows, "partner@y.com", [{ account_id: "WB-100" }]);
    expect(clash?.user_id).toBe("op@x.com#webull#individual-cash");
  });

  it("same owner re-connecting (rotation / re-sync) is allowed", () => {
    expect(findCrossOwnerWebullClash(rows, "op@x.com", [{ account_id: "WB-100" }])).toBeNull();
  });

  it("disconnected rows do not block a new owner", () => {
    expect(findCrossOwnerWebullClash(rows, "partner@y.com", [{ account_id: "WB-900" }])).toBeNull();
  });

  it("fresh accounts pass", () => {
    expect(findCrossOwnerWebullClash(rows, "partner@y.com", [{ account_id: "WB-777" }])).toBeNull();
  });
});

describe("handleWebullOauthDisconnect — connection removal clears credentials", () => {
  it("clears creds wraps, env ref, and mirror opt-in on every owner row", async () => {
    const env = makeEnv([
      { user_id: "partner@y.com#webull#individual-cash", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true, webull_app_key_wrap: "wrapK", webull_app_secret_wrap: "wrapS", webull_account_id: "WB-500" },
      { user_id: "partner@y.com#webull#individual-margin", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: false, webull_creds_env: "ACCT2", webull_account_id: "WB-501" },
    ]);
    const req = { json: async () => ({ user_id: "partner@y.com" }) };
    const out = await handleWebullOauthDisconnect(env, req);
    expect(out.ok).toBe(true);
    expect(out.accounts_disconnected).toBe(2);
    for (const id of ["partner@y.com#webull#individual-cash", "partner@y.com#webull#individual-margin"]) {
      const row = await readUser(env, id);
      expect(row.status).toBe("disconnected");
      expect(row.broker_integration_enabled).toBe(false);
      expect(row.mirror_participant).toBe(false);
      expect(row.webull_app_key_wrap).toBeNull();
      expect(row.webull_app_secret_wrap).toBeNull();
      expect(row.webull_creds_env).toBeNull();
    }
  });
});

describe("pauseOwnerAccounts — owner-level kill switch", () => {
  it("pauses every enabled/opted-in row for the owner, leaves other owners alone", async () => {
    const env = makeEnv([
      { user_id: "partner@y.com#webull#individual-cash", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: true, mirror_participant: true },
      { user_id: "partner@y.com#webull#individual-margin", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: false, mirror_participant: true },
      { user_id: "op@x.com#webull#roth-ira", owner_email: "op@x.com", broker: "webull", status: "connected", broker_integration_enabled: true },
    ]);
    const out = await pauseOwnerAccounts(env, "partner@y.com");
    expect(out.paused).toBe(2);
    const a = await readUser(env, "partner@y.com#webull#individual-cash");
    expect(a.broker_integration_enabled).toBe(false);
    expect(a.mirror_participant).toBe(false);
    expect(a.status).toBe("connected"); // stays connected — re-enable is one toggle
    const other = await readUser(env, "op@x.com#webull#roth-ira");
    expect(other.broker_integration_enabled).toBe(true);
  });

  it("no-op for an owner with nothing enabled", async () => {
    const env = makeEnv([
      { user_id: "partner@y.com#webull#individual-cash", owner_email: "partner@y.com", broker: "webull", status: "connected", broker_integration_enabled: false },
    ]);
    const out = await pauseOwnerAccounts(env, "partner@y.com");
    expect(out.paused).toBe(0);
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
