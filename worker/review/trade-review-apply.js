// worker/review/trade-review-apply.js
//
// What an approved review actually DOES.
//
// Approve / Modify routes the finding three ways, by kind:
//   config  → learning_proposals (the existing unified apply bus, tier2 so
//             a review can never silently mutate the live model)
//   engine  → a one-page proposal row destined for GitHub
//   any     → an exec memo the CIO / CRO / COO desks read
//
// Reject records the disagreement and routes nothing. Rejections are kept
// because a reviewer that is often overruled is itself a calibration
// signal.

import { ensureTradeReviewSchema } from "./trade-review-schema.js";
import { submitProposal } from "../learning-proposals.js";

const EXEC_MEMO_KV_KEY = "timed:exec:memos";
const EXEC_MEMO_RING = 40;
const MEMO_TTL_DAYS = 45;

function nowMs() { return Date.now(); }

function parseJson(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return fallback; }
}

function shortId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Merge the operator's edits over the agent's analysis. Modify means the
 * operator's version becomes the record of truth — the original stays in
 * analysis_json for audit, the patch is what gets applied.
 */
export function mergeOperatorPatch(analysis, patch) {
  const base = analysis && typeof analysis === "object" ? { ...analysis } : {};
  if (!patch || typeof patch !== "object") return base;
  const out = { ...base };
  for (const key of ["grade", "verdict", "headline", "price_action", "assessment", "capture_commentary"]) {
    if (typeof patch[key] === "string" && patch[key].trim()) out[key] = patch[key].trim().slice(0, 2000);
  }
  if (Array.isArray(patch.failure_modes)) {
    out.failure_modes = patch.failure_modes.filter((f) => typeof f === "string" && f.trim()).slice(0, 8);
  }
  if (Array.isArray(patch.engine_findings)) {
    out.engine_findings = patch.engine_findings.filter((f) => f && typeof f === "object" && f.finding);
  }
  if (typeof patch.should_have_held === "boolean") out.should_have_held = patch.should_have_held;
  const prob = Number(patch.probability_of_success);
  if (Number.isFinite(prob) && prob >= 0 && prob <= 1) out.probability_of_success = prob;
  return out;
}

/** Write a memo to the desk feed: D1 for history, KV for the hot read path. */
export async function writeExecMemo(env, { source, audience, ticker, headline, bodyMd, evidence, weight = 1 }) {
  if (!env?.DB || !headline) return { ok: false, error: "bad_memo" };
  await ensureTradeReviewSchema(env);
  const memoId = shortId("memo");
  const created = nowMs();
  const audienceCsv = (Array.isArray(audience) ? audience : String(audience || "cio,cro,coo").split(","))
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean)
    .join(",");
  try {
    await env.DB.prepare(
      `INSERT INTO exec_memos (memo_id, source, audience, ticker, headline, body_md, evidence_json, weight, status, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10)`
    ).bind(
      memoId, String(source || "trade_review"), audienceCsv, ticker ? String(ticker).toUpperCase() : null,
      String(headline).slice(0, 300), bodyMd ? String(bodyMd).slice(0, 6000) : null,
      JSON.stringify(evidence || {}), Number(weight) || 1, created,
      created + MEMO_TTL_DAYS * 86_400_000,
    ).run();
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }

  // KV ring so the CIO memory loader gets the feed in one read.
  try {
    const KV = env?.KV_TIMED;
    if (KV) {
      const prev = parseJson(await KV.get(EXEC_MEMO_KV_KEY), []) || [];
      const next = [
        { memo_id: memoId, source, audience: audienceCsv, ticker: ticker || null, headline, created_at: created },
        ...(Array.isArray(prev) ? prev : []),
      ].slice(0, EXEC_MEMO_RING);
      await KV.put(EXEC_MEMO_KV_KEY, JSON.stringify(next), { expirationTtl: MEMO_TTL_DAYS * 86_400 });
    }
  } catch (e) {
    console.warn("[TRADE_REVIEW] memo KV mirror failed:", String(e?.message || e).slice(0, 140));
  }
  return { ok: true, memo_id: memoId };
}

/**
 * Render an engine finding as a one-page requirement. Written as a spec a
 * coding agent can execute, not as a narrative.
 */
