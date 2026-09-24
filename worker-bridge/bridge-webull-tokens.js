// worker-bridge/bridge-webull-tokens.js
//
// 2026-06-15 — Proactive Webull access-token refresh (30-min TTL).

import { listConnectedUsers } from "./bridge-storage.js";
import { ensureWebullAccessToken } from "./bridge-webull-api.js";
import { webullLiveEnabled } from "./bridge-webull-config.js";

const REFRESH_CONCURRENCY = 10;

/**
 * Walk connected Webull users and refresh tokens nearing expiry.
 * Called from bridge-index scheduled() on the 5-min cron.
 *
 * Every account, not the first 50 rows: a token this cron never reaches
 * lives only on the lazy refresh inside an order, which is the one moment
 * an expired token costs a fill. `ensureWebullAccessToken` is a no-op until
 * a token nears expiry, so reading every row is cheap; the refreshes that
 * do call the broker run a few at a time so a 30-minute token life across
 * thousands of accounts fits inside one cron invocation.
 */
export async function refreshWebullTokensIfNeeded(env, { limit } = {}) {
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

  const refreshOne = async (user) => {
    try {
      const before = Number(user.webull_token_expires_at) || 0;
      const res = await ensureWebullAccessToken(env, user);
      if (!res.ok) {
        failed++;
        console.warn(`[WEBULL/REFRESH] ${user.user_id} failed: ${res.error}`);
        return;
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
  };

  // Rows for the same broker account stay serial. Two user rows can point at
  // one Webull account (the bare operator email and its `#webull#roth-ira`
  // row both do), and refreshing both at once could spend one rotating
  // refresh token twice.
  const groups = new Map();
  for (const u of webullUsers) {
    const key = String(u.webull_account_id || u.user_id || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  const lanes = [...groups.values()];
  for (let i = 0; i < lanes.length; i += REFRESH_CONCURRENCY) {
    await Promise.all(lanes.slice(i, i + REFRESH_CONCURRENCY).map(async (rows) => {
      for (const u of rows) await refreshOne(u);
    }));
  }

  return { ok: true, refreshed, failed, unchanged, total: webullUsers.length };
}
