// worker/cro/cro-orchestrator.js
// ─────────────────────────────────────────────────────────────────────────────
//  Cron orchestrator — runs the full CRO/CTO pipeline end-to-end on a schedule.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Sequence (one cron tick):
//    1. CTO universe rollup — runCTOUniverse (fastest; uses cached candles)
//    2. Rotation engine snapshot — runRotationSnapshot
//    3. FSD ingestion — runFSDIngestion (gated; if FSD scraper config not
//       yet validated, skips with a structured "operator needs to probe"
//       payload — never fails the whole cycle)
//    4. For each new publication: extract → propose → auto-apply (if
//       cro_auto_apply_tactical is on)
//    5. Daily synthesis — runCRODaily (consumes 1-4 + macro + discovery)
//
//  Each step is wrapped in best-effort try/catch + cron-tombstone
//  recording so a single failure never cascades. The whole cycle is
//  designed to be COMA-PROOF — runs autonomously without operator
//  intervention.

import { runFSDIngestion, ensureCROIngestionSchema, listRecentPublications } from "./fsd-ingestion.js";
import { extractPublicationToProposal, ensureCROProposalSchema } from "./fsd-extractor.js";
import { applyProposal, isAutoApplyEnabled, isAutoApplyStructuralEnabled } from "./cro-apply.js";
import { runRotationSnapshot } from "./rotation-engine.js";
import { runCRODaily, ensureCRODailyNoteSchema, loadLatestCRONote, getCROEtDate } from "./cro-service.js";
import { runCTOUniverse, ensureCTOSchema } from "../cto/cto-service.js";
import { rewritePendingPublications, ensureRewriteSchema } from "./fsd-rewriter.js";
import { backfillCashtagsForExistingPublications } from "./fsd-ingestion.js";

