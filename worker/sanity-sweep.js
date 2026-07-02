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
import { notifyDiscord } from "./alerts.js";
import {
  computeMarketSessionReference,
  effectiveCandleAgeMs,
  evaluateOpenPositionCandleMap,
} from "./freshness.js";
import { kvPutText } from "./storage.js";
import { normTicker } from "./ingest.js";
import {
  computeProtectiveStopTighten,
  resolveEffectiveStopLoss,
  slDrawdownPct,
  DEFAULT_MAX_SL_DRAWDOWN_PCT,
} from "./sanity-stop-heal.js";

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
    const pricesRaw = await env.KV_TIMED.get("timed:prices");
    const priceMap = pricesRaw ? (JSON.parse(pricesRaw)?.prices || {}) : {};
    let kvSlByTicker = new Map();
    try {
      const kvTradesRaw = await env.KV_TIMED.get("timed:trades:all");
      const kvTrades = kvTradesRaw ? JSON.parse(kvTradesRaw) : [];
      for (const t of (Array.isArray(kvTrades) ? kvTrades : [])) {
        if (!t || (t.status !== "OPEN" && t.status !== "TP_HIT_TRIM")) continue;
        const sym = String(t.ticker || "").toUpperCase();
        const sl = Number(t.sl ?? t.stop_loss);
        if (!sym || !(sl > 0)) continue;
        const dir = String(t.direction || "LONG").toUpperCase();
        const prev = kvSlByTicker.get(sym);
        if (prev == null) kvSlByTicker.set(sym, { sl, direction: dir });
        else {
          const merged = resolveEffectiveStopLoss(dir, prev.sl, sl);
          kvSlByTicker.set(sym, { sl: merged, direction: dir });
        }
      }
    } catch (_) { kvSlByTicker = new Map(); }
    const { results } = await env.DB.prepare(
      "SELECT t.ticker, t.entry_price, t.direction, p.stop_loss FROM trades t LEFT JOIN positions p ON p.position_id = t.trade_id WHERE t.status IN ('OPEN', 'TP_HIT_TRIM') LIMIT 100"
    ).all().catch(() => ({ results: [] }));
    for (const r of (results || [])) {
      const sym = String(r.ticker || "").toUpperCase();
      const px = Number(priceMap[sym]?.p) || Number(r.entry_price);
      const dir = String(r.direction || "LONG").toUpperCase();
      const kvMeta = kvSlByTicker.get(sym);
      const sl = resolveEffectiveStopLoss(dir, r.stop_loss, kvMeta?.sl);
      if (!(px > 0) || !(sl > 0)) continue;
      const ddPct = slDrawdownPct(dir, px, sl);
      if (ddPct == null) continue;
      if (ddPct > 25) {
        anomalies.push({
          ticker: sym,
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
    "Wide stops are auto-tightened by COO self-heal when COO_SELF_HEAL=true. Otherwise tighten via the gain-protection path — see worker/sanity-stop-heal.js.",
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

// ── Check 9: cron_tick_alive ────────────────────────────────────────────

const checkCronTickAlive = timed(async function checkCronTickAlive(env, ctx) {
  const anomalies = [];
  try {
    // Every cron tick (*/1, */5, hourly) stamps a heartbeat in KV. If
    // the */5 tick hasn't fired in >15min during market hours, the
    // entire cron pipeline (scoring, alerts, trims) is stalled.
    const lastTickRaw = await env.KV_TIMED.get("cron:last_5min_tick");
    const lastTick = Number(lastTickRaw) || 0;
    if (lastTick === 0) {
      anomalies.push({
        detail: "cron:last_5min_tick KV key missing — heartbeat may not be implemented yet",
        severity: "warn",
      });
    } else {
      const ageMin = (Date.now() - lastTick) / 60000;
      if (ageMin > 15) {
        const dt = new Date();
        const hourUtc = dt.getUTCHours();
        const dow = dt.getUTCDay();
        const isWeekend = dow === 0 || dow === 6;
        const isMarketHours = !isWeekend && hourUtc >= 13 && hourUtc <= 22;
        // Off-hours: only escalate to fail at extreme staleness.
        const severity = isMarketHours
          ? (ageMin > 30 ? "fail" : "warn")
          : (ageMin > 240 ? "warn" : "ok");
        if (severity !== "ok") {
          anomalies.push({
            detail: `last */5 cron tick ${Math.round(ageMin)}min ago${isMarketHours ? " (MARKET HOURS)" : " (off-hours)"}`,
            severity,
          });
        }
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "cron_tick_alive",
    "Cron tick heartbeat",
    anomalies,
    "Check the worker's scheduled() handler for errors. Cron is suspended? Check the wrangler.toml triggers list and the Cloudflare dashboard cron status.",
    "would have caught: cron silently muted by integrity-wipe guard with no operator notification"
  );
});

// ── Check 10: candle_freshness_open ─────────────────────────────────────

const checkCandleFreshnessOpen = timed(async function checkCandleFreshnessOpen(env, ctx) {
  const anomalies = [];
  try {
    if (!env?.DB) return envelope("candle_freshness_open", "Candle freshness on open positions", [], "no D1", null);
    // Candles live in D1 (ticker_candles table), NOT KV. Use the same
    // calendar-aware evaluation as ensureOpenPositionCandlesFresh in
    // worker/index.js — a flat 48h wall-clock gap false-alarms every
    // Monday morning (Fri close ≈ 65–89h old) and after holiday weekends.
    const { results: openRows } = await env.DB.prepare(
      "SELECT DISTINCT ticker FROM trades WHERE status IN ('OPEN', 'TP_HIT_TRIM') LIMIT 100"
    ).all().catch(() => ({ results: [] }));
    const openTickers = (openRows || [])
      .map((r) => normTicker(r.ticker))
      .filter(Boolean);
    if (openTickers.length === 0) {
      return envelope("candle_freshness_open", "Candle freshness on open positions",
        [], "no open positions to check", null);
    }
    const slice = openTickers.slice(0, 30);
    const nowMs = Date.now();
    const sessionRef = computeMarketSessionReference(nowMs);
    const marketOpen = sessionRef.market_open;
    const tfList = marketOpen ? ["D", "60", "30", "5", "240"] : ["D", "60", "240"];
    const tickerPH = slice.map(() => "?").join(",");
    const tfPH = tfList.map((_, i) => `?${slice.length + 1 + i}`).join(",");
    const { results: candleRows } = await env.DB.prepare(
      `SELECT ticker, tf, MAX(ts) AS max_ts FROM ticker_candles
       WHERE ticker IN (${tickerPH}) AND tf IN (${tfPH})
       GROUP BY ticker, tf`
    ).bind(...slice, ...tfList).all().catch(() => ({ results: [] }));
    const byTicker = new Map();
    for (const r of (candleRows || [])) {
      const t = normTicker(r.ticker);
      if (!byTicker.has(t)) byTicker.set(t, {});
      byTicker.get(t)[String(r.tf)] = Number(r.max_ts) || 0;
    }
    let staleCount = 0;
    const staleNames = [];
    const staleDetails = [];
    for (const sym of slice) {
      const tfMap = byTicker.get(sym) || {};
      const evalResult = evaluateOpenPositionCandleMap(tfMap, { nowMs, sessionRef, marketOpen });
      if (evalResult.stale) {
        staleNames.push(`${sym}(${evalResult.reasons.slice(0, 2).join("; ")})`);
        staleDetails.push({ ticker: sym, reasons: evalResult.reasons });
        staleCount++;
      }
    }
    if (staleCount > 0) {
      // Streak gate — mirror ensureOpenPositionCandlesFresh: one transient
      // ingest blip should not page; require ≥2 consecutive sweeps with the
      // same (tickers × reasons) signature before emitting an anomaly.
      let emitStale = true;
      try {
        const KV = env?.KV_TIMED || env?.KV;
        if (KV) {
          const _tickerSig = staleDetails.map((s) => s.ticker).sort().join(",");
          const _reasonSig = staleDetails.map((s) => (s.reasons || []).join("|")).sort().join(";").slice(0, 80);
          const _streakKey = `timed:freshness:open_pos_streak:${_tickerSig}::${_reasonSig}`;
          const _streak = (Number(await KV.get(_streakKey)) || 0) + 1;
          await kvPutText(KV, _streakKey, String(_streak), 1800);
          emitStale = _streak >= 2;
          if (!emitStale) {
            console.log(`[SANITY_SWEEP] candle_freshness_open streak=${_streak} for ${_tickerSig} — suppressed (need ≥2)`);
          }
        }
      } catch (_) {}
      if (emitStale) {
        anomalies.push({
          detail: `${staleCount} of ${slice.length} open positions have stale candles: ${staleNames.slice(0, 5).join(", ")}${staleCount > 5 ? `...+${staleCount - 5}` : ""}`,
          severity: staleCount >= 5 ? "fail" : "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "candle_freshness_open",
    "Candle freshness on open positions",
    anomalies,
    "Trigger /timed/admin/backfill-candles for the stale tickers. If many open positions are stale, the candle ingest cron may be down.",
    "would have caught: BK candle staleness 71.5h that almost paged before auto-heal cleared it (2026-06-01)"
  );
});

// ── Check 11: trade_orphan ──────────────────────────────────────────────

const checkTradeOrphan = timed(async function checkTradeOrphan(env, ctx) {
  const anomalies = [];
  try {
    if (!env?.DB) return envelope("trade_orphan", "Trade ↔ position integrity", [], "no D1", null);
    // Trade rows in OPEN status that have no matching positions row.
    // After the bridge has been writing manifest data, every model OPEN
    // trade should have a positions row. Orphans = something didn't get
    // through, the position might be untracked.
    const { results } = await env.DB.prepare(`
      SELECT t.trade_id, t.ticker, t.entry_ts
      FROM trades t
      LEFT JOIN positions p ON p.position_id = t.trade_id
      WHERE t.status IN ('OPEN', 'TP_HIT_TRIM')
        AND p.position_id IS NULL
        AND t.entry_ts >= ?
      LIMIT 30
    `).bind(Date.now() - 14 * 86400000).all().catch(() => ({ results: [] }));
    for (const r of (results || [])) {
      const ageHours = (Date.now() - Number(r.entry_ts)) / 3600000;
      anomalies.push({
        ticker: r.ticker,
        detail: `trade_id=${r.trade_id} OPEN ${ageHours.toFixed(1)}h ago has no positions row (SL/TP not tracked)`,
        severity: ageHours > 24 ? "warn" : "ok",
      });
    }
    // Drop the OK-severity ones (we only push if positions row is
    // missing, which is the issue; ageHours<24 is just "fresh enough
    // we'll wait before alerting").
    const realAnomalies = anomalies.filter(a => a.severity !== "ok");
    return envelope(
      "trade_orphan",
      "Trade row ↔ positions row integrity",
      realAnomalies,
      "Either re-run the trade through the bridge to create the positions row, or manually INSERT into positions if the trade is legitimately broker-orphaned.",
      "would have caught: TSM open trade missing from right-rail History because the trade row existed but no positions row was written (2026-06-01)"
    );
  } catch (e) {
    return envelope("trade_orphan", "Trade ↔ position integrity",
      [{ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" }],
      "Check D1 binding and trade/positions schema.",
      null);
  }
});

// ── Check 12: portfolio_reconcile ───────────────────────────────────────

const checkPortfolioReconcile = timed(async function checkPortfolioReconcile(env, ctx) {
  const anomalies = [];
  try {
    if (!env?.DB) return envelope("portfolio_reconcile", "Investor portfolio reconciliation", [], "no D1", null);
    // Reconciliation math:
    //   cash + positions_cost_basis = initial_capital + realized_pnl
    // (Realized P&L from SELL trims goes back into cash. Unrealized P&L
    // doesn't change either side — positions stay at cost basis.)
    //
    // 2026-06-02 — Earlier version used `total - expected` which flagged
    // ANY profitable account as drifted. Now subtract realized_pnl
    // from the expected side so the check only fires when the math
    // doesn't actually balance.
    const posSum = await env.DB.prepare(
      "SELECT COALESCE(SUM(cost_basis), 0) AS total FROM investor_positions WHERE status = 'OPEN'"
    ).first().catch(() => ({ total: 0 }));
    const ledgerSum = await env.DB.prepare(
      "SELECT COALESCE(SUM(cash_delta), 0) AS s, COALESCE(SUM(realized_pnl), 0) AS pnl FROM account_ledger WHERE mode = 'investor'"
    ).first().catch(() => ({ s: 0, pnl: 0 }));
    const initial = 100000;
    const positionsValue = Number(posSum?.total) || 0;
    const cash = initial + (Number(ledgerSum?.s) || 0); // race-free derived cash
    const realizedPnl = Number(ledgerSum?.pnl) || 0;
    const accounted = positionsValue + cash;
    const expected = initial + realizedPnl; // cash + positions should equal this
    const drift = accounted - expected;
    const driftPct = expected > 0 ? (drift / expected) * 100 : 0;
    // Tolerance: $50 absolute OR 2% relative, whichever is larger.
    const tolerance = Math.max(50, Math.abs(expected) * 0.02);
    if (Math.abs(drift) > tolerance) {
      anomalies.push({
        detail: `cash $${cash.toFixed(0)} + positions $${positionsValue.toFixed(0)} = $${accounted.toFixed(0)}, expected $${expected.toFixed(0)} (initial $${initial} + realized $${realizedPnl.toFixed(0)}) — drift $${drift.toFixed(0)} (${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(1)}%)`,
        severity: Math.abs(driftPct) > 5 ? "fail" : "warn",
      });
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "portfolio_reconcile",
    "Investor cash + positions reconciliation",
    anomalies,
    "If drift fires, run POST /timed/admin/ledger/repair?mode=investor&dryRun=true to diagnose, then dryRun=false to back-fill missing entries + rebuild the balance column from cumulative cash_delta. If ledger/lots agree but positions drift, run GET /timed/admin/positions/audit?mode=investor then POST /timed/admin/positions/repair?mode=investor&dryRun=false.",
    "would have caught: -27% investor drift caused by silent EXIT ledger insert failures + race-prone balance column (2026-06-02; repair endpoint shipped, 6 entries back-filled, 176 balance rows recomputed)"
  );
});

// ── Check 13: alert_delivery ────────────────────────────────────────────

const checkAlertDelivery = timed(async function checkAlertDelivery(env, ctx) {
  const anomalies = [];
  try {
    if (!env?.DB) return envelope("alert_delivery", "Discord/email alert delivery", [], "no D1", null);
    // Last 24h of alerts table — any with discord_sent=0 + non-null error?
    // .first() returns the row object directly (not {results: [...]}).
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n, MAX(ts) AS last_fail_ts
      FROM alerts
      WHERE discord_sent = 0
        AND discord_error IS NOT NULL
        AND discord_error != ''
        AND ts >= ?
    `).bind(Date.now() - 24 * 3600000).first().catch(() => null);
    const failCount = Number(row?.n) || 0;
    if (failCount > 0) {
      const lastFailAgo = row?.last_fail_ts ? ((Date.now() - Number(row.last_fail_ts)) / 60000).toFixed(0) : "?";
      anomalies.push({
        detail: `${failCount} Discord alert deliveries failed in last 24h (most recent ${lastFailAgo}min ago)`,
        severity: failCount >= 5 ? "fail" : "warn",
      });
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "alert_delivery",
    "Discord alert delivery health",
    anomalies,
    "Check the DISCORD_WEBHOOK_URL secret is valid + the channel still exists. Webhook 401/404 means it was deleted upstream.",
    "would have caught: silent Discord webhook expiration (user sees no alerts and assumes nothing happened)"
  );
});

// ── Check 14: broker_reconciler_freshness ───────────────────────────────

const checkBrokerReconcilerFreshness = timed(async function checkBrokerReconcilerFreshness(env, ctx) {
  const anomalies = [];
  try {
    // The broker bridge reconciler is supposed to run every */5 min
    // during RTH (gate inside bridge-index.js scheduled handler). It
    // writes a heartbeat KV key when it runs.
    const lastReconRaw = await env.KV_TIMED.get("bridge:reconciler:last_run");
    if (!lastReconRaw) {
      // No record yet — check if the bridge is even configured.
      if (env?.BROKER_BRIDGE_URL) {
        anomalies.push({
          detail: "bridge:reconciler:last_run KV key missing — reconciler may never have run",
          severity: "warn",
        });
      }
    } else {
      const lastRun = Number(lastReconRaw) || 0;
      const ageMin = (Date.now() - lastRun) / 60000;
      const dt = new Date();
      const hourUtc = dt.getUTCHours();
      const isWeekday = ![0, 6].includes(dt.getUTCDay());
      const isMarketHours = isWeekday && hourUtc >= 13 && hourUtc <= 22;
      if (isMarketHours && ageMin > 30) {
        anomalies.push({
          detail: `bridge reconciler last ran ${Math.round(ageMin)}min ago (>30min during market hours)`,
          severity: ageMin > 60 ? "fail" : "warn",
        });
      }
    }
  } catch (e) {
    anomalies.push({ detail: `read failed: ${String(e?.message || e).slice(0, 120)}`, severity: "fail" });
  }
  return envelope(
    "broker_reconciler_freshness",
    "Broker bridge reconciler freshness",
    anomalies,
    "Check the bridge worker's scheduled() handler logs. Reconciler stuck = position drift between model and broker goes uncaught.",
    "would have caught: bridge reconciler silently paused after a circuit-breaker trip (operator unaware until manifest got out of sync)"
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
  // 2026-06-02 — Coma-test additions per operator mandate ("imagine if
  // your hard earned money was on the line"). Each catches a different
  // class of silent failure that would let an issue compound overnight.
  checkCronTickAlive,
  checkCandleFreshnessOpen,
  checkTradeOrphan,
  checkPortfolioReconcile,
  checkAlertDelivery,
  checkBrokerReconcilerFreshness,
];

// Critical-path subset that runs every 15min instead of hourly. These
// are the ones where a 1-hour detection window is too long if money is
// on the line. The "full" CHECKS list (above) still runs hourly to catch
// the slower-changing semantic drifts.
const FAST_CHECKS = [
  checkComputeFreshness,
  checkPositionDrift,
  checkCronTickAlive,
  checkCandleFreshnessOpen,
  checkAlertDelivery,
  checkBrokerReconcilerFreshness,
];

/**
 * Run a sweep over the given list of checks in parallel.
 *
 * @param {object} env       worker env
 * @param {object} ctx       worker fetch ctx (may be null for cron path)
 * @param {string} sweepKind "full" | "fast" (just metadata for the response)
 * @param {array}  checks    array of check functions to run
 * @returns {Promise<{ok, ts, kind, summary, checks}>}
 */
async function _runSweep(env, ctx, sweepKind, checks) {
  const t0 = Date.now();
  const checkResults = await Promise.all(checks.map(c => c(env, ctx)));
  const summary = {
    ok_count: checkResults.filter(c => c.status === "ok").length,
    warn_count: checkResults.filter(c => c.status === "warn").length,
    fail_count: checkResults.filter(c => c.status === "fail").length,
    total_anomalies: checkResults.reduce((s, c) => s + (c.anomalies?.length || 0), 0),
  };
  return {
    ok: summary.fail_count === 0,
    ts: Date.now(),
    kind: sweepKind,
    elapsed_ms: Date.now() - t0,
    summary,
    checks: checkResults,
  };
}

export async function runSanitySweep(env, ctx = null) {
  return _runSweep(env, ctx, "full", CHECKS);
}

export async function runFastSweep(env, ctx = null) {
  return _runSweep(env, ctx, "fast", FAST_CHECKS);
}

export { computeProtectiveStopTighten, resolveEffectiveStopLoss, slDrawdownPct, DEFAULT_MAX_SL_DRAWDOWN_PCT };

/**
 * Tighten open-position stops that exceed max drawdown from current price.
 * Updates D1 positions.stop_loss and KV timed:trades:all when enabled.
 */
export async function tightenWideOpenStops(env, opts = {}) {
  const maxDdPct = Number(opts.maxDrawdownPct) || DEFAULT_MAX_SL_DRAWDOWN_PCT;
  const dryRun = opts.dryRun !== false;
  const thresholdPct = Number(opts.thresholdPct) || 25;
  if (!env?.DB || !env?.KV_TIMED) return { ok: false, error: "missing_bindings" };

  const pricesRaw = await env.KV_TIMED.get("timed:prices");
  const priceMap = pricesRaw ? (JSON.parse(pricesRaw)?.prices || {}) : {};
  const { results } = await env.DB.prepare(
    `SELECT t.trade_id, t.ticker, t.direction, t.entry_price, p.stop_loss
     FROM trades t
     LEFT JOIN positions p ON p.position_id = t.trade_id
     WHERE t.status IN ('OPEN', 'TP_HIT_TRIM') LIMIT 100`,
  ).all().catch(() => ({ results: [] }));

  let kvTrades = [];
  try {
    const raw = await env.KV_TIMED.get("timed:trades:all");
    kvTrades = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(kvTrades)) kvTrades = [];
  } catch (_) { kvTrades = []; }

  const tightened = [];
  for (const r of (results || [])) {
    const sym = String(r.ticker || "").toUpperCase();
    const dir = String(r.direction || "LONG").toUpperCase();
    const px = Number(priceMap[sym]?.p) || Number(r.entry_price);
    const kvTrade = kvTrades.find((t) => String(t?.ticker || "").toUpperCase() === sym
      && (t.status === "OPEN" || t.status === "TP_HIT_TRIM"));
    const oldSl = resolveEffectiveStopLoss(dir, r.stop_loss, kvTrade?.sl ?? kvTrade?.stop_loss);
    if (!(px > 0) || !(oldSl > 0)) continue;
    const ddPct = slDrawdownPct(dir, px, oldSl);
    if (ddPct == null || ddPct <= thresholdPct) continue;
    const newSl = computeProtectiveStopTighten(dir, px, oldSl, maxDdPct);
    if (newSl == null || newSl === oldSl) continue;
    tightened.push({ ticker: sym, direction: dir, price: px, oldSl, newSl, wasDrawdownPct: ddPct });
    if (!dryRun) {
      try {
        await env.DB.prepare(
          "UPDATE positions SET stop_loss = ?2, updated_at = ?3 WHERE ticker = ?1 AND status = 'OPEN'",
        ).bind(sym, newSl, Date.now()).run();
      } catch (_) {}
      if (kvTrade) {
        kvTrade.sl = newSl;
        kvTrade.stop_loss = newSl;
        kvTrade.sl_protect_reason = "SANITY_SWEEP_TIGHTEN";
        kvTrade.sl_last_tighten_ts = new Date().toISOString();
      }
    }
  }

  if (!dryRun && tightened.length > 0) {
    try {
      await env.KV_TIMED.put("timed:trades:all", JSON.stringify(kvTrades));
    } catch (_) {}
  }

  return { ok: true, dryRun, tightened, count: tightened.length };
}

/**
 * Persist the latest sweep to KV so the MC dashboard can read it without
 * re-running the entire sweep on every page load. Stores under both a
 * kind-specific key ("sanity_sweep:fast:latest") and the legacy
 * "sanity_sweep:latest" alias (pointing to the most recent full sweep).
 */
export async function persistSweep(env, sweep) {
  try {
    if (!env?.KV_TIMED) return;
    const kind = sweep?.kind || "full";
    await env.KV_TIMED.put(`sanity_sweep:${kind}:latest`, JSON.stringify(sweep), { expirationTtl: 7 * 86400 });
    // Back-compat alias: legacy "sanity_sweep:latest" always points to
    // the latest FULL sweep so MC + downstream consumers don't break.
    if (kind === "full") {
      await env.KV_TIMED.put("sanity_sweep:latest", JSON.stringify(sweep), { expirationTtl: 7 * 86400 });
    }
  } catch (e) {
    console.warn("[SANITY_SWEEP] persist failed:", String(e?.message || e).slice(0, 120));
  }
}

/**
 * Cron handler. Runs sweep, persists, fires Discord alert on any FAIL or
 * on >= 3 warns. Uses a stable cooldown so the same anomaly doesn't spam.
 */
export async function sanitySweepCron(env, ctx, kind = "full") {
  try {
    const sweep = kind === "fast" ? await runFastSweep(env, ctx) : await runSanitySweep(env, ctx);
    await persistSweep(env, sweep);

    // Fast sweep refreshes MC cache every 15m; full hourly sweep owns Discord
    // paging so :00 ET does not double-post (fast ~500ms + full ~1300ms).
    if (kind === "fast") return sweep;

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

    // Send the Discord alert (best-effort) — system lane (#system-alerts).
    // Previously posted directly to DISCORD_WEBHOOK_URL (#trade-signals).
    if (failing.length > 0 || warning.length >= 3) {
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
        for (const a of (c.anomalies || []).slice(0, 2)) {
          lines.push(`   • ${a.detail || ""}`);
        }
      }
      await notifyDiscord(env, {
        title: `Sanity Sweep Alert · ${failing.length} fails · ${warning.length} warns`,
        description: lines.slice(0, 30).join("\n"),
        color: failing.length > 0 ? 0xf43f5e : 0xf59e0b,
        timestamp: new Date().toISOString(),
        footer: { text: `Sweep took ${sweep.elapsed_ms}ms · /timed/admin/sanity-sweep` },
      }, "system").catch(e => console.warn("[SANITY_SWEEP] discord send failed:", String(e?.message || e).slice(0, 120)));
      await env.KV_TIMED.put("sanity_sweep:last_alert_fingerprint", fingerprint, { expirationTtl: 24 * 3600 });
    }

    // Best-effort COO self-heal for known warn/fail checks (ledger repair,
    // candle backfill, wide-stop tighten). Reads the sweep we just persisted.
    if (String(env?.COO_SELF_HEAL || "false").toLowerCase() === "true") {
      try {
        const { runSelfHealing } = await import("./coo/coo-orchestrator.js");
        await runSelfHealing(env).catch((e) =>
          console.warn("[SANITY_SWEEP] self-heal failed:", String(e?.message || e).slice(0, 120)),
        );
      } catch (_) {}
    }

    return sweep;
  } catch (e) {
    console.error("[SANITY_SWEEP] cron failed:", e);
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
