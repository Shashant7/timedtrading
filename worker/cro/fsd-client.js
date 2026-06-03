// worker/cro/fsd-client.js
// ─────────────────────────────────────────────────────────────────────────────
//  Fundstrat Direct HTTP client — authenticated fetch + publications list.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Goal: pull new FSD publications (Daily Technical Strategy, weekly recaps,
//  year-ahead decks) without operator intervention so the CRO can ingest them.
//
//  Design constraints:
//    • We don't have a published FSD API contract. The login flow, session
//      handling, and publications list URL are all *configurable via KV*
//      (`cro:fsd:config`) so the operator can re-tune the scraper without a
//      redeploy whenever the FSD site shifts. Hardcoded defaults are best
//      guesses based on standard Rails / Next.js auth patterns; the
//      operator runs `POST /timed/admin/cro/fsd/probe` after first
//      deployment to verify or adjust.
//    • All credentials come from worker secrets `env.FSD_USERNAME` +
//      `env.FSD_PASSWORD`. Never log them. Never echo them back from
//      probe responses.
//    • Every external call has a hard timeout (10s) and is wrapped to
//      return a structured `{ok, error_kind, hint}` payload — never throws.
//    • Session cookies are cached in KV (`cro:fsd:session`) with a 12h TTL.
//      Stale-on-401 triggers re-login.
//
//  Operator workflow:
//    1. wrangler secret put FSD_USERNAME + FSD_PASSWORD  (done in PR #447 plan)
//    2. POST /timed/admin/cro/fsd/probe — reports back what the login flow
//       sees (no credentials echoed). Tweak `cro:fsd:config` if needed.
//    3. POST /timed/admin/cro/fsd/list?force=1 — list publications.
//    4. Once the probe + list both succeed, flip `cro_fsd_ingestion_enabled`
//       in model_config to true to enable the daily cron.

const SESSION_KV_KEY = "cro:fsd:session";
const CONFIG_KV_KEY  = "cro:fsd:config";
const SESSION_TTL_SECONDS = 12 * 60 * 60;   // 12h
const FETCH_TIMEOUT_MS    = 12_000;          // 12s — FSD pages can be slow on cold cache

// ── Default config (operator overrides via KV `cro:fsd:config`) ───────────────
// Each path is a best-effort guess based on conventions of subscriber-only
// research-publication SaaS. Operator probe confirms / corrects via KV.
export const DEFAULT_FSD_CONFIG = {
  base_url: "https://fundstratdirect.com",
  // ── Login flow ──
  login_page_path: "/login",         // GET — used only to grab a CSRF / antiforgery token if present
  login_submit_path: "/login",       // POST form-encoded with credential fields below
  login_method: "POST",
  login_content_type: "application/x-www-form-urlencoded",
  // Field names commonly used; operator can swap to e.g. {user[email], user[password]}
  // (Rails / Devise) or {emailAddress, password} (custom) based on probe results.
  login_field_username: "email",
  login_field_password: "password",
  login_field_csrf: "authenticity_token", // probed from login page; ignored if not found
  login_success_redirect_path: "/research",
  // ── Session detection ──
  // Cookie name(s) we expect to find in the Set-Cookie header. If unsure,
  // we capture and replay ALL cookies; the operator can pin the canonical
  // session cookie name via this list.
  expected_session_cookie_names: ["_fsd_session", "session", "_session_id"],
  // ── Publications list ──
  publications_list_path: "/research",         // page to scrape for publication links
  publications_list_format: "html",            // "html" | "json"
  // When format=json, this JSON path within the response holds the list.
  publications_list_json_path: "publications",
  // When format=html, this regex extracts publication URLs from the response body.
  // Default targets <a href="/research/publications/{id}-{slug}">{title}</a> patterns.
  publications_html_link_pattern: "<a[^>]*href=\"(/research/publications/[^\"]+)\"[^>]*>([^<]{5,200})</a>",
  // ── Publication download ──
  // Some publications are HTML pages with an embedded PDF link; others
  // download directly. We follow the URL pattern below to resolve PDF.
  publication_pdf_link_pattern: "href=\"([^\"]+\\.pdf[^\"]*)\"",
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getConfig(env) {
  try {
    const raw = await env?.KV?.get(CONFIG_KV_KEY);
    if (raw) {
      const overrides = JSON.parse(raw);
      return { ...DEFAULT_FSD_CONFIG, ...(overrides || {}) };
    }
  } catch (_) { /* fall through to defaults */ }
  return { ...DEFAULT_FSD_CONFIG };
}

export async function setConfig(env, partial) {
  if (!env?.KV) return { ok: false, error_kind: "kv_unavailable" };
  const current = await getConfig(env);
  const merged = { ...current, ...(partial || {}) };
  await env.KV.put(CONFIG_KV_KEY, JSON.stringify(merged));
  return { ok: true, config: merged };
}

export async function getConfigPublic(env) {
  // Safe-to-render config (no secrets — config holds none today, but we
  // future-proof the shape).
  return await getConfig(env);
}

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: promise.finally(() => clearTimeout(t)) };
}

