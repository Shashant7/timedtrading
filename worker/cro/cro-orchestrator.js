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
import { runCRODaily, ensureCRODailyNoteSchema } from "./cro-service.js";
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

  // 3. FSD ingestion. If FSD_USERNAME / FSD_PASSWORD aren't set OR the
  //    operator's `cro_fsd_ingestion_enabled` flag is off, skip gracefully.
  const fsdEnabled = await isFSDIngestionEnabled(env);
  if (!fsdEnabled) {
    summary.fsd_ingestion = { ok: true, skipped: "fsd_ingestion_disabled_in_model_config" };
  } else if (!env?.FSD_USERNAME || !env?.FSD_PASSWORD) {
    summary.fsd_ingestion = { ok: false, skipped: "missing_fsd_credentials" };
  } else {
    try {
      const r = await runFSDIngestion(env, { limit: 10, force });
      summary.fsd_ingestion = r;
    } catch (e) {
      summary.fsd_ingestion = { ok: false, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) };
    }
  }

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
          signals: ext.signals_count || 0,
          error_kind: ext.error_kind || null,
        });
        if (!ext.ok || !ext.proposal_id) continue;
        // Auto-apply gating.
        const allow = (ext.classification === "structural")
          ? autoApplyStructural
          : autoApply;
        if (!allow) {
          summary.applies.push({ pub_id: p.pub_id, proposal_id: ext.proposal_id, applied: false, reason: ext.classification === "structural" ? "structural_auto_apply_disabled" : "tactical_auto_apply_disabled" });
          continue;
        }
        const apply = await applyProposal(env, ext.proposal_id, { autoApproved: true, decidedBy: "cro_cron" });
        summary.applies.push({
          pub_id: p.pub_id, proposal_id: ext.proposal_id,
          applied: !!apply.ok,
          classification: ext.classification,
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

  summary.elapsed_ms = Date.now() - t0;

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
