// worker-bridge/bridge-crypto.js
//
// 2026-05-29 — AES-256-GCM wrap/unwrap for per-user RH OAuth tokens.
// WebCrypto only (no Node crypto). Key material lives in CF secrets
// (env.BRIDGE_ENCRYPTION_KEY) as 32-byte base64. Never touches KV
// or D1 in plaintext.
//
// Wrap format (stored in KV):
//   {
//     alg: "A256GCM",
//     key_version: 1,        // bump on rotation
//     iv_b64: "...",         // 12-byte IV
//     ct_b64: "..."          // AES-GCM ciphertext + auth tag
//   }
//
// Rotation strategy: support multiple key_versions by accepting an
// array of keys via env.BRIDGE_ENCRYPTION_KEYS_PRIOR (b64 csv). Decrypt
// will try current key first then iterate priors. Re-encrypt on any
// touched record.

const ALG = "A256GCM";
const CURRENT_KEY_VERSION = 1;

function b64ToBuf(b64) {
  if (!b64) throw new Error("empty_b64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bufToB64(buf) {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

async function importKey(b64) {
  const raw = b64ToBuf(b64);
  if (raw.length !== 32) {
    throw new Error(`bridge_encryption_key_must_be_32_bytes_got_${raw.length}`);
  }
  return crypto.subtle.importKey(
    "raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
  );
}

function getKeyMaterial(env) {
  const current = env?.BRIDGE_ENCRYPTION_KEY;
  if (!current) throw new Error("BRIDGE_ENCRYPTION_KEY_not_set");
  const priors = (env?.BRIDGE_ENCRYPTION_KEYS_PRIOR || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { current, priors };
}

export async function wrapSecret(env, plaintext) {
  if (typeof plaintext !== "string") plaintext = String(plaintext ?? "");
  const { current } = getKeyMaterial(env);
  const key = await importKey(current);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    alg: ALG,
    key_version: CURRENT_KEY_VERSION,
    iv_b64: bufToB64(iv),
    ct_b64: bufToB64(ct),
  };
}

export async function unwrapSecret(env, wrapped) {
  if (!wrapped || typeof wrapped !== "object") throw new Error("invalid_wrap");
  if (wrapped.alg !== ALG) throw new Error(`unsupported_alg_${wrapped.alg}`);
  const { current, priors } = getKeyMaterial(env);
  const candidates = [current, ...priors];
  const iv = b64ToBuf(wrapped.iv_b64);
  const ct = b64ToBuf(wrapped.ct_b64);
  let lastErr = null;
  for (const b64 of candidates) {
    try {
      const key = await importKey(b64);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`unwrap_failed_with_${candidates.length}_keys: ${String(lastErr?.message || lastErr).slice(0, 80)}`);
}

// HMAC-SHA256 for webhook signature verification.
export async function hmacSign(env, payload) {
  const keyRaw = env?.BRIDGE_INTERNAL_HMAC_KEY;
  if (!keyRaw) throw new Error("BRIDGE_INTERNAL_HMAC_KEY_not_set");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keyRaw),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(payload)));
  return bufToB64(sig);
}

export async function hmacVerify(env, payload, expectedB64) {
  if (!expectedB64) return false;
  try {
    const computed = await hmacSign(env, payload);
    // Constant-time-ish compare. For untrusted inputs at this scale
    // the perf cost is negligible.
    if (computed.length !== expectedB64.length) return false;
    let mismatch = 0;
    for (let i = 0; i < computed.length; i++) {
      mismatch |= computed.charCodeAt(i) ^ expectedB64.charCodeAt(i);
    }
    return mismatch === 0;
  } catch (_) {
    return false;
  }
}

// Generate cryptographically-random state token for OAuth flow.
export function randomState(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return bufToB64(buf).replace(/[+/=]/g, "").slice(0, bytes);
}