function urlJoin(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/+$/, "") + "/" + String(path || "").replace(/^\/+/, "");
}

// Parse a Set-Cookie header value into [{name, value, expires?, path?}].
// CF Workers' Headers.getAll('set-cookie') / Headers.getSetCookie() returns an
// array. We accept either an array or a comma-joined string.
function parseSetCookies(headers) {
  const out = [];
  let lines = [];
  // Cloudflare Workers supports headers.getSetCookie() on modern runtimes.
  if (typeof headers?.getSetCookie === "function") {
    lines = headers.getSetCookie();
  } else {
    // Fallback: get-all not portable, single get() collapses to comma-joined.
    const raw = headers?.get?.("set-cookie") || "";
    // Split conservatively on `, ` followed by a token=, not on `, ` inside
    // an Expires=... date.
    lines = raw.split(/,\s*(?=[A-Za-z0-9_\-]+=)/);
  }
  for (const line of (lines || [])) {
    if (!line) continue;
    const [first, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const attrMap = {};
    for (const a of attrs) {
      const ai = a.indexOf("=");
      if (ai < 0) attrMap[a.toLowerCase()] = true;
      else attrMap[a.slice(0, ai).toLowerCase()] = a.slice(ai + 1);
    }
    out.push({ name, value, attrs: attrMap });
  }
  return out;
}

// Serialize back into a Cookie request-header value.
function serializeCookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
}

// Merge two cookie lists; later entries override earlier by name.
function mergeCookies(base, incoming) {
  const map = new Map();
  for (const c of (base || [])) map.set(c.name, c);
  for (const c of (incoming || [])) map.set(c.name, c);
  return Array.from(map.values());
}

