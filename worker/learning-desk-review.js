/**
 * Learning desk review — CIO / CRO / CTO triage of learning_proposals.
 *
 * The operator queue was a diary: stale demotions, already-applied blocks,
 * workhorse pauses, recycled discovery knobs. The desks already exist.
 * They review every pending row on the hourly research slot and only
 * escalate what is actually low-confidence or debatable.
 *
 *   CTO  — freshness / identity (already live, mangled key, recycled note)
 *   CRO  — capital hygiene (workhorse protection, widen-block on WoW red)
 *   CIO  — setup quality (30d recovered → restore; still bleeding → ack)
 *   COO  — executes high-confidence verdicts on the existing apply bus
 *
 * No new apply path. decideProposal() + model_config upserts only.
 */

import { resolvePlay, PLAY_STATUS } from "./foundation/play-catalog.js";
import {
  demotionProposalConfigKey,
  setupDemotionConfigKey,
} from "./pipeline/setup-demotion.js";
import {
  configValuesEquivalent,
  normalizeConfigValue,
  decideProposal,
  ensureLearningProposalsSchema,
} from "./learning-proposals.js";
import { computeWindowStats, setupGroupKey } from "./edge-scorecard.js";

export const LEARNING_DESK_KV = "timed:learning-desk:latest";
const WORKHORSE_IDS = new Set(["tt_gap_reversal_long", "tt_gap_reversal_short"]);

export function parseDemotionKey(configKey) {
  const raw = String(configKey || "");
  const m = raw.match(/^deep_audit_setup_demotion_(.+)_([a-z]+)$/i);
  if (!m) return null;
  const play = resolvePlay(m[1], m[2]);
  return {
    display: m[1],
    direction: String(m[2] || "long").toLowerCase(),
    play_id: play?.id || null,
    role: play?.role || null,
    status: play?.status || null,
    mangled: /tt tt /i.test(m[1]) || /^TT Tt /i.test(m[1]),
  };
}

export function findSetupStats(list, playId, direction) {
  const dir = String(direction || "long").toLowerCase();
  const rows = Array.isArray(list) ? list : [];
  return rows.find((s) => {
    const id = resolvePlay(s.setup, s.direction)?.id || String(s.setup || "").toLowerCase();
    return id === playId && String(s.direction || "long").toLowerCase() === dir;
  })?.stats || null;
}

export function recovered30d(stats) {
  if (!stats) return false;
  const n = Number(stats.n) || 0;
  const pnl = Number(stats.pnl_usd);
  return n >= 12 && Number.isFinite(pnl) && pnl > 0;
}

export function isPlayRecovered30d(perSetup30, playId, direction) {
  return recovered30d(findSetupStats(perSetup30, playId, direction));
}

