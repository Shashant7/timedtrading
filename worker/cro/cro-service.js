// worker/cro/cro-service.js
// ─────────────────────────────────────────────────────────────────────────────
//  Phase 6 — AI CRO daily synthesis service.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Composes the five input streams into a single daily research note:
//    1. FSD intel (latest extracted publications)
//    2. Cross-asset macro snapshot (worker/macro/cross-asset-tracker.js)
//    3. Rotation engine snapshot (worker/cro/rotation-engine.js)
//    4. Cross-universe discovery pulse (news, insider, social, move-discovery,
//       promotion-queue top-N) — best-effort, each input wrapped in its own
//       try/catch so one slow / failing source never blocks the rest
//    5. Active playbook + tactical overrides (worker/strategy-context.js)
//
//  Persisted:
//    • KV `timed:cro:daily-note:{YYYY-MM-DD}`  + `timed:cro:latest`
//    • D1 `cro_daily_notes` (full audit row — prompt + completion + sources)
//
//  Consumed by:
//    • CIO memory builder (Layer 15c — wired in Phase 7)
//    • Daily Brief morning + evening prompts (Phase 7)
//    • Operator `/timed/cro/latest` endpoint (Phase 8)

import { getStrategyDigest } from "../strategy-context.js";
import { listRecentPublications, loadPublicationText } from "./fsd-ingestion.js";
import { loadTacticalOverrideBlob, loadAppliedHistory } from "./cro-apply.js";
import { loadRotationSnapshot } from "./rotation-engine.js";
import { loadCTOUniverse } from "../cto/cto-service.js";

const DAILY_TABLE = "cro_daily_notes";
const KV_LATEST_KEY = "timed:cro:latest";
const SYNTH_TIMEOUT_MS = 60_000;        // synthesis call can take 30-50s
const DEFAULT_MODEL = "gpt-4o-mini";

