// worker/cro/fsd-extractor.js
// ─────────────────────────────────────────────────────────────────────────────
//  Phase 3 — LLM extraction of a Fundstrat Direct publication into a
//  structured playbook proposal.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Input: a publication's extracted text (HTML stripped or PDF heuristic).
//  Output: a JSON proposal matching the schema documented in
//          tasks/2026-06-03-ai-cro-and-fsd-ingestion-plan.md §Phase 3.
//
//  Design constraints:
//    • Strict JSON-mode schema. Validate before persistence. Fail safe to
//      `{ok:false, error_kind, hint}` if the LLM goes off-schema.
//    • Ground the LLM in our existing playbook taxonomy via
//      `getStrategyDigest()` so it uses our exact theme keys + sector
//      names + signal shape (no inventing new themes).
//    • The proposal is ALWAYS just a proposal — applying it is a separate
//      step (worker/cro/cro-apply.js). The operator gates whether
//      auto-apply is enabled.
//    • Persisted to cro_playbook_proposals D1 table with status enum
//      {pending, approved, rejected, applied, superseded}.

import { getStrategyDigest } from "../strategy-context.js";
import { loadPublicationText, markPublicationExtracted } from "./fsd-ingestion.js";

const PROPOSALS_TABLE = "cro_playbook_proposals";
const EXTRACTOR_TIMEOUT_MS = 45_000;     // long-form synthesis can take 20-30s
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_INPUT_CHARS = 20_000;           // hard cap on text shipped to LLM
const MAX_COMPLETION_TOKENS = 3000;