/** Collapse "7 churn" / "8 churn" and "65 → 60" / "60 → 55" to one template. */
export function discoveryNoteCore(note) {
  return String(note || "")
    .replace(/\s*\[.*?\]\s*/g, "")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function stillSevere(stats) {
  if (!stats) return false;
  const n = Number(stats.n) || 0;
  const pf = stats.profit_factor;
  return n >= 10 && pf != null && pf < 0.5;
}

/**
 * Pure verdict. ctx:
 *   liveValue, perSetup30, perSetup90, wow, appliedSameKey (prior applied rows)
 */
export function deskTriageProposal(row, ctx = {}) {
  const key = String(row?.config_key || "");
  const proposed = row?.proposed_value;
  const live = ctx.liveValue;
  const note = String(row?.note || "");
  const source = String(row?.source || "");
  const ageMs = Number(ctx.now) && Number(row?.created_at)
    ? Number(ctx.now) - Number(row.created_at)
    : 0;
  const ageDays = ageMs / 86400000;

  const demotion = parseDemotionKey(key);
  // Restore beats "already blocked". A recovered or workhorse setup
  // must come off the marker, not get an ack that leaves it dead.
  if (demotion && normalizeConfigValue(proposed) === "blocked" && demotion.play_id) {
    const s30 = findSetupStats(ctx.perSetup30, demotion.play_id, demotion.direction);
    if (recovered30d(s30)) {
      return {
        action: "restore",
        desk: "cio",
        confidence: "high",
        reason: "setup_recovered_30d",
        play_id: demotion.play_id,
        n30: s30.n,
        pnl30: s30.pnl_usd,
      };
    }
    if (WORKHORSE_IDS.has(demotion.play_id) && normalizeConfigValue(live) === "blocked") {
      return {
        action: "restore",
        desk: "cro",
        confidence: "high",
        reason: "workhorse_protected",
        play_id: demotion.play_id,
      };
    }
  }

  if (key && configValuesEquivalent(live, proposed)) {
    return {
      action: "ack",
      desk: "cto",
      confidence: "high",
      reason: "already_in_effect",
    };
  }

  if (key === "deep_audit_weekly_governor_block_widen") {
    if (String(proposed).toLowerCase() === "true" && ctx.wow?.regressing === true) {
      return {
        action: "approve",
        desk: "cro",
        confidence: "high",
        reason: "wow_regressing_block_widen",
      };
    }
    if (String(proposed).toLowerCase() === "true" && ctx.wow?.regressing === false) {
      return {
        action: "reject",
        desk: "cro",
        confidence: "high",
        reason: "wow_not_regressing",
      };
    }
    return {
      action: "escalate",
      desk: "cro",
      confidence: "low",
      reason: "wow_unknown",
    };
  }

  if (demotion) {
    if (demotion.mangled) {
      return {
        action: "reject",
        desk: "cto",
        confidence: "high",
        reason: "mangled_demotion_key",
        play_id: demotion.play_id,
      };
    }
    if (demotion.play_id && WORKHORSE_IDS.has(demotion.play_id)) {
      if (normalizeConfigValue(live) === "blocked") {
        return {
          action: "restore",
          desk: "cro",
          confidence: "high",
          reason: "workhorse_protected",
          play_id: demotion.play_id,
        };
      }
      return {
        action: "reject",
        desk: "cro",
        confidence: "high",
        reason: "workhorse_protected",
        play_id: demotion.play_id,
      };
    }
    if (normalizeConfigValue(proposed) === "blocked" && demotion.play_id) {
      const s30 = findSetupStats(ctx.perSetup30, demotion.play_id, demotion.direction);
      const s90 = findSetupStats(ctx.perSetup90, demotion.play_id, demotion.direction);
      if (stillSevere(s30) || stillSevere(s90)) {
        return {
          action: "ack",
          desk: "cio",
          confidence: "high",
          reason: "still_severe_keep_blocked",
          play_id: demotion.play_id,
        };
      }
      return {
        action: "escalate",
        desk: "cio",
        confidence: "low",
        reason: "demotion_mixed_windows",
        play_id: demotion.play_id,
      };
    }
  }

  if (source === "discovery") {
    const prior = (ctx.appliedSameKey || []).find((p) => p.config_key === key);
    const priorCore = discoveryNoteCore(prior?.note);
    const thisCore = discoveryNoteCore(note);
    if (prior && priorCore && thisCore && priorCore === thisCore) {
      return {
        action: "reject",
        desk: "cto",
        confidence: "high",
        reason: "recycled_discovery_note",
      };
    }
    // submitProposal restamps pending created_at on every nightly
    // rediscovery, so age must come from the last applied row.
    const priorTs = Number(prior?.applied_at || prior?.created_at) || 0;
    const priorAgeDays = Number(ctx.now) && priorTs
      ? (Number(ctx.now) - priorTs) / 86400000
      : ageDays;
    if (prior && priorAgeDays >= 7) {
      return {
        action: "reject",
        desk: "cto",
        confidence: "high",
        reason: "stale_discovery_increment",
      };
    }
    return {
      action: "escalate",
      desk: "cro",
      confidence: "low",
      reason: "discovery_needs_operator",
    };
  }

  return {
    action: "escalate",
    desk: "coo",
    confidence: "low",
    reason: "no_desk_rule",
  };
}

export async function loadPerSetupWindow(db, days, nowMs) {
  if (!db) return [];
  const now = Number(nowMs) || Date.now();
  const since = now - Number(days) * 86400000;
  let rows = [];
  try {
    rows = (await db.prepare(
      `SELECT setup_name, entry_path, direction, status, pnl, pnl_pct
         FROM trades
        WHERE status IN ('WIN','LOSS','FLAT') AND exit_ts >= ?1 AND run_id IS NULL
        ORDER BY exit_ts ASC LIMIT 2000`
    ).bind(since).all())?.results || [];
  } catch {
    try {
      rows = (await db.prepare(
        `SELECT setup_name, entry_path, direction, status, pnl, pnl_pct
           FROM trades
          WHERE status IN ('WIN','LOSS','FLAT') AND exit_ts >= ?1
          ORDER BY exit_ts ASC LIMIT 2000`
      ).bind(since).all())?.results || [];
    } catch { return []; }
  }
  const by = new Map();
  for (const r of rows) {
    const id = setupGroupKey(r);
    const dir = String(r.direction || "long").toLowerCase();
    const key = `${id}|${dir}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()].map(([key, list]) => {
    const [setup, direction] = key.split("|");
    return { setup, direction, stats: computeWindowStats(list) };
  }).filter((s) => s.stats.n >= 3);
}

export function planRecoveredRestores(perSetup30, daCfg = {}) {
  const out = [];
  for (const row of perSetup30 || []) {
    const play = resolvePlay(row.setup, row.direction);
    if (!play?.id || play.status === PLAY_STATUS.PAUSED) continue;
    if (!recovered30d(row.stats)) continue;
    const key = setupDemotionConfigKey(play.id, row.direction || "long")
      || demotionProposalConfigKey(row.setup, row.direction || "long");
    if (!key) continue;
    if (daCfg && Object.keys(daCfg).length) {
      if (normalizeConfigValue(daCfg[key]) !== "blocked") continue;
    }
    out.push({
      play_id: play.id,
      config_key: key,
      n: row.stats.n,
      pnl_usd: row.stats.pnl_usd,
    });
  }
  return out;
}

async function readLive(env, key) {
  if (!env?.DB || !key) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = ?1`
    ).bind(String(key)).first();
    return row?.config_value ?? null;
  } catch {
    return null;
  }
}

