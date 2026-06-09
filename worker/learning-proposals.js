// worker/learning-proposals.js
//
// P3.L4 (2026-06-09) — the unified "learning → acting" apply bus.
//
// Problem (full-system-review §3): every learning loop had a bespoke
// apply path with a different safety level — calibration had bounded
// blend + history, toxic-ticker bans were recommendation-only, CIO
// authority was operator checkboxes, profile nudges were direct writes.
// Several loops therefore never closed: recommendations accumulated in
// D1 and nothing acted on them.
//
// This module gives every loop ONE pipeline:
//
//   submitProposal()  — any loop proposes a change
//   processProposals() — nightly cron applies tier-1 within bounds,
//                        leaves tier-2 pending for the operator
//   decideProposal()  — operator approves/rejects tier-2 from MC
//
// Tier semantics (mirrors the COO contract in coo-orchestrator.js):
//   tier1 — numeric nudges within ±10% of the current value (or new
//           keys with explicit bounds). Auto-applied when
//           COO_AUTO_APPLY_TIER1=true; logged dry-run otherwise.
//   tier2 — anything structural (flag flips, bans, disables, >10%
//           moves). NEVER auto-applied; pending until operator decides.
//
// Every apply writes the previous value into the proposal row
// (rollback_value) and stamps model_config.updated_by =
// "learning_proposals" so the audit trail is queryable.

let _schemaReady = false;

export async function ensureLearningProposalsSchema(env) {
  if (_schemaReady || !env?.DB) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS learning_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_key TEXT,
      current_value TEXT,
      proposed_value TEXT NOT NULL,
      evidence_json TEXT,
      tier TEXT NOT NULL DEFAULT 'tier2',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_at INTEGER,
      decided_by TEXT,
      applied_at INTEGER,
      rollback_value TEXT,
      note TEXT
    )`).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_learning_proposals_status ON learning_proposals(status, created_at DESC)`
    ).run();
    _schemaReady = true;
  } catch (e) {
    console.warn("[LEARN_BUS] schema ensure failed:", String(e?.message || e).slice(0, 150));
  }
}

/**
 * Submit a proposal. Dedupes: an existing PENDING proposal from the
 * same source for the same config_key is updated in place (latest
 * evidence wins) instead of stacking duplicates.
 *
 * @param {object} p { source, kind, config_key, proposed_value,
 *                     evidence (object), tier ("tier1"|"tier2"), note }
 */
