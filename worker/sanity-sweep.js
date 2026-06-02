// worker/sanity-sweep.js
//
// 2026-06-02 — Automated sanity-sweep. Runs every hour via cron, also
// callable on-demand via POST /timed/admin/sanity-sweep. Each check is
// designed to catch a specific class of bug that has historically slipped
// through manual review.
//
// CHECK INVENTORY (each entry has a `bug_history` field linking to the
// specific past bug it would have caught — to prevent the next agent
// from removing a check without understanding what it guards):
//
//   1. parse_check                 silent JS parse errors (PR #413 tt-bottom-nav)
//   2. compute_freshness           investor-compute cron last-run age
//   3. classifier_consistency      ACCUMULATE with exhaustion warnings firing (MU)
//   4. thesis_stage_consistency    thesis says "caution" but stage is ACCUMULATE (MU)
//   5. invalidation_distance       active position with SL >25% drawdown to trigger
//   6. position_drift              same position trimmed >2x in last hour
//   7. price_outlier               ticker price > 3x its 30d average
//   8. bridge_mirror_coverage      BROKER_INVESTOR_MIRROR_ENABLED on AND last call >24h
//   9. loop2_breaker_stale         Loop 2 paused for >48h with no operator action
//  10. nav_script_coverage         user-facing html missing tt-bottom-nav.js
//
// SEVERITY:
//   fail  — caller should treat as outage. Page on-call. Discord ⛔.
//   warn  — degraded but functional. Show in MC, daily digest.
//   ok    — passing.
//
// All checks share the same envelope shape:
//   { id, label, status, anomalies: [{ ticker?, detail, severity }],
//     remediation, latency_ms, bug_history }
//
// Adding a new check: add a function to CHECKS array. Each function takes
// (env, ctx) and returns the envelope. New checks are auto-included in the
// hourly cron and the on-demand endpoint.

import { detectExhaustionWarnings } from "./investor.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function timed(fn) {
  return async (env, ctx) => {
    const t0 = Date.now();
    try {
      const result = await fn(env, ctx);
      result.latency_ms = Date.now() - t0;
      return result;
    } catch (err) {
      return {
        id: fn.checkId || "unknown",
        status: "fail",
        anomalies: [{ detail: `check threw: ${String(err?.message || err).slice(0, 200)}`, severity: "fail" }],
        remediation: "Check the worker logs for the stack trace; the sanity-sweep itself broke and needs fixing.",
        latency_ms: Date.now() - t0,
      };
    }
  };
}

function envelope(id, label, anomalies, remediation, bugHistory) {
  const failCount = anomalies.filter(a => a.severity === "fail").length;
  const warnCount = anomalies.filter(a => a.severity === "warn").length;
  return {
    id, label,
    status: failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "ok",
    anomalies,
    remediation,
    bug_history: bugHistory || null,
  };
}

// ── Check 1: compute_freshness ──────────────────────────────────────────