export function buildOnePager({ finding, review, context, analysis }) {
  const t = context?.trade || {};
  const cap = context?.tape?.capture || {};
  const claim = context?.engine_claim || {};
  const legLabel = `${review.leg_kind}${review.leg_seq ? ` #${review.leg_seq + 1}` : ""}`;
  const pctOrNa = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? "n/a" : `${Number(v).toFixed(d)}%`);

  const title = `[trade-review] ${finding.finding}`.slice(0, 240);
  const body = [
    `## Problem`,
    ``,
    finding.finding,
    ``,
    finding.rationale ? `${finding.rationale}\n` : ``,
    `## Evidence`,
    ``,
    `Surfaced by the Trade Review Agent grading the **${legLabel}** leg of \`${review.trade_id}\` (${t.ticker || "?"} ${t.direction || "?"}).`,
    ``,
    `| Fact | Value |`,
    `|---|---|`,
    `| Engine setup claim | ${claim.setup_name || "n/a"} (grade ${claim.setup_grade || "n/a"}, path \`${claim.entry_path || "n/a"}\`) |`,
    `| Reviewer grade / verdict | ${analysis?.grade || "n/a"} / ${analysis?.verdict || "n/a"} |`,
    `| Realized | ${pctOrNa(cap.realized_pct)} |`,
    `| MFE while open | ${pctOrNa(cap.mfe_pct)} |`,
    `| MAE while open | ${pctOrNa(cap.mae_pct)} |`,
    `| Capture of in-trade MFE | ${cap.capture_ratio == null ? "n/a" : `${(cap.capture_ratio * 100).toFixed(0)}%`} |`,
    `| Dominant move in window | ${cap.big_move ? pctOrNa(cap.big_move.pct) : "n/a"} |`,
    `| Share of that move captured | ${cap.big_move_capture_ratio == null ? "n/a" : `${(cap.big_move_capture_ratio * 100).toFixed(0)}%`} |`,
    `| Move left after exit | ${pctOrNa(cap.post_exit_pct)} |`,
    ``,
    analysis?.price_action ? `**Price action:** ${analysis.price_action}\n` : ``,
    analysis?.assessment ? `**Assessment:** ${analysis.assessment}\n` : ``,
    `## Requirement`,
    ``,
    finding.kind === "config"
      ? `Config change: set \`${finding.config_key}\` to \`${finding.proposed_value}\`. A matching proposal has been queued on the \`learning_proposals\` bus for operator approval — this issue tracks any code needed to make that key take effect.`
      : `Engine change. Implement behind a \`model_config\` flag, default OFF, following the gate-pack pattern in \`worker/july-autopsy-gates.js\`.`,
    ``,
    `## Acceptance criteria`,
    ``,
    `- [ ] Behaviour is flag-gated and defaults to OFF.`,
    `- [ ] Unit tests pin this trade's leg as a case (\`${review.trade_id}\`, ${legLabel}).`,
    `- [ ] A replay arm over the affected month shows no regression vs the current baseline (see \`skills/backtest-replay.md\`).`,
    `- [ ] \`tasks/\` documents the validation result and the go-live flag.`,
    ``,
    `## Scope`,
    ``,
    finding.scope === "recurring"
      ? `Reviewer marked this as a RECURRING pattern — expect more than one trade to be affected. Confirm the population before tuning.`
      : `Reviewer marked this as a ONE-OFF. Confirm it generalises before changing engine behaviour; a single trade is not a population.`,
    ``,
    `---`,
    `_Filed automatically by the Trade Review Agent. Review \`${review.review_id}\`._`,
  ].filter((l) => l !== ``).join("\n");

  return { title, body };
}

/**
 * Apply a decided review. Called for approve and modify; reject short-
 * circuits before this.
 *
 * @returns {{ok:boolean, applied:{proposals:Array, memo_id:?string, one_pagers:Array}}}
 */
