// worker/coo/coo-orchestrator.js
//
// AI COO (Chief OPERATING Officer) — the operations counterpart to the
// AI CIO. While the CIO decides what to trade, the COO keeps the SYSTEM
// running: calibration, parameter tuning, ticker bans, self-healing,
// audit trails. Designed to be COMA-PROOF: every operation is logged,
// every change is reversible, every auto-action is gated by tier-based
// safety bounds.
//
// Operator mandate (2026-06-02):
//   "I really need you to fulfill the promise of self-learning and
//    self-healing. The entire System Intelligence section is manual and
//    offers no assurance anything actually updated. This needs to be
//    coma-proof."
//
// ── Tiered auto-apply ──
//
// Tier 1 (auto-apply, no human gate):
//   • Parameter nudges within ±10% of current value
//   • Threshold changes within established BOUNDS in calibration apply
//   • All changes versioned in model_config_history (reversible)
//
// Tier 2 (operator approval required):
//   • Ticker bans (any new ticker added to toxic list)
//   • Setup disables (any setup turned off entirely)
//   • Bounds widening (changing the safety BOUNDS themselves)
//   • Any change >25% from baseline
//
// Tier 3 (informational only — no action):
//   • Anomalies the COO doesn't know how to fix
//   • Novel patterns flagged for human review
//
// ── Self-healing actions ──
//
// Wired to sanity-sweep failures. When a failing check has a known
// remediation, the COO auto-runs it (idempotently, with cooldowns):
//   • portfolio_reconcile FAIL → POST /timed/admin/ledger/repair
//   • candle_freshness_open FAIL → trigger backfill
//   • cron_tick_alive WARN (>30min) → log + escalate (can't self-fix)
//   • position_drift FAIL (1h cooldown bypassed) → bump cooldown +
//     log, escalate after 2 consecutive
//
// ── Audit trail ──
//
// Every COO action writes to KV `coo:actions:YYYY-MM-DD` (24h ring
// buffer keys). The MC card + daily digest read this. Each action has:
//   { ts, tier, kind, target, before, after, reason, applied, rollback_token }
//
// ── Gated by env ──
//
//   COO_ENABLED=true           — master switch (default false)
//   COO_AUTO_APPLY_TIER1=true  — actually mutate model_config (default false)
//                                — when false, COO just LOGS what it would do
//   COO_SELF_HEAL=true         — fire ledger repair etc (default false)
//
// All three default OFF so the first deploy is observation-only.
// Operator flips them on after reviewing the dry-run logs.

const COO_KV_PREFIX = "coo:actions";

// ── Audit log helpers ─────────────────────────────────────────────────

async function recordAction(env, action) {
  try {
    if (!env?.KV_TIMED) return;
    const date = new Date().toISOString().slice(0, 10);
    const key = `${COO_KV_PREFIX}:${date}`;
    const raw = await env.KV_TIMED.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({
      ts: Date.now(),
      ...action,
    });
    if (arr.length > 200) arr.length = 200; // cap per-day to 200 actions
    await env.KV_TIMED.put(key, JSON.stringify(arr), { expirationTtl: 30 * 86400 });
    // Also log to console for tail.
    const tag = action.applied === false ? "[DRY]" : action.tier === "tier1" ? "[T1]" : action.tier === "tier2" ? "[T2]" : "[T3]";
    console.log(`[COO] ${tag} ${action.kind}/${action.target || "?"} ${action.applied === false ? "would_do" : "did"}: ${(action.reason || "").slice(0, 200)}`);
  } catch (e) {
    console.warn("[COO] recordAction failed:", String(e?.message || e).slice(0, 120));
  }
}

/**
 * Read recent COO actions for the MC card + daily digest.
 *
 * @param {object} env
 * @param {number} days  how many trailing days to fetch (default 7)
 * @returns {Promise<Array>} flat array of actions, newest first
 */