export async function submitProposal(env, p) {
  if (!env?.DB || !p?.source || p?.proposed_value == null) {
    return { ok: false, error: "bad_proposal" };
  }
  await ensureLearningProposalsSchema(env);
  const now = Date.now();
  const tier = p.tier === "tier1" ? "tier1" : "tier2";
  try {
    const existing = p.config_key
      ? await env.DB.prepare(
        `SELECT id FROM learning_proposals
          WHERE status = 'pending' AND source = ?1 AND config_key = ?2
          ORDER BY created_at DESC LIMIT 1`
      ).bind(String(p.source), String(p.config_key)).first()
      : null;

    let currentValue = null;
    if (p.config_key) {
      try {
        const row = await env.DB.prepare(
          `SELECT config_value FROM model_config WHERE config_key = ?1`
        ).bind(String(p.config_key)).first();
        currentValue = row?.config_value ?? null;
      } catch (_) { /* key may not exist yet */ }
    }

    if (existing?.id) {
      await env.DB.prepare(
        `UPDATE learning_proposals
            SET proposed_value = ?1, evidence_json = ?2, tier = ?3,
                current_value = ?4, created_at = ?5, note = ?6
          WHERE id = ?7`
      ).bind(
        String(p.proposed_value), JSON.stringify(p.evidence || {}), tier,
        currentValue, now, p.note || null, existing.id,
      ).run();
      return { ok: true, id: existing.id, updated: true };
    }

    const res = await env.DB.prepare(
      `INSERT INTO learning_proposals
         (created_at, source, kind, config_key, current_value,
          proposed_value, evidence_json, tier, status, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)`
    ).bind(
      now, String(p.source), String(p.kind || "config_change"),
      p.config_key ? String(p.config_key) : null, currentValue,
      String(p.proposed_value), JSON.stringify(p.evidence || {}),
      tier, p.note || null,
    ).run();
    return { ok: true, id: res?.meta?.last_row_id ?? null, updated: false };
  } catch (e) {
    console.warn("[LEARN_BUS] submit failed:", String(e?.message || e).slice(0, 150));
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

const TIER1_MAX_DELTA = 0.10; // ±10% of current numeric value

function _tier1Clamp(currentRaw, proposedRaw) {
  const current = Number(currentRaw);
  const proposed = Number(proposedRaw);
  if (!Number.isFinite(proposed)) return { ok: false, reason: "proposed_not_numeric" };
  if (!Number.isFinite(current)) {
    // No current value — new key. Accept as-is; the proposer owns sanity.
    return { ok: true, value: proposed, clamped: false };
  }
  if (current === 0) {
    return Math.abs(proposed) <= 1
      ? { ok: true, value: proposed, clamped: false }
      : { ok: false, reason: "current_zero_proposed_large" };
  }
  const lo = current * (1 - TIER1_MAX_DELTA);
  const hi = current * (1 + TIER1_MAX_DELTA);
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (proposed >= min && proposed <= max) return { ok: true, value: proposed, clamped: false };
  const clamped = Math.min(max, Math.max(min, proposed));
  return { ok: true, value: clamped, clamped: true };
}

/**
 * Apply one proposal's config change. Caller has already authorized.
 */
async function _applyProposal(env, row, decidedBy) {
  const now = Date.now();
  if (!row.config_key) {
    return { ok: false, reason: "no_config_key" };
  }
  let valueToWrite = String(row.proposed_value);
  let clampNote = null;
  if (row.tier === "tier1") {
    const clamp = _tier1Clamp(row.current_value, row.proposed_value);
    if (!clamp.ok) return { ok: false, reason: clamp.reason };
    valueToWrite = String(clamp.value);
    if (clamp.clamped) clampNote = `clamped_to_pm10pct_of_${row.current_value}`;
  }
  await env.DB.prepare(
    `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, 'learning_proposals')
     ON CONFLICT(config_key) DO UPDATE SET
       config_value = excluded.config_value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).bind(
    String(row.config_key), valueToWrite,
    `learning_proposals #${row.id} (${row.source})`, now,
  ).run();
  await env.DB.prepare(
    `UPDATE learning_proposals
        SET status = 'applied', applied_at = ?1, decided_at = ?1,
            decided_by = ?2, rollback_value = ?3,
            note = COALESCE(note, '') || ?4
      WHERE id = ?5`
  ).bind(
    now, decidedBy, row.current_value,
    clampNote ? ` [${clampNote}]` : "", row.id,
  ).run();
  return { ok: true, written: valueToWrite, clamped: !!clampNote };
}

/**
 * Nightly processor. Tier-1 pending proposals auto-apply when
 * COO_AUTO_APPLY_TIER1=true (the operator's existing trust flag);
 * otherwise they're marked dry-run in the response but stay pending.
 * Tier-2 always stays pending for the operator.
 */
export async function processProposals(env) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  await ensureLearningProposalsSchema(env);
  const autoApply = String(env?.COO_AUTO_APPLY_TIER1 || "false").toLowerCase() === "true";
  const pending = (await env.DB.prepare(
    `SELECT * FROM learning_proposals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
  ).all().catch(() => ({ results: [] })))?.results || [];

  const applied = [];
  const dryRun = [];
  const awaitingOperator = [];
  for (const row of pending) {
    if (row.tier !== "tier1") {
      awaitingOperator.push({ id: row.id, source: row.source, config_key: row.config_key });
      continue;
    }
    if (!autoApply) {
      dryRun.push({ id: row.id, source: row.source, config_key: row.config_key, proposed: row.proposed_value });
      continue;
    }
    try {
      const r = await _applyProposal(env, row, "coo_nightly");
      if (r.ok) applied.push({ id: row.id, config_key: row.config_key, written: r.written, clamped: r.clamped });
      else dryRun.push({ id: row.id, config_key: row.config_key, blocked: r.reason });
    } catch (e) {
      console.warn(`[LEARN_BUS] apply #${row.id} threw:`, String(e?.message || e).slice(0, 120));
    }
  }
  return { ok: true, scanned: pending.length, applied, dry_run: dryRun, awaiting_operator: awaitingOperator, auto_apply: autoApply };
}

/**
 * Operator decision on a pending proposal (any tier).
 * action: "approve" (applies it) | "reject".
 */
export async function decideProposal(env, id, action, decidedBy = "operator") {
  if (!env?.DB) return { ok: false, error: "no_db" };
  await ensureLearningProposalsSchema(env);
  const row = await env.DB.prepare(
    `SELECT * FROM learning_proposals WHERE id = ?1 AND status = 'pending'`
  ).bind(Number(id)).first();
  if (!row) return { ok: false, error: "proposal_not_found_or_decided" };
  if (action === "reject") {
    await env.DB.prepare(
      `UPDATE learning_proposals SET status = 'rejected', decided_at = ?1, decided_by = ?2 WHERE id = ?3`
    ).bind(Date.now(), decidedBy, row.id).run();
    return { ok: true, id: row.id, status: "rejected" };
  }
  if (action === "approve") {
    const r = await _applyProposal(env, row, decidedBy);
    return r.ok
      ? { ok: true, id: row.id, status: "applied", written: r.written }
      : { ok: false, id: row.id, error: r.reason };
  }
  return { ok: false, error: "bad_action" };
}

export async function listProposals(env, { status = null, limit = 100 } = {}) {
  if (!env?.DB) return { ok: false, error: "no_db", proposals: [] };
  await ensureLearningProposalsSchema(env);
  const rows = status
    ? (await env.DB.prepare(
      `SELECT * FROM learning_proposals WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2`
    ).bind(String(status), Number(limit)).all().catch(() => ({ results: [] })))?.results
    : (await env.DB.prepare(
      `SELECT * FROM learning_proposals ORDER BY created_at DESC LIMIT ?1`
    ).bind(Number(limit)).all().catch(() => ({ results: [] })))?.results;
  return { ok: true, proposals: rows || [] };
}
