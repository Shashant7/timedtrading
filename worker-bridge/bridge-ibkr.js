// worker-bridge/bridge-ibkr.js
//
// 2026-05-29 — Interactive Brokers (IBKR) adapter for the broker
// bridge. Drop-in alternative to bridge-robinhood.js with broader
// capability (SHORTS, options, margin) and a more stable surface
// area than Robinhood's MCP.
//
// API CHOICE — IBKR's Client Portal Web API
//
// IBKR exposes three programmatic surfaces:
//   1. TWS API (Trader Workstation) — requires a desktop app or IB
//      Gateway running. Bad fit for serverless workers.
//   2. Client Portal Web API — REST + WebSocket, no desktop binary.
//      OAuth-style session model with a /sso/auth flow. THIS is
//      what we use.
//   3. FIX — institutional, overkill for a per-user bridge.
//
// Base URL: https://api.ibkr.com/v1/api
// Docs:     https://interactivebrokers.github.io/cpwebapi/
//
// AUTH MODEL — different from Robinhood OAuth
//
// IBKR uses an *authenticated session* (cookie-based) rather than a
// raw OAuth token:
//   1. Operator logs into the Client Portal Gateway (CPG) at
//      localhost or via the IBKR-hosted endpoint with their
//      username + password + 2FA.
//   2. CPG returns a session cookie.
//   3. The session needs a keepalive ping every ~5 min OR it dies.
//
// For a serverless bridge, we use IBKR's OAuth 1.0a flow against
// Self-Service OAuth (paid Pro plan required, ~$10/mo individuals).
// This produces a permanent consumer key + access token pair that
// CAN be stored per-user and reused — much friendlier for
// always-on automation than the cookie session.
//
// For Phase 1 the per-user IBKR setup is more involved than
// Robinhood (no friendly "connect" button — operator has to mint
// their own OAuth credentials in IBKR Account Management). We
// document the setup runbook in tasks/2026-05-29-broker-bridge-
// phase1-plan.md.
//
// SCHEMA (per-user KV under bridge:user:{user_id})
//
// For IBKR users the userObj also carries:
//   broker: "ibkr"
//   ibkr_account_id:   "U1234567"           (visible in IBKR portal)
//   ibkr_consumer_key: <plaintext, public>  (paired w/ access token)
//   ibkr_oauth_token_wrap:        encrypted
//   ibkr_oauth_token_secret_wrap: encrypted
//
// 10 TOOL EQUIVALENTS we use:
//   GET   /portfolio/accounts                  → list accounts
//   GET   /portfolio/{accountId}/summary       → portfolio snapshot
//   GET   /portfolio/{accountId}/positions/0   → open positions
//   GET   /iserver/marketdata/snapshot         → live quotes
//   GET   /iserver/account/orders              → order history
//   GET   /trsrv/secdef/search                 → ticker search
//   POST  /iserver/account/{accountId}/orders  → place order (+ preview flag for dry-run)
//   POST  /iserver/account/{accountId}/orders/{orderId}/cancel → cancel
//
// IBKR's REST is more straightforward than RH's MCP envelope —
// each tool is its own HTTPS endpoint with JSON bodies.

import { unwrapSecret } from "./bridge-crypto.js";

const IBKR_BASE = "https://api.ibkr.com/v1/api";
const REQUEST_TIMEOUT_MS = 12_000;

function isMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

