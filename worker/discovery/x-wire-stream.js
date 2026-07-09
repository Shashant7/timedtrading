// worker/discovery/x-wire-stream.js
//
// X API v2 Filtered Stream client for @DeItaone (Delta One).
// Push delivery (~$0.005/post) replaces aggressive timeline polling when
// the DeltaOneStream Durable Object holds the connection open.

import { DELTA_ONE_HANDLE } from "./x-wire-tracker.js";

const X_API_BASE = "https://api.x.com/2";
const RULES_TIMEOUT_MS = 15_000;

/** Filtered stream rule — Delta One originals only (no retweets). */
export const DELTA_ONE_STREAM_RULE = `from:${DELTA_ONE_HANDLE} -is:retweet`;
export const DELTA_ONE_STREAM_TAG = "delta_one";

const STREAM_PARAMS = new URLSearchParams({
  "tweet.fields": "created_at,text,author_id",
  expansions: "author_id",
  "user.fields": "username",
});

export function buildFilteredStreamUrl() {
  return `${X_API_BASE}/tweets/search/stream?${STREAM_PARAMS}`;
}

/** Parse one NDJSON line from the filtered stream. Returns tweet payload or null. */
export function parseStreamLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  try {
    const msg = JSON.parse(trimmed);
    if (msg?.errors?.length) {
      return { type: "error", errors: msg.errors };
    }
    const tw = msg?.data;
    if (!tw?.id || !tw?.text) return null;
    return {
      type: "tweet",
      tweet: {
        id: String(tw.id),
        text: String(tw.text).trim(),
        created_at: tw.created_at || null,
        author_id: tw.author_id ? String(tw.author_id) : null,
      },
      matching_rules: msg.matching_rules || [],
    };
  } catch (_) {
    return null;
  }
}

async function xJsonFetch(url, token, opts = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), opts.timeoutMs || RULES_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: opts.method || "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: json?.detail || json?.title || json?.errors?.[0]?.message || `x_${resp.status}`,
        json,
      };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(tid);
  }
}

/** Ensure the Delta One filtered-stream rule exists (idempotent). */
export async function ensureDeltaOneStreamRules(token) {
  if (!token) return { ok: false, error: "no_token" };

  const listUrl = `${X_API_BASE}/tweets/search/stream/rules`;
  const existing = await xJsonFetch(listUrl, token);
  if (!existing.ok) return existing;

  const rules = Array.isArray(existing.json?.data) ? existing.json.data : [];
  const hasRule = rules.some(
    (r) => r.tag === DELTA_ONE_STREAM_TAG
      || String(r.value || "").toLowerCase().includes(DELTA_ONE_HANDLE.toLowerCase()),
  );
  if (hasRule) {
    return { ok: true, added: 0, rule_count: rules.length };
  }

  const add = await xJsonFetch(listUrl, token, {
    method: "POST",
    body: {
      add: [{ value: DELTA_ONE_STREAM_RULE, tag: DELTA_ONE_STREAM_TAG }],
    },
  });
  if (!add.ok) return add;
  return {
    ok: true,
    added: 1,
    rule_count: (add.json?.meta?.summary?.created || 0) + rules.length,
  };
}

/** Open the filtered stream (caller reads resp.body as NDJSON). Long-lived — no fetch timeout. */
export async function connectFilteredStream(token, signal) {
  if (!token) return { ok: false, error: "no_token" };

  const rules = await ensureDeltaOneStreamRules(token);
  if (!rules.ok) return rules;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const resp = await fetch(buildFilteredStreamUrl(), {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => null);
      return {
        ok: false,
        status: resp.status,
        error: json?.detail || json?.title || `stream_${resp.status}`,
      };
    }
    return { ok: true, response: resp, rules };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