// ── Schema ────────────────────────────────────────────────────────────────────
export async function ensureCRODailyNoteSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${DAILY_TABLE} (
        note_id            TEXT PRIMARY KEY,
        as_of_date         TEXT NOT NULL,
        produced_at        INTEGER NOT NULL,
        model_used         TEXT,
        prompt_tokens      INTEGER,
        completion_tokens  INTEGER,
        verdict            TEXT,
        observations_json  TEXT,
        full_note_md       TEXT,
        sources_json       TEXT,
        prompt_full        TEXT,
        error              TEXT
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${DAILY_TABLE}_as_of_date
      ON ${DAILY_TABLE} (as_of_date DESC)
    `).run();
  } catch (e) {
    console.warn("[CRO_DAILY] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── Input collectors (each wrapped in best-effort try/catch) ──────────────────
async function collectFSDIntel(env, { lookbackHours = 36 } = {}) {
  try {
    const pubs = await listRecentPublications(env, { limit: 10 });
    const since = Date.now() - lookbackHours * 3600 * 1000;
    const recent = (pubs || []).filter((p) => Number(p.fetched_at || 0) >= since);
    const enriched = [];
    for (const p of recent.slice(0, 5)) {
      const text = await loadPublicationText(env, p.pub_id);
      enriched.push({
        pub_id: p.pub_id,
        title: p.title,
        source: p.source,
        published_at: p.published_at,
        fetched_at: p.fetched_at,
        status: p.fetch_status,
        applied_at: p.applied_at,
        proposal_id: p.proposal_id,
        excerpt: text?.text_excerpt?.slice(0, 1500) || null,
      });
    }
    return { ok: true, count: enriched.length, publications: enriched };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function collectMacroSnapshot(env) {
  try {
    const Macro = await import("../macro/cross-asset-tracker.js");
    const snap = await Macro.loadMacroSnapshot(env);
    if (!snap) return { ok: false, error: "no_macro_snapshot" };
    return {
      ok: true,
      computed_at: snap.computed_at,
      macro_narrative: snap.macro_narrative,
      cross_asset_regime: snap.cross_asset_regime || null,
      country_top_outperformers: (snap.country_rotation?.top_outperformers || []).slice(0, 5),
      country_top_underperformers: (snap.country_rotation?.top_underperformers || []).slice(0, 5),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function collectRotationSnapshot(env) {
  try {
    const snap = await loadRotationSnapshot(env);
    if (!snap) return { ok: false, error: "no_rotation_snapshot" };
    return {
      ok: true,
      computed_at: snap.computed_at,
      headlines: (snap.headlines || []).slice(0, 12),
      rs_pairs: (snap.rs_pairs || []).filter((p) => p.ok).map((p) => ({
        id: p.id, pair: `${p.numer}/${p.denom}`,
        trend_state: p.trend_state, roc_20d_pct: p.roc_20d_pct,
        td_setup: p.td_setup_state, td_count: p.td_setup_count,
      })),
      themes_all_bid_today: (snap.theme_breadth || [])
        .filter((t) => t.all_bid_today).map((t) => ({ theme: t.theme, breadth_pct: t.breadth_today_up_gt_1pct })),
      themes_all_offered_today: (snap.theme_breadth || [])
        .filter((t) => t.all_offered_today).map((t) => ({ theme: t.theme, breadth_pct: t.breadth_today_dn_gt_1pct })),
      themes_high_correlation: (snap.theme_correlation || [])
        .filter((c) => c.high_correlation_cluster).map((c) => ({ theme: c.theme, avg_corr: c.avg_correlation })),
      themes_decoupling: (snap.theme_correlation || [])
        .filter((c) => c.decoupling).map((c) => ({ theme: c.theme, avg_corr: c.avg_correlation })),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function collectCTOUniverse(env) {
  try {
    const rollup = await loadCTOUniverse(env);
    if (!rollup) return { ok: false, error: "no_cto_rollup" };
    return {
      ok: true,
      computed_at: rollup.computed_at,
      tickers_processed: rollup.tickers_processed,
      tickers_ok: rollup.tickers_ok,
      headlines: (rollup.headlines || []).slice(0, 10),
      top_picks: (rollup.results || [])
        .filter((r) => r.ok && (r.top_upside?.[0]?.regime_adjusted_prob >= 0.55 || r.top_downside?.[0]?.regime_adjusted_prob >= 0.55))
        .slice(0, 6)
        .map((r) => ({ ticker: r.ticker, narrative: r.narrative })),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function collectDiscoveryPulse(env) {
  const out = { ok: true };
  // 1. Move discovery — top recent moves vs universe
  try {
    const moves = await env?.KV?.get("timed:discovery:move-summary");
    if (moves) {
      const parsed = JSON.parse(moves);
      out.move_discovery = {
        scanned_at: parsed.scanned_at,
        top_moves: (parsed.candidates || parsed.top_moves || []).slice(0, 6),
      };
    }
  } catch (_) {}
  // 2. Coverage gaps — missed-tickers summary
  try {
    const gaps = await env?.KV?.get("timed:discovery:coverage-gaps-summary");
    if (gaps) {
      const parsed = JSON.parse(gaps);
      out.coverage_gaps = {
        universe_capture_rate_pct: parsed.universe_capture_rate_pct,
        worst_capture_tickers: Object.entries(parsed.by_ticker || {})
          .sort((a, b) => (a[1].capture_rate_pct || 0) - (b[1].capture_rate_pct || 0))
          .slice(0, 5)
          .map(([t, v]) => ({ ticker: t, capture_rate_pct: v.capture_rate_pct })),
      };
    }
  } catch (_) {}
  // 3. Promotion queue — top scored candidates
  try {
    const PQ = await import("../discovery/promotion-queue.js");
    const rows = await PQ.loadPromotionQueueRows(env, { status: "", limit: 6 });
    out.promotion_queue_top = (rows?.rows || rows?.results || rows || []).slice(0, 6);
  } catch (_) {}
  // 4. News — top cross-universe catalysts (we don't aggregate this today; pass through latest scored)
  try {
    const news = await env?.KV?.get("timed:discovery:news-summary");
    if (news) {
      const parsed = JSON.parse(news);
      out.news_top = (parsed.top_catalysts || []).slice(0, 6);
    }
  } catch (_) {}
  return out;
}

function collectPlaybookSnapshot() {
  try {
    const d = getStrategyDigest();
    return {
      ok: true,
      vintage: d.vintage,
      title: d.title,
      tactical_vintage: d.tactical?.vintage,
      tactical_title: d.tactical?.title,
      tactical_signals_count: (d.tactical?.signals || []).length,
      overweight_sectors: Object.entries(d.sector_tilts || {}).filter(([, v]) => v.stance === "overweight").map(([k]) => k),
      underweight_sectors: Object.entries(d.sector_tilts || {}).filter(([, v]) => v.stance === "underweight").map(([k]) => k),
      tier1_themes: Object.entries(d.theme_tilts || {}).filter(([, v]) => v.tier === "tier_1" && v.stance === "overweight").map(([k]) => k),
      active_risks: (d.active_risks || []).map((r) => `${r.name} (${r.severity})`),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function collectOverrideStatus(env) {
  try {
    const blob = await loadTacticalOverrideBlob(env);
    if (!blob) return { active: false };
    return {
      active: true,
      proposal_id: blob.proposal_id || null,
      pub_id: blob.pub_id || null,
      tactical_vintage: blob.tactical_vintage || null,
      tactical_title: blob.tactical_title || null,
      applied_at: blob.applied_at || null,
      signals_count: (blob.tactical_signals || []).length,
    };
  } catch (_) {
    return { active: false };
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildSynthesisPrompt(sources, asOfDate) {
  return {
    system: [
      "You are the Chief Research Officer (CRO) for Timed Trading.",
      "You synthesize five upstream input streams into a single, daily research note that the AI CIO and AI COO consume in their decision prompts and that the Daily Brief surfaces to users.",
      "",
      "ABSOLUTE CONSTRAINTS:",
      "• Output STRUCTURED JSON only, conforming to the schema at the end of the user message.",
      "• You DO NOT propose stance changes. The active playbook's sector and theme tilts are set by the structural playbook flow; you only OBSERVE and report what is corroborating, contradicting, or extending those stances. If you think the playbook is wrong, say so in `notable_drifts` — never invent a stance change here.",
      "• You DO NOT recommend specific trades. The CIO + engine own that. Your job is research context, not execution.",
      "• Cite each observation to a specific input source (FSD / rotation_engine / macro / discovery / playbook). No floating claims.",
      "• If an input source is missing or stale, mention it in `data_gaps` — don't pretend it was there.",
      "• Be concise. Every section has a target word budget.",
    ].join("\n"),
    user: [
      `Today is ${asOfDate}.`,
      "",
      "## Input Sources",
      "",
      "### 1. FSD Intel (recent publications)",
      JSON.stringify(sources.fsd, null, 2),
      "",
      "### 2. Cross-Asset Macro Snapshot",
      JSON.stringify(sources.macro, null, 2),
      "",
      "### 3. Rotation Engine Snapshot (TT's own universe data — corroborate / contradict FSD)",
      JSON.stringify(sources.rotation, null, 2),
      "",
      "### 4. CTO Probabilistic Levels (Markov-bias-adjusted Fib / ATR / pivot levels + empirical hit rates — the data-science backing)",
      JSON.stringify(sources.cto, null, 2),
      "",
      "### 5. Discovery Pulse (cross-universe signals: news, screener, moves, coverage)",
      JSON.stringify(sources.discovery, null, 2),
      "",
      "### 6. Active Playbook + Tactical Override Status",
      JSON.stringify({ playbook: sources.playbook, override: sources.override }, null, 2),
      "",
      "## Output Schema",
      "",
      "Respond with EXACTLY this JSON shape (use [] / null where no content):",
      "{",
      '  "verdict": "<one paragraph, ≤120 words, the CIO + COO will lean on this most heavily. What does today look like? What changed since yesterday? What is the dominant risk vs opportunity?>",',
      '  "observations": [',
      '    { "section": "Cross-asset", "text": "<≤30 words>", "source": "macro|rotation|fsd|playbook" },',
      '    { "section": "Sector rotation", "text": "<≤30 words>", "source": "rotation|fsd|playbook" },',
      '    { "section": "Themes in motion", "text": "<≤30 words>", "source": "rotation|discovery|fsd" },',
      '    { "section": "Correlation / cluster moves", "text": "<≤30 words>", "source": "rotation" },',
      '    { "section": "Discovery layer", "text": "<≤30 words>", "source": "discovery" }',
      "  ],",
      '  "early_indicators": [',
      '    { "indicator": "<short label, e.g. ' + "'RSP/SPY breaking up'" + '>", "implication": "<≤30 words>", "source": "..." }',
      "  ],",
      '  "notable_drifts": [',
      '    { "claim": "<what we observe>", "drift_from": "<which playbook stance this conflicts with>", "evidence": "<from which source>" }',
      "  ],",
      '  "data_gaps": ["<list of missing or stale inputs that limited this note>"],',
      '  "full_note_md": "<a 250-350 word Markdown note suitable for a Daily Brief section. Use bullets. Cite sources inline. End with a one-line ' + "'CRO verdict:'" + ' line that mirrors the verdict field.>"',
      "}",
    ].join("\n"),
  };
}

async function callOpenAI(env, messages, { model = DEFAULT_MODEL, maxTokens = 2500 } = {}) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };
  const isGpt5 = String(model).toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (!isGpt5) body.temperature = 0.2;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
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
    return { ok: false, error_kind: e?.name === "AbortError" ? "openai_timeout" : "openai_exception", hint: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

// ── Public: run a daily synthesis ─────────────────────────────────────────────
export async function runCRODaily(env, { asOfDate = null, force = false, model = null } = {}) {
  await ensureCRODailyNoteSchema(env);
  const today = asOfDate || new Date().toISOString().slice(0, 10);

  // Idempotency — skip if today's note already exists unless force=true.
  if (!force) {
    try {
      const existing = await env.DB.prepare(
        `SELECT note_id, produced_at FROM ${DAILY_TABLE} WHERE as_of_date = ? ORDER BY produced_at DESC LIMIT 1`,
      ).bind(today).first();
      if (existing) {
        const cached = await env?.KV?.get(KV_LATEST_KEY);
        return { ok: true, skipped: "already_produced", note_id: existing.note_id, latest_json: cached };
      }
    } catch (_) {}
  }

  const t0 = Date.now();
  const sources = {
    fsd:        await collectFSDIntel(env),
    macro:      await collectMacroSnapshot(env),
    rotation:   await collectRotationSnapshot(env),
    cto:        await collectCTOUniverse(env),
    discovery:  await collectDiscoveryPulse(env),
    playbook:   collectPlaybookSnapshot(),
    override:   await collectOverrideStatus(env),
  };

  const { system, user } = buildSynthesisPrompt(sources, today);
  const llm = await callOpenAI(env, [
    { role: "system", content: system },
    { role: "user",   content: user },
  ], { model: model || DEFAULT_MODEL });

  if (!llm.ok) {
    // Persist a stub error row so the operator sees the failure in
    // /timed/cro/recent without having to grep logs.
    const noteId = "note_" + today + "_err_" + Date.now().toString(36);
    try {
      await env.DB.prepare(`
        INSERT INTO ${DAILY_TABLE} (note_id, as_of_date, produced_at, model_used, sources_json, prompt_full, error)
        VALUES (?1,?2,?3,?4,?5,?6,?7)
      `).bind(noteId, today, Date.now(), model || DEFAULT_MODEL, JSON.stringify(sources).slice(0, 200000), null, `${llm.error_kind}: ${llm.hint || ""}`.slice(0, 500)).run();
    } catch (_) {}
    return { ok: false, error_kind: llm.error_kind, hint: llm.hint, elapsed_ms: Date.now() - t0 };
  }

  let parsed = null;
  try { parsed = JSON.parse(llm.content); } catch (e) {
    return { ok: false, error_kind: "synthesis_parse_failed", hint: String(e?.message || e).slice(0, 200), raw_preview: llm.content.slice(0, 400) };
  }

  const noteId = "note_" + today + "_" + Date.now().toString(36);
  try {
    await env.DB.prepare(`
      INSERT INTO ${DAILY_TABLE}
        (note_id, as_of_date, produced_at, model_used, prompt_tokens, completion_tokens,
         verdict, observations_json, full_note_md, sources_json, prompt_full)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    `).bind(
      noteId, today, Date.now(), llm.model,
      llm.prompt_tokens || null, llm.completion_tokens || null,
      String(parsed.verdict || "").slice(0, 4000),
      JSON.stringify(parsed.observations || []).slice(0, 60000),
      String(parsed.full_note_md || "").slice(0, 32000),
      JSON.stringify(sources).slice(0, 200000),
      user.slice(0, 100000),
    ).run();
  } catch (e) {
    console.warn("[CRO_DAILY] persist failed:", String(e?.message || e).slice(0, 200));
  }

  const latestPayload = {
    note_id: noteId,
    as_of_date: today,
    produced_at: Date.now(),
    model_used: llm.model,
    verdict: parsed.verdict || null,
    observations: parsed.observations || [],
    early_indicators: parsed.early_indicators || [],
    notable_drifts: parsed.notable_drifts || [],
    data_gaps: parsed.data_gaps || [],
    full_note_md: parsed.full_note_md || null,
    sources_summary: {
      fsd_pubs_seen: sources.fsd?.count || 0,
      rotation_headlines: (sources.rotation?.headlines || []).length,
      macro_ok: !!sources.macro?.ok,
      override_active: !!sources.override?.active,
    },
  };

  try {
    await env?.KV?.put(KV_LATEST_KEY, JSON.stringify(latestPayload), { expirationTtl: 48 * 3600 });
  } catch (_) {}

  return { ok: true, note_id: noteId, elapsed_ms: Date.now() - t0, ...latestPayload };
}

// ── Read helpers (used by Layer 15c + Daily Brief + admin endpoints) ──────────
export async function loadLatestCRONote(env) {
  try {
    const raw = await env?.KV?.get(KV_LATEST_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  // KV miss — fall back to D1 last row.
  try {
    const row = await env.DB.prepare(
      `SELECT note_id, as_of_date, produced_at, model_used, verdict, observations_json, full_note_md
         FROM ${DAILY_TABLE} ORDER BY produced_at DESC LIMIT 1`,
    ).first();
    if (!row) return null;
    return {
      note_id: row.note_id,
      as_of_date: row.as_of_date,
      produced_at: row.produced_at,
      model_used: row.model_used,
      verdict: row.verdict,
      observations: (() => { try { return JSON.parse(row.observations_json || "[]"); } catch (_) { return []; } })(),
      full_note_md: row.full_note_md,
    };
  } catch (_) { return null; }
}

export async function listRecentCRONotes(env, { limit = 14 } = {}) {
  try {
    const rows = await env.DB.prepare(
      `SELECT note_id, as_of_date, produced_at, model_used, verdict, error
         FROM ${DAILY_TABLE} ORDER BY produced_at DESC LIMIT ?`,
    ).bind(limit).all();
    return rows?.results || [];
  } catch (_) { return []; }
}

export async function loadCRONoteByDate(env, dateStr) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM ${DAILY_TABLE} WHERE as_of_date = ? ORDER BY produced_at DESC LIMIT 1`,
    ).bind(dateStr).first();
    return row || null;
  } catch (_) { return null; }
}

