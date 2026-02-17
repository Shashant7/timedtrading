// ═══════════════════════════════════════════════════════════════════════════
// Pages Worker — smart root routing + proxy /timed/* to the API Worker.
//
// Root path routing:
//   - If the user has a CF_Authorization cookie (authenticated) → redirect
//     to /index-react.html (dashboard).
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Smart root routing ───────────────────────────────────────────────
    // Authenticated users (have CF_Authorization cookie) → dashboard.
    // Everyone else → public splash page.
    if (url.pathname === "/") {
      const cookies = request.headers.get("Cookie") || "";
      const hasAuth = cookies.includes("CF_Authorization=");
      if (hasAuth) {
        return Response.redirect(
          new URL("/index-react.html", url.origin).toString(),
          302,
        );
      } else {
        // Serve splash.html as the public landing page
        return env.ASSETS.fetch(
          new Request(new URL("/splash.html", url.origin), request),
        );
      }
    }

    // ── Proxy /timed/* to the API Worker ─────────────────────────────────
    if (url.pathname.startsWith("/timed/") || url.pathname === "/timed") {
      const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

      // Forward select headers
      const headers = new Headers();

      // Forward CF Access JWT (from header or cookie fallback)
      const jwt = extractJwt(request);
      if (jwt) headers.set("CF-Access-JWT-Assertion", jwt);

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

    // ── Everything else: serve static assets (HTML, JS, CSS, etc.) ───────
    return env.ASSETS.fetch(request);
  },
};
