# X MCP in Cursor (local IDE)

Use this for **interactive** X queries in Cursor (read posts, search, debug ingest).
Production ingest uses the worker `x-wire-tracker` + `X_API_BEARER_TOKEN` in Cloudflare — not MCP.

## Recommended: Bearer token (no OAuth, no portal OAuth setup)

If you already have an **app-only Bearer token** (same one in Cloudflare), skip OAuth entirely:

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
```

Paste the Bearer token into `.cursor/mcp.json` → reload Cursor → **Tools & MCP** → green dot on `xapi`.

Read-only, no browser login, no `xurl` bridge. This is enough to read posts and timelines.

OAuth variant (only if you need user-context writes): see `.cursor/mcp.json.oauth.example`.

## Credentials — which keys?

| X Developer Portal item | Cursor MCP (Bearer path) | Cursor MCP (OAuth path) | Cloudflare worker |
|-------------------------|--------------------------|-------------------------|-------------------|
| **Bearer token** | **Yes (recommended)** | No | **Yes** |
| OAuth 2.0 Client ID + Secret | No | Yes | No |
| Consumer Key + Secret | No | No | No |

## OAuth path (optional — only if Bearer MCP fails)

1. Use **https://console.x.com/** (not legacy developer.twitter.com URLs)
2. Log into **x.com** in a normal tab first, then open the developer console
3. Your app → **User authentication settings** → enable **OAuth 2.0**
4. App type: **Web App, Automated App or Bot**
5. Redirect URI: `http://localhost:8080/callback`
6. Copy **OAuth 2.0** Client ID + Client Secret (not Consumer Key)
7. Use `.cursor/mcp.json.oauth.example` as the template

### Developer portal stuck on Register / Sign in?

Common fixes when the portal loops even though you already have an app + Bearer token:

1. **Use the right URL:** https://console.x.com/ (or https://developer.x.com/en/portal/dashboard)
2. **Sign into x.com first** in a separate tab with the same account that owns the developer app
3. **Disable ad blockers / strict tracking protection** for `x.com` and `twitter.com`
4. **Try a private window** after signing into x.com first, then open console.x.com
5. **Different browser** (Chrome vs Safari) — X session cookies are picky
6. If OAuth browser popup loops: copy the auth URL, replace `twitter.com` with `x.com`, open manually (known X redirect bug)

**You do not need OAuth for production ingest** — only for optional Cursor MCP user-context features.

## Enable in Cursor

1. **Cursor Settings** (`Cmd+,` / `Ctrl+,`)
2. **Tools & MCP** → confirm `xapi` shows a **green dot**
3. Bearer path: no browser step. OAuth path: browser opens once on first tool use.

## Verify

> Use X MCP to fetch the 5 most recent posts from @DeItaone

## Security

- Never commit `.cursor/mcp.json` with real secrets
- `.cursor/mcp.json` is gitignored
