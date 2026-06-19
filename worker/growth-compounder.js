// worker/growth-compounder.js
// -----------------------------------------------------------------------------
// Growth compounder playbook — Tenet-style revenue trajectory + "why we hold"
// + compounder dip-buy lane for Investor Mode.
//
// Pure module (no I/O). Fundamentals snapshots (timed:fundamentals_v4:{T})
// supply revenue history, growth classes, and fair-value quality grades.
// -----------------------------------------------------------------------------

import { extractFairValueSignal, qualityGrade, computeQualityScore } from "./fair-value.js";

const BILLION = 1e9;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classifyRevGrowth(pct) {
  if (pct == null) return "unknown";
  if (pct > 100) return "explosive";
  if (pct >= 50) return "exploding";
  if (pct >= 25) return "strong";
  if (pct >= 0) return "positive";
  return "declining";
}

/**
 * Build annual / LTM / forward revenue trajectory from a fundamentals_v4 snapshot.
 * Uses quarterly revenue_actual from earnings history when present; falls back
 * to market_cap / P/S for LTM when revenue rows are sparse.
 */
export function buildRevenueTrajectory(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, points: [], ltm_b: null, cagr_pct: null, total_change_pct: null };
  }

  const val = snapshot.valuation || {};
  const grw = snapshot.growth || {};
  const earn = snapshot.earnings || {};
  const past = Array.isArray(earn.history) ? earn.history : [];

  // Collect quarterly revenue from extended history rows (newer snapshots).
  const revRows = (Array.isArray(earn.revenue_history) ? earn.revenue_history : [])
    .concat(
      past.filter((r) => num(r?.revenue_actual) != null || num(r?.revenue_est) != null)
        .map((r) => ({
          date: r.date,
          revenue_actual: num(r.revenue_actual),
          revenue_est: num(r.revenue_est),
        })),
    )
    .filter((r) => r.date && (num(r.revenue_actual) != null || num(r.revenue_est) != null))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  // Dedupe by date
  const byDate = new Map();
  for (const r of revRows) byDate.set(r.date, r);
  const quarters = [...byDate.values()];

  let ltmB = null;
  if (quarters.length >= 4) {
    const last4 = quarters.slice(-4);
    const sum = last4.reduce((s, q) => s + (num(q.revenue_actual) ?? num(q.revenue_est) ?? 0), 0);
    if (sum > 0) ltmB = sum / BILLION;
  }
  if (ltmB == null) {
    const mcap = num(val.market_cap);
    const ps = num(val.ps_ratio);
    if (mcap != null && ps != null && ps > 0) {
      ltmB = mcap / ps / BILLION;
    }
  }

  const revGrowthPct = num(grw.rev_growth_pct) ?? num(snapshot?.growth?.rev_growth_pct);
  const fwdGrowth = revGrowthPct != null
    ? Math.max(-25, Math.min(100, revGrowthPct))
    : null;

  const points = [];

  // Annualize actual quarters into calendar-year buckets when possible.
  const yearBuckets = new Map();
  for (const q of quarters) {
    const y = new Date(q.date).getUTCFullYear();
    if (!Number.isFinite(y)) continue;
    const rev = num(q.revenue_actual);
    if (rev == null) continue;
    yearBuckets.set(y, (yearBuckets.get(y) || 0) + rev / BILLION);
  }
  const years = [...yearBuckets.keys()].sort((a, b) => a - b);
  let prevYearRev = null;
  for (const y of years) {
    const revB = yearBuckets.get(y);
    let yoy = null;
    if (prevYearRev != null && prevYearRev > 0) {
      yoy = ((revB - prevYearRev) / prevYearRev) * 100;
    }
    points.push({ label: String(y), revenue_b: Number(revB.toFixed(2)), yoy_pct: yoy != null ? Number(yoy.toFixed(1)) : null, kind: "actual" });
    prevYearRev = revB;
  }

  if (ltmB != null) {
    const lastActual = points.length ? points[points.length - 1].revenue_b : null;
    let ltmYoy = null;
    if (lastActual != null && lastActual > 0) {
      ltmYoy = ((ltmB - lastActual) / lastActual) * 100;
    } else if (fwdGrowth != null) {
      ltmYoy = fwdGrowth;
    }
    points.push({
      label: "LTM",
      revenue_b: Number(ltmB.toFixed(2)),
      yoy_pct: ltmYoy != null ? Number(ltmYoy.toFixed(1)) : null,
      kind: "ltm",
    });
  }

  // Forward estimates — rev growth applied to LTM (analyst revenue consensus is follow-up).
  if (ltmB != null && fwdGrowth != null) {
    let base = ltmB;
    const nowYear = new Date().getUTCFullYear();
    for (let i = 1; i <= 3; i += 1) {
      base = base * (1 + fwdGrowth / 100);
      points.push({
        label: `${nowYear + i}E`,
        revenue_b: Number(base.toFixed(2)),
        yoy_pct: Number(fwdGrowth.toFixed(1)),
        kind: "estimate",
      });
    }
  }

  let cagrPct = null;
  let totalChangePct = null;
  const actuals = points.filter((p) => p.kind === "actual");
  if (actuals.length >= 2) {
    const first = actuals[0].revenue_b;
    const last = actuals[actuals.length - 1].revenue_b;
    const span = actuals.length - 1;
    if (first > 0 && last > 0 && span > 0) {
      cagrPct = Number(((Math.pow(last / first, 1 / span) - 1) * 100).toFixed(1));
      totalChangePct = Number((((last - first) / first) * 100).toFixed(1));
    }
  }
  if (cagrPct == null && ltmB != null && fwdGrowth != null && fwdGrowth >= 25) {
    cagrPct = Number(Math.min(fwdGrowth, 50).toFixed(1));
  }

  const forwardStepUp = (() => {
    const ltm = points.find((p) => p.kind === "ltm");
    const e2 = points.find((p) => p.label?.endsWith("E") && p.label.includes(String(new Date().getUTCFullYear() + 2)));
    if (ltm?.revenue_b > 0 && e2?.revenue_b > 0) {
      return Number((((e2.revenue_b - ltm.revenue_b) / ltm.revenue_b) * 100).toFixed(1));
    }
    return null;
  })();

  return {
    ok: points.length > 0,
    points,
    ltm_b: ltmB != null ? Number(ltmB.toFixed(2)) : null,
    cagr_pct: cagrPct,
    total_change_pct: totalChangePct,
    forward_step_up_pct: forwardStepUp,
    rev_growth_pct: revGrowthPct,
    rev_growth_class: grw.rev_growth_class || classifyRevGrowth(revGrowthPct),
  };
}

