// worker/cro/influence-ledger.js
// ─────────────────────────────────────────────────────────────────────────────
//  Influence Ledger — "what did we ingest, and what did it influence?"
// ─────────────────────────────────────────────────────────────────────────────
//
//  The CRO cycle tombstone (timed:cro:last_summary) keeps aggregate health
//  counts only — it drops the per-publication lineage. This module rebuilds
//  that lineage on demand from the durable D1 + KV state so the Research Desk
//  (and the AI CIO) can answer, in one digestible payload:
//
//    1. WHAT was ingested (publication, category, TT-voice summary)
//    2. HOW it was categorized + synthesized (tactical / structural / editorial,
//       the extracted signals / themes / sectors / risks)
//    3. WHAT it influenced (applied to the live tactical overlay? which
//       downstream surfaces — Daily Brief, Intraday Pulse, CIO context — see it?)
//    4. WHAT is live right NOW (the active KV override + the pub it came from)
//
//  Pure read path. No writes, no LLM calls. Safe to call from a GET endpoint.

const PUBLICATIONS_TABLE = "cro_publications";
const REWRITES_TABLE = "cro_publication_rewrites";
const PROPOSALS_TABLE = "cro_playbook_proposals";
const PUBLICATION_TICKERS_TABLE = "cro_publication_tickers";
const OVERRIDE_KV_KEY = "cro:tactical_overrides";

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// Resolve a human content category. Prefer the durable WP post_type stored at
// ingest; fall back to URL / title inference for older rows that predate the
// post_type column.
function inferContentType(row) {
  const pt = String(row.post_type || "").toLowerCase();
  if (pt) {
    if (pt.includes("fsi-alert-crypto")) return "flash_crypto";
    if (pt.includes("fsi-alert") || pt.includes("flash")) return "flash";
    if (pt === "post" || pt === "posts") {
      const t0 = String(row.title || "").toLowerCase();
      if (t0.includes("video") || t0.includes("macro minute")) return "video";
      if (t0.includes("earnings") || t0.includes("eps")) return "earnings";
      return "note";
    }
  }
  const u = String(row.source_url || "").toLowerCase();
  const t = String(row.title || "").toLowerCase();
  if (u.includes("fsi-alert-crypto") || t.includes("crypto")) return "flash_crypto";
  if (u.includes("fsi-alert") || u.includes("flashinsight") || t.includes("flashinsight")) return "flash";
  if (t.includes("video") || t.includes("macro minute")) return "video";
  if (t.includes("earnings") || t.includes("eps")) return "earnings";
  return "note";
}

const CONTENT_TYPE_LABEL = {
  flash: "Market Intel",
  flash_crypto: "Crypto Intel",
  video: "Video / macro",
  earnings: "Earnings update",
  note: "Research note",
};

// Map a publication's processing state into a single, plain-English category
// the operator can scan: where is this pub in the ingest → influence funnel?
function deriveCategory(row, proposal) {
  if (row.fetch_status && row.fetch_status !== "ok") return "fetch_failed";
  if (!row.extracted_at) return "ingested_only";
  const cls = proposal?.classification || null;
  const hasSignals = Array.isArray(proposal?.tactical_signals_add) && proposal.tactical_signals_add.length > 0;
  const hasStance = (Array.isArray(proposal?.sector_stance_changes) && proposal.sector_stance_changes.length > 0)
    || (Array.isArray(proposal?.theme_stance_changes) && proposal.theme_stance_changes.length > 0);
  if (cls === "structural" || hasStance) return "structural";
  if (hasSignals) return "actionable";
  return "editorial";
}

const CATEGORY_LABEL = {
  fetch_failed: "Fetch failed",
  ingested_only: "Ingested (not yet processed)",
  editorial: "Editorial / context",
  actionable: "Actionable (tactical signals)",
  structural: "Structural (stance change)",
};

// The downstream surfaces an APPLIED tactical override currently reaches.
// Single source of truth so the UI copy and the CIO both agree.
function influencedSurfaces() {
  return [
    { key: "daily_brief", label: "Daily Brief", note: "Tactical overlay + CRO addendum embedded in the morning/evening brief prompt." },
    { key: "intraday_pulse", label: "Intraday Pulse", note: "Same overlay flows into the intraday pulse prompt." },
    { key: "cio_context", label: "AI CIO (context)", note: "CRO note slice attaches to per-ticker CIO memory as decision context." },
  ];
}

