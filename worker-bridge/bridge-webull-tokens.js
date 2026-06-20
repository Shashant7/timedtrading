// worker-bridge/bridge-webull-tokens.js
//
// 2026-06-15 — Proactive Webull access-token refresh (30-min TTL).

import { listConnectedUsers } from "./bridge-storage.js";
import { ensureWebullAccessToken } from "./bridge-webull-api.js";
import { webullLiveEnabled } from "./bridge-webull-config.js";

/**
 * Walk connected Webull users and refresh tokens nearing expiry.
 * Called from bridge-index scheduled() on the 5-min cron.
 */
export async function refreshWebullTokensIfNeeded(env, { limit = 50 } = {}) {
  if (!webullLiveEnabled(env)) {
    return { ok: true, skipped: "mock_or_not_configured", refreshed: 0, failed: 0 };
  }

  const users = await listConnectedUsers(env, limit);
  const webullUsers = users.filter((u) =>
    u && u.status === "connected" && String(u.broker || "").toLowerCase() === "webull",
  );

  let refreshed = 0;
  let failed = 0;
  let unchanged = 0;

  for (const user of webullUsers) {
    try {
      const before = Number(user.webull_token_expires_at) || 0;
      const res = await ensureWebullAccessToken(env, user);
      if (!res.ok) {
        failed++;
        console.warn(`[WEBULL/REFRESH] ${user.user_id} failed: ${res.error}`);
        continue;
      }
      if (res.refreshed || (Number(res.user?.webull_token_expires_at) || 0) > before) {
        refreshed++;
      } else {
        unchanged++;
      }
    } catch (e) {
      failed++;
      console.warn(`[WEBULL/REFRESH] ${user?.user_id} exception:`, String(e?.message || e).slice(0, 200));
    }
  }

  return { ok: true, refreshed, failed, unchanged, total: webullUsers.length };
}
