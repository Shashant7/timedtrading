// ═══════════════════════════════════════════════════════════════════════════
// Pages Worker — smart root routing + proxy /timed/* to the API Worker.
//
// Root path routing:
//   - If the user has a CF_Authorization cookie (authenticated) → redirect
//     to /today.html (the daily-ingest digest, new product home — was
//     /index-react.html before the journey-page split).
//   - Otherwise → serve /splash.html (public landing page).
//
// API proxy:
//   - /timed/* requests are forwarded to the API Worker server-side.
//   - The CF-Access-JWT-Assertion header is extracted from the CF Access
//     header (if present) or from the CF_Authorization cookie and forwarded
//     to the API Worker for authentication.
//
// All other requests (HTML, JS, CSS) are served as static assets via env.ASSETS.
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_ORIGIN = "https://timed-trading-ingest.shashant.workers.dev";

/**
 * Admin-only HTML pages. Anyone without an admin role gets a 403 instead
 * of the page HTML. This is defense in depth — Cloudflare Access is the
 * primary gate (configured in the Zero Trust dashboard); this is the
 * second gate that runs even if the Access policy is loose. Defends
 * against the "Critical: Overprovisioned Access Policies" insight by
 * checking admin status server-side via /timed/me before serving the
 * static asset.
 *
 * Source of truth for which pages are admin-only: scan the codebase for
 * `data-admin-only="true"` nav links. Keep this list in sync with the
 * .html files in react-app/.
 */
const ADMIN_ONLY_PAGES = new Set([
  "/admin-clients.html",
  "/mission-control.html",
  "/screener.html",
  "/system-intelligence.html",
  "/ticker-management.html",
  "/trade-autopsy.html",
  "/debug-dashboard.html",
  "/model-dashboard.html",
  "/model-performance.html",
  "/brand-kit.html",
  "/calibration.html",
  "/simulation-dashboard.html",
  "/bridge-audit.html",
  "/move-discovery.html",
]);

/**
 * Extract the CF Access JWT from the request.
 * Priority: CF-Access-JWT-Assertion header (set by CF Access on protected paths),
 * then fallback to the CF_Authorization cookie (set domain-wide by CF Access
 * after the user authenticates on any protected path).
 */
