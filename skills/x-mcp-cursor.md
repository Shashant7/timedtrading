# X MCP in Cursor (local IDE)

Use this for **interactive** X queries in Cursor (read posts, search, debug ingest).
Production ingest uses the worker `x-wire-tracker` + `X_API_BEARER_TOKEN` in Cloudflare — not MCP.

## Credentials — which keys?

| X Developer Portal item | Use for Cursor MCP? |
|-------------------------|---------------------|
| **OAuth 2.0 Client ID + Client Secret** | **Yes** (User authentication settings) |
| Bearer token | No (worker only) |
| Consumer Key + Secret | No (legacy OAuth 1.0a; not used by `xurl mcp`) |

## One-time X app setup

1. [developer.x.com](https://developer.x.com) → your app → **User authentication settings**
2. Enable **OAuth 2.0**
3. Type: **Web App** (or Native per portal UI)
4. Redirect URI (required):

   ```
   http://localhost:8080/callback
   ```

5. Scopes: at minimum **Read** (posts, users, timelines)
6. Copy **Client ID** and **Client Secret** (OAuth 2.0 section — not Consumer Key)

App should be **Pay-per-use + Production** if API calls fail with `client-not-enrolled`.

## Cursor config

### Option A — project only (this repo)

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
```

Edit `.cursor/mcp.json` and replace the two placeholders. `.cursor/mcp.json` is gitignored.

### Option B — all projects (global)

Copy the same JSON block into `~/.cursor/mcp.json` on your machine.

## Enable in Cursor

1. **Cursor Settings** (`Cmd+,` / `Ctrl+,`)
2. **Tools & MCP** → confirm `xapi` shows a **green dot**
3. On first tool use, browser opens for X OAuth — approve once
4. Tokens cache in `~/.xurl` on your machine

## Verify

Ask the agent:

> Use X MCP to fetch the 5 most recent posts from @DeItaone

Or test the bridge manually:

```bash
export CLIENT_ID="your-oauth2-client-id"
export CLIENT_SECRET="your-oauth2-client-secret"
npx -y @xdevplatform/xurl mcp https://api.x.com/mcp
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Timeout on startup | `startup_timeout_sec: 300` in config |
| Browser auth fails | Register `http://localhost:8080/callback` on the app |
| Wrong credentials error | Use OAuth 2.0 Client ID/Secret, not Consumer Key/Secret |
| `client-not-enrolled` | Move app to Pay-per-use + Production |

## Security

- Never commit `.cursor/mcp.json` with real secrets
- Do not paste Client Secret in PRs or chat
