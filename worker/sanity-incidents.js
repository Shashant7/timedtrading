/**
 * Sanity sweep incident tracker + agent playbook.
 *
 * Goal: every #system-alerts failure is either auto-healed, tracked until
 * resolved, or escalated with a structured brief for a coding agent (PR).
 */

/** @typedef {"runtime" | "ops" | "code" | "infra"} IncidentKind */

/**
 * Per-check playbook: how to classify and route an open incident.
 * @type {Record<string, { kind: IncidentKind, auto_heal: boolean, needs_pr: boolean, agent_prompt: string, files_hint?: string[] }>}
 */
export const SANITY_CHECK_PLAYBOOK = {
  compute_freshness: {
    kind: "runtime",
    auto_heal: true,
    needs_pr: false,
    files_hint: ["worker/investor.js", "worker/index.js"],
    agent_prompt: "Investor compute cron is stale. Verify hourly/5min cron runs POST /timed/investor/compute; fix silent aborts in classifyInvestorStage.",
  },
  classifier_consistency: {
    kind: "code",
    auto_heal: false,
    needs_pr: true,
    files_hint: ["worker/investor.js"],
    agent_prompt: "Investor stage ACCUMULATE/CORE_HOLD fires while detectExhaustionWarnings returns >=2 warnings. Tighten detectAccumulationZone / exhaustion gate so stage and warnings agree.",
  },
  thesis_stage_consistency: {
    kind: "code",
    auto_heal: false,
    needs_pr: true,
    files_hint: ["worker/investor.js"],
    agent_prompt: "Thesis text contains caution/distribution phrases while stage=accumulate. Align generateThesis() with stage classification.",
  },
  invalidation_distance: {
    kind: "runtime",
    auto_heal: true,
    needs_pr: false,
    files_hint: ["worker/sanity-stop-heal.js"],
    agent_prompt: "Open position SL is >25% from price. COO should tighten via tightenWideOpenStops; if persists, inspect gain-protection path.",
  },
  position_drift: {
    kind: "code",
    auto_heal: false,
    needs_pr: true,
    files_hint: ["worker/investor.js", "worker/index.js"],
    agent_prompt: "Same investor position auto-trimmed >1x in an hour. EXHAUSTION_TRIM_COOLDOWN_HOURS bypass — find and fix cooldown enforcement.",
  },
  price_outlier: {
    kind: "ops",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "Major ticker price outside sanity range — verify TwelveData quote, suspend trading on symbol if feed corruption.",
  },
  bridge_mirror_coverage: {
    kind: "ops",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "BROKER_INVESTOR_MIRROR_ENABLED but no bridge mirror calls. Check queueBackground scope, bridge forwarder, auto-rebalance cron.",
  },
  loop2_breaker_stale: {
    kind: "ops",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "Loop 2 paused >48h. Operator reset via POST /timed/admin/loop2-pause/reset or investigate pause reason in model_config.",
  },
  cron_tick_alive: {
    kind: "infra",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "*/5 cron heartbeat stale during market hours. Check wrangler cron triggers, worker role split (tt-engine), scheduled() errors in tail.",
  },
  candle_freshness_open: {
    kind: "runtime",
    auto_heal: true,
    needs_pr: false,
    files_hint: ["worker/index.js", "worker/coo/coo-orchestrator.js"],
    agent_prompt: "Open-position daily candles stale. COO backfill via alpaca-backfill; if recurring, fix candle ingest cron.",
  },
  trade_orphan: {
    kind: "runtime",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "OPEN trade missing positions row. Re-run bridge entry or INSERT positions row; if recurring, fix trade→positions write path.",
  },
  portfolio_reconcile: {
    kind: "runtime",
    auto_heal: true,
    needs_pr: false,
    files_hint: ["worker/index.js"],
    agent_prompt: "Investor cash + positions drift. POST /timed/admin/ledger/repair?mode=investor; if recurring, fix silent ledger insert failures.",
  },
  alert_delivery: {
    kind: "ops",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "Discord alerts failing in D1 alerts table. Rotate DISCORD_* webhook secrets on the worker that sends the failing lane.",
  },
  broker_reconciler_freshness: {
    kind: "infra",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: "Bridge reconciler heartbeat stale during RTH. Check worker-bridge scheduled() and bridge:reconciler:last_run KV writes.",
  },
};