/**
 * Build the influence ledger.
 *
 * @param env
 * @param opts { limit?, lookbackHours? }
 * @returns {
 *   ok, generated_at,
 *   window: { lookback_hours, ingested, fetch_ok, extracted, applied, pending, rejected, editorial, actionable, structural },
 *   active_overlay: { active, proposal_id, pub_id, title, applied_at, signals_count } | { active:false },
 *   items: [ ... per-publication lineage ... ]
 * }
 */
/**
 * Build a slim, USER-SAFE research feed for the Today page Research Desk panel.
 * Recent publications with their TT-voice headline, durable category,
 * publish time, and affected tickers — NO proposal internals / admin lineage.
 *
 * @param env
 * @param opts { limit?, lookbackHours? }
 * @returns { ok, generated_at, items: [{ pub_id, title, category, category_label,
 *            content_type_label, published_at, fetched_at, tickers: [], tt_summary }] }
 */
export async function buildPublicFSDFeed(env, { limit = 30, lookbackHours = 168, skipKvSync = false } = {}) {
  if (!env?.DB) return { ok: false, error_kind: "db_unavailable", items: [] };
  try {
    const { ensureCROIngestionSchema } = await import("./fsd-ingestion.js");
    const { ensureCROProposalSchema } = await import("./fsd-extractor.js");
    await ensureCROIngestionSchema(env);
    await ensureCROProposalSchema(env);
  } catch (_) { /* best-effort */ }

  const { parsePublicationTs, dedupeAndSortFeedItems, syncResearchFeedKv } = await import("./research-feed-kv.js");
  const lookbackDays = Math.max(1, Math.round(lookbackHours / 24));
  const cutoff = Date.now() - lookbackHours * 3600000;
  const fetchLimit = Math.min(120, Math.max(limit * 2, 60));

  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT p.pub_id, p.title, p.source_url, p.published_at, p.fetched_at, p.fetch_status, p.post_type,
              p.extracted_at,
              r.tt_summary_title, r.tt_summary_body, r.rewritten_at,
              pr.category AS proposal_category, pr.classification
         FROM ${PUBLICATIONS_TABLE} p
         LEFT JOIN ${REWRITES_TABLE} r ON r.pub_id = p.pub_id
         LEFT JOIN ${PROPOSALS_TABLE} pr ON pr.proposal_id = p.proposal_id
        WHERE p.fetch_status = 'ok'
        ORDER BY COALESCE(p.published_at, '') DESC, p.fetched_at DESC
        LIMIT ?`,
    ).bind(fetchLimit).all();
    rows = (res?.results || []).filter((row) => parsePublicationTs(row) >= cutoff);
  } catch (e) {
    return { ok: false, error_kind: "query_failed", hint: String(e?.message || e).slice(0, 200), items: [] };
  }

  // Affected tickers per pub (single batched query).
  const tickersByPub = {};
  try {
    const ids = rows.map((r) => r.pub_id).filter(Boolean);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const tk = await env.DB.prepare(
        `SELECT pub_id, ticker FROM ${PUBLICATION_TICKERS_TABLE}
          WHERE pub_id IN (${placeholders}) ORDER BY position ASC`,
      ).bind(...ids).all();
      for (const r of (tk?.results || [])) {
        const k = r.pub_id;
        (tickersByPub[k] = tickersByPub[k] || []).push(String(r.ticker || "").toUpperCase());
      }
    }
  } catch (_) { /* tickers are best-effort */ }

  const mapped = [];
  const seenPub = new Set();
  for (const row of rows) {
    if (!row.pub_id || seenPub.has(row.pub_id)) continue;
    seenPub.add(row.pub_id);
    const contentType = inferContentType(row);
    const category = row.proposal_category || (row.classification || "editorial");
    const hasTtVoice = !!row.tt_summary_body;
    const base = {
      pub_id: row.pub_id,
      category,
      category_label: CATEGORY_LABEL[category] || (category === "structural" ? "Structural" : category === "actionable" ? "Actionable" : "Editorial"),
      content_type_label: CONTENT_TYPE_LABEL[contentType] || "Research note",
      published_at: row.published_at || null,
      fetched_at: row.fetched_at || null,
      sort_ts: parsePublicationTs(row),
      tickers: (tickersByPub[row.pub_id] || []).slice(0, 6),
    };
    if (!hasTtVoice) {
      mapped.push({
        ...base,
        title: "Research note — writing TT summary…",
        tt_summary: null,
        pending_tt_voice: true,
      });
      continue;
    }
    mapped.push({
      ...base,
      title: row.tt_summary_title || "Research note",
      tt_summary: row.tt_summary_body || null,
      pending_tt_voice: false,
    });
  }

  const items = dedupeAndSortFeedItems(mapped, { lookbackDays }).slice(0, Math.min(50, Math.max(1, limit)));

  let kvSync = null;
  if (!skipKvSync) {
    try {
      kvSync = await syncResearchFeedKv(env, items, { lookbackDays });
    } catch (_) { kvSync = { ok: false }; }
  }

  return {
    ok: true,
    generated_at: Date.now(),
    lookback_hours: lookbackHours,
    lookback_days: lookbackDays,
    count: items.length,
    kv_sync: kvSync,
    items,
  };
}

export async function buildInfluenceLedger(env, { limit = 15, lookbackHours = 48 } = {}) {
  if (!env?.DB) return { ok: false, error_kind: "db_unavailable", items: [] };

  // Ensure the publications post_type + proposal gate columns exist (idempotent)
  // so the JOIN below never hits a missing column on a fresh deploy.
  try {
    const { ensureCROIngestionSchema } = await import("./fsd-ingestion.js");
    const { ensureCROProposalSchema } = await import("./fsd-extractor.js");
    await ensureCROIngestionSchema(env);
    await ensureCROProposalSchema(env);
  } catch (_) { /* best-effort */ }

  // Active override (what is live right now).
  let override = null;
  try {
    const raw = await env?.KV?.get(OVERRIDE_KV_KEY);
    override = raw ? JSON.parse(raw) : null;
  } catch (_) { override = null; }
  const liveProposalId = override?.proposal_id || null;

  // One JOIN over the durable lineage. limit is small (≤50) so this stays cheap.
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT p.pub_id, p.title, p.source, p.source_url, p.published_at, p.fetched_at,
              p.fetch_status, p.fetch_error, p.extracted_at, p.proposal_id, p.applied_at, p.post_type,
              r.tt_summary_title, r.tt_summary_body, r.tt_cta,
              pr.classification, pr.status AS proposal_status, pr.proposal_json,
              pr.created_at AS proposal_created_at,
              pr.category AS proposal_category, pr.confidence AS proposal_confidence,
              pr.review_status AS proposal_review_status, pr.auto_apply_reason AS proposal_auto_reason
         FROM ${PUBLICATIONS_TABLE} p
         LEFT JOIN ${REWRITES_TABLE} r ON r.pub_id = p.pub_id
         LEFT JOIN ${PROPOSALS_TABLE} pr ON pr.proposal_id = p.proposal_id
        ORDER BY p.fetched_at DESC
        LIMIT ?`,
    ).bind(Math.min(50, Math.max(1, limit))).all();
    rows = res?.results || [];
  } catch (e) {
    return { ok: false, error_kind: "query_failed", hint: String(e?.message || e).slice(0, 200), items: [] };
  }

  const now = Date.now();
  const windowMs = lookbackHours * 3600 * 1000;
  const window = {
    lookback_hours: lookbackHours,
    ingested: 0, fetch_ok: 0, extracted: 0, applied: 0, pending: 0, rejected: 0,
    needs_review: 0, auto_applied: 0,
    editorial: 0, actionable: 0, structural: 0,
  };

  const items = rows.map((row) => {
    const proposal = safeJson(row.proposal_json);
    const contentType = inferContentType(row);
    // Prefer the persisted category written at extraction; fall back to derive.
    const category = row.proposal_category || deriveCategory(row, proposal);
    const inWindow = Number(row.fetched_at || 0) >= (now - windowMs);

    const signals = Array.isArray(proposal?.tactical_signals_add) ? proposal.tactical_signals_add : [];
    const themeUpdates = Array.isArray(proposal?.theme_playbook_updates) ? proposal.theme_playbook_updates : [];
    const sectorUpdates = Array.isArray(proposal?.sector_playbook_updates) ? proposal.sector_playbook_updates : [];
    const risks = Array.isArray(proposal?.active_risks_add) ? proposal.active_risks_add : [];
    const edu = Array.isArray(proposal?.education_snippets_add) ? proposal.education_snippets_add : [];
    const sectorStance = Array.isArray(proposal?.sector_stance_changes) ? proposal.sector_stance_changes : [];
    const themeStance = Array.isArray(proposal?.theme_stance_changes) ? proposal.theme_stance_changes : [];

    // Themes/sectors touched (union of signal links + playbook updates).
    const themesTouched = new Set();
    const sectorsTouched = new Set();
    for (const s of signals) {
      for (const t of (s.affected_tier1_themes || [])) themesTouched.add(t);
      for (const sec of (s.affected_sectors_overweight || [])) sectorsTouched.add(sec);
    }
    for (const t of themeUpdates) if (t.theme) themesTouched.add(t.theme);
    for (const s of sectorUpdates) if (s.sector) sectorsTouched.add(s.sector);
    for (const s of sectorStance) if (s.sector) sectorsTouched.add(s.sector);
    for (const t of themeStance) if (t.theme) themesTouched.add(t.theme);

    const applied = !!row.applied_at && row.proposal_status === "applied";
    const isLive = !!liveProposalId && liveProposalId === row.proposal_id;

    if (inWindow) {
      window.ingested += 1;
      if (row.fetch_status === "ok") window.fetch_ok += 1;
      if (row.extracted_at) window.extracted += 1;
      if (applied) window.applied += 1;
      if (row.proposal_status === "pending") window.pending += 1;
      if (row.proposal_status === "rejected") window.rejected += 1;
      if (row.proposal_review_status === "needs_review" && row.proposal_status === "pending") window.needs_review += 1;
      if (row.proposal_review_status === "auto_applied") window.auto_applied += 1;
      if (category === "editorial") window.editorial += 1;
      if (category === "actionable") window.actionable += 1;
      if (category === "structural") window.structural += 1;
    }

    return {
      pub_id: row.pub_id,
      title: row.title || "(untitled)",
      source_url: row.source_url || null,
      published_at: row.published_at || null,
      fetched_at: row.fetched_at || null,
      in_window: inWindow,
      content_type: contentType,
      content_type_label: CONTENT_TYPE_LABEL[contentType] || "Research note",
      category,
      category_label: CATEGORY_LABEL[category] || category,
      fetch_status: row.fetch_status || null,
      fetch_error: row.fetch_error || null,
      // TT-voice synthesis (paraphrase — attribution rendered separately in UI).
      tt_title: row.tt_summary_title || null,
      tt_summary: row.tt_summary_body || null,
      tt_cta: row.tt_cta || null,
      has_tt_voice: !!row.tt_summary_body,
      // Extraction lineage.
      proposal_id: row.proposal_id || null,
      classification: row.classification || null,
      proposal_status: row.proposal_status || (row.extracted_at ? "unknown" : null),
      // Auto-apply gate lineage.
      review_status: row.proposal_review_status || null,
      confidence: Number.isFinite(Number(row.proposal_confidence)) ? Number(row.proposal_confidence) : null,
      auto_apply_reason: row.proposal_auto_reason || null,
      needs_review: row.proposal_review_status === "needs_review" && row.proposal_status === "pending",
      extracted_at: row.extracted_at || null,
      applied_at: row.applied_at || null,
      // What it changed.
      overlay: proposal?.one_line_phase_tactical_overlay || null,
      signals_count: signals.length,
      themes_touched: Array.from(themesTouched),
      sectors_touched: Array.from(sectorsTouched),
      risks_count: risks.length,
      education_count: edu.length,
      stance_changes_count: sectorStance.length + themeStance.length,
      // Influence status.
      applied,
      is_live: isLive,
      influenced_surfaces: (applied || isLive) ? influencedSurfaces() : [],
    };
  });

  const activeOverlay = override
    ? {
        active: true,
        proposal_id: override.proposal_id || null,
        pub_id: override.pub_id || null,
        title: override.tactical_title || null,
        overlay: override.tactical_overlay || null,
        applied_at: override.applied_at || null,
        signals_count: Array.isArray(override.tactical_signals) ? override.tactical_signals.length : 0,
      }
    : { active: false };

  return {
    ok: true,
    generated_at: now,
    window,
    active_overlay: activeOverlay,
    items,
  };
}