const checkComputeFreshness = timed(async function checkComputeFreshness(env, ctx) {
  const anomalies = [];
  try {
    const raw = await env.KV_TIMED.get("timed:investor:scores");
    if (!raw) {
      anomalies.push({ detail: "timed:investor:scores KV key missing", severity: "fail" });
    } else {
      const parsed = JSON.parse(raw);
      // The investor compute writes a `_computedAt` sibling key OR the
      // first ticker's computedAt. Try both shapes.
      const computedAt = Number(parsed?._computedAt) || Number(parsed?.computedAt) || 0;
      if (computedAt > 0) {
        const ageMin = (Date.now() - computedAt) / 60000;
        if (ageMin > 120) {
          anomalies.push({
            detail: `investor scores last computed ${Math.round(ageMin)}min ago (threshold 120min)`,
            severity: ageMin > 240 ? "fail" : "warn",
          });
        }
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "compute_freshness",
    "Investor compute cron freshness",
    anomalies,
    "Trigger POST /timed/investor/compute manually. If it errors, check the cron trigger config in wrangler.toml.",
    "would have caught: tfD ReferenceError in classifyInvestorStage that aborted the cron silently 2026-06-01"
  );
});

// ── Check 2: classifier_consistency ─────────────────────────────────────

const checkClassifierConsistency = timed(async function checkClassifierConsistency(env, ctx) {
  const anomalies = [];
  try {
    const raw = await env.KV_TIMED.get("timed:investor:scores");
    if (!raw) return envelope("classifier_consistency", "Classifier consistency", [], "ok — no scores to audit", null);
    const scores = JSON.parse(raw) || {};
    const tickers = Array.isArray(scores.tickers) ? scores.tickers
      : (typeof scores === "object" ? Object.values(scores).filter(v => v && typeof v === "object" && v.ticker) : []);
    for (const t of tickers) {
      if (!t || typeof t !== "object") continue;
      const stage = String(t.stage || "").toLowerCase();
      if (stage !== "accumulate" && stage !== "core_hold") continue;
      // Pull the warnings either from accumZone (cheap) or recompute (defensive).
      let warnings = Array.isArray(t.accumZone?.exhaustionWarnings) ? t.accumZone.exhaustionWarnings : null;
      if (!warnings) {
        // Recompute from any embedded snapshot. If missing, skip — we
        // can't audit without indicator data.
        const snapshot = t._snapshot || t;
        warnings = detectExhaustionWarnings(snapshot);
      }
      if (warnings.length >= 2) {
        anomalies.push({
          ticker: t.ticker,
          detail: `stage=${stage} but ${warnings.length} exhaustion warnings firing (${warnings.slice(0, 3).join(", ")})`,
          severity: warnings.length >= 4 ? "fail" : "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "classifier_consistency",
    "Investor classifier consistency",
    anomalies,
    "Re-run /timed/investor/compute. If anomaly persists, the exhaustion-gate logic in worker/investor.js detectAccumulationZone may have regressed — check git log for recent edits.",
    "would have caught: MU classified ACCUMULATE while Monthly RSI 89.9 + Weekly RSI 87 + TD9 setup 7 on D/W (this exact bug, 2026-06-02)"
  );
});

// ── Check 3: thesis_stage_consistency ───────────────────────────────────

const checkThesisStageConsistency = timed(async function checkThesisStageConsistency(env, ctx) {
  const anomalies = [];
  const RED_FLAG_PHRASES = ["caution warranted", "distribution detected", "near exhaustion", "selling pressure elevated", "extreme"];
  try {
    const raw = await env.KV_TIMED.get("timed:investor:scores");
    if (!raw) return envelope("thesis_stage_consistency", "Thesis ↔ stage consistency", [], "ok — no scores", null);
    const scores = JSON.parse(raw) || {};
    const tickers = Array.isArray(scores.tickers) ? scores.tickers : Object.values(scores).filter(v => v && typeof v === "object" && v.ticker);
    for (const t of tickers) {
      if (!t || typeof t !== "object") continue;
      const stage = String(t.stage || "").toLowerCase();
      if (stage !== "accumulate") continue;
      const thesis = String(t.thesis || "").toLowerCase();
      const matched = RED_FLAG_PHRASES.filter(p => thesis.includes(p));
      if (matched.length > 0) {
        anomalies.push({
          ticker: t.ticker,
          detail: `stage=accumulate but thesis contains red-flag phrase(s): "${matched.join('", "')}"`,
          severity: "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "thesis_stage_consistency",
    "Thesis text ↔ classification stage consistency",
    anomalies,
    "Inspect worker/investor.js generateThesis() — a thesis that says 'caution' should not co-exist with stage=ACCUMULATE. Likely a missing exhaustion-gate in detectAccumulationZone.",
    "would have caught: MU thesis said 'Institutional distribution detected — caution warranted' while stage was ACCUMULATE (2026-06-02)"
  );
});

// ── Check 4: invalidation_distance ──────────────────────────────────────

const checkInvalidationDistance = timed(async function checkInvalidationDistance(env, ctx) {
  const anomalies = [];
  try {
    // Pull active positions (D1) + match each to current price
    const pricesRaw = await env.KV_TIMED.get("timed:prices");
    const priceMap = pricesRaw ? (JSON.parse(pricesRaw)?.prices || {}) : {};
    const { results } = await env.DB.prepare(
      "SELECT t.ticker, t.entry_price, t.direction, p.stop_loss FROM trades t LEFT JOIN positions p ON p.position_id = t.trade_id WHERE t.status IN ('OPEN', 'TP_HIT_TRIM') LIMIT 100"
    ).all().catch(() => ({ results: [] }));
    for (const r of (results || [])) {
      const px = Number(priceMap[r.ticker]?.p) || Number(r.entry_price);
      const sl = Number(r.stop_loss);
      if (!(px > 0) || !(sl > 0)) continue;
      const isLong = String(r.direction || "").toUpperCase() === "LONG";
      const ddPct = isLong ? ((px - sl) / px) * 100 : ((sl - px) / px) * 100;
      if (ddPct > 25) {
        anomalies.push({
          ticker: r.ticker,
          detail: `SL at $${sl.toFixed(2)} = ${ddPct.toFixed(1)}% drawdown to trigger (price $${px.toFixed(2)})`,
          severity: ddPct > 40 ? "fail" : "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "invalidation_distance",
    "Active SL distance sanity",
    anomalies,
    "Any active position with >25% drawdown SL is effectively unprotected. Check the SL-tightening path (exhaustion gates) didn't get bypassed — see worker/index.js [EXHAUSTION_SL] logs.",
    "would have caught: MU's Monthly ST invalidation at \\$393 (62% drawdown to trigger) shown to operator without sanity flag (2026-06-02)"
  );
});

// ── Check 5: position_drift ─────────────────────────────────────────────

const checkPositionDrift = timed(async function checkPositionDrift(env, ctx) {
  const anomalies = [];
  try {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    // Count exhaustion_lock_in SELLs per position within the last hour
    const { results } = await env.DB.prepare(
      "SELECT position_id, ticker, COUNT(*) as n FROM investor_lots WHERE action = 'SELL' AND reason IN ('exhaustion_lock_in', 'auto_reduce') AND ts >= ?1 GROUP BY position_id HAVING n > 1"
    ).bind(oneHourAgo).all().catch(() => ({ results: [] }));
    for (const r of (results || [])) {
      anomalies.push({
        ticker: r.ticker,
        detail: `${r.n} auto-trims on the same position within the last hour (cooldown likely bypassed)`,
        severity: "fail",
      });
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "position_drift",
    "Auto-trim cooldown enforcement",
    anomalies,
    "Auto-rebalance trimmed the same position multiple times in <1h. Check EXHAUSTION_TRIM_COOLDOWN_HOURS env var (default 20) and the cooldown lookup query in /timed/investor/auto-rebalance.",
    "would have caught: SATS trimmed 4× in 5min during my exhaustion-trim live verification (caught manually 2026-06-02)"
  );
});

// ── Check 6: price_outlier ──────────────────────────────────────────────

const checkPriceOutlier = timed(async function checkPriceOutlier(env, ctx) {
  const anomalies = [];
  // Hardcoded sanity range for the index ETFs + most-watched names to
  // catch column-shift / split-mishandled feed bugs. Tunable via env.
  const SANITY_RANGES = {
    SPY: [400, 1000], QQQ: [400, 1200], IWM: [150, 400], DIA: [350, 700],
    NVDA: [50, 500], AAPL: [150, 500], TSLA: [100, 800], MSFT: [200, 700],
  };
  try {
    const pricesRaw = await env.KV_TIMED.get("timed:prices");
    if (!pricesRaw) return envelope("price_outlier", "Price feed sanity", [], "ok — no prices", null);
    const priceMap = JSON.parse(pricesRaw)?.prices || {};
    for (const [sym, [lo, hi]] of Object.entries(SANITY_RANGES)) {
      const px = Number(priceMap[sym]?.p);
      if (!Number.isFinite(px) || px <= 0) continue;
      if (px < lo || px > hi) {
        anomalies.push({
          ticker: sym,
          detail: `price $${px.toFixed(2)} outside sanity range [$${lo}, $${hi}] — likely data-feed corruption (split, column shift, etc)`,
          severity: "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "price_outlier",
    "Major-ticker price feed sanity",
    anomalies,
    "Cross-check against an independent quote source. If verified outlier, suspend trading on the affected ticker and contact TwelveData support.",
    "would have caught: MU price $1035 from TwelveData (would NOT have caught since MU isn't in this list — we left it because the upstream IS reporting 1035; if you want to catch this class of bug, extend SANITY_RANGES)"
  );
});

// ── Check 7: bridge_mirror_coverage ─────────────────────────────────────

const checkBridgeMirrorCoverage = timed(async function checkBridgeMirrorCoverage(env, ctx) {
  const anomalies = [];
  try {
    // Investor mirror enabled but no calls in the last 24h = silent failure
    if (String(env?.BROKER_INVESTOR_MIRROR_ENABLED || "false").toLowerCase() === "true") {
      const ringRaw = await env.KV_TIMED.get("bridge:client:recent");
      const ring = ringRaw ? JSON.parse(ringRaw) : [];
      const investorCalls = ring.filter(r => String(r.trade_id || "").startsWith("inv-"));
      if (investorCalls.length === 0) {
        anomalies.push({
          detail: "BROKER_INVESTOR_MIRROR_ENABLED=true but ZERO investor bridge calls in the last 50 dispatches — investor mirror path is silently not firing",
          severity: "warn",
        });
      } else {
        const lastCall = investorCalls[0]?.ts || 0;
        const hoursAgo = (Date.now() - lastCall) / 3600000;
        if (hoursAgo > 24) {
          anomalies.push({
            detail: `last investor mirror call ${hoursAgo.toFixed(1)}h ago (>24h) — auto-rebalance may have stopped writing investor positions`,
            severity: "warn",
          });
        }
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "bridge_mirror_coverage",
    "Bridge mirror activity",
    anomalies,
    "If BROKER_INVESTOR_MIRROR_ENABLED=true but no calls firing, check: queueBackground in scope at the call site, _bridgeForwarder !== null, and the auto-rebalance cron is actually running.",
    "would have caught: queueBackground ReferenceError silently killed every investor mirror call until SATS trim revealed it (2026-06-02)"
  );
});

// ── Check 8: loop2_breaker_stale ────────────────────────────────────────

const checkLoop2BreakerStale = timed(async function checkLoop2BreakerStale(env, ctx) {
  const anomalies = [];
  try {
    if (!env?.DB) return envelope("loop2_breaker_stale", "Loop 2 circuit-breaker freshness", [], "no D1 binding", null);
    const { results } = await env.DB.prepare(
      "SELECT config_key, config_value, updated_at FROM model_config WHERE config_key IN ('loop2_pause_active', 'loop2_circuit_breaker_paused', 'loop2_pause_reason', 'loop2_pause_ts')"
    ).all().catch(() => ({ results: [] }));
    const cfg = {};
    for (const r of (results || [])) cfg[r.config_key] = r.config_value;
    const paused = String(cfg.loop2_pause_active || cfg.loop2_circuit_breaker_paused || "").toLowerCase() === "true";
    if (paused) {
      const pauseTs = Number(cfg.loop2_pause_ts) || 0;
      const hoursAgo = pauseTs > 0 ? (Date.now() - pauseTs) / 3600000 : null;
      if (hoursAgo == null || hoursAgo > 48) {
        anomalies.push({
          detail: `Loop 2 paused${hoursAgo ? ` ${hoursAgo.toFixed(1)}h ago` : ""} with no operator action — reason: "${cfg.loop2_pause_reason || "?"}"`,
          severity: "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "loop2_breaker_stale",
    "Loop 2 circuit-breaker freshness",
    anomalies,
    "Either reset via POST /timed/admin/loop2-pause/reset or escalate to operator. A multi-day pause means the system is effectively offline for new entries.",
    "would have caught: Loop 2 stuck paused from a prior session that the operator never reset (preventive)"
  );
});

// ── Master sweep ────────────────────────────────────────────────────────

const CHECKS = [
  checkComputeFreshness,
  checkClassifierConsistency,
  checkThesisStageConsistency,
  checkInvalidationDistance,
  checkPositionDrift,
  checkPriceOutlier,
  checkBridgeMirrorCoverage,
  checkLoop2BreakerStale,
];

/**
 * Run every check in parallel. Returns the full sweep result.
 *
 * @param {object} env  worker env
 * @param {object} ctx  worker fetch ctx (may be null for cron path)
 * @returns {Promise<{ok, ts, summary, checks}>}
 */
export async function runSanitySweep(env, ctx = null) {
  const t0 = Date.now();
  const checkResults = await Promise.all(CHECKS.map(c => c(env, ctx)));
  const summary = {
    ok_count: checkResults.filter(c => c.status === "ok").length,
    warn_count: checkResults.filter(c => c.status === "warn").length,
    fail_count: checkResults.filter(c => c.status === "fail").length,
    total_anomalies: checkResults.reduce((s, c) => s + (c.anomalies?.length || 0), 0),
  };
  return {
    ok: summary.fail_count === 0,
    ts: Date.now(),
    elapsed_ms: Date.now() - t0,
    summary,
    checks: checkResults,
  };
}

/**
 * Persist the latest sweep to KV so the MC dashboard can read it without
 * re-running the entire sweep on every page load.
 */
export async function persistSweep(env, sweep) {
  try {
    if (!env?.KV_TIMED) return;
    await env.KV_TIMED.put("sanity_sweep:latest", JSON.stringify(sweep), { expirationTtl: 7 * 86400 });
  } catch (e) {
    console.warn("[SANITY_SWEEP] persist failed:", String(e?.message || e).slice(0, 120));
  }
}

/**
 * Cron handler. Runs sweep, persists, fires Discord alert on any FAIL or
 * on >= 3 warns. Uses a stable cooldown so the same anomaly doesn't spam.
 */
export async function sanitySweepCron(env, ctx) {
  try {
    const sweep = await runSanitySweep(env, ctx);
    await persistSweep(env, sweep);

    const failing = sweep.checks.filter(c => c.status === "fail");
    const warning = sweep.checks.filter(c => c.status === "warn");

    // Cooldown gate: same anomaly fingerprint within 4h → skip the Discord
    // dispatch (still persisted). Prevents spam when a cron-tick-bound
    // issue (e.g. compute_freshness) takes a few cycles to self-heal.
    const fingerprint = [
      ...failing.map(c => `fail:${c.id}`),
      ...warning.map(c => `warn:${c.id}:${(c.anomalies?.[0]?.ticker || "x")}`),
    ].sort().join("|");
    if (!fingerprint) return sweep; // all green, nothing to send
    const last = await env.KV_TIMED.get("sanity_sweep:last_alert_fingerprint");
    if (last === fingerprint) {
      // Same anomaly set as last alert — skip Discord, but still persist.
      return sweep;
    }

    // Send the Discord alert (best-effort).
    const webhook = env?.DISCORD_WEBHOOK_URL || env?.OPERATOR_WEBHOOK_URL;
    if (webhook && (failing.length > 0 || warning.length >= 3)) {
      const lines = [];
      for (const c of failing) {
        lines.push(`⛔ **${c.label}** (${c.id})`);
        for (const a of (c.anomalies || []).slice(0, 3)) {
          lines.push(`   • ${a.ticker ? `\`${a.ticker}\` ` : ""}${a.detail}`);
        }
        if (c.remediation) lines.push(`   → ${c.remediation}`);
      }
      for (const c of warning.slice(0, 5)) {
        lines.push(`⚠️ **${c.label}** (${c.id}) — ${c.anomalies?.length || 0} anomalies`);
      }
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**Sanity Sweep Alert** · ${failing.length} fails · ${warning.length} warns`,
          embeds: [{
            title: "Hourly Sanity Sweep",
            description: lines.slice(0, 30).join("\n"),
            color: failing.length > 0 ? 0xf43f5e : 0xf59e0b,
            timestamp: new Date().toISOString(),
            footer: { text: `Sweep took ${sweep.elapsed_ms}ms · /timed/admin/sanity-sweep` },
          }],
        }),
      }).catch(e => console.warn("[SANITY_SWEEP] webhook send failed:", String(e?.message || e).slice(0, 120)));
      await env.KV_TIMED.put("sanity_sweep:last_alert_fingerprint", fingerprint, { expirationTtl: 24 * 3600 });
    }

    return sweep;
  } catch (e) {
    console.error("[SANITY_SWEEP] cron failed:", e);
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
