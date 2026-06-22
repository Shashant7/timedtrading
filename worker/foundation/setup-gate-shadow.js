// worker/foundation/setup-gate-shadow.js
// -----------------------------------------------------------------------------
// Shadow gate evaluation on scored payloads — read-only, no entry gating.
// Evaluates confirm-stack presets over the setup_events lookback window.
// Gated by SETUP_GATE_SHADOW (explicit opt-in; preprod + tt-engine).
// -----------------------------------------------------------------------------

import { buildDiagnosticsContext } from "./setup-diagnostics-route.js";
import {
  diagnosticsForEventWindow,
  evaluateGateOnProfile,
  extractPatternProfile,
  gatePresetByKey,
} from "./setup-replay-mining.js";

export const DEFAULT_GATE_SHADOW_KEYS = Object.freeze([
  "stack_full_confirm",
  "gate_runway_full",
]);

/** 120h — matches gate simulation default lookback. */
export const DEFAULT_GATE_LOOKBACK_MS = 120 * 60 * 60 * 1000;

export function setupGateShadowEnabled(env) {
  const v = env?.SETUP_GATE_SHADOW;
  if (v === "0" || v === 0 || v === false) return false;
  return v === "1" || v === 1 || v === true || String(v).toLowerCase() === "true";
}

export function inferDirectionFromPayload(payload = {}) {
  const dir = String(payload?.trigger_dir || payload?.direction || "").toUpperCase();
  if (dir === "LONG" || dir === "SHORT") return dir;
  const state = String(payload?.state || "").toUpperCase();
  if (state.includes("SHORT") || state === "BEAR") return "SHORT";
  if (state.includes("LONG") || state === "BULL") return "LONG";
  return null;
}

export function deriveSetupGateShadowFromEvents(events = [], payload = {}, opts = {}) {
  const now = Number(payload?.ts || payload?.ingest_ts || Date.now());
  const lookbackMs = Number.isFinite(Number(opts.lookbackMs))
    ? Number(opts.lookbackMs)
    : DEFAULT_GATE_LOOKBACK_MS;
  const gateKeys = Array.isArray(opts.gateKeys) && opts.gateKeys.length
    ? opts.gateKeys
    : DEFAULT_GATE_SHADOW_KEYS;

  const diag = diagnosticsForEventWindow(events, now, {
    preEntryMs: lookbackMs,
    ticker: String(opts.ticker || payload?.ticker || "").toUpperCase(),
    context: buildDiagnosticsContext(payload, opts.env || {}),
  });

  const moveDir = inferDirectionFromPayload(payload);
  const profile = diag.ok
    ? extractPatternProfile(diag, { moveDir })
    : extractPatternProfile({ events: [], sequences: [] }, { moveDir });

  const gates = {};
  for (const key of gateKeys) {
    const preset = gatePresetByKey(key);
    gates[key] = {
      fires: evaluateGateOnProfile(profile, key),
      label: preset?.label || key,
    };
  }

  return {
    setup_gate_shadow: true,
    setup_gates: gates,
    setup_gate_lookback_hours: Math.round(lookbackMs / (60 * 60 * 1000)),
    setup_gate_event_count: Array.isArray(events) ? events.length : 0,
    setup_gate_as_of_ts: now,
  };
}

export function applySetupGateShadowFields(payload = {}, fields = null) {
  if (!payload || !fields) return payload;
  return { ...payload, ...fields };
}

export async function maybeStampSetupGateShadowOnPayload(env, ticker, payload = {}, opts = {}) {
  if (!setupGateShadowEnabled(env)) {
    return { ok: true, skipped: true, reason: "gate_shadow_disabled" };
  }
  const events = opts.events;
  if (!Array.isArray(events)) {
    return { ok: true, skipped: true, reason: "no_events_provided" };
  }
  try {
    const fields = deriveSetupGateShadowFromEvents(events, payload, {
      env,
      ticker,
      lookbackMs: opts.lookbackMs,
      gateKeys: opts.gateKeys,
    });
    return {
      ok: true,
      fields,
      payload: applySetupGateShadowFields(payload, fields),
    };
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: "gate_shadow_error",
      error: String(err?.message || err).slice(0, 200),
    };
  }
}