// 2026-06-03 — Macro snapshot freshness helper. Operator screenshot
// showed the CRO daily note flagging 'No macro snapshot available' as
// a data gap. Root cause: macro is only refreshed by the daily 22:00
// UTC cron, so any intraday CRO cycle run BEFORE 22:00 UTC reads a
// stale-or-missing snapshot. Fix: orchestrator now triggers
// runMacroSnapshot if the cached snapshot is missing OR > 6 hours old.
async function ensureMacroFreshness(env) {
  try {
    const Macro = await import("../macro/cross-asset-tracker.js");
    const snap = await Macro.loadMacroSnapshot(env).catch(() => null);
    const ageMs = snap?.computed_at ? Date.now() - Number(snap.computed_at) : Infinity;
    if (!snap || ageMs > 6 * 3600 * 1000) {
      const r = await Macro.runMacroSnapshot(env);
      return { kind: snap ? "refreshed_stale" : "first_run", ok: !!r?.ok, age_ms_before: ageMs };
    }
    return { kind: "fresh", ok: true, age_ms: ageMs };
  } catch (e) {
    return { kind: "error", ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// ── Auto-apply decision + needs-review handling (2026-06-04) ───────────────
// The extractor already computes per-proposal category + confidence + an
// auto-apply recommendation (worker/cro/fsd-extractor.js assessProposalAutoApply).
// Here we combine that with the global kill-switches so the operator only ever
// has to review proposals that are off-theme or that the model is unsure about.
const PROPOSALS_TABLE = "cro_playbook_proposals";

async function decideAutoApply(env, ext, { autoApply, autoApplyStructural }) {
  // Global kill-switches (operator can disable all auto-apply).
  const isStructural = ext.category === "structural" || ext.classification === "structural";
  if (isStructural && !autoApplyStructural) {
    return { apply: false, reason: ext.auto_apply_reason || "structural_review_required" };
  }
  if (!isStructural && !autoApply) {
    return { apply: false, reason: "tactical_auto_apply_disabled" };
  }
  // Per-proposal confidence / on-theme gate (computed at extraction).
  if (ext.auto_apply_recommended === false) {
    return { apply: false, reason: ext.auto_apply_reason || "needs_review" };
  }
  return { apply: true, reason: ext.auto_apply_reason || "confident_on_theme" };
}

async function markProposalNeedsReview(env, proposalId, reason) {
  try {
    await env.DB.prepare(
      `UPDATE ${PROPOSALS_TABLE}
          SET review_status = 'needs_review', auto_apply_reason = ?2
        WHERE proposal_id = ?1`,
    ).bind(proposalId, String(reason || "needs_review").slice(0, 200)).run();
  } catch (_) { /* best-effort */ }
}

// 2026-06-05 — Cycle-end pending-review digest. The per-item alert above only
// fires at the moment of extraction, so proposals extracted in an earlier
// cycle (before this code, or skipped as already-extracted) never alerted the
// operator. This sweeps the CURRENT pending+needs_review set after each cycle
// and sends ONE Discord digest — deduped by the proposal-id set so it only
// re-alerts when the set actually changes (new items arrive).
async function notifyPendingReviewDigest(env) {
  try {
    if (!env?.DB) return;
    const rows = await env.DB.prepare(
      `SELECT proposal_id, pub_id, classification, confidence, auto_apply_reason
         FROM ${PROPOSALS_TABLE}
        WHERE status = 'pending' AND review_status = 'needs_review'
        ORDER BY created_at DESC LIMIT 20`,
    ).all().catch(() => ({ results: [] }));
    const pending = rows?.results || [];
    const key = "cro:pending_review:last_alert_sig";
    const sig = pending.map((p) => p.proposal_id).sort().join(",");
    let prevSig = null;
    try { prevSig = await env.KV?.get(key); } catch (_) {}
    if (pending.length === 0) {
      // Clear the signature so the next pending item re-alerts cleanly.
      if (prevSig) { try { await env.KV?.delete(key); } catch (_) {} }
      return;
    }
    if (prevSig === sig) return; // unchanged set — already alerted
    const { notifyDiscord } = await import("../alerts.js");
    await notifyDiscord(env, {
      title: `[CRO] ${pending.length} FSD proposal${pending.length === 1 ? "" : "s"} need review`,
      description: "Off-theme / low-confidence proposals are waiting for an Approve / Reject decision on the Research Desk.",
      color: 0xf59e0b,
      fields: pending.slice(0, 5).map((p) => ({
        name: `${p.classification || "tactical"} · conf ${p.confidence != null ? Math.round(Number(p.confidence) * 100) + "%" : "n/a"}`,
        value: `pub ${p.pub_id} — ${String(p.auto_apply_reason || "review").slice(0, 100)}`,
        inline: false,
      })),
      footer: { text: "Research Desk → What we ingested & what it influenced → Approve / Reject" },
      timestamp: new Date().toISOString(),
    }, "system");
    try { await env.KV?.put(key, sig, { expirationTtl: 7 * 86400 }); } catch (_) {}
  } catch (_) { /* digest is best-effort — never block the cycle */ }
}

async function notifyProposalNeedsReview(env, pub, ext, reason) {
  try {
    const { notifyDiscord } = await import("../alerts.js");
    await notifyDiscord(env, {
      title: "[CRO] Proposal needs operator review",
      description: (pub?.title || pub?.pub_id || "publication").slice(0, 200),
      color: 0xf59e0b,
      fields: [
        { name: "Proposal", value: `${ext.proposal_id}`, inline: true },
        { name: "Category", value: `${ext.category || ext.classification || "?"}`, inline: true },
        { name: "Confidence", value: ext.confidence != null ? ext.confidence.toFixed(2) : "n/a", inline: true },
        { name: "Why held", value: String(reason || "review").slice(0, 300), inline: false },
        { name: "Review", value: "Research Desk → Proposed changes (Approve / Reject)", inline: false },
      ],
      timestamp: new Date().toISOString(),
    }, "system");
  } catch (_) { /* alerts never block the cycle */ }
}

// Refresh today's CRO note when new FSD intel arrives intraday. Skips the
// expensive LLM call when today's note is already newer than the latest pub.
async function maybeRefreshCRODailyNote(env, { hadNewExtractions = false, hadNewRewrites = false } = {}) {
  if (!hadNewExtractions && !hadNewRewrites) {
    return { ok: true, skipped: "no_new_fsd_activity" };
  }
  try {
    await ensureCRODailyNoteSchema(env);
    const recent = await listRecentPublications(env, { limit: 5 });
    const newestFetched = Math.max(0, ...(recent || []).map((p) => Number(p.fetched_at || 0)));
    const note = await loadLatestCRONote(env);
    const today = getCROEtDate();
    if (note?.as_of_date === today && Number(note.produced_at || 0) >= newestFetched) {
      return { ok: true, skipped: "note_fresh_enough", note_id: note.note_id || null };
    }
    const r = await runCRODaily(env, { force: true });
    return {
      ok: !!r.ok,
      skipped: r.skipped || null,
      note_id: r.note_id || null,
      elapsed_ms: r.elapsed_ms || null,
      error_kind: r.error_kind || null,
    };
  } catch (e) {
    return { ok: false, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) };
  }
}

// ── Public entry point: lightweight INTRADAY cycle ─────────────────────────
// Operator hit Workers CPU billing threshold (25M ms / month) twice in one
// day. Root cause: the hourly business-hours cron (0 13-21 * * 1-5 = 9
// fires per weekday) was calling runCROFullCycle, which re-runs CTO
// universe (50 tickers × candle loads + Markov + Fib + hit-rate stats) +
// rotation engine (12 pairs × daily candles + correlation) every hour.
// Those inputs are daily candles — they don't change intraday — yet we
// were burning ~30-40 CPU-seconds per hour to recompute the same answer.
//
// runCROIntradayCycle does ONLY the FSD pipeline (ingest + extract +
// apply). CTO + rotation stay in runCROFullCycle, which the daily 22:00
// UTC cron continues to call. ~70-80% CPU saved on the hourly intraday lane.
export async function runCROIntradayCycle(env, { force = false } = {}) {
  const t0 = Date.now();
  const summary = {
    ok: true,
    started_at: t0,
    elapsed_ms: null,
    cto: { skipped: "intraday_skips_cto_universe" },
    rotation: { skipped: "intraday_skips_rotation_engine" },
    fsd_ingestion: { ok: false, skipped: null },
    extractions: [],
    applies: [],
    cro_daily: { ok: false, skipped: "not_run" },
    cashtag_backfill: { ok: false, skipped: "not_run" },
    rewrite_pending: { ok: false, skipped: "not_run" },
    errors: [],
    cycle_kind: "intraday",
  };

  try {
    await ensureCROIngestionSchema(env);
    await ensureCROProposalSchema(env);
  } catch (e) {
    summary.errors.push(`schema_ensure_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  const fsdEnabled = await isFSDIngestionEnabled(env);
  if (!fsdEnabled) {
    summary.fsd_ingestion = { ok: true, skipped: "fsd_ingestion_disabled_in_model_config" };
  } else {
    try {
      const r = await runFSDIngestion(env, { limit: 10, force });
      summary.fsd_ingestion = r;
    } catch (e) {
      summary.fsd_ingestion = { ok: false, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) };
    }
  }
  await writeTombstone(env, summary).catch(() => {});

  try {
    const recent = await listRecentPublications(env, { limit: 15, sourceFilter: null });
    const autoApply = await isAutoApplyEnabled(env);
    const autoApplyStructural = await isAutoApplyStructuralEnabled(env);
    for (const p of recent) {
      if (p.fetch_status !== "ok" || p.extracted_at) continue;
      try {
        const ext = await extractPublicationToProposal(env, p.pub_id, { force: false });
        summary.extractions.push({
          pub_id: p.pub_id, ok: !!ext.ok,
          proposal_id: ext.proposal_id || null,
          classification: ext.classification || null,
          category: ext.category || null,
          confidence: ext.confidence ?? null,
          review_status: ext.review_status || null,
          error_kind: ext.error_kind || null,
        });
        if (!ext.ok || !ext.proposal_id) continue;
        const decision = await decideAutoApply(env, ext, { autoApply, autoApplyStructural });
        if (!decision.apply) {
          summary.applies.push({ pub_id: p.pub_id, proposal_id: ext.proposal_id, applied: false, reason: decision.reason, review_status: "needs_review" });
          await markProposalNeedsReview(env, ext.proposal_id, decision.reason);
          await notifyProposalNeedsReview(env, p, ext, decision.reason);
          continue;
        }
        const apply = await applyProposal(env, ext.proposal_id, { autoApproved: true, decidedBy: "cro_intraday" });
        summary.applies.push({
          pub_id: p.pub_id, proposal_id: ext.proposal_id,
          applied: !!apply.ok, classification: ext.classification,
          review_status: "auto_applied",
          error_kind: apply.error_kind || null,
        });
      } catch (e) {
        summary.errors.push(`extract_apply_failed:${p.pub_id}: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  } catch (e) {
    summary.errors.push(`extract_apply_loop: ${String(e?.message || e).slice(0, 200)}`);
  }

  // TT-voice rewrite — was skipped in intraday, leaving publications stuck at
  // "Ingested" with no synthesis in the Research Desk feed.
  try {
    await ensureRewriteSchema(env);
    const r = await rewritePendingPublications(env, { limit: 10 });
    summary.rewrite_pending = {
      ok: !!r.ok,
      considered: r.considered || 0,
      rewrote_ok: r.rewrote_ok || 0,
      errors: r.errors || 0,
    };
  } catch (e) {
    summary.errors.push(`rewrite_pending_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // Refresh today's CRO daily note when fresh FSD intel landed (lightweight
  // synthesis — skips if note is already newer than the latest publication).
  try {
    const hadNewExtractions = (summary.extractions || []).some((x) => x.ok);
    const hadNewRewrites = (summary.rewrite_pending?.rewrote_ok || 0) > 0;
    summary.cro_daily = await maybeRefreshCRODailyNote(env, { hadNewExtractions, hadNewRewrites });
  } catch (e) {
    summary.errors.push(`cro_daily_refresh_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // Always refresh the public Research Desk KV cache — even when no new pubs
  // were ingested this tick (operator reported stale Today feed).
  try {
    summary.research_feed = await refreshResearchFeedKv(env);
  } catch (e) {
    summary.errors.push(`research_feed_refresh_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  await notifyPendingReviewDigest(env).catch(() => {});
  summary.elapsed_ms = Date.now() - t0;
  await writeTombstone(env, summary).catch(() => {});
  return summary;
}

// ── Public entry point: run the whole CRO/CTO cycle ──────────────────────────
export async function runCROFullCycle(env, { force = false } = {}) {
  const t0 = Date.now();
  const summary = {
    ok: true,
    started_at: t0,
    elapsed_ms: null,
    cto: { ok: false },
    rotation: { ok: false },
    fsd_ingestion: { ok: false, skipped: null },
    extractions: [],
    applies: [],
    cro_daily: { ok: false },
    cashtag_backfill: { ok: false, skipped: "not_run" },
    rewrite_pending: { ok: false, skipped: "not_run" },
    macro_freshness: { ok: false, skipped: "not_run" },
    errors: [],
  };

  // 0. Ensure all schemas exist (idempotent CREATE TABLE IF NOT EXISTS).
  try {
    await ensureCROIngestionSchema(env);
    await ensureCROProposalSchema(env);
    await ensureCRODailyNoteSchema(env);
    await ensureCTOSchema(env);
  } catch (e) {
    summary.errors.push(`schema_ensure_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 1. CTO universe rollup. Always runs; cheap and the CRO synthesis depends on it.
  try {
    const r = await runCTOUniverse(env, { limit: 50 });
    summary.cto = {
      ok: !!r.ok,
      tickers_processed: r.tickers_processed,
      tickers_ok: r.tickers_ok,
      headlines_count: (r.headlines || []).length,
      elapsed_ms: r.elapsed_ms,
    };
  } catch (e) {
    summary.errors.push(`cto_failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  await writeTombstone(env, summary).catch(() => {});

  // 2. Rotation engine snapshot. Cheap; needed by CRO + CIO downstream.
  try {
    const r = await runRotationSnapshot(env, { force: true });
    summary.rotation = {
      ok: !!r.ok,
      headlines_count: (r.headlines || []).length,
      with_data: r.with_data,
      universe_size: r.universe_size,
      elapsed_ms: r.elapsed_ms,
    };
  } catch (e) {
    summary.errors.push(`rotation_failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  await writeTombstone(env, summary).catch(() => {});

  // 3. FSD ingestion.
  //
  // 2026-06-03 — The credential gate (FSD_USERNAME + FSD_PASSWORD) was
  // a LEGACY check for the deprecated HTML login-scrape path. The
  // current default is WordPress REST (`scrape_mode: "wp_rest"`), which
  // hits public endpoints (`/wp-json/wp/v2/posts`, `.../fsi-alert`,
  // `.../fsi-alert-crypto`) and does NOT require credentials. The old
  // gate was silently skipping every ingestion run with
  // `missing_fsd_credentials`, leaving the catalog empty and the
  // Catalysts tab dark — the user reported a fresh GOOGL FlashInsight
  // (post id 1534059, 2026-06-03 12:11) was never picked up.
  //
  // Now we always run the ingestion (gated only by the operator's
  // `cro_fsd_ingestion_enabled` model_config flag). The client itself
  // surfaces credential gaps if the operator ever flips back to the
  // legacy HTML scrape mode via `cro:fsd:config` KV override.
  const fsdEnabled = await isFSDIngestionEnabled(env);
  if (!fsdEnabled) {
    summary.fsd_ingestion = { ok: true, skipped: "fsd_ingestion_disabled_in_model_config" };
  } else {
    try {
      const r = await runFSDIngestion(env, { limit: 10, force });
      summary.fsd_ingestion = r;
    } catch (e) {
      summary.fsd_ingestion = { ok: false, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) };
    }
  }
  await writeTombstone(env, summary).catch(() => {});

  // 4. For each newly-ingested (or recently-failed-to-extract) publication,
  //    run the LLM extractor and (if auto-apply is on) apply.
  try {
    const recent = await listRecentPublications(env, { limit: 15, sourceFilter: null });
    const autoApply = await isAutoApplyEnabled(env);
    const autoApplyStructural = await isAutoApplyStructuralEnabled(env);
    for (const p of recent) {
      // Only process publications that have been ingested OK but not yet extracted.
      if (p.fetch_status !== "ok") continue;
      if (p.extracted_at) continue;
      try {
        const ext = await extractPublicationToProposal(env, p.pub_id, { force: false });
        summary.extractions.push({
          pub_id: p.pub_id, ok: !!ext.ok,
          proposal_id: ext.proposal_id || null,
          classification: ext.classification || null,
          category: ext.category || null,
          confidence: ext.confidence ?? null,
          review_status: ext.review_status || null,
          signals: ext.signals_count || 0,
          error_kind: ext.error_kind || null,
        });
        if (!ext.ok || !ext.proposal_id) continue;
        // Auto-apply gate: confident + on-theme proposals apply; off-theme /
        // low-confidence / structural ones are held for operator review.
        const decision = await decideAutoApply(env, ext, { autoApply, autoApplyStructural });
        if (!decision.apply) {
          summary.applies.push({ pub_id: p.pub_id, proposal_id: ext.proposal_id, applied: false, reason: decision.reason, review_status: "needs_review" });
          await markProposalNeedsReview(env, ext.proposal_id, decision.reason);
          await notifyProposalNeedsReview(env, p, ext, decision.reason);
          continue;
        }
        const apply = await applyProposal(env, ext.proposal_id, { autoApproved: true, decidedBy: "cro_cron" });
        summary.applies.push({
          pub_id: p.pub_id, proposal_id: ext.proposal_id,
          applied: !!apply.ok,
          classification: ext.classification,
          review_status: "auto_applied",
          error_kind: apply.error_kind || null,
        });
      } catch (e) {
        summary.errors.push(`extract_apply_failed:${p.pub_id}: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  } catch (e) {
    summary.errors.push(`extract_apply_loop: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 4b. One-time cashtag backfill — covers any pre-existing publications
  // that were ingested before per-ticker tagging shipped. KV lock keeps
  // this from re-running once successful; the cron path becomes a no-op
  // until the operator flips the lock OR the backfill block returns >0
  // new tags (in which case we leave it eligible for the next round of
  // pubs that need retagging).
  try {
    const LOCK_KEY = "cro:cashtag_backfill:done";
    const done = await env?.KV?.get(LOCK_KEY);
    if (!done) {
      const r = await backfillCashtagsForExistingPublications(env, { limit: 100 });
      summary.cashtag_backfill = {
        ok: !!r.ok,
        considered: r.pubs_processed || 0,
        tags_written: r.total_tags_written || 0,
      };
      // Lock for 7d; orchestrator re-runs after that to catch any newly-ingested
      // pubs that somehow slipped through the per-ingest tagging path.
      if (r.ok) await env.KV.put(LOCK_KEY, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
    } else {
      summary.cashtag_backfill = { ok: true, skipped: "kv_locked" };
    }
  } catch (e) {
    summary.errors.push(`cashtag_backfill_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 4c. TT-voice rewrite for any publications without a rewrite yet.
  // Runs LATE in the cycle so it doesn't slow ingest + apply; the
  // Catalysts tab falls back to raw excerpt when rewrite hasn't run yet.
  try {
    await ensureRewriteSchema(env);
    const r = await rewritePendingPublications(env, { limit: 8 });
    summary.rewrite_pending = {
      ok: !!r.ok,
      considered: r.considered || 0,
      rewrote_ok: r.rewrote_ok || 0,
      errors: r.errors || 0,
    };
  } catch (e) {
    summary.errors.push(`rewrite_pending_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 4d. Macro snapshot freshness — refresh if missing or > 6h old.
  // The CRO daily synthesis was flagging 'no macro snapshot available'
  // as a data gap on intraday cycles because the macro cron only fires
  // at 22:00 UTC daily.
  try {
    summary.macro_freshness = await ensureMacroFreshness(env);
  } catch (e) {
    summary.errors.push(`macro_freshness_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 5. CRO daily synthesis. Runs after all inputs are refreshed.
  try {
    const r = await runCRODaily(env, { force });
    summary.cro_daily = {
      ok: !!r.ok,
      skipped: r.skipped || null,
      note_id: r.note_id || null,
      elapsed_ms: r.elapsed_ms || null,
      error_kind: r.error_kind || null,
    };
  } catch (e) {
    summary.errors.push(`cro_daily_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  try {
    summary.research_feed = await refreshResearchFeedKv(env);
  } catch (e) {
    summary.errors.push(`research_feed_refresh_failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  await notifyPendingReviewDigest(env).catch(() => {});
  summary.elapsed_ms = Date.now() - t0;
  await writeTombstone(env, summary).catch(() => {});

  // Best-effort Discord notification on critical failures. We notify if
  // EITHER the CRO daily synthesis failed OR FSD ingestion failed with a
  // non-skipped error. Skips (gate disabled / no credentials) are silent.
  try {
    const fsdHardFail = summary.fsd_ingestion && summary.fsd_ingestion.ok === false && !summary.fsd_ingestion.skipped;
    const synthFail = summary.cro_daily && summary.cro_daily.ok === false;
    if (fsdHardFail || synthFail || (summary.errors && summary.errors.length > 0)) {
      const { notifyDiscord } = await import("../alerts.js");
      const fields = [];
      if (fsdHardFail) fields.push({ name: "FSD ingestion FAILED", value: `${summary.fsd_ingestion.error_kind || "?"}: ${(summary.fsd_ingestion.hint || "").slice(0, 200)}`, inline: false });
      if (synthFail) fields.push({ name: "CRO synthesis FAILED", value: `${summary.cro_daily.error_kind || "?"}`, inline: false });
      if (summary.errors && summary.errors.length > 0) fields.push({ name: `${summary.errors.length} other errors`, value: summary.errors.slice(0, 3).join("\n").slice(0, 800), inline: false });
      fields.push({ name: "Remediation", value: "POST /timed/admin/cro/fsd/probe → tune cro:fsd:config if site changed. Or set model_config cro_fsd_ingestion_enabled = false to silence.", inline: false });
      await notifyDiscord(env, {
        title: "[CRO/CTO daily] cycle reported failures",
        description: `CTO ok=${summary.cto?.ok} (${summary.cto?.tickers_ok || 0}/${summary.cto?.tickers_processed || 0}). Rotation ok=${summary.rotation?.ok}. CRO synthesis ok=${summary.cro_daily?.ok}.`,
        color: 0xe67e22,
        fields,
        timestamp: new Date().toISOString(),
      }, "system");
    } else if (summary.applies && summary.applies.filter((a) => a.applied).length > 0) {
      // Healthy run with applies — quiet info notification.
      const applied = summary.applies.filter((a) => a.applied);
      const { notifyDiscord } = await import("../alerts.js");
      await notifyDiscord(env, {
        title: "[CRO/CTO daily] cycle complete",
        description: `${applied.length} proposal${applied.length === 1 ? "" : "s"} auto-applied`,
        color: 0x2ecc71,
        fields: [
          { name: "CTO universe", value: `${summary.cto?.tickers_ok || 0}/${summary.cto?.tickers_processed || 0} tickers`, inline: true },
          { name: "Rotation", value: `${summary.rotation?.headlines_count || 0} headlines`, inline: true },
          { name: "FSD ingested", value: `${summary.fsd_ingestion?.ingested || 0}`, inline: true },
          { name: "Auto-applied", value: applied.slice(0, 5).map((a) => `\`${a.proposal_id}\` (${a.classification})`).join("\n") || "(none)", inline: false },
        ],
        timestamp: new Date().toISOString(),
      }, "system");
    }
  } catch (_) { /* alerts never block the cycle */ }

  return summary;
}

// ── Gating helpers ────────────────────────────────────────────────────────────
// Defaults TRUE per operator's "coma-proof" directive. If the FSD scraper
// can't reach FSD (credentials missing, login flow drift), runFSDIngestion
// returns {ok:false, error_kind, hint} cleanly — the orchestrator surfaces
// the failure in the cron summary + Discord alert, the rest of the cycle
// (CTO + rotation + CRO synthesis on previously-ingested pubs) still runs.
// Operator opt-out: set model_config row cro_fsd_ingestion_enabled = "false".
async function isFSDIngestionEnabled(env) {
  const cached = env?._deepAuditConfig?.cro_fsd_ingestion_enabled;
  if (cached === false || String(cached).toLowerCase() === "false" || String(cached) === "0") return false;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (!env?.DB) return true;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_fsd_ingestion_enabled'`,
    ).first();
    if (!row) return true;
    const v = row.config_value;
    if (v === false || String(v).toLowerCase() === "false" || String(v) === "0") return false;
    return true;
  } catch (_) { return true; }
}

// ── Probe-only entry point (operator one-click validation) ────────────────────
export async function runCROProbe(env) {
  const out = {
    schema_ready: false,
    fsd_credentials_present: !!(env?.FSD_USERNAME && env?.FSD_PASSWORD),
    fsd_ingestion_gate: await isFSDIngestionEnabled(env),
    auto_apply_tactical: await isAutoApplyEnabled(env),
    auto_apply_structural: await isAutoApplyStructuralEnabled(env),
    openai_credentials_present: !!env?.OPENAI_API_KEY,
  };
  try {
    await ensureCROIngestionSchema(env);
    await ensureCROProposalSchema(env);
    await ensureCRODailyNoteSchema(env);
    await ensureCTOSchema(env);
    out.schema_ready = true;
  } catch (_) {}
  return out;
}

// ── Tombstone writer (2026-06-03) ──────────────────────────────────────
// Persists the cycle summary to KV `timed:cro:last_summary` after every
// major step. Operator's window into the orchestrator without admin auth
// — even when later steps fail or get killed by CPU limits, the previous
// steps' health is visible. 7-day TTL.
export async function refreshResearchFeedKv(env) {
  const { buildPublicFSDFeed } = await import("./influence-ledger.js");
  const feed = await buildPublicFSDFeed(env, { limit: 50, lookbackHours: 7 * 24 });
  return {
    ok: !!feed.ok,
    count: feed.count || 0,
    kv_sync: feed.kv_sync || null,
    error_kind: feed.error_kind || null,
  };
}

async function writeTombstone(env, summary) {
  try {
    const KV = env?.KV_TIMED || env?.KV;
    if (!KV) return;
    const tombstone = {
      started_at: summary.started_at,
      finished_at: Date.now(),
      elapsed_ms: Date.now() - (summary.started_at || Date.now()),
      ok: !summary.errors || summary.errors.length === 0,
      cto: summary.cto ? {
        ok: !!summary.cto.ok,
        tickers_processed: summary.cto.tickers_processed || 0,
        tickers_ok: summary.cto.tickers_ok || 0,
        error_kind: summary.cto.error_kind || null,
      } : null,
      rotation: summary.rotation ? {
        ok: !!summary.rotation.ok,
        headlines_count: summary.rotation.headlines_count || 0,
      } : null,
      fsd_ingestion: summary.fsd_ingestion ? {
        ok: !!summary.fsd_ingestion.ok,
        ingested: summary.fsd_ingestion.ingested || 0,
        skipped: summary.fsd_ingestion.skipped || null,
        error_kind: summary.fsd_ingestion.error_kind || null,
        hint: (summary.fsd_ingestion.hint || "").slice(0, 200),
      } : null,
      extractions: Array.isArray(summary.extractions) ? summary.extractions.length : 0,
      applies_count: Array.isArray(summary.applies) ? summary.applies.filter((a) => a.applied).length : 0,
      cashtag_backfill: summary.cashtag_backfill ? {
        ok: !!summary.cashtag_backfill.ok,
        skipped: summary.cashtag_backfill.skipped || null,
        pubs_processed: summary.cashtag_backfill.pubs_processed || 0,
        total_tags_written: summary.cashtag_backfill.total_tags_written || 0,
      } : null,
      rewrite_pending: summary.rewrite_pending ? {
        ok: !!summary.rewrite_pending.ok,
        skipped: summary.rewrite_pending.skipped || null,
        rewrote_ok: summary.rewrite_pending.rewrote_ok || 0,
      } : null,
      cro_daily: summary.cro_daily ? {
        ok: !!summary.cro_daily.ok,
        error_kind: summary.cro_daily.error_kind || null,
      } : null,
      errors: Array.isArray(summary.errors) ? summary.errors.slice(0, 8) : [],
    };
    await KV.put("timed:cro:last_summary", JSON.stringify(tombstone), { expirationTtl: 7 * 24 * 3600 });
  } catch (e) {
    // Log but never block the cycle on tombstone write
    try { console.warn("[CRO TOMBSTONE] write failed:", String(e?.message || e).slice(0, 200)); } catch (_) {}
  }
}