function extractJwt(request) {
  const header = request.headers.get("CF-Access-JWT-Assertion");
  if (header) return header;

  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(/CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Server-side admin check: ask the API worker /timed/me whether the
 * forwarded JWT belongs to an admin user. Returns true only on
 * affirmative confirmation. Any error / missing JWT / non-admin returns
 * false, so a failure mode is fail-closed (deny) rather than fail-open.
 *
 * Cached in-flight per request (no caching across requests because the
 * call only fires for admin-only HTML page loads, which are infrequent
 * and warrant a fresh check each time).
 */
async function isAdmin(request) {
  const jwt = extractJwt(request);
  if (!jwt) return false;
  try {
    const res = await fetch(`${WORKER_ORIGIN}/timed/me`, {
      headers: {
        "CF-Access-JWT-Assertion": jwt,
        "User-Agent": request.headers.get("User-Agent") || "pages-worker",
      },
    });
    if (!res.ok) return false;
    const json = await res.json();
    if (!json || !json.ok || !json.user) return false;
    const u = json.user;
    return u.role === "admin" || u.tier === "admin";
  } catch (_) {
    return false;
  }
}

/**
 * Render a 403 page for non-admin users hitting an admin-only path.
 * Plain HTML; no React, no JS, no asset deps so it works regardless of
 * Pages availability.
 */
function adminForbiddenResponse() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex,nofollow" />
  <title>403 — Admin only</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
           background: #0A0D11; color: #e5e7eb; margin: 0;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { max-width: 420px; padding: 40px 32px; text-align: center;
            background: #13171D; border: 1px solid rgba(255,255,255,0.06);
            border-radius: 14px; }
    h1 { font-size: 22px; margin: 0 0 8px; color: #fff; }
    p { font-size: 14px; line-height: 1.6; color: #9ca3af; margin: 0 0 18px; }
    a { color: #F5C25C; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .code { font-family: monospace; font-size: 11px; color: #6b7280; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin only</h1>
    <p>This page requires an administrator account. If you believe this is a mistake, contact <a href="mailto:support@timed-trading.com">support@timed-trading.com</a>.</p>
    <p><a href="/">&larr; Back to home</a></p>
    <div class="code">HTTP 403 &middot; admin_required</div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex,nofollow",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Smart root routing ───────────────────────────────────────────────
    // Authenticated users (have CF_Authorization cookie) → /today.html
    // (the daily-ingest digest, new product home as of P0.7.187).
    // Everyone else → public splash page.
    //
    // 2026-05-23 — Preserve search params + hash on every redirect path so
    // deep links like /?ticker=IBM survive into today.html and the global
    // search component can open the right rail. Previously the redirect
    // dropped the query string and the rail never opened. Also forward
    // deep-link queries through to today.html for unauthed visitors so the
    // CF Access auth flow lands them back on the correctly-deep-linked
    // page rather than the bare today.html / splash.
    if (url.pathname === "/") {
      const cookies = request.headers.get("Cookie") || "";
      const hasAuth = cookies.includes("CF_Authorization=");
      const search = url.search || "";   // includes leading "?"
      const hash = url.hash || "";       // includes leading "#"
      // A "deep-link" root request is anything with a query string or hash
      // (e.g. /?ticker=IBM, /#some-anchor). For these we always want to
      // land the user on today.html so the deep-link handler runs.
      const isDeepLink = search.length > 0 || hash.length > 0;
      if (hasAuth || isDeepLink) {
        const target = new URL("/today.html", url.origin);
        target.search = search;
        if (hash) target.hash = hash;
        return Response.redirect(target.toString(), 302);
      }
      // Bare / from an unauthenticated visitor → public splash page.
      return env.ASSETS.fetch(
        new Request(new URL("/splash.html", url.origin), request),
      );
    }

    // ── Proxy /timed/* to the API Worker ─────────────────────────────────
    if (url.pathname.startsWith("/timed/") || url.pathname === "/timed") {
      const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

      // Forward select headers
      const headers = new Headers();

      // Forward CF Access JWT (from header or cookie fallback)
      const jwt = extractJwt(request);
      if (jwt) headers.set("CF-Access-JWT-Assertion", jwt);

      // HOTFIX 2026-06-09 — forward API-key auth headers. The P0.3
      // migration moved internal callers from ?key= query strings (which
      // this proxy preserved via url.search) to X-API-Key headers (which
      // this allowlist silently DROPPED). Cron self-fetches route through
      // the custom domain (wrangler.toml WORKER_URL — workers.dev
      // self-fetch trips CF error 1042), i.e. through THIS proxy — so
      // every header-authed self-call 401'd within minutes of the deploy
      // (brief_accuracy_eval, investor_hourly_compute tombstones).
      const apiKey = request.headers.get("X-API-Key");
      if (apiKey) headers.set("X-API-Key", apiKey);
      const authz = request.headers.get("Authorization");
      if (authz) headers.set("Authorization", authz);

      // Forward content type (important for POST with JSON body)
      const ct = request.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);

      // Forward user-agent for logging
      const ua = request.headers.get("User-Agent");
      if (ua) headers.set("User-Agent", ua);

      // Forward CF-Connecting-IP for audit trails (terms acceptance, etc.)
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) headers.set("CF-Connecting-IP", ip);

      const init = { method: request.method, headers, redirect: "manual" };

      // Forward body for methods that carry one
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        init.body = request.body;
      }

      try {
        const response = await fetch(targetUrl, init);

        // Strip CORS headers — same-origin doesn't need them
        const respHeaders = new Headers(response.headers);
        respHeaders.delete("Access-Control-Allow-Origin");
        respHeaders.delete("Access-Control-Allow-Methods");
        respHeaders.delete("Access-Control-Allow-Headers");
        respHeaders.delete("Access-Control-Allow-Credentials");
        respHeaders.delete("Access-Control-Max-Age");

        // Rewrite Location header on redirects: Worker origin → production origin
        // Since we use redirect: "manual", 3xx responses are passed through.
        // The Worker's Location header points to its own origin; rewrite it
        // so the client browser redirects to the production domain instead.
        const location = respHeaders.get("Location");
        if (location && response.status >= 300 && response.status < 400) {
          respHeaders.set(
            "Location",
            location.replace(WORKER_ORIGIN, url.origin),
          );
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: respHeaders,
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "proxy_error",
            message: String(err?.message || err),
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // ── Admin-only HTML gate (defense in depth for CF Access policy) ────
    // Cloudflare Access is the primary gate; this is the second one. Any
    // request for a known admin-only HTML path is checked against
    // /timed/me before the asset is served. Non-admins see a 403 page
    // instead of the underlying tool. Only HTML page paths are gated;
    // chunk JS / CSS / asset requests fall through (they're useless
    // without the page anyway, and gating them would waste round trips).
    if (request.method === "GET" && ADMIN_ONLY_PAGES.has(url.pathname)) {
      const ok = await isAdmin(request);
      if (!ok) return adminForbiddenResponse();
    }

    // ── Everything else: serve static assets (HTML, JS, CSS, etc.) ───────
    // 2026-06-10 PERF — explicit cache policy. `_headers` files are NOT
    // honored in advanced mode (_worker.js), so without this every page
    // switch re-validated all ~17 scripts per page (a conditional request
    // each). Policy:
    //   - ?v=-stamped assets + /vendor/*: immutable for a year. The build
    //     restamps every ?v= on every deploy (scripts/build-frontend.js
    //     BUILD_MARKER), so a new deploy always changes the URL — the
    //     long TTL can never serve a stale file.
    //   - HTML + service-worker.js: no-cache (always revalidate; ETag
    //     makes unchanged loads a cheap 304).
    //   - everything else (logos, robots.txt, unversioned helpers):
    //     1h with revalidation.
    const assetResponse = await env.ASSETS.fetch(request);
    if (!assetResponse.ok) return assetResponse;

    const isVersioned =
      url.searchParams.has("v") || url.pathname.startsWith("/vendor/");
    // Pretty URLs (/active-trader, /today, …) serve HTML without a .html
    // suffix. Path-only checks miss those and used to stamp max-age=3600,
    // so browsers kept an old document (and its old ?v= script URLs) for
    // up to an hour after a Pages deploy — classic "I merged but don't
    // see the UI" report. Prefer Content-Type; keep path fallbacks.
    const contentType = String(assetResponse.headers.get("Content-Type") || "").toLowerCase();
    const isHtml =
      contentType.includes("text/html") ||
      url.pathname.endsWith(".html") ||
      url.pathname.endsWith("/");
    const isServiceWorker = url.pathname === "/service-worker.js";

    const cached = new Response(assetResponse.body, assetResponse);
    if (isHtml || isServiceWorker) {
      cached.headers.set("Cache-Control", "no-cache");
    } else if (isVersioned) {
      cached.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      cached.headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
    }
    return cached;
  },
};
