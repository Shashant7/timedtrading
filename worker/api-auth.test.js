// Security regression tests for CF Access JWT verification (worker/api.js).
//
// The vulnerability fixed in P0.2: verifyAccessJWT previously returned the
// decoded payload WITHOUT signature verification when (a) the JWKS fetch
// returned no keys, or (b) the matching key had no JWK n/e fields. That let
// anyone who could reach the worker directly forge a CF-Access-JWT-Assertion
// header and impersonate ADMIN_EMAIL. These tests pin the fail-closed
// behavior via the exported authenticateUser().

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authenticateUser, requireIngestKey } from "./api.js";

function ingestReq(url) { return new Request(url, { method: "POST" }); }
function ingestReqHdr(url, hdr) { return new Request(url, { method: "POST", headers: hdr }); }

describe("requireIngestKey — TradingView webhook auth (?key= always allowed; dedicated TV key)", () => {
  const ENV_BOTH = { TIMED_API_KEY: "main-key", TV_INGEST_KEY: "tv-key", ALLOW_QUERY_API_KEY: "false" };
  it("accepts the dedicated TV_INGEST_KEY via ?key= even when ALLOW_QUERY_API_KEY=false", () => {
    expect(requireIngestKey(ingestReq("https://w/timed/ingest-candles?key=tv-key"), ENV_BOTH)).toBeNull();
  });
  it("accepts the main TIMED_API_KEY via ?key= (TV can't send headers)", () => {
    expect(requireIngestKey(ingestReq("https://w/timed/ingest-candles?key=main-key"), ENV_BOTH)).toBeNull();
  });
  it("accepts either key via X-API-Key header too", () => {
    expect(requireIngestKey(ingestReqHdr("https://w/timed/ingest-candles", { "X-API-Key": "tv-key" }), ENV_BOTH)).toBeNull();
  });
  it("rejects a wrong/stale key (the 401 the operator saw)", () => {
    const r = requireIngestKey(ingestReq("https://w/timed/ingest-candles?key=stale-old-key"), ENV_BOTH);
    expect(r).not.toBeNull();
    expect(r.status).toBe(401);
  });
  it("rejects when no key configured at all", () => {
    expect(requireIngestKey(ingestReq("https://w/timed/ingest-candles?key=x"), {}).status).toBe(401);
  });
  it("still works with only the main key set (TV_INGEST_KEY unset)", () => {
    expect(requireIngestKey(ingestReq("https://w/timed/ingest-candles?key=main-key"), { TIMED_API_KEY: "main-key" })).toBeNull();
  });
});

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function forgeJWT({ email = "attacker@evil.test", aud = "test-aud" } = {}) {
  const header = { alg: "RS256", kid: "forged-kid", typ: "JWT" };
  const payload = {
    email,
    aud: [aud],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  // Garbage signature — must never verify.
  return `${b64url(header)}.${b64url(payload)}.${b64url({ sig: "forged" })}`;
}

function makeReq(jwt) {
  return new Request("https://worker.test/timed/me", {
    headers: { "CF-Access-JWT-Assertion": jwt },
  });
}

const ENV = {
  CF_ACCESS_TEAM_DOMAIN: "unit-test-team",
  CF_ACCESS_AUD: "test-aud",
  // No DB binding — authenticateUser returns raw JWT identity when the
  // payload verifies, null when it does not. Exactly what we assert on.
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// api.js caches JWKS in a module-level slot for 1 hour. Advance the clock
// 2 hours per test so every test's fetch mock is actually consulted.
let _clockOffsetMs = 0;
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _clockOffsetMs += 2 * 60 * 60 * 1000;
  vi.useFakeTimers({ now: Date.now() + _clockOffsetMs, toFake: ["Date"] });
});

async function genRsaPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function signJWT(kp, { email, aud, expOffsetSec, kid }) {
  const header = { alg: "RS256", kid, typ: "JWT" };
  const payload = {
    email,
    aud: [aud],
    exp: Math.floor(Date.now() / 1000) + expOffsetSec,
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    kp.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = Buffer.from(new Uint8Array(sig))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${signingInput}.${sigB64}`;
}

describe("CF Access JWT — fail-closed verification", () => {
  it("rejects a forged JWT when JWKS returns no keys", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    );
    const user = await authenticateUser(makeReq(forgeJWT()), ENV);
    expect(user).toBeNull();
  });

  it("rejects a forged JWT when JWKS fetch fails entirely", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 }));
    const user = await authenticateUser(makeReq(forgeJWT()), ENV);
    expect(user).toBeNull();
  });

  it("rejects a forged JWT when JWKS only has PEM certs (no JWK n/e)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          keys: [],
          public_certs: [{ kid: "forged-kid", cert: "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----" }],
        }),
        { status: 200 },
      ),
    );
    const user = await authenticateUser(makeReq(forgeJWT()), ENV);
    expect(user).toBeNull();
  });

  it("rejects a forged JWT even when a real-looking RSA JWK is present", async () => {
    // Valid-format RSA key that did NOT sign the token — signature
    // verification must run and fail.
    const kp = await genRsaPair();
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...jwk, kid: "forged-kid", alg: "RS256", use: "sig" }] }),
        { status: 200 },
      ),
    );
    const user = await authenticateUser(makeReq(forgeJWT()), ENV);
    expect(user).toBeNull();
  });

  it("accepts a JWT genuinely signed by a JWKS key", async () => {
    const kp = await genRsaPair();
    const jwt = await signJWT(kp, {
      email: "operator@timed.test",
      aud: "test-aud",
      expOffsetSec: 3600,
      kid: "good-kid",
    });
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...jwk, kid: "good-kid", alg: "RS256", use: "sig" }] }),
        { status: 200 },
      ),
    );
    const user = await authenticateUser(makeReq(jwt), ENV);
    expect(user).not.toBeNull();
    expect(user.email).toBe("operator@timed.test");
  });

  it("rejects an expired but correctly signed JWT", async () => {
    const kp = await genRsaPair();
    const jwt = await signJWT(kp, {
      email: "operator@timed.test",
      aud: "test-aud",
      expOffsetSec: -60,
      kid: "good-kid-2",
    });
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ keys: [{ ...jwk, kid: "good-kid-2", alg: "RS256", use: "sig" }] }),
        { status: 200 },
      ),
    );
    const user = await authenticateUser(makeReq(jwt), ENV);
    expect(user).toBeNull();
  });
});
