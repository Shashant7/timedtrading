/**
 * worker/replay-kv-snapshot.js
 *
 * Phase 3.9 (2026-05-10) — Replay KV snapshot helper.
 *
 * Problem this solves
 * -------------------
 * The replay/scoring path reads a number of KV namespaces that are not
 * day-keyed and that get mutated continuously by live cron:
 *
 *   timed:capture:latest:$INDICATOR
 *   timed:capture:trail:$INDICATOR
 *   timed:latest:$TICKER
 *   timed:context:$TICKER
 *   timed:profile:$TICKER
 *   timed:sector_map:$TICKER
 *   phase-c:setup-admission
 *   phase-c:exit-doctrine
 *
 * When a replay reads these, it sees "now" state, not the state that was
 * present on the simulated date. Two consequences:
 *   - replays drift over time as live cron rewrites those keys
 *   - reproducing a canonical run requires the exact KV state at the
 *     moment that run originally executed, which is generally lost
 *
 * This module provides a thin wrapper around `env.KV_TIMED.get(key, type)`
 * that lives in one of three modes:
 *
 *   "passthrough" — behaves identically to a direct KV.get. The default
 *                   for production / live cron.
 *   "capture"     — passes through to live KV, but ALSO records the
 *                   (key, value) pair into `replayCtx.kvCapture`. The
 *                   caller persists this map into the per-session
 *                   day-state blob at end of session.
 *   "replay"      — serves the value from `replayCtx.kvSnapshot` if
 *                   present; falls back to live KV with a warn.
 *
 * Wiring
 * ------
 * 1. The replay loader (`loadReplayRuntimeConfig`) pulls `kv_reads`
 *    off the day-state blob and exposes it on `replayCtx.kvSnapshot`.
 * 2. Every scoring call site that previously called `KV.get(...)` now
 *    calls `getReplayKv(env, replayCtx, key, type)`.
 * 3. Capture-mode runs accumulate writes into `replayCtx.kvCapture`,
 *    which the day-state writer merges back into the blob.
 *
 * Mode resolution
 * ---------------
 * Mode is chosen from env + replayCtx at every call. Order of precedence:
 *
 *   - If env.USE_REPLAY_KV_SNAPSHOT is not "true": always "passthrough".
 *   - Else if replayCtx.kvCaptureEnabled === true: "capture".
 *   - Else if replayCtx.kvSnapshot is a non-empty object: "replay".
 *   - Else: "passthrough" (no snapshot to read from yet).
 *
 * This means the same worker code is safe to deploy to live (where
 * USE_REPLAY_KV_SNAPSHOT is absent/false → always passthrough) and to
 * preprod (where USE_REPLAY_KV_SNAPSHOT="true" + a populated kvSnapshot
 * → replay reads from snapshot).
 *
 * Capture-mode policy
 * -------------------
 * Capture mode currently records ANY key the caller reads through this
 * helper. The caller is expected to use this helper only for keys that
 * are time-sensitive and contribute to scoring/entry decisions. Static
 * config keys that don't drift over time (e.g. CORS settings) should
 * not go through this helper.
 *
 * Cross-references
 * ----------------
 * tasks/phase-c/PREPROD_FIDELITY_2026-05-10.md
 * tasks/phase-c/PREPROD_KV_SNAPSHOT_2026-05-10.md (this PR)
 */

const ENV_FLAG = "USE_REPLAY_KV_SNAPSHOT";

function resolveMode(env, replayCtx) {
  if (String(env?.[ENV_FLAG] || "").trim().toLowerCase() !== "true") {
    return "passthrough";
  }
  if (replayCtx?.kvCaptureEnabled === true) {
    return "capture";
  }
  const snap = replayCtx?.kvSnapshot;
  if (snap && typeof snap === "object" && Object.keys(snap).length > 0) {
    return "replay";
  }
  return "passthrough";
}

function decodeStoredValue(stored, type) {
  if (stored === null || stored === undefined) return null;
  if (type === "json" || (type && type.type === "json")) {
    if (typeof stored === "string") {
      try { return JSON.parse(stored); } catch { return null; }
    }
    return stored;
  }
  if (type === "arrayBuffer" || type === "stream") {
    // We don't support binary capture; force passthrough.
    return stored;
  }
  return stored;
}