// OAuth 1.0a RSA-SHA256 signing for IBKR's Self-Service OAuth.
//
// IBKR's flavor of OAuth 1.0a uses asymmetric signing — the bridge
// holds an RSA private key (private_signature.pem) and IBKR holds
// the matching public key uploaded during operator setup. This is
// MORE secure than HMAC because the access-token-secret never has
// to be transmitted on each request.
//
// Signing recipe per https://ndcdyn.interactivebrokers.com/oauth/
// (and corroborated by Voyz/ibind reverse-engineering):
//
//   1. Build OAuth parameter set:
//        oauth_consumer_key:     <9-char string operator chose>
//        oauth_token:            <access token from /Generate Token>
//        oauth_signature_method: RSA-SHA256
//        oauth_timestamp:        unix seconds
//        oauth_nonce:            random 16-byte hex
//        oauth_version:          1.0
//        + any request-specific query params
//
//   2. Base string:
//        METHOD + "&" + percent_encode(URL) + "&" +
//        percent_encode(sorted(k=v joined by "&"))
//      (BUT — and this is the IBKR-specific bit — the
//       access_token_secret needs to be DECODED using the
//       Diffie-Hellman shared secret first to become the
//       LST (Live Session Token) before signing)
//
//   3. Sign base with RSA-SHA256(private_signature_key)
//
//   4. Header:
//        Authorization: OAuth realm="limited_poa",
//          oauth_consumer_key="...",
//          oauth_token="...",
//          oauth_signature_method="RSA-SHA256",
//          oauth_timestamp="...",
//          oauth_nonce="...",
//          oauth_version="1.0",
//          oauth_signature="<url-encoded base64 RSA signature>"
//
// The LST exchange happens ONCE per session via /oauth/live_session_token
// and is cached for ~24h. We do that lazily on first call.