// ── Schema ────────────────────────────────────────────────────────────────────
export async function ensureCROProposalSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${PROPOSALS_TABLE} (
        proposal_id        TEXT PRIMARY KEY,
        pub_id             TEXT NOT NULL,
        classification     TEXT NOT NULL,
        proposal_json      TEXT NOT NULL,
        model_used         TEXT,
        prompt_tokens      INTEGER,
        completion_tokens  INTEGER,
        status             TEXT NOT NULL DEFAULT 'pending',
        created_at         INTEGER NOT NULL,
        decided_at         INTEGER,
        decided_by         TEXT,
        decision_note      TEXT,
        applied_at         INTEGER,
        apply_kind         TEXT,
        apply_error        TEXT
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${PROPOSALS_TABLE}_status_created
      ON ${PROPOSALS_TABLE} (status, created_at DESC)
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${PROPOSALS_TABLE}_pub
      ON ${PROPOSALS_TABLE} (pub_id)
    `).run();
    // 2026-06-04 — Categorization + auto-apply gate columns. ALTER guarded
    // (D1 has no IF NOT EXISTS for columns; the try/catch is the idempotency).
    try { await db.prepare(`ALTER TABLE ${PROPOSALS_TABLE} ADD COLUMN category TEXT`).run(); } catch (_) {}
    try { await db.prepare(`ALTER TABLE ${PROPOSALS_TABLE} ADD COLUMN confidence REAL`).run(); } catch (_) {}
    try { await db.prepare(`ALTER TABLE ${PROPOSALS_TABLE} ADD COLUMN on_theme INTEGER`).run(); } catch (_) {}
    try { await db.prepare(`ALTER TABLE ${PROPOSALS_TABLE} ADD COLUMN review_status TEXT`).run(); } catch (_) {}
    try { await db.prepare(`ALTER TABLE ${PROPOSALS_TABLE} ADD COLUMN auto_apply_reason TEXT`).run(); } catch (_) {}
  } catch (e) {
    console.warn("[CRO_EXTRACTOR] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── Schema-locked extraction prompt ───────────────────────────────────────────
// All field names mirror worker/strategy-context.js exactly so the apply
// step doesn't have to translate.
function buildExtractionPrompt(text, playbook) {
  const themeKeys = Object.keys(playbook.theme_tilts || {}).join(", ");
  const sectorKeys = Object.keys(playbook.sector_tilts || {}).join(", ");
  return {
    system: [
      "You are the Chief Research Officer extractor. Your only job is to convert a research publication into a structured JSON proposal for updating the active strategy playbook.",
      "",
      "CRITICAL CONSTRAINTS:",
      "• Output ONLY valid JSON conforming to the schema below. No markdown, no prose outside the JSON.",
      "• Use ONLY these exact theme keys: " + themeKeys,
      "• Use ONLY these exact sector names: " + sectorKeys,
      "• Do NOT invent new theme or sector names — if a publication discusses a concept not in the list, omit it (or wedge it into the closest existing key).",
      "• A 'tactical' classification is the norm — daily / weekly publications almost always fall here. Only flag a publication 'structural' if it explicitly argues a sector or theme STANCE change (overweight ↔ neutral ↔ underweight).",
      "• tactical_signals_add must be COMPLETE — replace, not extend. The next apply replaces the whole TACTICAL_SIGNALS array.",
      "• Every tactical signal MUST include affected_tier1_themes (from the theme list above) OR affected_sectors_overweight (from the sector list). Empty for both is allowed only for index-level signals (e.g. an SPX-only observation).",
      "• Be conservative. If the publication is unclear, leave fields null/empty rather than guess.",
    ].join("\n"),
    user: [
      "ACTIVE PLAYBOOK (for taxonomy reference only — do not echo back):",
      `vintage=${playbook.vintage}, title="${playbook.title}", current tactical vintage=${playbook.tactical?.vintage || "n/a"}`,
      "",
      "Theme tilts (key → current stance / current playbook string):",
      ...Object.entries(playbook.theme_tilts || {}).slice(0, 80).map(
        ([k, v]) => `  ${k}: ${v.stance} — ${v.playbook}`,
      ),
      "",
      "Sector tilts (key → current stance / rationale_short):",
      ...Object.entries(playbook.sector_tilts || {}).map(
        ([k, v]) => `  ${k}: ${v.stance} — ${v.rationale_short}`,
      ),
      "",
      "PUBLICATION TEXT (your only input — extract from this only):",
      "```",
      text.slice(0, MAX_INPUT_CHARS),
      "```",
      "",
      "Return JSON in EXACTLY this schema (omit a field by setting null/[] — do not omit the key itself):",
      "{",
      '  "classification": "tactical" | "structural",',
      '  "one_line_phase_tactical_overlay": "<single sentence the LLM-facing prompt header surfaces; e.g. ' + "'SPX > 7,600 on a 9-day streak; RSP/SPY broke its downtrend → broadening rotation underway' " + '">",',
      '  "vintage_history_entry": "<3-6 lines summarizing what changed, suitable for the worker/strategy-context.js comment-block changelog>",',
      '  "tactical_signals_add": [',
      "    {",
      '      "signal": "<lowercase_snake_case unique id, e.g. rsp_spy_breadth_breakout>",',
      '      "pair": "<RSP/SPY, IGV/SMH, XLI/SPY, MAGS, ^SPX, BTCUSD vs ^SPX, etc.>",',
      '      "direction": "<favor_a_over_b | caution_short_term | bullish_stretched | favor_industrials_into_broadening | ...>",',
      '      "horizon": "tactical" | "intermediate",',
      '      "evidence": "<1-line summary of the technical read (TD setup, MACD, trendline, DeMark, volume)>",',
      '      "playbook_action": "<2-3 sentences: what the desk should do with this signal>",',
      '      "affected_tier1_themes": ["<theme_key>", "..."],',
      '      "affected_sectors_overweight": ["<sector_name>", "..."],',
      '      "suspected_driver": "<optional one-liner on why this is happening; null if not stated>"',
      "    }",
      "  ],",
      '  "theme_playbook_updates": [',
      "    {",
      '      "theme": "<theme_key>",',
      '      "tactical_note": "<10-25 word note appended in (tactical M/D: ...) form to the theme playbook string>"',
      "    }",
      "  ],",
      '  "sector_playbook_updates": [',
      "    {",
      '      "sector": "<sector name>",',
      '      "tactical_note": "<short note appended to sector rationale_long>"',
      "    }",
      "  ],",
      '  "active_risks_add": [',
      "    {",
      '      "name": "<snake_case_risk_id>",',
      '      "severity": "low" | "medium" | "high",',
      '      "note": "<1-3 sentences describing the risk + how it manifests>"',
      "    }",
      "  ],",
      '  "education_snippets_add": [',
      "    {",
      '      "term": "<short label>",',
      '      "plain": "<plain-English explanation a non-technical user would understand>"',
      "    }",
      "  ],",
      "  // Populate ONLY if classification == 'structural'. Leave null/[] otherwise.",
      '  "strategy_headline_revision": "<full new STRATEGY_HEADLINE prose, ≤600 chars> | null",',
      '  "strategy_phase_revision": null | { "label": "...", "tactical_overlay": "..." },',
      '  "sector_stance_changes": [',
      "    { \"sector\": \"...\", \"new_stance\": \"overweight|neutral|underweight\", \"new_multiplier\": <number>, \"rationale_short\": \"...\" }",
      "  ],",
      '  "theme_stance_changes": [',
      "    { \"theme\": \"...\", \"new_stance\": \"overweight|neutral|underweight\", \"new_multiplier\": <number> }",
      "  ],",
      "  // Self-assessment — used to decide whether this proposal can be AUTO-APPLIED",
      "  // without a human review. Be honest and conservative.",
      '  "self_assessment": {',
      '    "confidence": <0.0-1.0 — how well-supported and unambiguous is this extraction? High (>0.8) only when the publication clearly states the read and it maps cleanly onto the existing playbook taxonomy>,',
      '    "on_theme": <true|false — does this ALIGN with the active playbook above (same themes/sectors, no contradiction of current stances)? false if it argues against a current stance or introduces an off-playbook concept>,',
      '    "review_recommended": <true|false — true if a human should review before applying (e.g. structural stance change, conflicts with the playbook, low-confidence read, unusually large signal change, or ambiguous source text)>,',
      '    "rationale": "<one sentence: why this confidence / on_theme / review_recommended>"',
      "  }",
      "}",
    ].join("\n"),
  };
}