/**
 * Classify compounder tier from fundamentals + optional fair-value signal.
 */
export function classifyGrowthCompounder(snapshot, fvSignal = null) {
  const fv = fvSignal || extractFairValueSignal(snapshot);
  const traj = buildRevenueTrajectory(snapshot);
  const grw = snapshot?.growth || {};
  const earn = snapshot?.earnings || {};

  const quality = fv?.quality_grade || qualityGrade(computeQualityScore(snapshot).score);
  const revClass = grw.rev_growth_class || traj.rev_growth_class || "unknown";
  const growthDetected = fv?.growth_detected === true;
  const beatRate = num(earn.beat_rate_pct);

  const strongRev = ["explosive", "exploding", "strong"].includes(revClass);
  const strongEps = ["explosive", "exploding", "strong"].includes(String(grw.eps_growth_class || ""));
  const highCagr = traj.cagr_pct != null && traj.cagr_pct >= 20;
  const bigForward = traj.forward_step_up_pct != null && traj.forward_step_up_pct >= 50;
  const qualityOk = quality === "A" || quality === "B";

  let tier = null;
  if (qualityOk && growthDetected && strongRev && (highCagr || bigForward || revClass === "explosive")) {
    tier = "growth_elite";
  } else if (qualityOk && (strongRev || strongEps) && (highCagr || traj.ltm_b != null)) {
    tier = "growth_strong";
  } else if (strongRev || growthDetected) {
    tier = "growth_watch";
  }

  const eligible = tier === "growth_elite" || tier === "growth_strong";
  const whyHold = buildWhyWeHoldBullets(snapshot, fv, traj, tier);

  return {
    eligible,
    tier,
    trajectory: traj,
    quality_grade: quality,
    growth_detected: growthDetected,
    rev_growth_class: revClass,
    beat_rate_pct: beatRate,
    why_hold: whyHold,
    fair_value_rising: growthDetected && strongRev && fv?.fv_class !== "discount",
  };
}

