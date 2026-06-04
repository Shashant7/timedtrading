// worker/cro/fsd-client.js
// ─────────────────────────────────────────────────────────────────────────────
//  Fundstrat Direct HTTP client — WordPress REST API + login fallback.
// ─────────────────────────────────────────────────────────────────────────────
//
//  2026-06-03 — Discovered FSD is a WordPress site that exposes the
//  standard /wp-json/wp/v2/posts REST API publicly. Both metadata
//  (id, title, link, date, categories, excerpt) AND full content
//  (content.rendered HTML body) are accessible without authentication.
//  The original login+cookie flow was solving a problem we don't have.
//
//  Current default scrape_mode is "wp_rest". The legacy "html" mode is
//  retained for future use if FSD ever paywalls the REST endpoint or
//  the site shape shifts; that mode walks the login + HTML scrape we
//  built in PR #448, also configurable via KV `cro:fsd:config`.
//
//  All FSD-specific knobs (URLs, query strings, scrape mode) live in
//  KV `cro:fsd:config` (operator overrides via POST /timed/admin/cro/
//  fsd/config). The defaults below are what the orchestrator uses on
//  cold start.

const SESSION_KV_KEY = "cro:fsd:session";
const CONFIG_KV_KEY  = "cro:fsd:config";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const FETCH_TIMEOUT_MS    = 12_000;

