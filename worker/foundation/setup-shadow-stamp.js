// worker/foundation/setup-shadow-stamp.js
// -----------------------------------------------------------------------------
// Stamp compact setup sequence shadow fields onto scored ticker payloads.
// Read-only for entry — gated by SETUP_SHADOW_STAMP (defaults on when
// SETUP_EVENTS_WRITE=1). Sequences derive from D1 setup_events ledger.
// -----------------------------------------------------------------------------

import { detectMeanReversionSequences } from "./setup-sequences.js";
import { buildDiagnosticsContext, summarizeTraderPosture } from "./setup-diagnostics-route.js";
import { loadSetupEvents, setupEventsWriteEnabled } from "./setup-events-store.js";
import {
  DEFAULT_GATE_LOOKBACK_MS,
  deriveSetupGateShadowFromEvents,
  setupGateShadowEnabled,
} from "./setup-gate-shadow.js";

const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export function setupShadowStampEnabled(env) {
  const explicit = env?.SETUP_SHADOW_STAMP;
  if (explicit === "0" || explicit === 0 || explicit === false) return false;
  if (explicit === "1" || explicit === 1 || explicit === true) return true;
  return setupEventsWriteEnabled(env);
}

export function compactSequenceForPayload(seq = {}) {
  return {
    sequence_id: seq.sequence_id || null,
    sequence_type: seq.sequence_type || null,
    direction: seq.direction || null,
    stage: Number(seq.stage) || 0,
    status: seq.status || null,
    posture: seq.posture || null,
    confidence: Number.isFinite(Number(seq.confidence)) ? Number(seq.confidence) : null,
  };
}

export function deriveSetupShadowFromEvents(events = [], payload = {}, opts = {}) {
  const ticker = String(opts.ticker || payload?.ticker || "").toUpperCase();
  if (!events.length) return null;

  const context = buildDiagnosticsContext(payload, opts.env || {});
  const sequences = detectMeanReversionSequences(events, {
    ticker,
    context,
    includeEmpty: false,
  });
  const active = (sequences || []).filter((s) => Number(s.stage) > 0 && s.status !== "invalidated");
  const traderPosture = summarizeTraderPosture(sequences, opts.postureOpts || {});
  const now = Number(payload?.ts || payload?.ingest_ts || Date.now());

  return {
    setup_shadow: true,
    setup_sequences: active.slice(0, 6).map(compactSequenceForPayload),
    setup_shadow_posture: traderPosture,
    setup_shadow_event_count: events.length,
    setup_shadow_as_of_ts: now,
  };
}

export async function loadSetupShadowFields(env, ticker, payload = {}, opts = {}) {
  const shadowOn = setupShadowStampEnabled(env);
  const gateOn = setupGateShadowEnabled(env);
  if (!shadowOn && !gateOn) {
    return { ok: true, skipped: true, reason: "stamp_disabled" };
  }
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db" };

  const sym = String(ticker || payload?.ticker || "").toUpperCase();
  if (!sym) return { ok: false, skipped: true, reason: "no_ticker" };

  const gateLookbackMs = Number.isFinite(Number(opts.gateLookbackMs))
    ? Number(opts.gateLookbackMs)
    : DEFAULT_GATE_LOOKBACK_MS;
  const shadowLookbackMs = Number.isFinite(Number(opts.lookbackMs))
    ? Number(opts.lookbackMs)
    : DEFAULT_LOOKBACK_MS;
  const lookbackMs = Math.max(
    shadowOn ? shadowLookbackMs : 0,
    gateOn ? gateLookbackMs : 0,
  );
  const now = Number(payload?.ts || payload?.ingest_ts || Date.now());
  const events = await loadSetupEvents(db, {
    ticker: sym,
    since: now - lookbackMs,
    until: now + 60000,
    limit: Math.max(50, Math.min(5000, Number(opts.limit) || 500)),
  });

  const shadowFields = shadowOn
    ? deriveSetupShadowFromEvents(events, { ...payload, ticker: sym }, {
      env,
      ticker: sym,
      postureOpts: opts.postureOpts,
    })
    : null;
  if (!shadowFields && !gateOn) {
    return { ok: true, skipped: true, reason: "no_events", event_count: 0 };
  }

  let fields = shadowFields || {};
  if (gateOn) {
    fields = {
      ...fields,
      ...deriveSetupGateShadowFromEvents(events, { ...payload, ticker: sym }, {
        env,
        ticker: sym,
        lookbackMs: gateLookbackMs,
        gateKeys: opts.gateKeys,
      }),
    };
  }

  if (!Object.keys(fields).length) {
    return { ok: true, skipped: true, reason: "no_events", event_count: 0 };
  }
  return { ok: true, fields, event_count: events.length };
}

export function applySetupShadowFields(payload = {}, fields = null) {
  if (!payload || !fields) return payload;
  return {
    ...payload,
    ...fields,
  };
}

export async function maybeStampSetupShadowOnPayload(env, ticker, payload = {}, opts = {}) {
  try {
    const result = await loadSetupShadowFields(env, ticker, payload, opts);
    if (!result.ok || result.skipped || !result.fields) return result;
    return {
      ...result,
      payload: applySetupShadowFields(payload, result.fields),
    };
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: "stamp_error",
      error: String(err?.message || err).slice(0, 200),
    };
  }
}