export async function getRecentCooActions(env, days = 7) {
  if (!env?.KV_TIMED) return [];
  const out = [];
  try {
    for (let d = 0; d < days; d++) {
      const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      const raw = await env.KV_TIMED.get(`${COO_KV_PREFIX}:${date}`);
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) out.push(...arr);
      } catch {}
    }
  } catch (e) {
    console.warn("[COO] getRecentActions failed:", String(e?.message || e).slice(0, 120));
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// ── Calibration auto-run + auto-apply ─────────────────────────────────

/**
 * Full calibration cycle. Runs the analysis as a promotion candidate
 * (not diagnostic), then applies tier-1 recommendations if enabled.
 *
 * Returns { ok, report_id, applied, clamped, action_count } so the
 * cron can record + the operator can audit.
 */
export async function runCooCalibrationCycle(env, options = {}) {
  const t0 = Date.now();
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const adminKey = env?.TIMED_TRADING_API_KEY;
  const tier1Enabled = String(env?.COO_AUTO_APPLY_TIER1 || "false").toLowerCase() === "true";

  if (!adminKey) {
    await recordAction(env, { tier: "tier3", kind: "calibration", target: "cycle", applied: false, reason: "no admin key configured" });
    return { ok: false, error: "no_admin_key" };
  }

  // 1. Run the calibration as promotion candidate (analysis_only=false)
  //    so apply has live deltas. The auto-seed inside runCalibrationAnalysis
  //    handles the no-autopsy-rows case.
  let runRes;
  try {
    const r = await fetch(`${baseUrl}/timed/calibration/run?key=${encodeURIComponent(adminKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_id: options.scopeId || `coo-auto-${new Date().toISOString().slice(0, 10)}`,
        analysis_only: false,
        scope_kind: "global",
      }),
    });
    runRes = await r.json();
    if (!runRes?.ok) {
      await recordAction(env, {
        tier: "tier3", kind: "calibration", target: "run", applied: false,
        reason: `run failed: ${runRes?.error || "unknown"}`,
      });
      return { ok: false, error: runRes?.error || "run_failed" };
    }
  } catch (e) {
    await recordAction(env, {
      tier: "tier3", kind: "calibration", target: "run", applied: false,
      reason: `run threw: ${String(e?.message || e).slice(0, 200)}`,
    });
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  const reportId = runRes?.report?.report_id;
  if (!reportId) {
    await recordAction(env, { tier: "tier3", kind: "calibration", target: "run", applied: false, reason: "no report_id in run response" });
    return { ok: false, error: "no_report_id" };
  }

  // 2. If tier-1 auto-apply is disabled, log dry-run and exit.
  if (!tier1Enabled) {
    await recordAction(env, {
      tier: "tier1", kind: "calibration", target: reportId, applied: false,
      reason: "dry-run (COO_AUTO_APPLY_TIER1=false). Set to true after reviewing 7+ days of dry-run logs.",
      report_id: reportId,
    });
    return { ok: true, report_id: reportId, applied: false, dry_run: true, elapsed_ms: Date.now() - t0 };
  }

  // 3. Apply. The /apply endpoint already has BOUNDS + blendVal that
  //    keeps Tier-1 safe (clamps anything beyond bounds, blends with
  //    baseline weighted by sample-size confidence).
  let applyRes;
  try {
    const r = await fetch(`${baseUrl}/timed/calibration/apply?key=${encodeURIComponent(adminKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report_id: reportId }),
    });
    applyRes = await r.json();
  } catch (e) {
    await recordAction(env, {
      tier: "tier1", kind: "calibration", target: reportId, applied: false,
      reason: `apply threw: ${String(e?.message || e).slice(0, 200)}`,
      report_id: reportId,
    });
    return { ok: false, error: String(e?.message || e).slice(0, 200), report_id: reportId };
  }

  await recordAction(env, {
    tier: "tier1", kind: "calibration", target: reportId,
    applied: !!applyRes?.ok,
    reason: applyRes?.ok
      ? `applied ${(applyRes.applied || []).length} keys${(applyRes.clamped || []).length ? ` (${applyRes.clamped.length} clamped)` : ""}`
      : `apply failed: ${applyRes?.error || "unknown"}`,
    applied_keys: applyRes?.applied || [],
    clamped_keys: applyRes?.clamped || [],
    report_id: reportId,
  });
  return {
    ok: !!applyRes?.ok,
    report_id: reportId,
    applied: applyRes?.applied || [],
    clamped: applyRes?.clamped || [],
    elapsed_ms: Date.now() - t0,
  };
}

// ── Self-healing actions ──────────────────────────────────────────────

/**
 * Read the latest sanity sweep, route each failing check to its
 * remediation handler. Each remediation is idempotent + cooldown-gated.
 *
 * @returns {Promise<{healed: Array, skipped: Array}>}
 */