export const DEFAULT_FSD_CONFIG = {
  base_url: "https://fundstratdirect.com",
  // ── Scrape mode ── "wp_rest" (current, default) | "html" (legacy) ──
  scrape_mode: "wp_rest",
  // ── WP REST settings (used in wp_rest mode) ──
  // 2026-06-03 — FSD exposes MULTIPLE custom post types via WP REST:
  //   - /wp/v2/posts            — long-form notes (Daily Technical Strategy,
  //                                Market Update, Earnings Daily, First Word, ...)
  //   - /wp/v2/fsi-alert        — FlashInsights (short tactical alerts from
  //                                Mark Newton + the technical desk, multiple
  //                                per day during US sessions)
  //   - /wp/v2/fsi-alert-crypto — FlashInsights specific to crypto desk
  // Listing hits all three concurrently and merges by date DESC. Per-type
  // counts are config-tunable so the operator can throttle if needed.
  wp_rest_list_path: "/wp-json/wp/v2/posts",
  wp_rest_list_query: "_fields=id,title,link,date,categories,excerpt",
  wp_rest_post_types: [
    { path: "/wp-json/wp/v2/posts",            label: "post",        per_page: 12 },
    { path: "/wp-json/wp/v2/fsi-alert",        label: "fsi-alert",   per_page: 12 },
    { path: "/wp-json/wp/v2/fsi-alert-crypto", label: "fsi-alert-crypto", per_page: 6 },
  ],
  wp_rest_post_path: "/wp-json/wp/v2/posts",  // legacy single-type fetch path
  wp_rest_post_query: "_fields=id,title,link,date,categories,content,excerpt",
  // ── Legacy login fields (used in html mode only) ──
  login_page_path: "/login",
  login_submit_path: "/login",
  login_method: "POST",
  login_content_type: "application/x-www-form-urlencoded",
  login_field_username: "email",
  login_field_password: "password",
  login_field_csrf: "authenticity_token",
  login_success_redirect_path: "/dashboard/",
  expected_session_cookie_names: ["_fsd_session", "session", "_session_id", "wordpress_logged_in"],
  // ── Legacy HTML scrape (used in html mode only) ──
  publications_list_path: "/dashboard/",
  publications_list_format: "html",
  publications_list_json_path: "",
  publications_html_link_pattern: "<a[^>]*href=\"(/market-intelligence/[^\"]+)\"[^>]*>([^<]{5,200})</a>",
  publication_pdf_link_pattern: "href=\"([^\"]+\\.pdf[^\"]*)\"",
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getConfig(env) {
  try {
    const raw = await env?.KV?.get(CONFIG_KV_KEY);
    if (raw) return { ...DEFAULT_FSD_CONFIG, ...(JSON.parse(raw) || {}) };
  } catch (_) {}
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

// Decode WP-style "title.rendered" / "content.rendered" / "excerpt.rendered"
// and strip a few common HTML entities so the LLM extractor sees clean text.
function wpField(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const raw = v.rendered != null ? v.rendered : String(v);
  return String(raw)
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

// ── Legacy login flow (used only in html scrape_mode) ─────────────────────────

function parseSetCookies(headers) {
  const out = [];
  let lines = [];
  if (typeof headers?.getSetCookie === "function") lines = headers.getSetCookie();
  else {
    const raw = headers?.get?.("set-cookie") || "";
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
function serializeCookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
}
function mergeCookies(base, incoming) {
  const map = new Map();
  for (const c of (base || [])) map.set(c.name, c);
  for (const c of (incoming || [])) map.set(c.name, c);
  return Array.from(map.values());
}
function extractCsrfToken(html, csrfField) {
  if (!html || !csrfField) return null;
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

export async function loginFSD(env, { force = false } = {}) {
  if (!env?.FSD_USERNAME || !env?.FSD_PASSWORD) {
    return { ok: false, error_kind: "no_credentials", hint: "wrangler secret put FSD_USERNAME and FSD_PASSWORD on both envs" };
  }
  if (!force) {
    try {
      const cached = await env.KV?.get(SESSION_KV_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.cookies && (Date.now() - (parsed.created_at || 0)) < SESSION_TTL_SECONDS * 1000) {
          return { ok: true, cookies: parsed.cookies, from_cache: true, probe_summary: parsed.probe_summary || null };
        }
      }
    } catch (_) {}
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
  let cookies = [];
  let csrfToken = null;
  try {
    const url = urlJoin(cfg.base_url, cfg.login_page_path);
    const { signal, done: req } = withTimeout(
      fetch(url, { method: "GET", headers: { "User-Agent": cfg.user_agent, "Accept": "text/html,application/xhtml+xml" } }),
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
  try {
    const url = urlJoin(cfg.base_url, cfg.login_submit_path);
    const body = new URLSearchParams();
    body.set(cfg.login_field_username, env.FSD_USERNAME);
    body.set(cfg.login_field_password, env.FSD_PASSWORD);
    if (csrfToken) body.set(cfg.login_field_csrf, csrfToken);
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: cfg.login_method || "POST",
        redirect: "manual",
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
    const redirectAwayFromLogin = probe_summary.response_redirect
      && !probe_summary.response_redirect.toLowerCase().includes("login");
    const sessionCookieSet = cookies.some((c) =>
      (cfg.expected_session_cookie_names || []).some((n) => c.name.toLowerCase() === String(n).toLowerCase()));
    const looksGood = (resp.status >= 300 && resp.status < 400 && redirectAwayFromLogin)
      || (resp.status === 200 && sessionCookieSet);
    if (!looksGood) {
      const body = await resp.text().catch(() => "");
      probe_summary.body_first_500_chars = body.slice(0, 500);
      return {
        ok: false,
        error_kind: "login_rejected",
        hint: "login POST returned status " + resp.status + (probe_summary.response_redirect ? `, Location=${probe_summary.response_redirect}` : ". no session cookie set."),
        probe_summary,
      };
    }
    try {
      await env.KV?.put(SESSION_KV_KEY, JSON.stringify({ cookies, created_at: Date.now(), probe_summary }), { expirationTtl: SESSION_TTL_SECONDS });
    } catch (_) {}
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

export async function probeFSD(env) {
  // 2026-06-03 — Probe both surfaces. In wp_rest mode the operator
  // primarily cares that the WP REST endpoint is reachable; login is
  // only needed if FSD paywalls the REST API in the future.
  const cfg = await getConfig(env);
  const out = { scrape_mode: cfg.scrape_mode };
  // 1. WP REST probe
  try {
    const url = urlJoin(cfg.base_url, cfg.wp_rest_list_path) + "?per_page=1&_fields=id,title,date";
    const { signal, done: req } = withTimeout(
      fetch(url, { method: "GET", headers: { "User-Agent": cfg.user_agent, "Accept": "application/json" } }),
      FETCH_TIMEOUT_MS,
    );
    const resp = await Object.assign(req, { signal });
    const body = await resp.json().catch(() => null);
    out.wp_rest = {
      status: resp.status,
      ok: resp.ok && Array.isArray(body),
      first_post_id: Array.isArray(body) && body[0]?.id || null,
      first_post_date: Array.isArray(body) && body[0]?.date || null,
    };
  } catch (e) {
    out.wp_rest = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  // 2. Login probe (legacy / fallback)
  out.login = await loginFSD(env, { force: true });
  return out;
}

// ── Public API: list publications ─────────────────────────────────────────────

export async function listFSDPublications(env, { limit = 20 } = {}) {
  const cfg = await getConfig(env);
  if (cfg.scrape_mode === "wp_rest") return listViaWPRest(env, cfg, limit);
  return listViaHTML(env, cfg, limit);
}

async function listViaWPRest(env, cfg, limit) {
  // Multi-type fetch. Each type runs in parallel; results merge by date DESC,
  // truncated to `limit`. Per-type failures are reported in `meta.errors[]`
  // but don't fail the whole list — partial results are still returned.
  const types = Array.isArray(cfg.wp_rest_post_types) && cfg.wp_rest_post_types.length > 0
    ? cfg.wp_rest_post_types
    : [{ path: cfg.wp_rest_list_path, label: "post", per_page: limit }];
  const baseQuery = (cfg.wp_rest_list_query || "").replace(/(^|[?&])per_page=\d+/g, "").replace(/^&+|&+$/g, "");

  const fetches = types.map(async (t) => {
    const perPage = Math.min(50, Math.max(1, t.per_page || limit));
    const url = urlJoin(cfg.base_url, t.path) + "?per_page=" + perPage + (baseQuery ? "&" + baseQuery : "");
    try {
      const { signal, done: req } = withTimeout(
        fetch(url, { method: "GET", headers: { "User-Agent": cfg.user_agent, "Accept": "application/json" } }),
        FETCH_TIMEOUT_MS,
      );
      const resp = await Object.assign(req, { signal });
      if (!resp.ok) return { ok: false, label: t.label, error: `HTTP ${resp.status}`, url };
      const json = await resp.json().catch(() => null);
      if (!Array.isArray(json)) return { ok: false, label: t.label, error: "non-array response", url };
      const posts = json.map((post) => ({
        id: String(post.id),
        post_type: t.label,
        post_type_path: t.path,
        title: wpField(post.title).slice(0, 300),
        source_url: String(post.link || ""),
        published_at: post.date || post.date_gmt || null,
        categories: Array.isArray(post.categories) ? post.categories : null,
        excerpt: wpField(post.excerpt).slice(0, 500) || null,
      }));
      return { ok: true, label: t.label, posts };
    } catch (e) {
      return { ok: false, label: t.label, error: String(e?.message || e).slice(0, 200), url };
    }
  });

  const results = await Promise.all(fetches);
  const errors = results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`);
  const allPosts = results.filter((r) => r.ok).flatMap((r) => r.posts);

  if (allPosts.length === 0) {
    return {
      ok: false,
      error_kind: errors.length > 0 ? "list_http_error" : "list_empty",
      hint: errors.length > 0 ? errors.join("; ").slice(0, 400) : "no posts returned from any WP post-type",
    };
  }

  // De-dup by id (across post types, just in case) + sort by date DESC.
  const seen = new Set();
  const deduped = [];
  for (const p of allPosts) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    deduped.push(p);
  }
  deduped.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));

  return {
    ok: true,
    publications: deduped.slice(0, limit),
    scrape_mode: "wp_rest",
    post_types_attempted: types.map((t) => t.label),
    partial_errors: errors.length > 0 ? errors : null,
  };
}

async function listViaHTML(env, cfg, limit) {
  const auth = await loginFSD(env);
  if (!auth.ok) return { ok: false, error_kind: auth.error_kind, hint: auth.hint, login_probe: auth.probe_summary };
  const url = urlJoin(cfg.base_url, cfg.publications_list_path);
  try {
    const { signal, done: req } = withTimeout(
      fetch(url, {
        method: "GET",
        headers: { "User-Agent": cfg.user_agent, "Accept": "text/html", "Cookie": serializeCookieHeader(auth.cookies) },
      }),
      FETCH_TIMEOUT_MS,
    );
    const resp = await Object.assign(req, { signal });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        try { await env.KV?.delete(SESSION_KV_KEY); } catch (_) {}
        return { ok: false, error_kind: "list_unauthorized", hint: "session may be expired; busted cache, retry" };
      }
      return { ok: false, error_kind: "list_http_error", hint: `GET ${cfg.publications_list_path} -> ${resp.status}` };
    }
    const html = await resp.text().catch(() => "");
    const re = new RegExp(cfg.publications_html_link_pattern, "gi");
    const seen = new Set();
    const publications = [];
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
    return { ok: true, publications, scrape_mode: "html" };
  } catch (e) {
    return { ok: false, error_kind: "list_exception", hint: String(e?.message || e).slice(0, 200) };
  }
}

// ── Public API: fetch a single publication ────────────────────────────────────

export async function fetchFSDPublication(env, sourceUrlOrId) {
  const cfg = await getConfig(env);

  // Path A: WP REST mode — accepts a numeric id OR a WP-style slug URL.
  if (cfg.scrape_mode === "wp_rest") {
    let postId = null;
    if (typeof sourceUrlOrId === "number" || /^\d+$/.test(String(sourceUrlOrId))) {
      postId = String(sourceUrlOrId);
    } else if (typeof sourceUrlOrId === "string") {
      // 2026-06-03 — Resolve slug → id by walking ALL configured post
      // types in turn. The previous implementation only checked
      // /wp/v2/posts, which 404s for fsi-alert / fsi-alert-crypto
      // entries (a separate WP custom post-type bucket). The miss fell
      // through to the legacy login + full-page HTML scrape, which
      // grabbed FSD's site nav + footer chrome and stored garbage as
      // the publication text — operator-visible as the "Search Search
      // Referral Program Gift Cards Merch Store…" noise in the
      // Catalysts tab.
      const m = sourceUrlOrId.match(/\/([^/]+?)\/?$/);
      const slug = m ? m[1] : null;
      if (slug) {
        const slugCandidates = Array.isArray(cfg.wp_rest_post_types) && cfg.wp_rest_post_types.length > 0
          ? cfg.wp_rest_post_types.map((t) => t.path)
          : [cfg.wp_rest_list_path];
        for (const candidatePath of slugCandidates) {
          try {
            const slugUrl = urlJoin(cfg.base_url, candidatePath) + "?slug=" + encodeURIComponent(slug) + "&_fields=id";
            const { signal, done: req } = withTimeout(
              fetch(slugUrl, { method: "GET", headers: { "User-Agent": cfg.user_agent, "Accept": "application/json" } }),
              FETCH_TIMEOUT_MS,
            );
            const r = await Object.assign(req, { signal });
            if (r.ok) {
              const arr = await r.json().catch(() => null);
              if (Array.isArray(arr) && arr[0]?.id) { postId = String(arr[0].id); break; }
            }
          } catch (_) { /* try next post-type */ }
        }
      }
    }
    if (postId) {
      // Try each configured post-type path until one returns the post.
      // /wp/v2/posts holds long-form notes; /wp/v2/fsi-alert holds
      // FlashInsights; etc. Iterate so a numeric id resolves regardless
      // of which post-type it lives under.
      const candidatePaths = Array.isArray(cfg.wp_rest_post_types) && cfg.wp_rest_post_types.length > 0
        ? cfg.wp_rest_post_types.map((t) => t.path)
        : [cfg.wp_rest_post_path];
      let post = null;
      let lastStatus = null;
      for (const candidatePath of candidatePaths) {
        try {
          const url = urlJoin(cfg.base_url, candidatePath) + "/" + encodeURIComponent(postId)
            + "?" + (cfg.wp_rest_post_query || "");
          const { signal, done: req } = withTimeout(
            fetch(url, { method: "GET", headers: { "User-Agent": cfg.user_agent, "Accept": "application/json" } }),
            FETCH_TIMEOUT_MS,
          );
          const resp = await Object.assign(req, { signal });
          lastStatus = resp.status;
          if (resp.ok) {
            const p = await resp.json().catch(() => null);
            if (p && p.id) { post = p; break; }
          }
        } catch (_) { /* try next type */ }
      }
      if (!post) {
        return { ok: false, error_kind: "wp_post_http_error", hint: `wp/posts/${postId} across ${candidatePaths.length} type(s) -> last status ${lastStatus}` };
      }
      const title = wpField(post.title);
      const excerpt = wpField(post.excerpt);
      const content = wpField(post.content);
      const fullText = [title, excerpt, content].filter(Boolean).join("\n\n");
      return {
        ok: true,
        content_type: "text/html",
        body_bytes_len: fullText.length,
        body_text: fullText,
        body_bytes: null,
        pdf_url: null,
        source_kind: "wp_rest_post",
        post_id: post.id,
        post_link: post.link || null,
      };
    }
    // If we couldn't resolve a post id, fall through to legacy login.
  }

  // Path B: legacy login + HTML scrape.
  const auth = await loginFSD(env);
  if (!auth.ok) return { ok: false, error_kind: auth.error_kind, hint: auth.hint };
  const sourceUrl = String(sourceUrlOrId);

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
    const html = await r1.text();
    const re = new RegExp(cfg.publication_pdf_link_pattern, "i");
    const m = html.match(re);
    if (m && m[1]) {
      let pdfUrl = m[1].replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(pdfUrl)) pdfUrl = urlJoin(cfg.base_url, pdfUrl);
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
    return { ok: true, content_type: ct, body_bytes_len: html.length, body_text: html, body_bytes: null, pdf_url: null };
  } catch (e) {
    return { ok: false, error_kind: "fetch_exception", hint: String(e?.message || e).slice(0, 200) };
  }
}

export function describeDefaultConfig() {
  return {
    description: "Operator-tunable config for the FSD scraper. Override via KV cro:fsd:config (partial merge). Default mode is wp_rest (no auth needed).",
    defaults: DEFAULT_FSD_CONFIG,
    kv_key: CONFIG_KV_KEY,
    session_kv_key: SESSION_KV_KEY,
    session_ttl_seconds: SESSION_TTL_SECONDS,
  };
}