function _percentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, "%21").replace(/\*/g, "%2A")
    .replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function _genNonce() {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

function _bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function _hexToBytes(hex) {
  const h = String(hex || "").replace(/^0+/, "") || "0";
  const padded = h.length % 2 === 0 ? h : "0" + h;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
  return out;
}

function _bytesToBigInt(bytes) {
  let bi = 0n;
  for (let i = 0; i < bytes.length; i++) bi = (bi << 8n) | BigInt(bytes[i]);
  return bi;
}

function _bigIntToBytes(bi) {
  if (bi === 0n) return new Uint8Array([0]);
  const out = [];
  let v = bi;
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return new Uint8Array(out);
}

// Modular exponentiation (b^e mod m) via right-to-left binary.
function _modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

// Strip PEM armor, base64-decode, return ArrayBuffer of DER bytes.
function _pemToDer(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("empty_pem");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// Import private RSA key for signing (RSA-SHA256).
async function _importRsaSignKey(pem) {
  return crypto.subtle.importKey("pkcs8", _pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// Import private RSA key for decryption (RSA-OAEP with SHA-1 — IBKR
// uses RSAES-PKCS1-v1_5 actually; we try OAEP first then fall back).
// IBKR's prepend decryption is RSA-PKCS1-v1_5 not OAEP — WebCrypto
// doesn't support PKCS1-v1_5 decrypt out of the box, so we use a
// minimal manual unpadding helper instead.
async function _importRsaDecryptKeyRaw(pem) {
  // Import as a generic key with empty usages first — we'll do the
  // raw RSA op manually if WebCrypto refuses PKCS1-v1_5.
  return crypto.subtle.importKey("pkcs8", _pemToDer(pem),
    { name: "RSA-OAEP", hash: "SHA-1" }, true, ["decrypt"]);
}

// HMAC sign helper. algo = "SHA-1" | "SHA-256". key is bytes.
async function _hmac(algo, keyBytes, messageBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes,
    { name: "HMAC", hash: algo }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, messageBytes);
  return new Uint8Array(sig);
}

// ── Live Session Token exchange ──────────────────────────────────────
//
// IBKR REST endpoints (/iserver/*, /portfolio/*) require HMAC signing
// with a Live Session Token (LST). The LST is computed via a one-time
// Diffie-Hellman exchange against IBKR's /oauth/live_session_token
// endpoint, then cached for ~24h.
//
// Full flow:
//   1. Decrypt accessTokenSecret (base64 → RSA decrypt with private
//      encryption key) → produces the `prepend` value (raw bytes).
//   2. Generate DH random `a`, compute A = 2^a mod p.
//   3. Build the OAuth base string, prefix with hex(prepend).
//   4. Sign with RSA-SHA256(private_signature_key).
//   5. POST /oauth/live_session_token with all OAuth params + the
//      `diffie_hellman_challenge=A` parameter.
//   6. IBKR returns { diffie_hellman_response, live_session_token_
//      signature, live_session_token_expiration }.
//   7. Compute K = (B^a) mod p (where B = dh_response).
//   8. LST = HMAC_SHA1(K_bytes, prepend_bytes).
//   9. Cache LST in KV (TTL = expiration - now).
//
// For subsequent requests, sign with HMAC-SHA256(LST_bytes, baseString).

const LST_KV_PREFIX = "bridge:ibkr:lst:";

async function _decryptPrepend(env, creds) {
  // IBKR uses RSAES-PKCS1-v1_5 padding on the access_token_secret.
  // WebCrypto only supports OAEP via importKey, so we do a raw
  // RSA decrypt by importing the key and manually stripping PKCS1
  // v1.5 padding ourselves. Easiest path: use `node:crypto` style
  // through a JS RSA implementation. The simplest correct approach
  // in WebCrypto is to use the existing OAEP key for our own
  // decryption shim — but PKCS1-v1_5 unpadding from a raw RSA op is
  // 20 lines. We do that directly.
  const tokenSecretB64 = creds.accessTokenSecret;
  const ciphertext = (() => {
    const bin = atob(tokenSecretB64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  })();
  // Use a manual RSA-PKCS1-v1_5 decrypt via JSEncrypt-style math.
  // For Phase 1 simplicity, we use the WebCrypto RSA primitive by
  // re-importing the key as "RSAES-PKCS1-v1_5" — which is not in
  // the WebCrypto spec. So we have to do raw modular exponentiation
  // ourselves using BigInt + parse the PKCS#8 private key manually.
  //
  // SIMPLIFIED PATH — extract the RSA private exponent + modulus
  // from the PKCS#8 PEM. This is a 30-line parser.
  const { n, d } = await _parsePkcs8RsaPrivate(creds.privateEncryptionKey);
  const c = _bytesToBigInt(ciphertext);
  const m = _modPow(c, d, n);
  // Convert back to bytes (modulus length).
  const modLenBytes = (n.toString(16).length + 1) >> 1;
  let mBytes = _bigIntToBytes(m);
  // Left-pad to modLenBytes (PKCS1 encoded message starts with 0x00).
  if (mBytes.length < modLenBytes) {
    const pad = new Uint8Array(modLenBytes - mBytes.length);
    const padded = new Uint8Array(modLenBytes);
    padded.set(pad);
    padded.set(mBytes, pad.length);
    mBytes = padded;
  }
  // PKCS1-v1_5 unpad: 0x00 0x02 <PS_random_nonzero> 0x00 <message>
  if (mBytes[0] !== 0x00 || mBytes[1] !== 0x02) {
    throw new Error("invalid_pkcs1_padding");
  }
  let i = 2;
  while (i < mBytes.length && mBytes[i] !== 0x00) i++;
  if (i >= mBytes.length) throw new Error("pkcs1_no_separator");
  return mBytes.slice(i + 1); // raw prepend bytes
}

// Parse an RSA private key PEM (PKCS#1 or PKCS#8) → { n, d } as
// BigInts.
//
// Auto-detects format. `openssl genrsa` produces PKCS#1
// (`-----BEGIN RSA PRIVATE KEY-----` — just the bare RSAPrivateKey
// SEQUENCE). `openssl pkcs8 -topk8` wraps it in a PKCS#8
// PrivateKeyInfo (`-----BEGIN PRIVATE KEY-----` — adds version +
// algorithm SEQUENCE + OCTET STRING wrapper).
//
// Both formats end in the same RSAPrivateKey SEQUENCE:
//   SEQUENCE { version INTEGER, n INTEGER, e INTEGER, d INTEGER, ... }
async function _parsePkcs8RsaPrivate(pem) {
  const der = new Uint8Array(_pemToDer(pem));
  let pos = 0;
  const readLen = () => {
    let b = der[pos++];
    if (b < 0x80) return b;
    const n = b & 0x7f;
    let l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | der[pos++];
    return l;
  };
  const readTag = () => der[pos++];
  const readInt = () => {
    if (readTag() !== 0x02) throw new Error("expected_INTEGER");
    const len = readLen();
    let bytes = der.slice(pos, pos + len);
    pos += len;
    if (bytes[0] === 0x00 && bytes.length > 1) bytes = bytes.slice(1);
    return _bytesToBigInt(bytes);
  };

  // 2026-05-29 — IMPORTANT: avoid `pos += readLen()` because JS
  // evaluates compound assignment LHS BEFORE the RHS function call.
  // Since readLen() advances pos as a side effect, `pos += readLen()`
  // ends up assigning (old_pos + returned_len), missing the
  // advancement readLen already did. Always assign to a temp first.
  const skip = (n) => { pos += n; };
  const skipPastValue = () => {
    const len = readLen();   // advances pos past length encoding
    skip(len);                // then skip the value bytes
  };

  // Outer SEQUENCE
  if (readTag() !== 0x30) throw new Error("expected_outer_SEQUENCE");
  readLen();
  const afterOuter = pos;

  // PKCS#1: next is INTEGER (version=0), then INTEGER (modulus n).
  // PKCS#8: next is INTEGER (version=0), then SEQUENCE (algorithm).
  if (readTag() !== 0x02) throw new Error("expected_version_INTEGER");
  skipPastValue();
  const afterVersion = pos;
  const nextTag = der[pos];

  if (nextTag === 0x02) {
    // PKCS#1 — n, e, d follow directly. Rewind to after version.
    pos = afterVersion;
    const n = readInt();
    /* e */ readInt();
    const d = readInt();
    return { n, d };
  }
  if (nextTag === 0x30) {
    // PKCS#8 — algorithm SEQUENCE, then OCTET STRING containing the
    // inner RSAPrivateKey SEQUENCE.
    if (readTag() !== 0x30) throw new Error("expected_algoSEQUENCE");
    skipPastValue();
    if (readTag() !== 0x04) throw new Error("expected_OCTETSTRING");
    readLen();
    if (readTag() !== 0x30) throw new Error("expected_inner_SEQUENCE");
    readLen();
    readInt(); // inner version
    const n = readInt();
    /* e */ readInt();
    const d = readInt();
    return { n, d };
  }
  throw new Error(`unknown_pem_format_after_version_tag=0x${nextTag?.toString(16)}`);
}

async function _exchangeLst(env, creds) {
  // 1. Decrypt prepend.
  const prepend = await _decryptPrepend(env, creds);
  const prependHex = _bytesToHex(prepend);

  // 2. DH: random a, A = 2^a mod p.
  // Strip any whitespace from the DH prime hex (operator may have
  // pasted it with line breaks from openssl output). BigInt parsing
  // is strict — even one trailing space breaks it.
  const dhPrimeClean = String(creds.dhPrime || "").replace(/[^0-9a-fA-F]/g, "");
  if (!dhPrimeClean) throw new Error("dh_prime_empty_after_cleanup");
  const aBytes = crypto.getRandomValues(new Uint8Array(32));
  const a = _bytesToBigInt(aBytes);
  const p = BigInt("0x" + dhPrimeClean);
  const A = _modPow(2n, a, p);
  const aHex = A.toString(16);

  // 3. OAuth params for LST request.
  const url = `${IBKR_BASE}/oauth/live_session_token`;
  const oauthParams = {
    oauth_consumer_key:     creds.consumerKey,
    oauth_token:            creds.accessToken,
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            _genNonce(),
    oauth_version:          "1.0",
    diffie_hellman_challenge: aHex,
  };
  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${_percentEncode(k)}=${_percentEncode(oauthParams[k])}`)
    .join("&");
  // 3b. PREPEND the decrypted token-secret hex to the base string.
  const baseString = prependHex + ["POST", _percentEncode(url), _percentEncode(paramString)].join("&");

  // 4. RSA-SHA256 sign.
  const signKey = await _importRsaSignKey(creds.privateSignatureKey);
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", signKey, new TextEncoder().encode(baseString),
  );
  const sigArr = new Uint8Array(sigBuf);
  let sigB64 = "";
  for (let i = 0; i < sigArr.length; i++) sigB64 += String.fromCharCode(sigArr[i]);
  const oauth_signature = _percentEncode(btoa(sigB64));

  // 5. POST.
  const headerParts = [
    `realm="limited_poa"`,
    ...Object.entries({ ...oauthParams, oauth_signature })
      .map(([k, v]) => `${k}="${v}"`),
  ];
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `OAuth ${headerParts.join(", ")}`,
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "tt-broker-bridge/0.1",
    },
  });
  const txt = await r.text().catch(() => "");
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch (_) {}
  if (!r.ok || !body?.diffie_hellman_response) {
    // Capture rich diagnostic for the operator — server header, body
    // preview, and our request shape.
    const serverHeader = r.headers.get("server") || "unknown";
    const reqIdHeader = r.headers.get("x-cf-trace-id") || r.headers.get("x-amz-request-id") || "";
    throw new Error(
      `lst_exchange_failed status=${r.status} server=${serverHeader} req_id=${reqIdHeader} `
      + `body=${txt.slice(0, 500)} `
      + `consumer_key_len=${creds.consumerKey?.length} `
      + `access_token_len=${creds.accessToken?.length} `
      + `prepend_bytes=${prepend.length}`,
    );
  }

  // 6. Compute K = (B^a) mod p, then LST = HMAC_SHA1(K_bytes, prepend).
  const B = BigInt("0x" + body.diffie_hellman_response);
  const K = _modPow(B, a, p);
  let kBytes = _bigIntToBytes(K);
  // IBKR's spec: prepend a 0x00 byte if K's leading byte has high bit set.
  if (kBytes[0] & 0x80) {
    const padded = new Uint8Array(kBytes.length + 1);
    padded[0] = 0x00;
    padded.set(kBytes, 1);
    kBytes = padded;
  }
  const lstBytes = await _hmac("SHA-1", kBytes, prepend);
  const lstB64 = (() => {
    let s = "";
    for (let i = 0; i < lstBytes.length; i++) s += String.fromCharCode(lstBytes[i]);
    return btoa(s);
  })();

  // 7. Verify the LST by recomputing the LST signature IBKR sent.
  const expectedSig = await _hmac("SHA-1", lstBytes, new TextEncoder().encode(creds.consumerKey));
  const expectedHex = _bytesToHex(expectedSig);
  const valid = String(body.live_session_token_signature || "").toLowerCase() === expectedHex.toLowerCase();
  if (!valid) {
    throw new Error("lst_signature_mismatch");
  }

  return {
    lst: lstB64,
    lstBytes: Array.from(lstBytes), // serializable
    expiration: Number(body.live_session_token_expiration) || (Date.now() + 23 * 3600 * 1000),
  };
}

// 2026-05-29 — Exported diagnostic helper so the operator can probe
// each LST exchange step from /bridge/test/rh-call with tool='_lst_debug'.
// Returns shape:
//   { ok, prepend_len, dh_prime_bytes, dh_a_bytes, dh_pubkey_hex_len,
//     lst_status, lst_response (parsed), lst_b64_len, lst_valid, error }
export async function _lstDebug(env, user) {
  try {
    const creds = await resolveIbkrCreds(env, user);
    if (!creds) return { ok: false, error: "no_creds" };
    // Dump first 32 bytes of each private key as hex so we can see
    // the actual ASN.1 structure (PKCS#1 vs PKCS#8 vs encrypted).
    const _peek = (pem) => {
      try {
        const der = new Uint8Array(_pemToDer(pem));
        return _bytesToHex(der.slice(0, 32)) + ` (total ${der.length} bytes)`;
      } catch (e) { return `peek_fail:${String(e?.message || e).slice(0, 80)}`; }
    };
    const _peekHeader = (pem) => {
      const lines = String(pem || "").split("\n");
      return lines[0] || "(empty)";
    };
    const out = {
      ok: true,
      source: creds.source,
      has_account_id: !!creds.accountId,
      account_id_preview: creds.accountId ? creds.accountId.slice(0, 4) + "***" : null,
      has_consumer_key: !!creds.consumerKey,
      consumer_key_len: creds.consumerKey?.length || 0,
      has_access_token: !!creds.accessToken,
      access_token_len: creds.accessToken?.length || 0,
      has_access_token_secret: !!creds.accessTokenSecret,
      has_private_signature_key: !!creds.privateSignatureKey,
      has_private_encryption_key: !!creds.privateEncryptionKey,
      has_dh_prime: !!creds.dhPrime,
      dh_prime_hex_len: creds.dhPrime?.length || 0,
      signature_key_header: _peekHeader(creds.privateSignatureKey),
      signature_key_der_head: _peek(creds.privateSignatureKey),
      encryption_key_header: _peekHeader(creds.privateEncryptionKey),
      encryption_key_der_head: _peek(creds.privateEncryptionKey),
    };
    // Try prepend decrypt.
    try {
      const prepend = await _decryptPrepend(env, creds);
      out.prepend_decrypt_ok = true;
      out.prepend_bytes = prepend.length;
    } catch (e) {
      out.prepend_decrypt_ok = false;
      out.prepend_decrypt_error = String(e?.message || e).slice(0, 200);
    }
    // Try LST exchange.
    try {
      const lst = await _exchangeLst(env, creds);
      out.lst_exchange_ok = true;
      out.lst_b64_len = lst.lst?.length || 0;
      out.lst_expiration_at = lst.expiration;
      out.lst_expires_in_hours = Math.round((lst.expiration - Date.now()) / 3600000 * 10) / 10;
    } catch (e) {
      out.lst_exchange_ok = false;
      out.lst_exchange_error = String(e?.message || e).slice(0, 400);
    }
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// Exposed mock-test passthrough for /bridge/test/rh-call when tool starts with "_".
export async function callMcpTool(env, user, toolName, args) {
  if (toolName === "_lst_debug") return _lstDebug(env, user);
  if (toolName === "get_portfolio")        return getPortfolio(env, user);
  if (toolName === "get_equity_positions") return getEquityPositions(env, user);
  return { ok: false, error: `tool_${toolName}_not_supported_on_ibkr` };
}

async function _getLiveSessionToken(env, creds) {
  const KV = env?.BRIDGE_KV;
  const key = `${LST_KV_PREFIX}${creds.consumerKey || "operator"}`;
  // Check cache.
  if (KV) {
    try {
      const raw = await KV.get(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && Number(cached.expiration) > Date.now() + 60000) {
          return cached;
        }
      }
    } catch (_) {}
  }
  // Exchange + cache.
  const fresh = await _exchangeLst(env, creds);
  if (KV) {
    try {
      await KV.put(key, JSON.stringify(fresh), {
        expirationTtl: Math.max(60, Math.floor((fresh.expiration - Date.now()) / 1000)),
      });
    } catch (_) {}
  }
  return fresh;
}

async function signRequest(env, user, method, url, params = {}) {
  const creds = await resolveIbkrCreds(env, user);
  if (!creds || !creds.accessToken || !creds.privateSignatureKey
      || !creds.privateEncryptionKey || !creds.dhPrime || !creds.accessTokenSecret) {
    return { Authorization: "OAuth oauth_signature=missing_creds" };
  }
  // 1. Get / refresh LST.
  let lst;
  try {
    lst = await _getLiveSessionToken(env, creds);
  } catch (e) {
    console.warn(`[BRIDGE/IBKR] LST fetch failed:`, String(e?.message || e).slice(0, 200));
    return { Authorization: `OAuth oauth_signature=lst_error_${String(e?.message || e).slice(0, 60)}` };
  }
  const lstBytes = new Uint8Array(lst.lstBytes);

  // 2. Standard OAuth base string (no prepend for post-LST requests).
  const oauthParams = {
    oauth_consumer_key:     creds.consumerKey,
    oauth_token:            creds.accessToken,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            _genNonce(),
    oauth_version:          "1.0",
  };
  const allParams = { ...oauthParams, ...(params || {}) };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${_percentEncode(k)}=${_percentEncode(allParams[k])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    _percentEncode(url),
    _percentEncode(paramString),
  ].join("&");

  // 3. HMAC-SHA256 with LST as key.
  const sigBytes = await _hmac("SHA-256", lstBytes, new TextEncoder().encode(baseString));
  let sigB64 = "";
  for (let i = 0; i < sigBytes.length; i++) sigB64 += String.fromCharCode(sigBytes[i]);
  const signature = _percentEncode(btoa(sigB64));

  const headerParts = [
    `realm="limited_poa"`,
    ...Object.entries({ ...oauthParams, oauth_signature: signature })
      .map(([k, v]) => `${k}="${v}"`),
  ];
  return { Authorization: `OAuth ${headerParts.join(", ")}` };
}

// 2026-05-29 — Resolve IBKR credentials with TWO sources:
//
//   (a) env-level secrets (worker secrets via wrangler secret put) —
//       used when the operator is the sole IBKR user. Simpler +
//       safer because credentials never round-trip through KV.
//   (b) per-user KV-stored credentials (via POST /bridge/ibkr/connect)
//       — used for multi-user Phase 2+ when each customer has their
//       own IBKR account.
//
// env-level wins if both are set. Lets the operator set their own
// account via wrangler secrets while still supporting the per-user
// path for future customer onboarding without code changes.
async function resolveIbkrCreds(env, user) {
  // (a) env-level
  if (env?.IBKR_ACCESS_TOKEN_SECRET) {
    return {
      source: "env",
      accountId:           env.IBKR_ACCOUNT_ID || user?.ibkr_account_id || null,
      consumerKey:         env.IBKR_CONSUMER_KEY || user?.ibkr_consumer_key || null,
      accessToken:         env.IBKR_ACCESS_TOKEN || null,
      accessTokenSecret:   env.IBKR_ACCESS_TOKEN_SECRET,
      privateSignatureKey: env.IBKR_PRIVATE_SIGNATURE_KEY || null,
      privateEncryptionKey: env.IBKR_PRIVATE_ENCRYPTION_KEY || null,
      dhPrime:             env.IBKR_DH_PRIME || null,
    };
  }
  // (b) per-user KV
  if (!user?.ibkr_oauth_token_secret_wrap) return null;
  try {
    return {
      source: "kv",
      accountId: user.ibkr_account_id,
      consumerKey: user.ibkr_consumer_key,
      accessToken: user.ibkr_oauth_token_wrap ? await unwrapSecret(env, user.ibkr_oauth_token_wrap) : null,
      accessTokenSecret: await unwrapSecret(env, user.ibkr_oauth_token_secret_wrap),
      privateSignatureKey: user.ibkr_private_signature_wrap ? await unwrapSecret(env, user.ibkr_private_signature_wrap) : null,
      privateEncryptionKey: user.ibkr_private_encryption_wrap ? await unwrapSecret(env, user.ibkr_private_encryption_wrap) : null,
      dhPrime: user.ibkr_dh_prime || null,
    };
  } catch (e) {
    console.warn(`[BRIDGE/IBKR] cred unwrap failed for ${user?.user_id}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
}

// Legacy single-secret helper kept for backwards compat with code paths
// that only need the token-secret string.
async function getAccessTokenSecret(env, user) {
  const c = await resolveIbkrCreds(env, user);
  return c?.accessTokenSecret || null;
}

// Generic IBKR call. Mock mode short-circuits.
async function callIbkr(env, user, method, path, body) {
  const t0 = Date.now();
  if (isMockMode(env)) {
    return _mockResponse(path, body, t0);
  }
  const secret = await getAccessTokenSecret(env, user);
  if (!secret) return { ok: false, error: "no_access_token_secret", latency_ms: Date.now() - t0 };

  const url = `${IBKR_BASE}${path}`;
  const headers = await signRequest(env, user, method, url, body || {});
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json";
  headers["User-Agent"] = "tt-broker-bridge/0.1";

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return {
      ok: r.ok,
      http_status: r.status,
      response: parsed || text || null,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 200),
      latency_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(tid);
  }
}

// Convenience wrappers — translate TT's order shape into IBKR's REST
// schema. IBKR uses `conid` (contract ID) for symbols — we resolve
// via /trsrv/secdef/search on first use and cache the conid per ticker.

async function resolveConid(env, user, symbol) {
  // 24h cache in KV per ticker so we don't re-resolve every order.
  const KV = env?.BRIDGE_KV;
  const cacheKey = `bridge:ibkr:conid:${String(symbol).toUpperCase()}`;
  if (KV) {
    try {
      const cached = await KV.get(cacheKey);
      if (cached) return Number(cached) || null;
    } catch (_) {}
  }
  const r = await callIbkr(env, user, "GET", `/trsrv/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK&name=false`);
  const conid = Array.isArray(r?.response) ? r.response[0]?.conid : null;
  if (conid && KV) {
    try { await KV.put(cacheKey, String(conid), { expirationTtl: 86400 }); } catch (_) {}
  }
  return conid || null;
}

// 2026-05-29 — Resolve the account ID via creds, not raw user record.
// When using env-level secrets the user record carries a dummy "ENV"
// account ID; the real one is in env.IBKR_ACCOUNT_ID and surfaces
// via resolveIbkrCreds().
async function _accountId(env, user) {
  const creds = await resolveIbkrCreds(env, user);
  return creds?.accountId || user?.ibkr_account_id || "UNKNOWN";
}

export async function reviewOrder(env, user, order) {
  const conid = await resolveConid(env, user, order.ticker);
  if (!conid) return { ok: false, error: `conid_not_found_for_${order.ticker}` };
  const acctId = await _accountId(env, user);
  const body = {
    acctId,
    conid,
    orderType: "MKT",
    side: order.side === "exit" || order.side === "sell" ? "SELL" : "BUY",
    quantity: Number(order.qty),
    tif: "DAY",
  };
  return callIbkr(env, user, "POST", `/iserver/account/${acctId}/orders?preview=true`, body);
}

export async function placeOrder(env, user, order) {
  const conid = await resolveConid(env, user, order.ticker);
  if (!conid) return { ok: false, error: `conid_not_found_for_${order.ticker}` };
  const acctId = await _accountId(env, user);
  const body = {
    acctId,
    conid,
    orderType: "MKT",
    side: order.side === "exit" || order.side === "sell" ? "SELL" : (order.side === "short" ? "SELL" : "BUY"),
    quantity: Number(order.qty),
    tif: "DAY",
  };
  return callIbkr(env, user, "POST", `/iserver/account/${acctId}/orders`, body);
}

export async function getPortfolio(env, user) {
  const acctId = await _accountId(env, user);
  return callIbkr(env, user, "GET", `/portfolio/${acctId}/summary`);
}

export async function getEquityPositions(env, user) {
  const acctId = await _accountId(env, user);
  return callIbkr(env, user, "GET", `/portfolio/${acctId}/positions/0`);
}

export async function cancelOrder(env, user, ibkrOrderId) {
  const acctId = await _accountId(env, user);
  return callIbkr(env, user, "DELETE", `/iserver/account/${acctId}/order/${ibkrOrderId}`);
}

// Mock response builder — mirrors bridge-robinhood.js shape so the
// audit log + flow are exercised end-to-end without IBKR creds.
function _mockResponse(path, body, t0) {
  const base = {
    ok: true,
    mock: true,
    broker: "ibkr",
    path,
    latency_ms: Math.max(20, Date.now() - t0),
  };
  // Preview (review) path — IBKR returns warning/risk preview block.
  if (path.includes("?preview=true")) {
    return {
      ...base,
      response: {
        preview: {
          warnings: [],
          warnings_count: 0,
          equity: { current: 100000, change: -Number(body?.quantity || 0) * 100 },
          margin: { current: 100000, change: 0 },
        },
        review_status: "ok",
      },
    };
  }
  if (path.startsWith("/iserver/account/") && path.endsWith("/orders") && body) {
    return {
      ...base,
      response: [{
        order_id: `mock_ibkr_${crypto.randomUUID().slice(0, 8)}`,
        order_status: "Submitted",
        encrypt_message: "1",
      }],
    };
  }
  if (path.startsWith("/iserver/account/") && path.includes("/order/")) {
    return { ...base, response: { msg: "Request was submitted", order_id: path.split("/").pop() } };
  }
  if (path.startsWith("/portfolio/") && path.endsWith("/summary")) {
    return {
      ...base,
      response: {
        accountcode: { value: body?.acctId || "U_MOCK" },
        nettotalliquidationusd: { amount: 100000, currency: "USD" },
        availablefunds: { amount: 40000, currency: "USD" },
        buyingpower: { amount: 160000, currency: "USD" },
      },
    };
  }
  if (path.startsWith("/portfolio/") && path.includes("/positions/")) {
    return { ...base, response: [] };
  }
  if (path.startsWith("/trsrv/secdef/search")) {
    // Return a deterministic mock conid so resolveConid caches a value.
    const sym = (path.match(/symbol=([^&]+)/) || [])[1] || "UNK";
    const conid = Math.abs(sym.split("").reduce((s, c) => ((s << 5) - s) + c.charCodeAt(0), 0)) % 99999999;
    return { ...base, response: [{ symbol: sym, conid, secType: "STK", name: `${sym} (mock)` }] };
  }
  return { ...base, response: { note: "mock_default_ibkr", echoed_body: body } };
}