// ── Auto-apply categorization + gating (2026-06-04) ─────────────────────────
// Turns a parsed proposal + validation warnings into a durable category and a
// recommendation on whether it can be auto-applied. The operator only needs to
// review proposals that are off-theme or that the model is unsure about.
const DEFAULT_MIN_CONFIDENCE = 0.7;

// Reads the operator-tunable auto-apply config from model_config.
//   cro_auto_apply_min_confidence  (default 0.7)
//   cro_auto_apply_structural      (default false — structural always reviewed)
async function readAutoApplyConfig(env) {
  let minConfidence = DEFAULT_MIN_CONFIDENCE;
  let allowStructural = true; // 2026-06-05 — operator flipped structural auto-apply ON by default.
  try {
    if (env?.DB) {
      const rows = await env.DB.prepare(
        `SELECT config_key, config_value FROM model_config
          WHERE config_key IN ('cro_auto_apply_min_confidence','cro_auto_apply_structural')`,
      ).all();
      for (const r of (rows?.results || [])) {
        if (r.config_key === "cro_auto_apply_min_confidence") {
          const v = Number(r.config_value);
          if (Number.isFinite(v) && v >= 0 && v <= 1) minConfidence = v;
        } else if (r.config_key === "cro_auto_apply_structural") {
          const v = String(r.config_value).toLowerCase();
          allowStructural = !(v === "false" || v === "0");
        }
      }
    }
  } catch (_) { /* defaults */ }
  return { minConfidence, allowStructural };
}

export function categorizeProposal(parsed) {
  const hasSignals = Array.isArray(parsed?.tactical_signals_add) && parsed.tactical_signals_add.length > 0;
  const hasStance = (Array.isArray(parsed?.sector_stance_changes) && parsed.sector_stance_changes.length > 0)
    || (Array.isArray(parsed?.theme_stance_changes) && parsed.theme_stance_changes.length > 0);
  if (parsed?.classification === "structural" || hasStance) return "structural";
  if (hasSignals) return "actionable";
  return "editorial";
}

/**
 * Decide whether a freshly-extracted proposal should auto-apply or be held for
 * operator review. Deterministic checks (unknown taxonomy, structural) combine
 * with the LLM self-assessment (confidence / on-theme / review-recommended).
 *
 * @returns { auto, review_status, reason, confidence, on_theme, category }
 */
export function assessProposalAutoApply(parsed, warnings, {
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  allowStructural = false,
} = {}) {
  const category = categorizeProposal(parsed);
  const sa = (parsed && typeof parsed.self_assessment === "object") ? parsed.self_assessment : {};
  const confidence = Number.isFinite(Number(sa.confidence)) ? Number(sa.confidence) : null;
  const onTheme = sa.on_theme !== false; // default true unless explicitly false
  const reviewRecommended = sa.review_recommended === true;
  // Unknown theme/sector keys are a strong off-theme signal.
  const hasUnknownTaxonomy = (warnings || []).some((w) =>
    String(w).startsWith("unknown_theme") || String(w).startsWith("unknown_sector")
    || String(w).startsWith("theme_update_unknown") || String(w).startsWith("sector_update_unknown"));

  const flags = [];
  if (category === "structural") flags.push("structural");
  if (hasUnknownTaxonomy) flags.push("off_taxonomy");
  if (!onTheme) flags.push("off_theme");
  if (reviewRecommended) flags.push("model_review_recommended");
  if (confidence != null && confidence < minConfidence) flags.push(`low_confidence(${confidence.toFixed(2)})`);

  let auto = flags.length === 0;
  // Structural is gated separately and OFF by default.
  if (category === "structural") auto = allowStructural && !hasUnknownTaxonomy && onTheme && !reviewRecommended && (confidence == null || confidence >= minConfidence);

  return {
    auto,
    review_status: auto ? "auto_applied" : "needs_review",
    reason: auto ? "confident_on_theme" : (flags.join(", ") || "review"),
    confidence,
    on_theme: onTheme,
    category,
  };
}

