// ═══════════════════════════════════════════════════════════════════════════
// Pages Worker — proxy /timed/* requests to the Worker API.
//
// This eliminates cross-origin issues: the browser only talks to the Pages
// domain (timedtrading.pages.dev), and this worker forwards /timed/* to
// the API Worker (timed-trading-ingest.shashant.workers.dev) server-side.
//
// The CF-Access-JWT-Assertion header (set by Cloudflare Access on the Pages
// domain) is forwarded so the API Worker can identify the authenticated user.
//
// All other requests (HTML, JS, CSS) are served as static assets via env.ASSETS.
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_ORIGIN = "https://timed-trading-ingest.shashant.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Proxy /timed/* to the API Worker ─────────────────────────────────
    if (url.pathname.startsWith("/timed/") || url.pathname === "/timed") {
      const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

      // Forward select headers
      const headers = new Headers();

      // Forward CF Access JWT (set by CF Access on Pages domain)
      const jwt = request.headers.get("CF-Access-JWT-Assertion");
      if (jwt) headers.set("CF-Access-JWT-Assertion", jwt);

      // Forward content type (important for POST with JSON body)
      const ct = request.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);

      // Forward user-agent for logging
      const ua = request.headers.get("User-Agent");
      if (ua) headers.set("User-Agent", ua);

      const init = { method: request.method, headers };

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
