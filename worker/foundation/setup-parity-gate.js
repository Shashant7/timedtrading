// worker/foundation/setup-parity-gate.js
// -----------------------------------------------------------------------------
// Shadow parity gate: live setup_events vs re-derived events from payloads.
// Fixture parity runs offline via scripts/run-setup-parity-gate.mjs.
// -----------------------------------------------------------------------------

import { eventsFromSnapshotPair } from "./setup-events-store.js";
import { buildSequenceTrailSnapshot } from "./sequence-snapshot.js";

export const PARITY_FIXTURE_TICKERS = Object.freeze([
  "SPY", "QQQ", "IWM", "USO", "GLD", "XLE", "NVDA", "TSLA",
]);

export function compareEventSets(liveEvents = [], derivedEvents = []) {
  const key = (ev) => `${ev.event_type}|${ev.tf}|${ev.direction}|${ev.event_ts}`;
  const liveSet = new Set(liveEvents.map(key));
  const derivedSet = new Set(derivedEvents.map(key));
  const missing_in_live = [...derivedSet].filter((k) => !liveSet.has(k));
  const extra_in_live = [...liveSet].filter((k) => !derivedSet.has(k));
  return {
    live_count: liveEvents.length,
    derived_count: derivedEvents.length,
    matched: liveEvents.filter((ev) => derivedSet.has(key(ev))).length,
    missing_in_live,
    extra_in_live,
    ok: missing_in_live.length === 0 && extra_in_live.length === 0,
  };
}

export async function runLiveSetupParityGate(env, opts = {}) {
  const db = env?.DB;
  const tickers = opts.tickers || PARITY_FIXTURE_TICKERS;
  const sinceMs = Number(opts.sinceMs) || (15 * 60 * 1000);
  const since = Date.now() - sinceMs;
  const items = [];

  for (const ticker of tickers) {
    const sym = String(ticker).toUpperCase();
    let current = null;
    let prev = null;

    const trailRows = await db?.prepare(
      `SELECT ts, payload_json FROM timed_trail
       WHERE ticker = ?1 AND payload_json IS NOT NULL AND ts >= ?2
       ORDER BY ts DESC LIMIT 2`,
    ).bind(sym, since).all();
    const parsed = (trailRows?.results || [])
      .map((r) => {
        try { return JSON.parse(r.payload_json); } catch { return null; }
      })
      .filter(Boolean);

    if (parsed.length >= 2) {
      current = buildSequenceTrailSnapshot(parsed[0]) || parsed[0];
      prev = buildSequenceTrailSnapshot(parsed[1]) || parsed[1];
    } else {
      try {
        const row = await db.prepare(
          `SELECT payload_json FROM ticker_latest WHERE ticker = ?1`,
        ).bind(sym).first();
        if (row?.payload_json) current = JSON.parse(row.payload_json);
      } catch { /* defensive */ }
    }

    if (!current) {
      items.push({ ticker: sym, ok: false, reason: "no_payload" });
      continue;
    }

    const derived = eventsFromSnapshotPair(prev, current, { source: "parity_gate_rederive" });
    let live = [];
    try {
      const res = await db.prepare(
        `SELECT event_type, tf, direction, event_ts FROM setup_events
         WHERE ticker = ?1 AND event_ts >= ?2 ORDER BY event_ts ASC LIMIT 200`,
      ).bind(sym, since).all();
      live = (res?.results || []).map((row) => ({
        event_type: row.event_type,
        tf: row.tf,
        direction: row.direction,
        event_ts: Number(row.event_ts),
      }));
    } catch { /* empty */ }

    const cmp = compareEventSets(live, derived);
    items.push({
      ticker: sym,
      ok: cmp.ok || (derived.length === 0 && live.length === 0),
      ...cmp,
      trail_snapshot_pairs: parsed.length,
    });
  }

  const passed = items.filter((i) => i.ok).length;
  return {
    ok: items.length > 0 && passed === items.length,
    tickers_checked: items.length,
    tickers_passed: passed,
    since_ts: since,
    items,
    promotion_safe: false,
    note: "Requires SETUP_TRAIL_SNAPSHOT + two consecutive */5 trail rows per ticker for full pair diff.",
  };
}

export async function handleSetupParityGateRoute(_req, env, url, corsHeaders) {
  const tickersParam = url.searchParams.get("tickers");
  const tickers = tickersParam
    ? tickersParam.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    : PARITY_FIXTURE_TICKERS;

  const liveGate = await runLiveSetupParityGate(env, {
    tickers,
    sinceMs: Number(url.searchParams.get("sinceMs")) || undefined,
  });

  const body = {
    ok: liveGate.ok,
    shadow: true,
    live_gate: liveGate,
    write_enabled: String(env?.SETUP_EVENTS_WRITE || "") === "1",
    trail_snapshot_enabled: String(env?.SETUP_TRAIL_SNAPSHOT || env?.SETUP_EVENTS_WRITE || "") === "1",
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(corsHeaders || {}) },
  });
}