export async function applyTradeReview(env, { review, analysis, operatorNote, decidedBy }) {
  await ensureTradeReviewSchema(env);
  const context = parseJson(review?.context_json, {}) || {};
  const applied = { proposals: [], one_pagers: [], memo_id: null, skipped: [] };
  const findings = Array.isArray(analysis?.engine_findings) ? analysis.engine_findings : [];

  for (const f of findings) {
    if (!f || f.kind === "none") { applied.skipped.push(f?.finding || "unnamed"); continue; }

    if (f.kind === "config" && f.config_key && f.proposed_value != null) {
      const res = await submitProposal(env, {
        source: "trade_review",
        kind: "config_change",
        config_key: f.config_key,
        proposed_value: f.proposed_value,
        // Always tier2: a single-trade review is never allowed to auto-mutate
        // the live model, however confident the reviewer is.
        tier: "tier2",
        evidence: {
          review_id: review.review_id,
          trade_id: review.trade_id,
          ticker: review.ticker,
          leg: `${review.leg_kind}#${review.leg_seq}`,
          grade: analysis?.grade || null,
          verdict: analysis?.verdict || null,
          scope: f.scope,
          rationale: f.rationale,
          capture: parseJson(review.capture_json, null),
          operator_note: operatorNote || null,
        },
        note: `[trade-review] ${String(f.finding).slice(0, 180)}`,
      });
      applied.proposals.push({ finding: f.finding, config_key: f.config_key, ok: res.ok, proposal_id: res.id ?? null });
      continue;
    }

    // Engine work → a one-pager row the operator can mark agent-ready.
    const { title, body } = buildOnePager({ finding: f, review, context, analysis });
    const proposalId = shortId("trp");
    const created = nowMs();
    try {
      await env.DB.prepare(
        `INSERT INTO trade_review_proposals
           (proposal_id, review_id, trade_id, ticker, kind, title, body_md, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?9)`
      ).bind(
        proposalId, review.review_id, review.trade_id, review.ticker || null,
        f.kind === "config" ? "config" : "engine", title, body, decidedBy || "operator", created,
      ).run();
      applied.one_pagers.push({ proposal_id: proposalId, title, status: "draft" });
    } catch (e) {
      applied.one_pagers.push({ ok: false, error: String(e?.message || e).slice(0, 150) });
    }
  }

  // Always memo the desks — even a review with no engine finding is a
  // graded outcome the CIO should weigh next time it sees this setup.
  const memoBody = [
    analysis?.headline ? `**${analysis.headline}**` : null,
    analysis?.assessment || null,
    analysis?.capture_commentary || null,
    operatorNote ? `\n_Operator:_ ${operatorNote}` : null,
  ].filter(Boolean).join("\n\n");

  const memo = await writeExecMemo(env, {
    source: "trade_review",
    audience: ["cio", "cro", "coo"],
    ticker: review.ticker,
    headline: `${review.ticker || "?"} ${review.leg_kind} graded ${analysis?.grade || "?"}: ${analysis?.verdict || "no verdict"}`,
    bodyMd: memoBody,
    evidence: {
      review_id: review.review_id,
      trade_id: review.trade_id,
      setup_name: context?.engine_claim?.setup_name || null,
      entry_path: context?.engine_claim?.entry_path || null,
      capture: parseJson(review.capture_json, null),
      failure_modes: analysis?.failure_modes || [],
    },
    // A recurring finding should weigh more on the desks than a one-off.
    weight: findings.some((f) => f?.scope === "recurring") ? 2 : 1,
  });
  applied.memo_id = memo.memo_id || null;

  return { ok: true, applied };
}

/** Memos for a desk, newest first — the read side of the feed. */
export async function loadExecMemos(env, { audience = "cio", limit = 10 } = {}) {
  if (!env?.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT memo_id, source, ticker, headline, body_md, evidence_json, weight, created_at
         FROM exec_memos
        WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?1)
          AND (audience LIKE ?2 OR audience = 'all')
        ORDER BY weight DESC, created_at DESC LIMIT ?3`
    ).bind(nowMs(), `%${String(audience).toLowerCase()}%`, Math.min(50, Number(limit) || 10)).all();
    return (results || []).map((r) => ({
      memo_id: r.memo_id, source: r.source, ticker: r.ticker, headline: r.headline,
      body_md: r.body_md, weight: r.weight, created_at: r.created_at,
      evidence: parseJson(r.evidence_json, null),
    }));
  } catch { return []; }
}

export { EXEC_MEMO_KV_KEY };