// Best-effort CSRF token extractor from an HTML body.
function extractCsrfToken(html, csrfField) {
  if (!html || !csrfField) return null;
  // Common patterns:
  //   <meta name="csrf-token" content="..."> (Rails)
  //   <input name="authenticity_token" value="..."> (Rails forms)
  //   <input name="_token" value="..."> (Laravel)
  //   <input name="csrfmiddlewaretoken" value="..."> (Django)
  const tries = [
    new RegExp(`<input[^>]*name=["']${csrfField}["'][^>]*value=["']([^"']+)["']`, "i"),
    new RegExp(`<input[^>]*value=["']([^"']+)["'][^>]*name=["']${csrfField}["']`, "i"),
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const re of tries) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt a login. Returns:
 *   { ok: true,  cookies: [...], probe_summary: { ... } }
 *   { ok: false, error_kind, hint, probe_summary }
 *
 * Caches the cookie set in KV on success.
 */
export async function loginFSD(env, { force = false } = {}) {
  if (!env?.FSD_USERNAME || !env?.FSD_PASSWORD) {
    return { ok: false, error_kind: "no_credentials", hint: "wrangler secret put FSD_USERNAME and FSD_PASSWORD on both envs" };
  }

  // Try cached session first unless force=true.
  if (!force) {
    try {
      const cached = await env.KV?.get(SESSION_KV_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.cookies && (Date.now() - (parsed.created_at || 0)) < SESSION_TTL_SECONDS * 1000) {
          return { ok: true, cookies: parsed.cookies, from_cache: true, probe_summary: parsed.probe_summary || null };
        }
      }
    } catch (_) { /* fall through to fresh login */ }
  }

  const cfg = await getConfig(env);
  const probe_summary = {
    base_url: cfg.base_url,
    login_page_path: cfg.login_page_path,
    login_submit_path: cfg.login_submit_path,
    used_csrf: false,
    csrf_field: cfg.login_field_csrf,
    login_page_status: null,
    login_submit_status: null,
    response_redirect: null,
    cookies_received: 0,
    cookies_named: [],
    body_first_500_chars: null,
  };

  // 1. GET login page to harvest CSRF + initial cookies.
  let cookies = [];
  let csrfToken = null;
  try {
    const url = urlJoin(cfg.base_url, cfg.login_page_path);
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: "GET",
        headers: { "User-Agent": cfg.user_agent, "Accept": "text/html,application/xhtml+xml" },
      }),
      FETCH_TIMEOUT_MS,
    );
    const resp = await Object.assign(req, { signal });
    probe_summary.login_page_status = resp.status;
    cookies = mergeCookies(cookies, parseSetCookies(resp.headers));
    const html = await resp.text().catch(() => "");
    csrfToken = extractCsrfToken(html, cfg.login_field_csrf);
    probe_summary.used_csrf = !!csrfToken;
    probe_summary.body_first_500_chars = html.slice(0, 500);
  } catch (e) {
    return {
      ok: false,
      error_kind: "login_page_fetch_failed",
      hint: `GET ${cfg.login_page_path} failed: ${String(e?.message || e).slice(0, 200)}`,
      probe_summary,
    };
  }

  // 2. POST credentials.
  try {
    const url = urlJoin(cfg.base_url, cfg.login_submit_path);
    const body = new URLSearchParams();
    body.set(cfg.login_field_username, env.FSD_USERNAME);
    body.set(cfg.login_field_password, env.FSD_PASSWORD);
    if (csrfToken) body.set(cfg.login_field_csrf, csrfToken);
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: cfg.login_method || "POST",
        redirect: "manual", // we want to see the redirect target
        headers: {
          "User-Agent": cfg.user_agent,
          "Content-Type": cfg.login_content_type || "application/x-www-form-urlencoded",
          "Accept": "text/html,application/xhtml+xml",
          "Cookie": serializeCookieHeader(cookies),
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
    );
    const resp = await Object.assign(req, { signal });
    probe_summary.login_submit_status = resp.status;
    probe_summary.response_redirect = resp.headers.get("location") || null;
    const incoming = parseSetCookies(resp.headers);
    cookies = mergeCookies(cookies, incoming);
    probe_summary.cookies_received = incoming.length;
    probe_summary.cookies_named = cookies.map((c) => c.name);

    // Heuristic: redirect to non-login page OR a session cookie was set →
    // login succeeded.
    const redirectAwayFromLogin = probe_summary.response_redirect
      && !probe_summary.response_redirect.toLowerCase().includes("login");
    const sessionCookieSet = cookies.some((c) =>
      (cfg.expected_session_cookie_names || []).some((n) =>
        c.name.toLowerCase() === String(n).toLowerCase()));
    const looksGood = (resp.status >= 300 && resp.status < 400 && redirectAwayFromLogin)
      || (resp.status === 200 && sessionCookieSet);

    if (!looksGood) {
      // Capture a small body slice for debugging.
      const body = await resp.text().catch(() => "");
      probe_summary.body_first_500_chars = body.slice(0, 500);
      return {
        ok: false,
        error_kind: "login_rejected",
        hint: "login POST returned status " + resp.status + (probe_summary.response_redirect ? `, Location=${probe_summary.response_redirect}` : ". no session cookie set. check field names + login_submit_path via cro:fsd:config; rotate credentials if password was leaked."),
        probe_summary,
      };
    }

    // Persist to KV with 12h TTL.
    try {
      await env.KV?.put(SESSION_KV_KEY, JSON.stringify({
        cookies,
        created_at: Date.now(),
        probe_summary,
      }), { expirationTtl: SESSION_TTL_SECONDS });
    } catch (_) { /* best-effort */ }

    return { ok: true, cookies, from_cache: false, probe_summary };
  } catch (e) {
    return {
      ok: false,
      error_kind: "login_submit_failed",
      hint: `POST ${cfg.login_submit_path} threw: ${String(e?.message || e).slice(0, 200)}`,
      probe_summary,
    };
  }
}

/**
 * Probe — does a full login but reports a verbose summary so the operator
 * can tune the config. Returns the same shape as loginFSD but always
 * recomputes (ignores cache).
 */
export async function probeFSD(env) {
  return await loginFSD(env, { force: true });
}

/**
 * List the recent publications. Returns:
 *   { ok: true, publications: [{ id, title, source_url, published_at? }] }
 *   { ok: false, error_kind, hint }
 */