async function upsertAllowed(env, key, by, note) {
  if (!env?.DB || !key) return;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(config_key) DO UPDATE SET
       config_value = excluded.config_value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       description = excluded.description`
  ).bind(String(key), JSON.stringify("allowed"), note || "desk restore", now, by).run();
}

export async function runLearningDeskReview(env, opts = {}) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  await ensureLearningProposalsSchema(env);
  const now = Number(opts.now) || Date.now();
  const pending = (await env.DB.prepare(
    `SELECT * FROM learning_proposals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
  ).all().catch(() => ({ results: [] })))?.results || [];

  const appliedSame = (await env.DB.prepare(
    `SELECT config_key, note, applied_at, created_at FROM learning_proposals
      WHERE status = 'applied' ORDER BY applied_at DESC LIMIT 40`
  ).all().catch(() => ({ results: [] })))?.results || [];

  const perSetup30 = opts.perSetup30
    || await loadPerSetupWindow(env.DB, 30, now);
  const perSetup90 = opts.perSetup90
    || await loadPerSetupWindow(env.DB, 90, now);
  const wow = opts.wow || {};
  const daCfg = opts.daCfg || {};

  const decided = [];
  const escalated = [];
  const restored = [];

  for (const row of pending) {
    let liveValue = daCfg[row.config_key];
    if (liveValue == null) liveValue = await readLive(env, row.config_key);
    const verdict = deskTriageProposal(row, {
      now,
      liveValue,
      perSetup30,
      perSetup90,
      wow,
      appliedSameKey: appliedSame.filter((p) => p.config_key === row.config_key),
    });

    if (verdict.action === "escalate") {
      escalated.push({ id: row.id, config_key: row.config_key, ...verdict });
      continue;
    }
    if (opts.dryRun) {
      decided.push({ id: row.id, config_key: row.config_key, dry_run: true, ...verdict });
      continue;
    }

    try {
      if (verdict.action === "ack") {
        await env.DB.prepare(
          `UPDATE learning_proposals
              SET status = 'applied', applied_at = ?1, decided_at = ?1,
                  decided_by = ?2, rollback_value = ?3,
                  note = COALESCE(note, '') || ?4
            WHERE id = ?5`
        ).bind(
          now, `learning_desk_${verdict.desk}`, row.current_value,
          ` [${verdict.reason}]`, row.id,
        ).run();
        decided.push({ id: row.id, config_key: row.config_key, ...verdict });
        continue;
      }
      if (verdict.action === "approve" || verdict.action === "reject") {
        const r = await decideProposal(env, row.id, verdict.action, `learning_desk_${verdict.desk}`);
        decided.push({ id: row.id, config_key: row.config_key, ok: r.ok, ...verdict });
        continue;
      }
      if (verdict.action === "restore") {
        await decideProposal(env, row.id, "reject", `learning_desk_${verdict.desk}`);
        const parsed = parseDemotionKey(row.config_key);
        const restoreKey = parsed?.play_id
          ? setupDemotionConfigKey(parsed.play_id, parsed.direction)
          : row.config_key;
        await upsertAllowed(
          env,
          restoreKey,
          `learning_desk_${verdict.desk}`,
          `CIO restore ${verdict.play_id} 30d n=${verdict.n30} pnl=${verdict.pnl30}`,
        );
        restored.push({ config_key: restoreKey, play_id: verdict.play_id });
        decided.push({ id: row.id, config_key: row.config_key, ...verdict });
      }
    } catch (e) {
      escalated.push({
        id: row.id,
        config_key: row.config_key,
        action: "escalate",
        desk: "coo",
        confidence: "low",
        reason: `desk_apply_failed:${String(e?.message || e).slice(0, 80)}`,
      });
    }
  }

  // Restore recovered setups even when no pending demotion row exists.
  if (!opts.dryRun) {
    for (const r of planRecoveredRestores(perSetup30, {
      ...daCfg,
      // Re-read after proposal loop so a just-restored key is not double-written.
    })) {
      const live = await readLive(env, r.config_key);
      if (normalizeConfigValue(live) !== "blocked") continue;
      try {
        await upsertAllowed(
          env,
          r.config_key,
          "learning_desk_cio",
          `CIO restore ${r.play_id} 30d n=${r.n} pnl=${r.pnl_usd}`,
        );
        restored.push(r);
      } catch { /* best-effort */ }
    }
  }

  const report = {
    ok: true,
    generated_at: now,
    scanned: pending.length,
    decided,
    escalated,
    restored,
  };

  const KV = env?.KV_TIMED || env?.KV;
  if (KV?.put && !opts.dryRun) {
    try {
      await KV.put(LEARNING_DESK_KV, JSON.stringify(report), { expirationTtl: 45 * 86400 });
    } catch { /* */ }
  }
  return report;
}