// ── Compact addendum for the CIO + Daily Brief prompts (Phase 7 callers) ─────
/**
 * Returns a compact 5-8 line addendum for embedding in CIO prompts +
 * Daily Brief prompts. Designed to be ≤ ~600 chars so it doesn't blow the
 * existing prompt budgets. Falls back to a single-line "no note yet" stub
 * when no daily note has been produced.
 */
export async function getCROBriefAddendum(env) {
  const note = await loadLatestCRONote(env);
  if (!note) {
    return "## CRO Research Desk (no fresh note today — relying on structural playbook + rotation snapshot).";
  }
  const lines = [
    `## CRO Research Desk — daily note ${note.as_of_date}`,
    `Verdict: ${(note.verdict || "").slice(0, 300)}`,
  ];
  if (note.early_indicators?.length) {
    lines.push("Early indicators: " + note.early_indicators.slice(0, 3).map((e) => `${e.indicator} → ${e.implication}`).join(" | "));
  }
  if (note.notable_drifts?.length) {
    lines.push("Drifts vs playbook: " + note.notable_drifts.slice(0, 2).map((d) => d.claim).join(" | "));
  }
  if (note.data_gaps?.length) {
    lines.push("Data gaps: " + note.data_gaps.slice(0, 3).join("; "));
  }
  return lines.join("\n");
}