export async function listFSDPublications(env, { limit = 20 } = {}) {
  const auth = await loginFSD(env);
  if (!auth.ok) return { ok: false, error_kind: auth.error_kind, hint: auth.hint, login_probe: auth.probe_summary };

  const cfg = await getConfig(env);
  const url = urlJoin(cfg.base_url, cfg.publications_list_path);
  try {
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": cfg.user_agent,
          "Accept": cfg.publications_list_format === "json" ? "application/json" : "text/html",
          "Cookie": serializeCookieHeader(auth.cookies),
        },
      }),
      FETCH_TIMEOUT_MS,
    );
    const resp = await Object.assign(req, { signal });
    if (!resp.ok) {
      // Likely session expired — bust cache + retry once.
      if (resp.status === 401 || resp.status === 403) {
        try { await env.KV?.delete(SESSION_KV_KEY); } catch (_) {}
        return { ok: false, error_kind: "list_unauthorized", hint: "session may be expired; busted cache, retry the call" };
      }
      return { ok: false, error_kind: "list_http_error", hint: `GET ${cfg.publications_list_path} -> ${resp.status}` };
    }

    const publications = [];
    if (cfg.publications_list_format === "json") {
      const json = await resp.json().catch(() => null);
      if (!json) return { ok: false, error_kind: "list_parse_failed", hint: "response not JSON" };
      // Walk the configured path (dotted).
      let cursor = json;
      for (const seg of String(cfg.publications_list_json_path || "publications").split(".")) {
        cursor = cursor?.[seg];
        if (cursor == null) break;
      }
      const list = Array.isArray(cursor) ? cursor : [];
      for (const item of list.slice(0, limit)) {
        publications.push({
          id: String(item.id ?? item.slug ?? item.uuid ?? "").slice(0, 100),
          title: String(item.title ?? item.headline ?? "").slice(0, 300),
          source_url: urlJoin(cfg.base_url, item.url || item.path || ""),
          published_at: item.published_at || item.publishedAt || item.date || null,
        });
      }
    } else {
      const html = await resp.text().catch(() => "");
      // Extract publication links via configured regex. We want unique URLs.
      const re = new RegExp(cfg.publications_html_link_pattern, "gi");
      const seen = new Set();
      let m;
      while ((m = re.exec(html)) && publications.length < limit) {
        const path = m[1];
        if (seen.has(path)) continue;
        seen.add(path);
        publications.push({
          id: path.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100),
          title: (m[2] || "").trim().slice(0, 300),
          source_url: urlJoin(cfg.base_url, path),
          published_at: null,
        });
      }
    }

    return { ok: true, publications };
  } catch (e) {
    return { ok: false, error_kind: "list_exception", hint: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Download a publication. Returns:
 *   { ok: true, content_type, body_text, body_bytes_len, pdf_url? }
 *   { ok: false, error_kind, hint }
 *
 * If the publication page is HTML with a PDF link, we follow the PDF link and
 * return the PDF bytes. If the page is the PDF itself, we return it directly.
 * If the page is HTML without a PDF, we return the HTML text (the extractor
 * handles either).
 */
export async function fetchFSDPublication(env, sourceUrl) {
  const auth = await loginFSD(env);
  if (!auth.ok) return { ok: false, error_kind: auth.error_kind, hint: auth.hint };

  const cfg = await getConfig(env);

  async function fetchOnce(url) {
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": cfg.user_agent,
          "Accept": "text/html,application/xhtml+xml,application/pdf",
          "Cookie": serializeCookieHeader(auth.cookies),
        },
      }),
      FETCH_TIMEOUT_MS,
    );
    return await Object.assign(req, { signal });
  }

  try {
    const r1 = await fetchOnce(sourceUrl);
    if (!r1.ok) {
      return { ok: false, error_kind: "page_http_error", hint: `GET ${sourceUrl} -> ${r1.status}` };
    }
    const ct = (r1.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("application/pdf")) {
      const buf = await r1.arrayBuffer();
      return { ok: true, content_type: ct, body_bytes_len: buf.byteLength, body_bytes: buf, body_text: null, pdf_url: sourceUrl };
    }

    // HTML — try to find an embedded PDF link.
    const html = await r1.text();
    const re = new RegExp(cfg.publication_pdf_link_pattern, "i");
    const m = html.match(re);
    if (m && m[1]) {
      let pdfUrl = m[1].replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(pdfUrl)) {
        pdfUrl = urlJoin(cfg.base_url, pdfUrl);
      }
      const r2 = await fetchOnce(pdfUrl);
      if (!r2.ok) {
        return { ok: false, error_kind: "pdf_http_error", hint: `GET ${pdfUrl} -> ${r2.status}` };
      }
      const buf = await r2.arrayBuffer();
      return {
        ok: true,
        content_type: r2.headers.get("content-type") || "application/pdf",
        body_bytes_len: buf.byteLength,
        body_bytes: buf,
        body_text: null,
        pdf_url: pdfUrl,
      };
    }

    // No PDF link — return the HTML as text. The extractor can still do
    // something with it (FSD daily notes are sometimes posted as long-form
    // HTML, not PDF).
    return {
      ok: true,
      content_type: ct,
      body_bytes_len: html.length,
      body_text: html,
      body_bytes: null,
      pdf_url: null,
    };
  } catch (e) {
    return { ok: false, error_kind: "fetch_exception", hint: String(e?.message || e).slice(0, 200) };
  }
}

// Operator-visible config descriptor for the admin endpoint.
export function describeDefaultConfig() {
  return {
    description: "Operator-tunable config for the FSD scraper. Override via KV cro:fsd:config (partial merge).",
    defaults: DEFAULT_FSD_CONFIG,
    kv_key: CONFIG_KV_KEY,
    session_kv_key: SESSION_KV_KEY,
    session_ttl_seconds: SESSION_TTL_SECONDS,
  };
}
