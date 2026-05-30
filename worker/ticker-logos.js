// worker/ticker-logos.js
//
// Cached ticker logos in KV, served at GET /timed/logo/:ticker.png
// Primary source: Finnhub profile2 `logo` URL. Fallback: eodhd US PNG.

const LOGO_KV_PREFIX = "timed:logo:v1:";
const LOGO_MANIFEST_KEY = "timed:logos:manifest:v1";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_LOGO_BYTES = 150_000;
const FINNHUB_PROFILE = "https://finnhub.io/api/v1/stock/profile2";

export function logoKvKey(ticker) {
  return `${LOGO_KV_PREFIX}${normalizeLogoTicker(ticker)}`;
}

export function normalizeLogoTicker(raw) {
  let s = String(raw || "").toUpperCase().trim();
  if (!s) return "";
  if (s.endsWith(".PNG")) s = s.slice(0, -4);
  if (s.endsWith(".PNG")) s = s.slice(0, -4);
  return s.replace(/[^A-Z0-9.-]/g, "");
}

/** Symbol variants for vendor APIs (BRK-B ↔ BRK.B). */
export function logoSymbolCandidates(sym) {
  const s = normalizeLogoTicker(sym);
  if (!s) return [];
  const out = [s];
  if (s.includes("-")) out.push(s.replace(/-/g, "."));
  if (s.includes(".")) out.push(s.replace(/\./g, "-"));
  return [...new Set(out.filter(Boolean))];
}

function isPngBytes(buf) {
  if (!buf || buf.byteLength < 8) return false;
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function fetchImageBytes(url) {
  try {
    const r = await fetchWithTimeout(url, {
      headers: { Accept: "image/*", "User-Agent": "TimedTrading-LogoSync/1.0" },
    });
    if (!r.ok) return null;
    const ct = String(r.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.includes("image") && !ct.includes("octet-stream")) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < 64 || buf.byteLength > MAX_LOGO_BYTES) return null;
    if (!isPngBytes(buf) && !ct.includes("jpeg") && !ct.includes("jpg") && !ct.includes("webp")) {
      // Finnhub logos are usually PNG; reject HTML error pages.
      if (buf[0] === 0x3c) return null;
    }
    return buf;
  } catch (_) {
    return null;
  }
}