const INCIDENTS_KV_KEY = "sanity_sweep:incidents:v1";
const INCIDENT_TTL_SEC = 14 * 86400;
const ESCALATE_AFTER_HEAL_ATTEMPTS = 2;

function playbookFor(checkId) {
  return SANITY_CHECK_PLAYBOOK[checkId] || {
    kind: "ops",
    auto_heal: false,
    needs_pr: false,
    agent_prompt: `Investigate sanity check ${checkId} — no playbook entry yet.`,
  };
}

function incidentFingerprint(check) {
  const first = check.anomalies?.[0];
  const ticker = first?.ticker ? String(first.ticker).toUpperCase() : "";
  const detail = String(first?.detail || "").slice(0, 120);
  return `${check.id}|${check.status}|${ticker}|${detail}`;
}

/**
 * @param {object} env
 * @returns {Promise<Record<string, object>>}
 */
async function readIncidentMap(env) {
  if (!env?.KV_TIMED) return {};
  try {
    const raw = await env.KV_TIMED.get(INCIDENTS_KV_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function writeIncidentMap(env, map) {
  if (!env?.KV_TIMED) return;
  await env.KV_TIMED.put(INCIDENTS_KV_KEY, JSON.stringify(map), {
    expirationTtl: INCIDENT_TTL_SEC,
  });
}

/**
 * Merge sweep + self-heal results into durable incidents.
 *
 * @param {object} env
 * @param {object} sweep
 * @param {{ healed?: Array, skipped?: Array } | null} healResult
 */
export async function syncIncidentsFromSweep(env, sweep, healResult = null) {
  const map = await readIncidentMap(env);
  const now = Date.now();
  const activeIds = new Set();
  const failing = (sweep?.checks || []).filter((c) => c.status === "fail" || c.status === "warn");

  const healedByCheck = new Map();
  for (const h of (healResult?.healed || [])) {
    if (h?.check) healedByCheck.set(h.check, h);
  }
  const skippedByCheck = new Map();
  for (const s of (healResult?.skipped || [])) {
    if (s?.check) skippedByCheck.set(s.check, s);
  }

  for (const check of failing) {
    activeIds.add(check.id);
    const pb = playbookFor(check.id);
    const fp = incidentFingerprint(check);
    const prev = map[check.id];
    const healAttempts = Array.isArray(prev?.heal_attempts) ? [...prev.heal_attempts] : [];

    if (healedByCheck.has(check.id)) {
      healAttempts.push({
        ts: now,
        ok: true,
        detail: JSON.stringify(healedByCheck.get(check.id)).slice(0, 300),
      });
    } else if (skippedByCheck.has(check.id) && pb.auto_heal) {
      healAttempts.push({
        ts: now,
        ok: false,
        detail: String(skippedByCheck.get(check.id)?.reason || skippedByCheck.get(check.id)?.error || "skipped").slice(0, 200),
      });
    }

    const escalated = healAttempts.filter((a) => a.ok).length === 0
      && healAttempts.length >= ESCALATE_AFTER_HEAL_ATTEMPTS;

    map[check.id] = {
      id: check.id,
      label: check.label,
      status: escalated ? "escalated" : "open",
      severity: check.status,
      kind: pb.kind,
      needs_pr: !!(pb.needs_pr || (escalated && pb.kind === "code")),
      auto_heal: pb.auto_heal,
      remediation: check.remediation || null,
      agent_prompt: pb.agent_prompt,
      files_hint: pb.files_hint || [],
      fingerprint: fp,
      anomalies: (check.anomalies || []).slice(0, 5),
      first_seen_ts: prev?.first_seen_ts || now,
      last_seen_ts: now,
      heal_attempts: healAttempts.slice(-5),
      last_sweep_kind: sweep?.kind || null,
    };
  }

  for (const id of Object.keys(map)) {
    if (!activeIds.has(id)) {
      map[id] = {
        ...map[id],
        status: "resolved",
        resolved_ts: now,
      };
      // Drop resolved entries after recording so open list stays lean.
      delete map[id];
    }
  }

  await writeIncidentMap(env, map);
  return summarizeIncidents(map);
}

/**
 * @param {Record<string, object>} map
 */
export function summarizeIncidents(map) {
  const open = Object.values(map).filter((i) => i.status === "open" || i.status === "escalated");
  return {
    open_count: open.length,
    escalated_count: open.filter((i) => i.status === "escalated").length,
    needs_pr_count: open.filter((i) => i.needs_pr).length,
    open,
  };
}

export async function getOpenIncidents(env, opts = {}) {
  const map = await readIncidentMap(env);
  let open = Object.values(map).filter((i) => i.status === "open" || i.status === "escalated");
  if (opts.needs_pr) open = open.filter((i) => i.needs_pr);
  if (opts.kind) open = open.filter((i) => i.kind === opts.kind);
  open.sort((a, b) => (b.last_seen_ts || 0) - (a.last_seen_ts || 0));
  return { ...summarizeIncidents(map), open };
}

/**
 * Build GitHub issue body for a coding agent.
 */
export function buildAgentIssueBody(incident) {
  const lines = [
    "## Sanity sweep incident (auto-opened)",
    "",
    `**Check:** \`${incident.id}\` — ${incident.label}`,
    `**Severity:** ${incident.severity}`,
    `**Status:** ${incident.status}`,
    `**Kind:** ${incident.kind}${incident.needs_pr ? " (code fix expected)" : ""}`,
    "",
    "### Anomalies",
  ];
  for (const a of (incident.anomalies || [])) {
    lines.push(`- ${a.ticker ? `\`${a.ticker}\` ` : ""}${a.detail || ""}`);
  }
  lines.push("", "### Remediation (from sweep)", incident.remediation || "(none)", "");
  lines.push("### Agent task", incident.agent_prompt || "", "");
  if (incident.files_hint?.length) {
    lines.push("### Files to inspect", incident.files_hint.map((f) => `- \`${f}\``).join("\n"), "");
  }
  if (incident.heal_attempts?.length) {
    lines.push("### Auto-heal attempts", ...incident.heal_attempts.map((h) =>
      `- ${new Date(h.ts).toISOString()} — ${h.ok ? "ok" : "failed"}: ${h.detail || ""}`,
    ), "");
  }
  lines.push(
    "---",
    "Opened by `.github/workflows/sanity-sweep-agent.yml`.",
    "A Cursor Cloud Agent (or human) should fix, run `npm test`, and open a PR.",
  );
  return lines.join("\n");
}

export function formatIncidentActionLines(summary, healResult) {
  const lines = [];
  const healed = healResult?.healed || [];
  if (healed.length > 0) {
    lines.push(`**Auto-heal applied (${healed.length}):** ${healed.map((h) => h.check).join(", ")}`);
  }
  const skipped = (healResult?.skipped || []).filter((s) => s.check && !s.reason?.includes("cooldown"));
  if (skipped.length > 0) {
    lines.push(`**Heal skipped:** ${skipped.slice(0, 4).map((s) => `${s.check} (${s.reason || s.error || "?"})`).join("; ")}`);
  }
  if (summary.open_count > 0) {
    lines.push(`**Still open:** ${summary.open_count} incident(s) — ${summary.needs_pr_count} need code PR`);
    for (const inc of summary.open.slice(0, 4)) {
      lines.push(`• \`${inc.id}\` [${inc.status}]${inc.needs_pr ? " → agent/PR" : ""}`);
    }
  }
  return lines;
}
