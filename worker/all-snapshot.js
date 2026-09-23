// worker/all-snapshot.js
//
// `timed:all:snapshot` — the pre-assembled universe index.
//
// ── Why this file exists ────────────────────────────────────────────────
//
// The snapshot used to hold the FULL scoring payload for every ticker. That
// worked at 140 tickers and stopped working somewhere around 255, for two
// reasons that both have hard limits behind them:
//
//   1. A KV value cannot exceed 25 MiB (26,214,400 bytes). On 2026-08-14 the
//      blob reached 26,195,645 bytes — 18,755 bytes of headroom — and every
//      write after that was rejected. The snapshot then sat frozen for 40
//      days while the cron kept "succeeding": `built_at` stayed
//      2026-08-14T08:03:11Z with NVDA at $225.30. Readers with a freshness
//      gate quietly fell through to D1; readers without one served 40-day-old
//      scores.
//   2. A Worker isolate cannot exceed 128 MB. Measured on the real 255-ticker
//      blob, ONE build cost 182 MB: 37.7 MB for the assembled object graph,
//      36.7 MB for the payloads read to fill it, and 57.7 MB for the
//      JSON.stringify needed to put it. tt-engine's */5 scoring tick ended in
//      `exceededMemory` every pass, which is what killed the trader-ENTRY
//      dispatch tail.
//
// At today's 330 tickers a full snapshot is 29.9 MB of JSON. It does not fit
// and never will again — the universe outgrew the key. So the snapshot is now
// a SLIM INDEX: enough per ticker to rank, filter, route and render a card,
// and nothing that belongs to a detail view.
//
// Callers that need a full payload ask for a BOUNDED set of tickers via
// `hydrateSnapshotRows`, which reads `timed:latest:<SYM>` per ticker. Every
// such caller already narrows to a handful (the options lanes to 4 index
// tickers, the convexity scanner to its top 20), so this is cheaper than the
// blob it replaces — it just has to be asked for explicitly.

export const ALL_SNAPSHOT_KEY = "timed:all:snapshot";

/**
 * Bump when the projection changes shape. Readers that need full payloads
 * check this instead of guessing from the fields they happen to find, so an
 * old full blob left in KV is still served correctly until it ages out.
 */
export const ALL_SNAPSHOT_SCHEMA = "slim-v1";

/**
 * Hard ceiling for the serialized value, well under KV's 26,214,400 so the
 * universe can keep growing without anyone having to notice. The projection
 * below measures ~1.1 MB at 330 tickers, so this is ~10x headroom rather
 * than a limit anything is expected to reach.
 */
export const ALL_SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Fields the slim index carries.
 *
 * The first block is the projection `/timed/all?slim=1` has served in
 * production for months, so it is known to be sufficient for the cards, the
 * right rail header, the movers bar and the table view. The rest is what the
 * non-`/timed/all` readers select on: rank and entry quality for candidate
 * ranking, stage/state/direction for routing, and the session scalars the
 * futures-pairs lane pulls.
 *
 * Anything NOT here is a detail-view field — `tf_tech`, `_tickerProfile`,
 * `_journey`, `atr_levels`, `regime_forecast`, `move_phase_profile`,
 * `td_sequential`, `confluence_verdict`, `__entry_setup_snapshot` — which
 * between them are 60% of a payload's bytes and are read one ticker at a
 * time anyway.
 */
export const ALL_SNAPSHOT_FIELDS = [
  // ── the proven ?slim=1 projection ──
  "ticker", "price", "prev_close",
  "day_change_pct", "day_change", "change_pct", "change",
  "_ah_change_pct", "_ah_change", "_ah_price",
  "kanban_stage", "direction",
  "investor_stage", "investor_score",
  "_sparkline", "_display_name", "_company_name",
  "__execution_ready", "__execution_block_reason",
  // ── freshness ──
  "ts", "ingest_ts", "ingest_time", "data_source",
  // ── ranking / selection ──
  "rank", "score", "eqScore", "eq_score", "dynamicScore",
  "htf_score", "ltf_score", "completion", "phase_pct", "saty_phase_pct",
  "entry_quality_score",
  // ── routing / state ──
  "state", "prev_kanban_stage", "move_status", "bias_direction",
  "trigger_ts", "trigger_dir", "trigger_reason", "trigger_price",
  "sl", "tp", "rr", "entry_ts", "entry_price",
  // ── session scalars (futures-pairs, movers) ──
  "close", "open", "dayOpen", "high", "low", "volume",
  "previous_close", "prior_close", "is_rth", "session",
  "_live_price", "_price_updated_at",
  // ── cron-side enrichment ──
  "sector", "_runtime_sector", "_alignment", "_last_trail_ts",
  // ── thin-slice detection, for the Today queue / Cloud Pivot desk ──
  // These are selection criteria, so they have to be scannable across the
  // whole universe. Measured on live payloads they are ~2.2 KB per ticker
  // all together (flags 450 B, _model_lifecycle 450 B, _cloud_pivot_detect
  // 500 B, _sequence_queue_proposal 400 B, _continuation_detect 180 B,
  // setup_gates 175 B) against a tf_tech that is 27 KB on its own.
  "flags", "setup_gates", "_model_lifecycle", "_sequence_queue_proposal",
  "_cloud_pivot_detect", "_continuation_detect",
  "tt_cloud_pivot", "momentum_continuation", "__pullback_confirmed",
  "_model_play", "instrument_type",
  // ── the rest of what `extractSliceFields` reads ──
  // Adding these means /timed/plays/today is satisfied by the index alone
  // and never has to hydrate. Measured per ticker: setup_shadow_posture
  // ~700 B, _business_character ~600 B, setup_sequences ~420 B,
  // setup_shadow_business_character ~200 B, _cloud_magnet 164 B.
  "setup_sequences", "setup_shadow_posture", "setup_gate_shadow",
  "_business_character", "business_character", "setup_shadow_business_character",
  "__conviction_tier", "conviction_tier", "__conviction_score", "conviction_score",
  "confluence_mode", "_confluence", "confluence",
  "setup_name", "entry_path", "slice_family",
  "_cloud_magnet", "_cloud_session_plan", "_cloud_leader", "_cloud_leader_follow",
];

