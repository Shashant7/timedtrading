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
//   • portfolio_reconcile FAIL/WARN → POST /timed/admin/ledger/repair
//   • candle_freshness_open FAIL/WARN → trigger backfill
//   • invalidation_distance WARN → tighten wide stops on open positions
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

/* Static imports — see Tests note in runMoveDiscoveryCycle. Always
   use top-level imports for worker modules; dynamic imports inside
   handlers occasionally fail to resolve under esbuild + wrangler. */
import { runMoveDiscovery } from "../discovery/move-discovery.js";
import { runDiagnosis } from "../discovery/diagnose-missed.js";
import { buildDiscoveryGameplan } from "../discovery/gameplan.js";
import { submitProposal } from "../learning-proposals.js";
import { notifyDiscord } from "../alerts.js";

const COO_KV_PREFIX = "coo:actions";

// P1.8 (2026-06-09) — prefer the cron's in-process dispatcher
// (env._selfDispatch, set in worker/index.js scheduled()) over a real
// network self-fetch. In-process avoids Cloudflare loopback rejection
// (error 1042), subrequest budget, and edge 503s. Falls back to network
// fetch with the X-API-Key header when invoked outside the cron (e.g.
// the admin POST /timed/admin/coo/run route).
async function _dispatch(env, path, init = {}) {
  if (typeof env?._selfDispatch === "function") {
    return env._selfDispatch(path, init);
  }
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const adminKey = env?.TIMED_API_KEY || env?.TIMED_INGEST_API_KEY || env?.TIMED_TRADING_API_KEY;
  const headers = { ...(init.headers || {}), ...(adminKey ? { "X-API-Key": adminKey } : {}) };
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

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
  // The worker's admin key env var is TIMED_API_KEY (see worker/api.js
  // requireKeyOr401). Fall back to other names for forward-compat.
  const adminKey = env?.TIMED_API_KEY || env?.TIMED_INGEST_API_KEY || env?.TIMED_TRADING_API_KEY;
  const tier1Enabled = String(env?.COO_AUTO_APPLY_TIER1 || "false").toLowerCase() === "true";

  if (!adminKey) {
    await recordAction(env, { tier: "tier3", kind: "calibration", target: "cycle", applied: false, reason: "no admin key configured (set TIMED_API_KEY env var)" });
    return { ok: false, error: "no_admin_key" };
  }

  // 1. Run the calibration as promotion candidate (analysis_only=false)
  //    so apply has live deltas. The auto-seed inside runCalibrationAnalysis
  //    handles the no-autopsy-rows case.
  let runRes;
  try {
    const r = await _dispatch(env, `/timed/calibration/run`, {
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
    const r = await _dispatch(env, `/timed/calibration/apply`, {
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

  const SELF_HEAL_IDS = new Set([
    "portfolio_reconcile",
    "candle_freshness_open",
    "invalidation_distance",
  ]);
  const failing = (sweep.checks || []).filter((c) =>
    c.status === "fail" || (c.status === "warn" && SELF_HEAL_IDS.has(c.id)),
  );
  if (failing.length === 0) {
    return { healed, skipped: [{ reason: "no_failures_in_sweep" }], elapsed_ms: Date.now() - t0 };
  }

  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const adminKey = env?.TIMED_API_KEY || env?.TIMED_INGEST_API_KEY || env?.TIMED_TRADING_API_KEY;
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
    } else if (check.id === "invalidation_distance") {
      action = enabled
        ? await _healInvalidationDistance(env)
        : { ok: true, dry_run: true, would_do: "tightenWideOpenStops(dryRun=false)" };
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
    const r = await _dispatch(env, `/timed/admin/ledger/repair?mode=investor&dryRun=false`, {
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
  // Batch via alpaca-backfill (TD-primary, Alpaca fallback) — heals D+60
  // in one shot per ticker instead of the older single-TF backfill-candles
  // path that often left intraday gaps on open positions.
  const results = [];
  for (const sym of tickers) {
    try {
      let ok = false;
      for (const tf of ["D", "60"]) {
        const r = await _dispatch(
          env,
          `/timed/admin/alpaca-backfill?ticker=${encodeURIComponent(sym)}&tf=${tf}&sinceDays=7`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        const j = await r.json().catch(() => ({}));
        if (j?.ok && (j?.upserted || 0) > 0) ok = true;
      }
      results.push({ ticker: sym, ok, status: ok ? 200 : 0 });
    } catch (e) {
      results.push({ ticker: sym, ok: false, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: results.some(r => r.ok), results };
}

async function _healInvalidationDistance(env) {
  try {
    const { tightenWideOpenStops } = await import("../sanity-sweep.js");
    const r = await tightenWideOpenStops(env, { dryRun: false, thresholdPct: 25, maxDrawdownPct: 20 });
    return r?.ok
      ? { ok: true, tightened: r.count, tickers: (r.tightened || []).map((t) => t.ticker) }
      : { ok: false, error: r?.error || "tighten_failed" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// ── Screener auto-promotion ───────────────────────────────────────────

/**
 * Walk the discovery_promotion_queue, auto-approve high-conviction
 * candidates. Operator mandate: "I just want to be informed and have a
 * way to provide feedback."
 *
 * Approach:
 *   • COO owns the decision (universe management = operations)
 *   • Each candidate gets a CIO consult — CIO can VETO (REJECT) per ticker
 *   • Operator is informed via Discord/email + MC card
 *   • Operator has 24h to flip approve→decline (which removes the ticker
 *     from the universe again, see decideOnCandidate decline path)
 *
 * Auto-approve criteria (all gates must pass):
 *   1. status === "needs_review"
 *   2. total_score >= COO_SCREENER_AUTO_SCORE (default 70)
 *   3. red_flags is empty
 *   4. CIO consult returns APPROVE or ADJUST (REJECT vetoes)
 *   5. Daily cap: max COO_SCREENER_DAILY_MAX promotions per cycle
 *      (default 3 — never more than 3 new universe adds per day)
 *
 * Returns { promoted: [], vetoed: [], skipped: [], elapsed_ms }
 */
export async function runScreenerAutoPromote(env, options = {}) {
  const t0 = Date.now();
  const promoted = [];
  const vetoed = [];
  const skipped = [];
  const masterEnabled = String(env?.COO_ENABLED || "false").toLowerCase() === "true";
  const screenerEnabled = String(env?.COO_SCREENER_AUTO_PROMOTE || "false").toLowerCase() === "true";
  const dryRun = !screenerEnabled || !masterEnabled || !!options.dryRun;
  /* 2026-06-10 — model_config override FIRST, env fallback. The
     Discovery "lower screener threshold" recommendation Apply writes
     COO_SCREENER_AUTO_SCORE into model_config, but this lane only read
     the env var — so the operator's Apply was silently inert until the
     next worker deploy. Hot-reload the knob like every other dynamic
     config value. */
  let minScore = Number(env?.COO_SCREENER_AUTO_SCORE) || 70;
  try {
    const row = await env?.DB?.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'COO_SCREENER_AUTO_SCORE'`,
    ).first();
    const dbVal = Number(row?.config_value);
    if (Number.isFinite(dbVal) && dbVal >= 50 && dbVal <= 100) minScore = dbVal;
  } catch (_) { /* env fallback stands */ }
  const dailyMax = Number(env?.COO_SCREENER_DAILY_MAX) || 3;

  try {
    /* 1. Load needs_review candidates.
       NOTE: the function is `loadPromotionQueueRows` (returns
       { ok, count, rows }), NOT `listPromotionQueue` (which was the
       name in an earlier draft and would have thrown at runtime).
       Caught by worker/coo/coo-orchestrator.test.js — keep that
       test passing if you rename anything here. */
    const PromotionQueue = await import("../discovery/promotion-queue.js");
    const list = await PromotionQueue.loadPromotionQueueRows(env, { status: "needs_review", limit: 50 });
    const candidates = (list?.rows || []).filter(c =>
      Number(c.total_score) >= minScore && (!c.red_flags || c.red_flags.length === 0)
    );
    if (candidates.length === 0) {
      return { promoted, vetoed, skipped: [{ reason: "no_eligible_candidates", min_score: minScore }], elapsed_ms: Date.now() - t0 };
    }

    // 2. For each, run CIO consult + (if dry-run=false) approve.
    const PromotionDecide = PromotionQueue.decideOnCandidate;
    const { cioReviewEntrySkip } = await import("../cio/cio-lifecycle-gate.js");
    for (const c of candidates) {
      if (promoted.length >= dailyMax) {
        skipped.push({ ticker: c.ticker, reason: `daily_cap_${dailyMax}_reached` });
        continue;
      }
      // CIO consult — uses the entry-skip-review gate but inverted: we're
      // asking "should we SKIP this promotion?" CIO returning OVERRIDE
      // means it'd promote despite Loop 2 (= positive signal here);
      // CIO returning APPROVE/PROCEED is also fine. Only HARD REJECT
      // (cio_decision === REJECT) is a veto.
      let cioOk = true;
      let cioReasoning = "no_cio_consult";
      try {
        const cioRes = await cioReviewEntrySkip(env, {
          sym: c.ticker,
          direction: "LONG", // screener candidates are always assumed long
          proposal: { ticker: c.ticker, total_score: c.total_score, thesis: c.thesis_text },
          memory: {},
          bucket: "screener_auto_promote",
        });
        // If CIO outright REJECTed (gate returns allow=false AND cio_decision=REJECT),
        // veto the promotion. Otherwise proceed.
        if (cioRes?.gate?.cio_decision === "REJECT") {
          cioOk = false;
          cioReasoning = String(cioRes?.reasoning || "cio_rejected").slice(0, 200);
        } else {
          cioReasoning = String(cioRes?.reasoning || "cio_no_objection").slice(0, 200);
        }
      } catch (e) {
        // CIO failure shouldn't block; just note it.
        cioReasoning = `cio_unavailable: ${String(e?.message || e).slice(0, 100)}`;
      }

      if (!cioOk) {
        vetoed.push({
          ticker: c.ticker, candidate_id: c.candidate_id,
          total_score: c.total_score, cio_reasoning: cioReasoning,
        });
        await recordAction(env, {
          tier: "tier2", kind: "screener_promote", target: c.ticker,
          applied: false, reason: `CIO veto: ${cioReasoning}`,
          candidate_id: c.candidate_id, total_score: c.total_score,
        });
        continue;
      }

      // Actually promote (or dry-run log).
      if (dryRun) {
        promoted.push({
          ticker: c.ticker, candidate_id: c.candidate_id,
          total_score: c.total_score, dry_run: true, cio_reasoning: cioReasoning,
        });
        await recordAction(env, {
          tier: "tier1", kind: "screener_promote", target: c.ticker,
          applied: false, dry_run: true,
          reason: `would promote (score ${c.total_score}, CIO: ${cioReasoning.slice(0, 80)})`,
          candidate_id: c.candidate_id, total_score: c.total_score,
        });
      } else {
        const decideRes = await PromotionDecide(env, {
          candidate_id: c.candidate_id,
          decision: "approve",
          decided_by: `ai_coo_auto`,
          ctx: options.ctx,
          ensureOnboard: typeof options.ensureOnboard === "function"
            ? (sym, meta) => options.ensureOnboard(sym, meta)
            : undefined,
        });
        if (decideRes?.ok) {
          promoted.push({
            ticker: c.ticker, candidate_id: c.candidate_id,
            total_score: c.total_score, universe_added: !!decideRes.universe_added,
            cio_reasoning: cioReasoning,
          });
          await recordAction(env, {
            tier: "tier1", kind: "screener_promote", target: c.ticker,
            applied: true, reason: `promoted (score ${c.total_score}, CIO: ${cioReasoning.slice(0, 80)})`,
            candidate_id: c.candidate_id, total_score: c.total_score,
            universe_added: !!decideRes.universe_added,
          });
        } else {
          skipped.push({
            ticker: c.ticker, candidate_id: c.candidate_id,
            reason: `decide_failed: ${decideRes?.error || "unknown"}`,
          });
        }
      }
    }

    // 3. Discord notification + audit (only when something was promoted).
    if (promoted.length > 0 && !dryRun) {
      await _notifyScreenerPromotions(env, promoted, vetoed);
    }
  } catch (e) {
    console.error("[COO screener_auto_promote] threw:", String(e?.message || e).slice(0, 200));
    return { promoted, vetoed, skipped: [{ reason: `error: ${String(e?.message || e).slice(0, 200)}` }], elapsed_ms: Date.now() - t0 };
  }
  return { promoted, vetoed, skipped, dry_run: dryRun, elapsed_ms: Date.now() - t0 };
}

// ── Move Discovery integration ────────────────────────────────────────

/**
 * Run the worker-native move discovery, persist to KV, and surface
 * actionable findings (missed-pattern alerts, churn alerts) to the
 * operator. Discovery used to be a CLI-only ritual that went 3+
 * months without refresh; this puts it on autopilot.
 *
 * Findings drive notifications when:
 *   • capture_rate falls below COO_DISCOVERY_CAPTURE_FLOOR (default 5%)
 *   • churn_rate exceeds COO_DISCOVERY_CHURN_CEIL (default 5%)
 *   • a single ticker churned ≥ 3 times in window
 *
 * Returns the discovery summary so it lands in the daily cycle log.
 */
export async function runMoveDiscoveryCycle(env, options = {}) {
  const t0 = Date.now();
  const masterEnabled = String(env?.COO_ENABLED || "false").toLowerCase() === "true";
  const discoveryEnabled = String(env?.COO_DISCOVERY_ENABLED || "true").toLowerCase() === "true";
  if (!masterEnabled || !discoveryEnabled) {
    return { ok: false, skipped: true, reason: "coo_or_discovery_disabled", elapsed_ms: Date.now() - t0 };
  }

  let result;
  try {
    /* Use the top-level import (see top of file) instead of dynamic
       import — dynamic imports inside async handlers can intermittently
       fail to bundle in Cloudflare Workers under certain wrangler/
       esbuild combinations. Static imports always bundle correctly. */
    result = await runMoveDiscovery(env, {
      windowDays: Number(env?.COO_DISCOVERY_WINDOW_DAYS) || 60,
      minAtr: Number(env?.COO_DISCOVERY_MIN_ATR) || 3,
    });
  } catch (e) {
    return { ok: false, error: `discovery_threw: ${String(e?.message || e).slice(0, 200)}`, elapsed_ms: Date.now() - t0 };
  }

  if (!result?.ok) {
    return { ok: false, error: result?.error || "discovery_failed", elapsed_ms: Date.now() - t0 };
  }

  await recordAction(env, {
    tier: "tier3", kind: "move_discovery_scan", target: "universe",
    applied: true,
    reason: `scanned ${result.summary?.tickers_scanned || 0} tickers, ${result.summary?.total_moves || 0} moves, capture ${result.summary?.capture_rate || 0}%, missed ${result.summary?.missed || 0}, churned ${result.summary?.churned || 0}`,
    summary: result.summary,
  });

  /* 2026-06-10 — Auto-diagnose + gameplan synthesis (the Discovery
     blindspot fix). Previously the diagnosis pass (miss-reason
     buckets) only ran when the operator clicked "Run Diagnosis", so
     the most actionable discovery data was almost always absent — and
     NOTHING fed the officer suite. Chain both steps right after the
     scan so every nightly cycle produces:
       1. report.diagnosis      (LOW_RANK / NO_SIGNALS / SHOULD_HAVE_
                                 ENTERED... buckets on KV)
       2. timed:discovery:gameplan (constraint mix + playbook usage +
                                 miss archetypes + narrative) — the
                                 artifact CRO synthesis and CIO memory
                                 now consume.
     Both are best-effort: a failure must not break the COO cycle. */
  let gameplanSummary = null;
  try {
    const diag = await runDiagnosis(env, { limit: 150 });
    if (!diag?.ok) console.warn("[COO discovery] diagnosis skipped:", diag?.error || "unknown");
  } catch (e) {
    console.warn("[COO discovery] diagnosis threw:", String(e?.message || e).slice(0, 150));
  }
  try {
    const gp = await buildDiscoveryGameplan(env);
    if (gp?.ok) {
      gameplanSummary = {
        binding_constraint: gp.gameplan?.binding_constraint,
        binding_constraint_pct: gp.gameplan?.binding_constraint_pct,
        one_play_offense: gp.gameplan?.playbook_usage?.one_play_offense || false,
        plays_idle: (gp.gameplan?.playbook_usage?.plays_idle || []).length,
        archetypes: (gp.gameplan?.miss_archetypes || []).length,
      };
      await recordAction(env, {
        tier: "tier3", kind: "discovery_gameplan", target: "universe",
        applied: true,
        reason: (gp.gameplan?.narrative || "").slice(0, 280),
        summary: gameplanSummary,
      });
    } else {
      console.warn("[COO discovery] gameplan skipped:", gp?.error || "unknown");
    }
  } catch (e) {
    console.warn("[COO discovery] gameplan threw:", String(e?.message || e).slice(0, 150));
  }

  /* 2026-06-02 — Surface discovery recommendations as individual
     tier-2 (operator approval) audit-log entries so the operator
     sees them in the MC AI COO card alongside calibration/screener
     actions. The Discovery page is the primary UI for applying them
     (1-click Apply), but logging here gives the daily-digest path
     visibility too.

     2026-06-10 — ALSO submit each actionable rec to the canonical
     learning_proposals bus (tier-2, source=discovery). Before this,
     Discovery was the only learning loop bypassing the bus: its Apply
     wrote model_config directly with no rollback row and no place in
     the operator's proposal queue. submitProposal dedupes per
     (source, config_key) — a repeat nightly scan UPDATES the pending
     proposal's evidence instead of stacking duplicates, and the
     cooldown veto in buildRecommendations stops post-apply re-spam. */
  try {
    const recs = result.recommendations || [];
    const actionable = recs.filter((r) => r?.type === "knob_change");
    for (const rec of actionable.slice(0, 5)) {
      await recordAction(env, {
        tier: rec.tier === 1 ? "tier1" : rec.tier === 2 ? "tier2" : "tier3",
        kind: "discovery_recommendation",
        target: rec.knob_path || rec.id,
        applied: false, // never auto-applied; operator decides on the Discovery page
        reason: `${rec.title} (${rec.confidence || "?"} conf): ${(rec.rationale || "").slice(0, 200)}`,
        recommendation_id: rec.id,
        current_value: rec.current_value,
        suggested_value: rec.suggested_value,
        expected_captures: rec.expected_captures,
      });
      try {
        await submitProposal(env, {
          source: "discovery",
          kind: "discovery_knob",
          config_key: rec.knob_path,
          proposed_value: rec.suggested_value,
          tier: "tier2",
          evidence: {
            recommendation_id: rec.id,
            rationale: (rec.rationale || "").slice(0, 400),
            confidence: rec.confidence,
            expected_captures: rec.expected_captures,
            example_tickers: rec.example_tickers || [],
            window_summary: result.summary,
            gameplan: gameplanSummary,
          },
          note: rec.title,
        });
      } catch (e) {
        console.warn("[COO discovery] bus submit failed:", String(e?.message || e).slice(0, 120));
      }
    }
  } catch (e) {
    console.warn("[COO discovery] failed to record recommendations:", String(e?.message || e).slice(0, 120));
  }

  // Findings trigger surface notification (Tier 3 info-only — operator
  // decides whether to act on calibration knobs).
  const captureFloor = Number(env?.COO_DISCOVERY_CAPTURE_FLOOR) || 5;
  const churnCeiling = Number(env?.COO_DISCOVERY_CHURN_CEIL) || 5;
  const captureRate = Number(result.summary?.capture_rate) || 0;
  const churnRate = Number(result.summary?.churn_rate) || 0;
  const alerts = [];
  if (captureRate < captureFloor && (result.summary?.total_moves || 0) > 20) {
    alerts.push(`Capture rate ${captureRate}% < floor ${captureFloor}% (${result.summary.missed} missed of ${result.summary.total_moves})`);
  }
  if (churnRate > churnCeiling) {
    alerts.push(`Churn rate ${churnRate}% > ceiling ${churnCeiling}% (${result.summary.churned} churned)`);
  }
  // Repeated-churn tickers (per-ticker churn ≥ 3 in window).
  // result.churning is summarized per-ticker; pick worst offenders.
  // The full report on KV has the per-ticker list under `churning`.

  if (alerts.length > 0) {
    await _notifyDiscoveryAlert(env, alerts, result.summary, result.missed_signals);
    await recordAction(env, {
      tier: "tier2", kind: "move_discovery_alert", target: "universe",
      applied: false, reason: alerts.join(" · "),
      summary: result.summary,
    });
  }

  return {
    ok: true,
    elapsed_ms: Date.now() - t0,
    discovery_elapsed_ms: result.elapsed_ms,
    summary: result.summary,
    alerts,
  };
}

async function _notifyDiscoveryAlert(env, alerts, summary, missedSignals) {
  // 2026-06-10 — route through notifyDiscord's LANE ROUTER on the
  // "system" lane (#system-alerts). This sender previously did a raw
  // fetch against DISCORD_WEBHOOK_URL — the #trade-signals webhook — so
  // ops/calibration noise landed in the channel users watch for trade
  // entries (operator-reported). Same fix for _notifyScreenerPromotions.
  try {
    const lines = [];
    lines.push("**Discovery flagged the following:**");
    for (const a of alerts) lines.push(`• ${a}`);
    if (summary) {
      lines.push("");
      lines.push(`Window summary: ${summary.total_moves} moves over ${summary.tickers_scanned} tickers · ${summary.full_capture} full · ${summary.partial_capture} partial · ${summary.missed} missed · ${summary.churned} churned`);
    }
    if (missedSignals?.top_missed?.length > 0) {
      lines.push("");
      lines.push(`Biggest misses: ${missedSignals.top_missed.slice(0, 5).map((m) => `${m.ticker} ${m.move_pct}%`).join(", ")}`);
    }
    lines.push("");
    lines.push("Review in System Intelligence → Discovery tab. Operator can use Calibration → Run Analysis to propose knob changes targeting these patterns.");
    await notifyDiscord(env, {
      title: "AI COO · Move Discovery Alert",
      description: lines.join("\n"),
      color: 0xf59e0b,
      timestamp: new Date().toISOString(),
    }, "system").catch((e) => console.warn("[COO discovery] webhook failed:", String(e?.message || e).slice(0, 120)));
  } catch (e) {
    console.warn("[COO discovery] notify failed:", String(e?.message || e).slice(0, 120));
  }
}

async function _notifyScreenerPromotions(env, promoted, vetoed) {
  // 2026-06-10 — system lane via the router (see _notifyDiscoveryAlert).
  try {
    const lines = [];
    lines.push(`✅ **${promoted.length} ticker${promoted.length === 1 ? "" : "s"} auto-promoted to universe**`);
    lines.push("");
    for (const p of promoted) {
      lines.push(`• \`${p.ticker}\` — score ${p.total_score}${p.cio_reasoning ? ` · CIO: ${p.cio_reasoning.slice(0, 60)}` : ""}`);
    }
    if (vetoed.length > 0) {
      lines.push("");
      lines.push(`🚫 CIO vetoed: ${vetoed.map(v => `\`${v.ticker}\``).join(", ")}`);
    }
    lines.push("");
    lines.push(`To reverse any promotion within 24h: Mission Control → Screener Promotions card → click "Undo" on the row.`);

    await notifyDiscord(env, {
      title: "AI COO · Screener Auto-Promote",
      description: lines.join("\n"),
      color: 0x34d399,
      timestamp: new Date().toISOString(),
    }, "system").catch(e => console.warn("[COO screener] webhook failed:", String(e?.message || e).slice(0, 120)));
  } catch (e) {
    console.warn("[COO screener] notify failed:", String(e?.message || e).slice(0, 120));
  }
}

// ── Screener lane (post-ingest) ───────────────────────────────────────

/**
 * Rebuild promotion queue then run screener auto-promote. Scheduled at
 * 23:00 UTC Mon–Fri so it runs AFTER the 22:30 GitHub screener POST.
 */
export async function runCooScreenerLane(env, options = {}) {
  const t0 = Date.now();
  const summary = {
    ok: true,
    started_at: t0,
    promotion_queue: null,
    screener_promote: null,
    elapsed_ms: 0,
  };

  try {
    const PromotionQueue = await import("../discovery/promotion-queue.js");
    summary.promotion_queue = await PromotionQueue.rebuildPromotionQueue(env);
  } catch (e) {
    summary.promotion_queue = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  try {
    summary.screener_promote = await runScreenerAutoPromote(env, options);
  } catch (e) {
    summary.screener_promote = { error: String(e?.message || e).slice(0, 200) };
  }

  summary.elapsed_ms = Date.now() - t0;

  try {
    await env.KV_TIMED.put("coo:last_screener_lane", JSON.stringify(summary), { expirationTtl: 14 * 86400 });
  } catch (_) {}

  return summary;
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
    screener_promote: null,
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

  // 3. Screener auto-promote moved to runCooScreenerLane() at 23:00 UTC
  // (after the 22:30 GitHub screener POST). Running it here at 22:00
  // raced the empty/stale KV and produced zero promotions.
  summary.screener_promote = { skipped: true, reason: "deferred_to_23_00_screener_lane" };

  // 4. Move Discovery scan — what did we miss / churn / capture?
  //    Persists to KV timed:move-discovery (which the system-
  //    intelligence Discovery tab reads). Surfaces missed-pattern
  //    findings so the operator can see WHY a move was missed and
  //    later, calibration can act on the pattern signal.
  try {
    summary.move_discovery = await runMoveDiscoveryCycle(env, options);
  } catch (e) {
    summary.move_discovery = { error: String(e?.message || e).slice(0, 200) };
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