export function buildWhyWeHoldBullets(snapshot, fvSignal, trajectory, tier) {
  if (!tier || tier === "growth_watch") return [];
  const grw = snapshot?.growth || {};
  const earn = snapshot?.earnings || {};
  const bullets = [];
  const ticker = snapshot?.ticker || "Name";

  if (trajectory?.cagr_pct != null) {
    bullets.push(`${ticker}: revenue trajectory ~${trajectory.cagr_pct}% CAGR (${trajectory.ltm_b != null ? `$${trajectory.ltm_b}B LTM` : "LTM est."})`);
  } else if (grw.rev_growth_pct != null) {
    bullets.push(`${ticker}: revenue growing ~${Number(grw.rev_growth_pct).toFixed(0)}% YoY`);
  }

  if (fvSignal?.growth_detected) {
    bullets.push("Earnings + revenue growth accelerating with consistent beats");
  }
  if (fvSignal?.quality_grade === "A") {
    bullets.push("Quality grade A — strong margins, ROE, and cash generation");
  }
  if (fvSignal?.fair_value != null && fvSignal?.fv_class === "premium" && fvSignal?.growth_detected) {
    bullets.push("Fair value rising with growth — premium reflects forward estimates, not static overextension");
  } else if (fvSignal?.fair_value != null && fvSignal?.fv_class === "discount") {
    bullets.push(`Trading below fair value ($${fvSignal.fair_value}) — accumulation zone`);
  }

  if (earn.beat_rate_pct != null && earn.beat_rate_pct >= 70) {
    bullets.push(`Beat rate ${earn.beat_rate_pct}% — guidance credibility supports hold/add on dips`);
  }

  if (tier === "growth_elite") {
    bullets.unshift("Portfolio compounder — add on pullbacks, hold through extension unless monthly thesis breaks");
  }

  return bullets.slice(0, 5);
}

/**
 * Detect dip-buy conditions for compounders (pullback / mean-reversion / timing bottom).
 */
export function detectCompounderDipBuy(tickerData, timing = null, accumZone = null) {
  const signals = [];
  const price = num(tickerData?._live_price || tickerData?.price);
  const tfD = tickerData?.tf_tech?.D;
  const tfW = tickerData?.tf_tech?.W;
  const mb = tickerData?.monthly_bundle;

  if (timing?.timing_primary === "BOTTOM" || timing?.add_on_dips) {
    signals.push("timing_bottom");
  }

  const wRsi = num(tfW?.rsi?.r5);
  const mRsi = num(mb?.rsi);
  if (wRsi != null && wRsi < 55 && mRsi != null && mRsi > 45) {
    signals.push("weekly_pullback_monthly_intact");
  }

  if (tfW?.ema?.priceAboveEma21 === true && price != null) {
    const ema21 = num(tfW?.ema?.e21 || tfW?.ema21);
    if (ema21 != null && ema21 > 0) {
      const dist = ((price - ema21) / ema21) * 100;
      if (dist >= 0 && dist <= 6) {
        signals.push("near_weekly_ema21");
      }
    }
  }

  if (accumZone?.zoneType && !accumZone.zoneType.includes("exhausted")) {
    if (["momentum_runner", "weekly_oversold_monthly_intact", "near_weekly_supertrend"].some((z) =>
      String(accumZone.zoneType).includes(z) || (accumZone.signals || []).some((s) => s.includes("oversold")))) {
      signals.push(`zone_${accumZone.zoneType}`);
    }
  }

  // Daily mean-reversion sequence (shadow / trail path on timed:latest).
  const seqs = tickerData?.setup_sequences || tickerData?.sequences || [];
  const mrSeq = (Array.isArray(seqs) ? seqs : []).find((s) =>
    String(s?.sequence_type || "").includes("mean_reversion")
    && String(s?.direction || "").toUpperCase() === "LONG"
    && Number(s?.stage) >= 1);
  if (mrSeq) {
    signals.push("daily_mean_reversion_sequence");
  }

  const dailyChg = num(tickerData?.dailyChgPct ?? tickerData?.day_change_pct);
  if (dailyChg != null && dailyChg <= -2) {
    signals.push("intraday_pullback");
  }

  return {
    isDip: signals.length > 0,
    signals,
  };
}

/** Bounded investor score boost for compounders. */
export function computeCompounderScoreBoost(compounder, dipBuy, cfg = {}) {
  if (!compounder?.eligible) return 0;
  let boost = compounder.tier === "growth_elite" ? 5 : 3;
  if (dipBuy?.isDip) boost += 2;
  const cap = Number(cfg.compounder_score_boost_cap) || 7;
  return Math.min(cap, boost);
}

export function extractGrowthCompounderSignal(snapshot) {
  if (!snapshot) return null;
  const fv = extractFairValueSignal(snapshot);
  const compounder = classifyGrowthCompounder(snapshot, fv);
  return {
    ...compounder,
    fair_value: fv?.fair_value ?? null,
    fv_premium_pct: fv?.fv_premium_pct ?? null,
    fv_class: fv?.fv_class ?? null,
  };
}