function encodeForStorage(value) {
  if (value === null || value === undefined) return null;
  // Capture as raw value; JSON serialization happens when the day-state
  // is written. Strings and primitives are stored as-is. Buffers
  // currently bypass capture (callers using arrayBuffer mode should not
  // route through this helper).
  return value;
}

/**
 * Replacement for KV.get(key, type) when reading values that contribute
 * to replay scoring decisions. See module docstring for mode semantics.
 *
 * @param {object} env       — worker env (used to read USE_REPLAY_KV_SNAPSHOT)
 * @param {object} replayCtx — the replay context object that loadReplayRuntimeConfig builds
 * @param {string} key       — KV key
 * @param {string|object} [type] — pass-through to env.KV_TIMED.get (e.g. "json", { type: "json" })
 * @returns {Promise<any>}
 */
export async function getReplayKv(env, replayCtx, key, type) {
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  if (!key) return null;

  const mode = resolveMode(env, replayCtx);

  if (mode === "passthrough") {
    return KV.get(key, type);
  }

  if (mode === "replay") {
    const snap = replayCtx.kvSnapshot;
    if (Object.prototype.hasOwnProperty.call(snap, key)) {
      const stored = snap[key];
      return decodeStoredValue(stored, type);
    }
    // Not in snapshot — fall back to live KV. Log once per missing key
    // for visibility.
    if (replayCtx._kvSnapshotMisses == null) {
      replayCtx._kvSnapshotMisses = new Set();
    }
    if (!replayCtx._kvSnapshotMisses.has(key)) {
      replayCtx._kvSnapshotMisses.add(key);
      console.warn(
        `[replay-kv-snapshot] miss key=${String(key).slice(0, 120)} (falling back to live KV; capture run missed this read)`
      );
    }
    return KV.get(key, type);
  }

  // capture: read from live KV, also stash on replayCtx for persistence
  const value = await KV.get(key, type);
  if (!replayCtx.kvCapture || typeof replayCtx.kvCapture !== "object") {
    replayCtx.kvCapture = {};
  }
  // We always re-stash on every read; for deterministic capture we want
  // the LAST observed value within the session.
  replayCtx.kvCapture[key] = encodeForStorage(value);
  return value;
}

/**
 * Helper for callers that want a JSON value specifically. Equivalent to
 * `await getReplayKv(env, replayCtx, key, "json")`. Returns null if the
 * underlying value is missing or not parseable.
 */
export async function getReplayKvJson(env, replayCtx, key) {
  return getReplayKv(env, replayCtx, key, "json");
}

/**
 * Inspect the current mode for diagnostics. Useful in tests + logs.
 */
export function describeReplayKvMode(env, replayCtx) {
  const mode = resolveMode(env, replayCtx);
  const flag = String(env?.[ENV_FLAG] || "").trim().toLowerCase();
  const snapSize = replayCtx?.kvSnapshot ? Object.keys(replayCtx.kvSnapshot).length : 0;
  const capSize = replayCtx?.kvCapture ? Object.keys(replayCtx.kvCapture).length : 0;
  return {
    mode,
    env_flag: flag,
    snapshot_keys: snapSize,
    capture_keys: capSize,
  };
}

/**
 * Convenience: produce the JSON-serializable representation of the captured
 * map. Used by the day-state writer.
 */
export function exportCapturedKv(replayCtx) {
  if (!replayCtx?.kvCapture) return null;
  return { ...replayCtx.kvCapture };
}

/**
 * Convenience: hydrate a kvSnapshot from a day-state blob's `kv_reads`
 * field. Idempotent; safe to call with null/undefined.
 */
export function hydrateKvSnapshotFromDaystate(replayCtx, daystateBlob) {
  if (!replayCtx) return;
  const reads = daystateBlob?.kv_reads;
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) {
    return;
  }
  replayCtx.kvSnapshot = { ...reads };
}