export async function fetchFinnhubLogoUrl(env, ticker) {
  const apiKey = env?.FINNHUB_API_KEY;
  if (!apiKey) return null;
  for (const candidate of logoSymbolCandidates(ticker)) {
    try {
      const r = await fetchWithTimeout(
        `${FINNHUB_PROFILE}?symbol=${encodeURIComponent(candidate)}&token=${encodeURIComponent(apiKey)}`,
      );
      if (!r.ok) continue;
      const data = await r.json().catch(() => null);
      const logo = data?.logo;
      if (typeof logo === "string" && logo.startsWith("http")) {
        return { url: logo, source: "finnhub", symbol: candidate };
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

export async function fetchEodhdLogoBytes(ticker) {
  for (const candidate of logoSymbolCandidates(ticker)) {
    const url = `https://eodhd.com/img/logos/US/${encodeURIComponent(candidate)}.png`;
    const buf = await fetchImageBytes(url);
    if (buf && (isPngBytes(buf) || buf.byteLength > 200)) {
      return { bytes: buf, source: "eodhd", url, contentType: "image/png" };
    }
  }
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function readCachedLogo(env, ticker) {
  const kv = env?.KV_TIMED;
  if (!kv) return null;
  const raw = await kv.get(logoKvKey(ticker));
  if (!raw) return null;
  try {
    const row = JSON.parse(raw);
    if (!row?.b64) return null;
    return {
      bytes: base64ToBytes(row.b64),
      contentType: row.contentType || "image/png",
      source: row.source || "cache",
      fetchedAt: row.fetchedAt || null,
    };
  } catch (_) {
    return null;
  }
}

async function readManifest(env) {
  const kv = env?.KV_TIMED;
  if (!kv) return { tickers: {}, updated_at: 0 };
  try {
    const raw = await kv.get(LOGO_MANIFEST_KEY);
    if (!raw) return { tickers: {}, updated_at: 0 };
    const m = JSON.parse(raw);
    return { tickers: m.tickers || {}, updated_at: m.updated_at || 0 };
  } catch (_) {
    return { tickers: {}, updated_at: 0 };
  }
}

async function writeManifest(env, manifest) {
  const kv = env?.KV_TIMED;
  if (!kv) return;
  manifest.updated_at = Date.now();
  await kv.put(LOGO_MANIFEST_KEY, JSON.stringify(manifest), { expirationTtl: 90 * 86400 });
}

export async function writeCachedLogo(env, ticker, bytes, meta = {}) {
  const kv = env?.KV_TIMED;
  const SYM = normalizeLogoTicker(ticker);
  if (!kv || !SYM || !bytes?.byteLength) return false;
  const row = {
    b64: bytesToBase64(bytes),
    contentType: meta.contentType || "image/png",
    source: meta.source || "unknown",
    fetchedAt: Date.now(),
    symbol: meta.symbol || SYM,
  };
  await kv.put(logoKvKey(SYM), JSON.stringify(row), { expirationTtl: 180 * 86400 });
  const manifest = await readManifest(env);
  manifest.tickers[SYM] = { source: row.source, fetchedAt: row.fetchedAt };
  await writeManifest(env, manifest);
  return true;
}

/** Download + persist one ticker. Returns { ok, source } or { ok: false, error }. */
export async function syncTickerLogo(env, ticker) {
  const SYM = normalizeLogoTicker(ticker);
  if (!SYM) return { ok: false, error: "invalid_ticker" };

  const existing = await readCachedLogo(env, SYM);
  if (existing?.bytes?.byteLength > 100) {
    return { ok: true, ticker: SYM, source: existing.source, cached: true };
  }

  const fh = await fetchFinnhubLogoUrl(env, SYM);
  if (fh?.url) {
    const bytes = await fetchImageBytes(fh.url);
    if (bytes) {
      const ct = isPngBytes(bytes) ? "image/png" : "image/jpeg";
      await writeCachedLogo(env, SYM, bytes, { source: "finnhub", contentType: ct, symbol: fh.symbol });
      return { ok: true, ticker: SYM, source: "finnhub", symbol: fh.symbol };
    }
  }

  const eod = await fetchEodhdLogoBytes(SYM);
  if (eod?.bytes) {
    await writeCachedLogo(env, SYM, eod.bytes, { source: "eodhd", contentType: eod.contentType, symbol: SYM });
    return { ok: true, ticker: SYM, source: "eodhd" };
  }

  return { ok: false, ticker: SYM, error: "no_logo_found" };
}

export async function getUniverseTickers(env, sectorMapKeys = []) {
  try {
    const raw = await env.KV_TIMED.get("timed:tickers");
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        return [...new Set(list.map((t) => normalizeLogoTicker(t)).filter(Boolean))];
      }
    }
  } catch (_) { /* fall through */ }
  return [...new Set((sectorMapKeys || []).map((t) => normalizeLogoTicker(t)).filter(Boolean))];
}

export async function syncUniverseLogos(env, opts = {}) {
  const max = Math.max(1, Math.min(300, Number(opts.max) || 50));
  const onlyMissing = opts.onlyMissing !== false;
  const tickers = Array.isArray(opts.tickers) && opts.tickers.length
    ? opts.tickers.map(normalizeLogoTicker).filter(Boolean)
    : await getUniverseTickers(env, opts.sectorMapKeys);

  const manifest = await readManifest(env);
  const queue = onlyMissing
    ? tickers.filter((t) => !manifest.tickers[t])
    : tickers;

  const results = [];
  for (const sym of queue.slice(0, max)) {
    results.push(await syncTickerLogo(env, sym));
    await new Promise((r) => setTimeout(r, 120));
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return {
    ok: true,
    attempted: results.length,
    synced: ok,
    failed: failed.length,
    failures: failed.slice(0, 20),
    remaining_missing: Math.max(0, queue.length - results.length),
  };
}

export async function serveLogo(env, ticker, corsHdr = {}) {
  const SYM = normalizeLogoTicker(ticker);
  if (!SYM) {
    return new Response("invalid ticker", { status: 400 });
  }

  let cached = await readCachedLogo(env, SYM);
  if (!cached) {
    const synced = await syncTickerLogo(env, SYM);
    if (synced.ok) cached = await readCachedLogo(env, SYM);
  }

  if (!cached?.bytes) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=300", ...corsHdr },
    });
  }

  return new Response(cached.bytes, {
    status: 200,
    headers: {
      ...corsHdr,
      "Content-Type": cached.contentType || "image/png",
      "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
      "X-TT-Logo-Source": cached.source || "cache",
    },
  });
}

export async function getLogoStatus(env, sectorMapKeys = []) {
  const universe = await getUniverseTickers(env, sectorMapKeys);
  const manifest = await readManifest(env);
  const cached = universe.filter((t) => manifest.tickers[t]);
  return {
    ok: true,
    universe: universe.length,
    cached: cached.length,
    missing: universe.length - cached.length,
    missing_sample: universe.filter((t) => !manifest.tickers[t]).slice(0, 40),
    manifest_updated_at: manifest.updated_at || null,
  };
}