export async function runSelfHealing(env, options = {}) {
  const t0 = Date.now();
  const enabled = String(env?.COO_SELF_HEAL || "false").toLowerCase() === "true";
  const healed = [];
  const skipped = [];

  let sweep;
  try {
    const raw = await env.KV_TIMED.get("sanity_sweep:latest");
    if (!raw) {
      skipped.push({ reason: "no_cached_sweep" });
      return { healed, skipped, elapsed_ms: Date.now() - t0 };
    }
    sweep = JSON.parse(raw);
  } catch (e) {
    skipped.push({ reason: `read_sweep_failed: ${String(e?.message || e).slice(0, 120)}` });
    return { healed, skipped, elapsed_ms: Date.now() - t0 };
  }

  const failing = (sweep.checks || []).filter(c => c.status === "fail");
  if (failing.length === 0) {
    return { healed, skipped: [{ reason: "no_failures_in_sweep" }], elapsed_ms: Date.now() - t0 };
  }

  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const adminKey = env?.TIMED_TRADING_API_KEY;
  if (!adminKey) {
    return { healed, skipped: [{ reason: "no_admin_key" }], elapsed_ms: Date.now() - t0 };
  }

  // Cooldown: don't run the same remediation twice within 4 hours.
  const cooldownMs = 4 * 60 * 60 * 1000;

  for (const check of failing) {
    const cooldownKey = `coo:heal_cooldown:${check.id}`;
    const lastHealRaw = await env.KV_TIMED.get(cooldownKey).catch(() => null);
    const lastHeal = Number(lastHealRaw) || 0;
    if (lastHeal && (Date.now() - lastHeal) < cooldownMs) {
      const minsAgo = Math.round((Date.now() - lastHeal) / 60000);
      skipped.push({ check: check.id, reason: `cooldown (last attempt ${minsAgo}min ago, ${(cooldownMs / 60000)}min cooldown)` });
      continue;
    }

    // Route to handler by check id.
    let action = null;
    if (check.id === "portfolio_reconcile") {
      action = enabled
        ? await _healPortfolioReconcile(env, baseUrl, adminKey)
        : { ok: true, dry_run: true, would_do: "POST /timed/admin/ledger/repair?mode=investor&dryRun=false" };
    } else if (check.id === "candle_freshness_open") {
      action = enabled
        ? await _healCandleFreshness(env, baseUrl, adminKey, check)
        : { ok: true, dry_run: true, would_do: "POST /timed/admin/backfill-candles for each stale ticker" };
    } else {
      action = { ok: false, reason: `no_handler_for_${check.id}` };
    }

    await recordAction(env, {
      tier: "tier1",
      kind: "self_heal",
      target: check.id,
      applied: !!(action?.ok && !action?.dry_run),
      dry_run: !!action?.dry_run,
      reason: action?.dry_run
        ? `would_do: ${action.would_do}`
        : action?.ok
          ? `healed: ${JSON.stringify(action).slice(0, 200)}`
          : `failed: ${action?.error || action?.reason || "unknown"}`,
    });

    if (action?.ok && !action?.dry_run) {
      healed.push({ check: check.id, ...action });
      await env.KV_TIMED.put(cooldownKey, String(Date.now()), { expirationTtl: 86400 });
    } else {
      skipped.push({ check: check.id, ...(action || {}) });
    }
  }

  return { healed, skipped, elapsed_ms: Date.now() - t0 };
}

async function _healPortfolioReconcile(env, baseUrl, adminKey) {
  try {
    const r = await fetch(`${baseUrl}/timed/admin/ledger/repair?mode=investor&dryRun=false&key=${encodeURIComponent(adminKey)}`, {
      method: "POST",
    });
    const j = await r.json();
    return j?.ok
      ? { ok: true, written: j.written, rebalanced: j.rebalanced, missing_was: j.missing_count }
      : { ok: false, error: j?.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function _healCandleFreshness(env, baseUrl, adminKey, check) {
  // The check's anomaly text contains tickers like "SNDK(missing), MU(missing)".
  // Pull the ticker list and trigger backfill for each.
  const detail = (check.anomalies?.[0]?.detail || "");
  const tickers = Array.from(detail.matchAll(/([A-Z][A-Z0-9.-]{0,9})\(/g)).map(m => m[1]).slice(0, 10);
  if (tickers.length === 0) {
    return { ok: false, reason: "could_not_extract_tickers_from_anomaly" };
  }
  const results = [];
  for (const sym of tickers) {
    try {
      const r = await fetch(`${baseUrl}/timed/admin/backfill-candles?ticker=${sym}&tf=D&key=${encodeURIComponent(adminKey)}`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      results.push({ ticker: sym, ok: !!j?.ok, status: r.status });
    } catch (e) {
      results.push({ ticker: sym, ok: false, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: results.some(r => r.ok), results };
}

// ── Master orchestrator ───────────────────────────────────────────────

/**
 * Run a full COO cycle: calibration + self-healing. Called by the
 * daily cron (22:00 UTC weekday = 6pm ET, after market close).
 *
 * Returns a summary of all actions so the daily digest can render it.
 */
export async function runCooDailyCycle(env, options = {}) {
  const t0 = Date.now();
  const masterEnabled = String(env?.COO_ENABLED || "false").toLowerCase() === "true";

  if (!masterEnabled && !options.force) {
    await recordAction(env, {
      tier: "tier3", kind: "cycle", applied: false,
      reason: "COO_ENABLED=false (master switch); cycle skipped",
    });
    return { ok: true, skipped: "master_disabled", elapsed_ms: Date.now() - t0 };
  }

  const summary = {
    ok: true,
    started_at: t0,
    elapsed_ms: 0,
    calibration: null,
    self_healing: null,
    error: null,
  };

  // 1. Calibration cycle.
  try {
    summary.calibration = await runCooCalibrationCycle(env, options);
  } catch (e) {
    summary.calibration = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // 2. Self-healing cycle.
  try {
    summary.self_healing = await runSelfHealing(env, options);
  } catch (e) {
    summary.self_healing = { error: String(e?.message || e).slice(0, 200) };
  }

  summary.elapsed_ms = Date.now() - t0;

  // Persist the latest cycle result for the MC card.
  try {
    await env.KV_TIMED.put("coo:last_cycle", JSON.stringify(summary), { expirationTtl: 14 * 86400 });
  } catch (_) {}

  return summary;
}

/**
 * Read the latest COO cycle result for the MC card.
 */
export async function getLatestCooCycle(env) {
  try {
    if (!env?.KV_TIMED) return null;
    const raw = await env.KV_TIMED.get("coo:last_cycle");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