// ── LLM call ──────────────────────────────────────────────────────────────────
async function callOpenAI(env, messages, { model = DEFAULT_MODEL, maxTokens = MAX_COMPLETION_TOKENS } = {}) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };

  const isGpt5 = String(model).toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (!isGpt5) body.temperature = 0.15;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), EXTRACTOR_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error_kind: `openai_${resp.status}`, hint: errText.slice(0, 200) };
    }
    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || "";
    const usage = json.usage || {};
    return { ok: true, content, model, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens };
  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    return { ok: false, error_kind: isTimeout ? "openai_timeout" : "openai_exception", hint: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateProposal(parsed, playbook) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") {
    errors.push("not_an_object");
    return errors;
  }
  if (!["tactical", "structural"].includes(parsed.classification)) {
    errors.push("classification_invalid");
  }
  const allowedThemes = new Set(Object.keys(playbook.theme_tilts || {}));
  const allowedSectors = new Set(Object.keys(playbook.sector_tilts || {}));
  for (const sig of (parsed.tactical_signals_add || [])) {
    if (!sig.signal || !sig.direction || !sig.horizon) errors.push(`signal_missing_fields:${sig.signal || "?"}`);
    for (const t of (sig.affected_tier1_themes || [])) {
      if (!allowedThemes.has(t)) errors.push(`unknown_theme:${t}`);
    }
    for (const s of (sig.affected_sectors_overweight || [])) {
      if (!allowedSectors.has(s)) errors.push(`unknown_sector:${s}`);
    }
  }
  for (const t of (parsed.theme_playbook_updates || [])) {
    if (!allowedThemes.has(t.theme)) errors.push(`theme_update_unknown:${t.theme}`);
  }
  for (const s of (parsed.sector_playbook_updates || [])) {
    if (!allowedSectors.has(s.sector)) errors.push(`sector_update_unknown:${s.sector}`);
  }
  return errors;
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Extract a publication's text into a structured playbook proposal.
 *
 * @param env
 * @param pubId       D1 publication id (must exist in cro_publication_text)
 * @param options
 * @returns { ok, proposal_id, classification?, validation_warnings?, model, ... }
 */