const FIELD_SET = new Set(ALL_SNAPSHOT_FIELDS);

/**
 * `entry_quality` is an object whose only field anyone selects on is
 * `.score`, and it drags a `reasons` array with it. Flatten it to a scalar
 * and keep a tiny stand-in so `t?.entry_quality?.score` still resolves for
 * callers that read it that way.
 */
function projectEntryQuality(payload, row) {
  const score = Number(payload?.entry_quality?.score ?? payload?.entry_quality_score);
  if (!Number.isFinite(score)) return;
  row.entry_quality_score = score;
  row.entry_quality = { score };
}

/**
 * One slim row. Only fields actually present are copied, so the row stays
 * small for a ticker that has barely scored.
 */
export function projectAllSnapshotRow(sym, payload) {
  if (!payload || typeof payload !== "object") return null;
  const row = {};
  for (const k of ALL_SNAPSHOT_FIELDS) {
    const v = payload[k];
    if (v !== undefined) row[k] = v;
  }
  projectEntryQuality(payload, row);
  if (!row.ticker) row.ticker = String(sym || "").toUpperCase();
  return row;
}

/** Is this field carried by the slim index at all? */
export function isAllSnapshotField(name) {
  return FIELD_SET.has(String(name));
}

/**
 * Fields the snapshot build ADDS to a row that are not in the stored
 * payload: the live-price overlay, the sparkline, the calibration alignment,
 * the investor stage and the runtime sector.
 *
 * The D1 `ticker_latest` sync used to inherit these for free because it read
 * the same in-memory objects the enrichment had just mutated. It now reads
 * payloads back from KV, so it has to be handed the enrichment explicitly —
 * otherwise D1 would quietly go back to serving the scoring-time price.
 */
export const ALL_SNAPSHOT_ENRICHED_FIELDS = [
  "sector", "_runtime_sector", "_sparkline", "_alignment",
  "price", "close", "prev_close", "day_change", "day_change_pct",
  "_price_updated_at", "investor_stage", "investor_score",
  "_cloud_leader", "_cloud_leader_follow",
];

/** Copy the build's enrichment from a slim row onto a full payload. */
export function applySnapshotEnrichment(payload, row) {
  if (!payload || typeof payload !== "object" || !row) return payload;
  for (const k of ALL_SNAPSHOT_ENRICHED_FIELDS) {
    if (row[k] !== undefined) payload[k] = row[k];
  }
  return payload;
}

/**
 * Keep a patch to the slim index slim. Thin-slice / shadow stamps are built
 * for the full payload, and most of their fields are detail-view fields; if
 * they were assigned wholesale the index would grow back toward the ceiling
 * one stamp at a time.
 */
export function projectSnapshotPatch(patch) {
  if (!patch || typeof patch !== "object") return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (FIELD_SET.has(k)) { out[k] = v; n++; }
  }
  return n > 0 ? out : null;
}

/**
 * Build the slim index by reading ONE payload at a time.
 *
 * The point of the generator shape is that no full payload outlives the
 * iteration that produced it: `readPayload` hands one over, it is projected,
 * and it becomes garbage before the next read. Peak retention is the slim
 * index plus a single payload, which is why this can run inside the
 * five-minute scoring tick that used to die.
 *
 * `byteBudget` is checked as rows accumulate rather than after, so a runaway
 * universe degrades (oldest-scored tickers omitted) instead of failing the
 * write outright and freezing the snapshot again.
 */