/**
 * Cron / admin entry: reuse the nightly scorecard + governor WoW when
 * present, else load 30d/90d from D1.
 */
export async function runLearningDeskCron(env, opts = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  let scorecard = opts.scorecard || null;
  let wow = opts.wow || null;
  if (!scorecard && KV?.get) {
    try {
      const raw = await KV.get("timed:edge:scorecard");
      scorecard = raw ? JSON.parse(raw) : null;
    } catch { scorecard = null; }
  }
  if (!wow && KV?.get) {
    try {
      const raw = await KV.get("timed:weekly-governor:latest");
      const gov = raw ? JSON.parse(raw) : null;
      wow = gov?.wow || null;
    } catch { /* */ }
  }
  const d30 = opts.perSetup30 || (scorecard?.per_setup_d30?.length ? scorecard.per_setup_d30 : undefined);
  const d90 = opts.perSetup90 || (scorecard?.per_setup?.length ? scorecard.per_setup : undefined);
  return runLearningDeskReview(env, {
    ...opts,
    perSetup30: d30,
    perSetup90: d90,
    wow: wow || opts.wow || {},
    daCfg: opts.daCfg || env?._deepAuditConfig || {},
  });
}

export function formatLearningDeskDiscord(desk) {
  const lines = [];
  for (const d of desk?.decided || []) {
    lines.push(`${String(d.desk || "desk").toUpperCase()} ${d.action} #${d.id ?? "—"} \`${d.config_key}\` (${d.reason})`);
  }
  const decidedRestore = new Set(
    (desk?.decided || []).filter((d) => d.action === "restore").map((d) => d.config_key),
  );
  for (const r of desk?.restored || []) {
    if (decidedRestore.has(r.config_key)) continue;
    lines.push(`CIO restore \`${r.config_key}\` ${r.play_id || ""}`.trim());
  }
  for (const e of desk?.escalated || []) {
    lines.push(`ESCALATE ${e.desk} #${e.id ?? "—"} \`${e.config_key}\` (${e.reason})`);
  }
  return lines.join("\n").slice(0, 1900);
}

export { WORKHORSE_IDS };