export async function extractPublicationToProposal(env, pubId, { model = null, force = false } = {}) {
  await ensureCROProposalSchema(env);

  const row = await loadPublicationText(env, pubId);
  if (!row || !row.text_full) {
    return { ok: false, error_kind: "publication_text_missing", hint: `no row in cro_publication_text for pub_id=${pubId}` };
  }

  // Idempotent: if a non-superseded proposal already exists and force=false,
  // return it. (Re-extraction supersedes prior pending proposals.)
  if (!force) {
    try {
      const existing = await env.DB.prepare(
        `SELECT proposal_id, classification, status FROM ${PROPOSALS_TABLE}
          WHERE pub_id = ? AND status IN ('pending','approved','applied')
          ORDER BY created_at DESC LIMIT 1`,
      ).bind(pubId).first();
      if (existing) {
        return { ok: true, proposal_id: existing.proposal_id, classification: existing.classification, skipped: "already_extracted", existing_status: existing.status };
      }
    } catch (_) {}
  }

  const playbook = getStrategyDigest();
  const { system, user } = buildExtractionPrompt(row.text_full, playbook);
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const llm = await callOpenAI(env, messages, { model: model || DEFAULT_MODEL });
  if (!llm.ok) return llm;

  let parsed = null;
  try { parsed = JSON.parse(llm.content); } catch (e) {
    return { ok: false, error_kind: "llm_json_parse_failed", hint: String(e?.message || e).slice(0, 200), raw_preview: llm.content.slice(0, 400) };
  }
  const warnings = validateProposal(parsed, playbook);
  if (warnings.includes("not_an_object") || warnings.includes("classification_invalid")) {
    return { ok: false, error_kind: "validation_fatal", validation_warnings: warnings, raw_preview: JSON.stringify(parsed).slice(0, 400) };
  }

  // If force, mark any prior pending proposals for this pub as superseded.
  if (force) {
    try {
      await env.DB.prepare(
        `UPDATE ${PROPOSALS_TABLE} SET status = 'superseded', decided_at = ?2, decided_by = 'auto_supersede'
          WHERE pub_id = ?1 AND status = 'pending'`,
      ).bind(pubId, Date.now()).run();
    } catch (_) {}
  }

  // 2026-06-04 — Categorize + decide auto-apply vs needs-review. Persisted on
  // the row so the Research Desk + orchestrator agree on what needs a human.
  const gateCfg = await readAutoApplyConfig(env);
  const gate = assessProposalAutoApply(parsed, warnings, gateCfg);

  const proposalId = "prop_" + pubId.slice(0, 40) + "_" + Date.now().toString(36);
  try {
    await env.DB.prepare(`
      INSERT INTO ${PROPOSALS_TABLE}
        (proposal_id, pub_id, classification, proposal_json, model_used,
         prompt_tokens, completion_tokens, status, created_at,
         category, confidence, on_theme, review_status, auto_apply_reason)
      VALUES (?1,?2,?3,?4,?5,?6,?7, 'pending', ?8, ?9, ?10, ?11, ?12, ?13)
    `).bind(
      proposalId,
      pubId,
      String(parsed.classification),
      JSON.stringify(parsed),
      llm.model,
      llm.prompt_tokens || null,
      llm.completion_tokens || null,
      Date.now(),
      gate.category,
      gate.confidence,
      gate.on_theme ? 1 : 0,
      gate.review_status,
      gate.reason,
    ).run();
  } catch (e) {
    return { ok: false, error_kind: "persist_failed", hint: String(e?.message || e).slice(0, 200) };
  }

  await markPublicationExtracted(env, pubId, proposalId);

  return {
    ok: true,
    proposal_id: proposalId,
    classification: parsed.classification,
    signals_count: (parsed.tactical_signals_add || []).length,
    theme_updates: (parsed.theme_playbook_updates || []).length,
    sector_updates: (parsed.sector_playbook_updates || []).length,
    risks_added: (parsed.active_risks_add || []).length,
    education_added: (parsed.education_snippets_add || []).length,
    validation_warnings: warnings,
    // Auto-apply gate (consumed by the orchestrator).
    category: gate.category,
    confidence: gate.confidence,
    on_theme: gate.on_theme,
    auto_apply_recommended: gate.auto,
    review_status: gate.review_status,
    auto_apply_reason: gate.reason,
    model: llm.model,
    prompt_tokens: llm.prompt_tokens,
    completion_tokens: llm.completion_tokens,
  };
}

// ── Lookups ───────────────────────────────────────────────────────────────────
export async function getProposal(env, proposalId) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM ${PROPOSALS_TABLE} WHERE proposal_id = ?`,
    ).bind(proposalId).first();
    if (!row) return null;
    let parsed = null;
    try { parsed = JSON.parse(row.proposal_json); } catch (_) {}
    return { ...row, proposal: parsed };
  } catch (_) { return null; }
}

export async function listPendingProposals(env, { limit = 20 } = {}) {
  try {
    const rows = await env.DB.prepare(
      `SELECT proposal_id, pub_id, classification, status, created_at, decided_at, decided_by, applied_at
         FROM ${PROPOSALS_TABLE}
         WHERE status IN ('pending','approved')
         ORDER BY created_at DESC LIMIT ?`,
    ).bind(limit).all();
    return rows?.results || [];
  } catch (_) { return []; }
}

export async function listRecentProposals(env, { limit = 20 } = {}) {
  // Ensure the gate columns exist (idempotent) before selecting them — a fresh
  // deploy may hit this endpoint before the first cron runs the migration.
  await ensureCROProposalSchema(env);
  try {
    const rows = await env.DB.prepare(
      `SELECT proposal_id, pub_id, classification, status, created_at, decided_at, applied_at,
              category, confidence, on_theme, review_status, auto_apply_reason
         FROM ${PROPOSALS_TABLE} ORDER BY created_at DESC LIMIT ?`,
    ).bind(limit).all();
    return rows?.results || [];
  } catch (_) { return []; }
}

export async function setProposalStatus(env, proposalId, { status, decided_by = null, decision_note = null }) {
  try {
    await env.DB.prepare(`
      UPDATE ${PROPOSALS_TABLE}
         SET status = ?2, decided_at = ?3, decided_by = ?4, decision_note = ?5
       WHERE proposal_id = ?1
    `).bind(proposalId, status, Date.now(), decided_by, decision_note).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function markProposalApplied(env, proposalId, { apply_kind, apply_error = null }) {
  try {
    await env.DB.prepare(`
      UPDATE ${PROPOSALS_TABLE}
         SET status = ?2, applied_at = ?3, apply_kind = ?4, apply_error = ?5
       WHERE proposal_id = ?1
    `).bind(proposalId, apply_error ? "rejected" : "applied", Date.now(), apply_kind, apply_error).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