export async function buildAllSnapshot(syms, readPayload, {
  byteBudget = ALL_SNAPSHOT_MAX_BYTES,
  onRow = null,
} = {}) {
  const data = {};
  let bytes = 2;
  let count = 0;
  let omitted = 0;
  for (const raw of syms || []) {
    const sym = String(raw || "").toUpperCase();
    if (!sym || data[sym]) continue;
    let payload = null;
    try {
      payload = await readPayload(sym);
    } catch (_) {
      payload = null;
    }
    if (!payload || typeof payload !== "object") continue;
    const row = projectAllSnapshotRow(sym, payload);
    if (!row) continue;
    if (onRow) {
      try { onRow(sym, row, payload); } catch (_) { /* enrichment is optional */ }
    }
    let rowBytes = 0;
    try {
      rowBytes = JSON.stringify(row).length + sym.length + 4;
    } catch (_) {
      continue;
    }
    if (bytes + rowBytes > byteBudget) {
      omitted++;
      continue;
    }
    bytes += rowBytes;
    data[sym] = row;
    count++;
  }
  return { data, count, bytes, omitted };
}

/** The envelope written to KV. */
export function allSnapshotEnvelope({ data, count, bytes, omitted } = {}) {
  const out = {
    data: data || {},
    count: count ?? Object.keys(data || {}).length,
    built_at: Date.now(),
    schema: ALL_SNAPSHOT_SCHEMA,
  };
  if (bytes != null) out.bytes = bytes;
  if (omitted) out.omitted = omitted;
  return out;
}

/** Is this envelope a slim index rather than a legacy full blob? */
export function isSlimAllSnapshot(snapshot) {
  return String(snapshot?.schema || "") === ALL_SNAPSHOT_SCHEMA;
}

/**
 * Read the index, refusing anything older than `maxAgeMs`.
 *
 * Callers used to read the key with no age check at all, which is how a blob
 * frozen on 2026-08-14 kept feeding live lanes. There is no default of
 * "however old it happens to be": a caller must say how stale it can accept.
 */
export async function readAllSnapshot(KV, { maxAgeMs, nowMs = Date.now() } = {}) {
  if (!KV) return null;
  let snapshot = null;
  try {
    const raw = await KV.get(ALL_SNAPSHOT_KEY);
    if (!raw) return null;
    // A legacy full blob is ~26 MB and parses to ~38 MB of object graph. Once
    // it has aged out it is refused below anyway, so refuse it on size first
    // and skip the parse entirely — otherwise every reader pays 38 MB to
    // discover the value is 40 days old. A slim index has ~10x headroom here.
    if (raw.length > ALL_SNAPSHOT_MAX_BYTES) {
      console.warn(
        `[readAllSnapshot] refusing ${raw.length} bytes — above the ${ALL_SNAPSHOT_MAX_BYTES} budget,`
        + " so this is a pre-slim blob rather than an index.",
      );
      return null;
    }
    snapshot = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!snapshot?.data || typeof snapshot.data !== "object") return null;
  const builtAt = Number(snapshot.built_at) || 0;
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    if (!(builtAt > 0) || (nowMs - builtAt) >= maxAgeMs) return null;
  }
  return snapshot;
}

/**
 * Full payloads for a BOUNDED list of tickers.
 *
 * The replacement for "read 25 MB to look at four rows". Reads are chunked so
 * a caller that asks for more than it should still cannot hold the whole
 * universe at once, and a chunk that fails leaves the rest intact.
 */
export async function hydrateSnapshotRows(KV, syms, {
  chunkSize = 25,
  limit = 60,
  readPayload = null,
} = {}) {
  const wanted = [...new Set(
    (syms || []).map((s) => String(s || "").toUpperCase()).filter(Boolean),
  )].slice(0, limit);
  const read = readPayload
    || (async (sym) => JSON.parse((await KV.get(`timed:latest:${sym}`)) || "null"));
  const out = {};
  for (let i = 0; i < wanted.length; i += chunkSize) {
    const chunk = wanted.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(chunk.map((sym) => read(sym)));
    for (let j = 0; j < chunk.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled" && r.value && typeof r.value === "object") {
        out[chunk[j]] = r.value;
      }
    }
  }
  return out;
}

/**
 * Slim rows for selection, with full payloads merged in for the few tickers
 * a caller actually works on. `pick` receives the slim rows and returns the
 * symbols to hydrate.
 */
export async function selectAndHydrate(KV, snapshot, pick, opts = {}) {
  const rows = snapshot?.data || {};
  const picked = (typeof pick === "function" ? pick(rows) : pick) || [];
  const full = await hydrateSnapshotRows(KV, picked, opts);
  const out = [];
  for (const sym of picked.map((s) => String(s || "").toUpperCase())) {
    const slim = rows[sym] || null;
    const detail = full[sym] || null;
    if (!slim && !detail) continue;
    out.push({ ...(slim || {}), ...(detail || {}), ticker: sym });
  }
  return out;
}
