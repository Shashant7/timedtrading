# Debug HTTP Codes (401 / 403 / 404 / 503 / "error code: 1042")

**WHEN to use:** A worker endpoint or Pages route is returning a
non-2xx and you need to know what's actually wrong.

This codebase has its own conventions for each status code. Memorise
them — guessing wastes hours.

---

## 401 Unauthorized

**Body:** `{"ok":false,"error":"unauthorized"}`

**What it means:** `requireKeyOrAdmin` or `requireKeyOr401` rejected the
request. Both check, in order:

1. CF Access JWT (header `CF-Access-JWT-Assertion` OR `CF_Authorization` cookie)
2. `key=` query param OR `X-TT-Admin-Key` header against `TIMED_TRADING_API_KEY` env

**Fix:**

- From a browser logged in via CF Access → cookie should be sent automatically
- From `curl` → add `-H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY"` or `?key=$TIMED_TRADING_API_KEY`
- From the Pages worker proxy → it extracts the JWT from cookie and forwards as header. If broken, check `react-app/_worker.js` → `extractJwt`.

---

## 403 Forbidden

**Body:** Usually HTML, often Cloudflare's challenge page (`cf-mitigated: challenge`).

**What it means:** Cloudflare Access denied OR Cloudflare Bot Mitigation
flagged the request as automated.

**Fix:**

- For Cloudflare Access: the user's email isn't in the Zero Trust policy. Operator can add it via the Cloudflare dashboard.
- For Bot Mitigation: passes from a real browser; blocks bare `curl`. Add `-A "Mozilla/5.0..."` to bypass for testing, but never as a permanent fix.
- For admin HTML pages: `react-app/_worker.js` runs a server-side admin gate. Non-admins see a 403 page. Check `ADMIN_ONLY_PAGES` set + `/timed/me` returns `user.role === "admin"`.

---

## 404 Not Found

**Body matters here.**

### `{"ok":false,"error":"not_found"}` (JSON)

The worker's route dispatcher didn't find a match. Causes:

- Endpoint isn't registered in the `ROUTES` table (`worker/index.js` line ~1500). Add it; or check if the path has a typo.
- Wrong HTTP method (e.g. POST to a GET-only route returns 404, not 405).

### `error code: 1042` (plain text, 16 bytes)

**This is a Cloudflare INFRASTRUCTURE error, NOT a worker error.** Code 1042 is "subrequest loopback rejected" — your worker tried to `fetch()` a URL that Cloudflare considers part of the same worker zone.

Most common cause in this repo: main worker fetching `tt-broker-bridge.shashant.workers.dev` from within a subrequest. Cloudflare's loop detection sometimes blocks this even though they're distinct workers on workers.dev.

**Fix:** Use a **Service Binding** instead of HTTP fetch for worker-to-worker calls. See the [Cloudflare service-bindings docs](https://developers.cloudflare.com/workers/configuration/bindings/about-service-bindings/). The bridge integration is a planned migration target.

### HTML 404 page

You hit the Pages catch-all (file doesn't exist in `react-app-dist/`).
Check spelling + that the file is actually deployed.

---

## 503 Service Unavailable

**Body:** Usually `{"ok":false,"error":"<thing>_not_configured"}`

**What it means:** An admin endpoint requires a piece of config that's
missing (env var, secret, KV namespace).

**Fix:** The response body always includes a `hint` field with the
exact wrangler command to set it. Follow the hint.

> **As of PR after 2026-05-30, the broker bridge endpoints return HTTP
> 200 with `ok: false` instead of 503** so the operator browser console
> doesn't show red errors for an expected-empty state. If you add new
> admin endpoints that are polled on every page load, follow this
> pattern.

---

## 502 Bad Gateway

The worker tried a subrequest and the upstream timed out / errored.
Body includes `error: "bridge_unreachable: <message>"` etc. Check the
upstream's own health endpoint.

---

## Triage cheat-sheet

```
Symptom: red 4xx in browser console, no functional impact
  → Wrap the endpoint to return 200 + structured payload. Pattern:
    if (problem) return sendJSON({ ok: false, error_kind: "..." }, 200, corsHeaders(...))

Symptom: curl returns 404 + "error code: 1042"
  → Worker-to-worker loopback. Use Service Bindings, not HTTP fetch.

Symptom: curl returns 401, browser session works
  → Auth is fine; you're missing -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY"

Symptom: curl returns 403 + CF challenge page
  → Bot mitigation. Add -A "Mozilla/5.0..." (for testing only).

Symptom: browser shows 403 admin HTML page
  → user.role !== "admin". Either grant admin via /timed/admin or test as the right user.

Symptom: "I added a route but get 404"
  → Forgot to add to the ROUTES table at line ~1500 in worker/index.js. Both lines:
    ["GET", "/timed/admin/foo", "GET /timed/admin/foo"],   ← registration
    if (routeKey === "GET /timed/admin/foo") { ... }       ← handler
```

## Source

- `worker/index.js` → `ROUTES` table + `getRouteKey()` dispatcher
- `worker/auth.js` → `requireKeyOrAdmin`, `requireKeyOr401`, `requireAdminOr403`
- `react-app/_worker.js` → Pages worker proxy + admin HTML gate