// ── Fresh FSD synthesis addendum for the Daily Brief / Intraday Pulse ────────
/**
 * Surfaces the FRESHEST FundStrat publications synthesis so the Daily Brief +
 * Intraday Pulse stay on-theme with what FSD published THROUGH THE DAY — not
 * just the once-nightly CRO note. Built from the influence ledger so it
 * reflects the same lineage the Research Desk shows: the live tactical
 * overlay + the most recent TT-voice publication takes + themes/sectors in
 * motion. Compact (≤ ~900 chars) to fit the prompt budget. Returns a
 * single-line stub when nothing is ingested.
 *
 * @param env
 * @param opts { lookbackHours?, maxItems? }
 */
export async function getFSDSynthesisAddendum(env, { lookbackHours = 30, maxItems = 4 } = {}) {
  let ledger = null;
  try {
    const { buildInfluenceLedger } = await import("./influence-ledger.js");
    ledger = await buildInfluenceLedger(env, { limit: 12, lookbackHours });
  } catch (_) { ledger = null; }
  if (!ledger || !ledger.ok) {
    return "## FundStrat Intel — no fresh publications ingested today (relying on the structural playbook + CRO note above).";
  }

  const items = (ledger.items || []).filter((it) => it.in_window && it.fetch_status === "ok");
  const live = ledger.active_overlay;
  const lines = ["## FundStrat Intel — fresh synthesis (keep today's update ON-THEME with these)"];

  if (live && live.active && (live.overlay || live.title)) {
    lines.push(`Live tactical overlay (FSD-derived, applied): ${(live.overlay || live.title).slice(0, 240)}`);
  } else {
    lines.push("No tactical overlay is live — read against the structural playbook above.");
  }

  if (items.length > 0) {
    lines.push(`Latest publications (TT voice — paraphrased, attribute to FundStrat):`);
    for (const it of items.slice(0, maxItems)) {
      const headline = (it.tt_title || it.title || "").slice(0, 120);
      const cat = it.category_label || it.category || "";
      const take = (it.tt_summary || "").slice(0, 200);
      lines.push(`• [${cat}] ${headline}${take ? ` — ${take}` : ""}`);
    }
    // Themes + sectors in motion across the window.
    const themes = new Set();
    const sectors = new Set();
    for (const it of items) {
      for (const t of (it.themes_touched || [])) themes.add(t);
      for (const s of (it.sectors_touched || [])) sectors.add(s);
    }
    if (themes.size > 0) lines.push(`Themes in motion: ${Array.from(themes).slice(0, 8).join(", ")}.`);
    if (sectors.size > 0) lines.push(`Sectors in motion: ${Array.from(sectors).slice(0, 8).join(", ")}.`);
  } else {
    lines.push("No new publications in the last day — the overlay above is the current read.");
  }

  lines.push(
    "DIRECTIVE: Thread today's narrative through these FSD themes where the live tape supports them, in TT voice (concise, technical, no second-person, never name the source brand in body copy — attribution renders separately). Call out explicitly when the tape DIVERGES from the FSD read.",
  );
  return lines.join("\n");
}
