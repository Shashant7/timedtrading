// worker/growth-compounder.js
// -----------------------------------------------------------------------------
// Growth compounder playbook — revenue path + hold thesis + dip-buy lane
// for Investor Mode. Pure module (no I/O).
// Fundamentals snapshots (timed:fundamentals_v5:{T}) supply revenue history,
// analyst consensus, growth classes, and fair-value quality grades.
// -----------------------------------------------------------------------------

import { extractFairValueSignal, qualityGrade, computeQualityScore } from "./fair-value.js";

const BILLION = 1e9;

const TIER_RANK = Object.freeze({
  growth_elite: 3,
  growth_strong: 2,
  growth_watch: 1,
});

export const COMPOUNDER_TIER_LABELS = Object.freeze({
  growth_elite: "COMPOUND CORE",
  growth_strong: "COMPOUND PLUS",
  growth_watch: "COMPOUND RADAR",
});

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

function yearFromDate(dateStr) {
  const y = new Date(dateStr).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

function periodLabel(row) {
  const y = yearFromDate(row?.date);
  const p = String(row?.period || "");
  if (p === "current_year" && y) return `${y}E`;
  if (p === "next_year" && y) return `${y}E`;
  if (p === "current_quarter" && y) return `${y} Q`;
  if (p === "next_quarter" && y) return `${y} Q+1`;
  if (y) return `${y}E`;
  return "Est";
}

/** Normalize analyst /revenue_estimate rows for trajectory + UI. */
export function normalizeRevenueEstimates(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      date: row.date || null,
      period: row.period || null,
      label: periodLabel(row),
      revenue_b: num(row.avg_estimate) != null ? Number((num(row.avg_estimate) / BILLION).toFixed(2)) : null,
      low_b: num(row.low_estimate) != null ? Number((num(row.low_estimate) / BILLION).toFixed(2)) : null,
      high_b: num(row.high_estimate) != null ? Number((num(row.high_estimate) / BILLION).toFixed(2)) : null,
      analysts: num(row.number_of_analysts),
      yoy_pct: (() => {
        const v = num(row.sales_growth_pct ?? row.sales_growth);
        if (v == null) return null;
        return Math.abs(v) <= 2 ? Number((v * 100).toFixed(2)) : Number(v.toFixed(2));
      })(),
      year_ago_b: num(row.year_ago_sales) != null ? Number((num(row.year_ago_sales) / BILLION).toFixed(2)) : null,
      source: "analyst_consensus",
    }))
    .filter((r) => r.revenue_b != null);
}

/**
 * Build annual / LTM / forward revenue path from a fundamentals snapshot.
 * Forward bars prefer TwelveData analyst revenue consensus when present.
 */
export function buildRevenueTrajectory(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, points: [], ltm_b: null, cagr_pct: null, total_change_pct: null };
  }

  const val = snapshot.valuation || {};
  const grw = snapshot.growth || {};
  const earn = snapshot.earnings || {};
  const past = Array.isArray(earn.history) ? earn.history : [];
  const analystEstimates = normalizeRevenueEstimates(earn.revenue_estimates);

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
    points.push({
      label: String(y),
      revenue_b: Number(revB.toFixed(2)),
      yoy_pct: yoy != null ? Number(yoy.toFixed(1)) : null,
      kind: "actual",
    });
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

  // Forward — analyst annual consensus first, then model projection fallback.
  const annualAnalyst = analystEstimates.filter((r) =>
    String(r.period || "").includes("year") || ["current_year", "next_year"].includes(String(r.period || "")));
  const usedAnalyst = annualAnalyst.length > 0;
  if (usedAnalyst) {
    let prevRev = ltmB;
    for (const est of annualAnalyst.slice(0, 4)) {
      let yoy = est.yoy_pct;
      if (yoy == null && prevRev != null && prevRev > 0) {
        yoy = Number((((est.revenue_b - prevRev) / prevRev) * 100).toFixed(1));
      }
      points.push({
        label: est.label,
        revenue_b: est.revenue_b,
        yoy_pct: yoy != null ? Number(Number(yoy).toFixed(1)) : null,
        kind: "estimate",
        analysts: est.analysts,
        source: "analyst_consensus",
      });
      prevRev = est.revenue_b;
    }
  } else if (ltmB != null && fwdGrowth != null) {
    let base = ltmB;
    const nowYear = new Date().getUTCFullYear();
    for (let i = 1; i <= 3; i += 1) {
      base = base * (1 + fwdGrowth / 100);
      points.push({
        label: `${nowYear + i}E`,
        revenue_b: Number(base.toFixed(2)),
        yoy_pct: Number(fwdGrowth.toFixed(1)),
        kind: "estimate",
        source: "model_projection",
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
    const estPoints = points.filter((p) => p.kind === "estimate");
    const e2 = estPoints.length >= 2 ? estPoints[1] : estPoints[0];
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
    analyst_estimates: analystEstimates,
    forward_source: usedAnalyst ? "analyst_consensus" : (fwdGrowth != null ? "model_projection" : null),
  };
}

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
  const whyHold = buildHoldThesisBullets(snapshot, fv, traj, tier);

  return {
    eligible,
    tier,
    tier_label: tier ? COMPOUNDER_TIER_LABELS[tier] : null,
    trajectory: traj,
    quality_grade: quality,
    growth_detected: growthDetected,
    rev_growth_class: revClass,
    beat_rate_pct: beatRate,
    why_hold: whyHold,
    hold_thesis: whyHold,
    fair_value_rising: growthDetected && strongRev && fv?.fv_class !== "discount",
  };
}

/** Timed Trading hold-thesis bullets — distinct voice, not competitor copy. */
export function buildHoldThesisBullets(snapshot, fvSignal, trajectory, tier) {
  if (!tier || tier === "growth_watch") return [];
  const grw = snapshot?.growth || {};
  const earn = snapshot?.earnings || {};
  const bullets = [];
  const ticker = snapshot?.ticker || "Name";

  if (tier === "growth_elite") {
    bullets.push("Compounding core — add on pullbacks; hold while monthly structure stays intact");
  }

  if (trajectory?.cagr_pct != null) {
    bullets.push(`${ticker}: revenue runway ~${trajectory.cagr_pct}% CAGR (${trajectory.ltm_b != null ? `$${trajectory.ltm_b}B LTM` : "LTM est."})`);
  } else if (grw.rev_growth_pct != null) {
    bullets.push(`${ticker}: revenue expanding ~${Number(grw.rev_growth_pct).toFixed(0)}% YoY`);
  }

  if (trajectory?.forward_source === "analyst_consensus") {
    const fwd = (trajectory.analyst_estimates || []).find((e) => String(e.period || "").includes("year"));
    if (fwd?.analysts != null) {
      bullets.push(`Analyst revenue consensus — ${fwd.analysts} estimates on the forward path`);
    }
  }

  if (fvSignal?.growth_detected) {
    bullets.push("Earnings and revenue accelerating — estimate revisions tend to follow");
  }
  if (fvSignal?.quality_grade === "A") {
    bullets.push("Quality A — margins, ROE, and cash flow support the long thesis");
  }
  if (fvSignal?.fair_value != null && fvSignal?.fv_class === "premium" && fvSignal?.growth_detected) {
    bullets.push("Fair value tracking higher with estimates — extension follows the growth curve");
  } else if (fvSignal?.fair_value != null && fvSignal?.fv_class === "discount") {
    bullets.push(`Below model fair value ($${fvSignal.fair_value}) — favorable accumulation band`);
  }

  if (earn.beat_rate_pct != null && earn.beat_rate_pct >= 70) {
    bullets.push(`Beat cadence ${earn.beat_rate_pct}% — guidance credibility intact`);
  }

  return bullets.slice(0, 5);
}

/** @deprecated use buildHoldThesisBullets */
export function buildWhyWeHoldBullets(snapshot, fvSignal, trajectory, tier) {
  return buildHoldThesisBullets(snapshot, fvSignal, trajectory, tier);
}

export function detectCompounderDipBuy(tickerData, timing = null, accumZone = null) {
  const signals = [];
  const price = num(tickerData?._live_price || tickerData?.price);
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

const HOLDBOOK_STAGE_SET = new Set(["core_hold", "accumulate", "watch", "reduce", "research_on_watch"]);

export function isHoldbookCandidateRow(row) {
  const stage = String(row?.stage || "").toLowerCase();
  const owned = row?.position?.owned === true;
  return owned || HOLDBOOK_STAGE_SET.has(stage);
}

function compactCompounderPayload(comp, snapshot = null) {
  if (!comp?.tier) return null;
  const val = snapshot?.valuation || {};
  return {
    tier: comp.tier,
    tier_label: comp.tier_label || COMPOUNDER_TIER_LABELS[comp.tier] || null,
    eligible: comp.eligible === true,
    hold_thesis: comp.hold_thesis || comp.why_hold || [],
    why_hold: comp.why_hold || comp.hold_thesis || [],
    trajectory: comp.trajectory || null,
    fair_value: comp.fair_value ?? val.fair_value_price ?? null,
    fv_class: comp.fv_class ?? val.fair_value_class ?? null,
    fv_premium_pct: comp.fv_premium_pct ?? val.fair_value_premium_pct ?? null,
  };
}

/**
 * Attach compounder signal from a fundamentals snapshot when missing on score row.
 */
export function attachCompounderFromSnapshot(row, snapshot) {
  if (!row || !snapshot) return row;
  const comp = snapshot.compounder || extractGrowthCompounderSignal(snapshot);
  const payload = compactCompounderPayload(comp, snapshot);
  if (!payload?.tier && !row?.compounder?.tier) return row;
  if (!payload?.tier) return row;
  if (row?.compounder?.tier) {
    return {
      ...row,
      compounder: {
        ...(row.compounder || {}),
        fair_value: row.compounder.fair_value ?? payload.fair_value ?? null,
        fv_class: row.compounder.fv_class ?? payload.fv_class ?? null,
        fv_premium_pct: row.compounder.fv_premium_pct ?? payload.fv_premium_pct ?? null,
      },
    };
  }
  return { ...row, compounder: { ...(row.compounder || {}), ...payload } };
}

/**
 * Attach compounder from timed:latest scoring payload (_compounder).
 */
export function attachCompounderFromLatest(row, latestRow) {
  if (!row || row?.compounder?.tier || !latestRow?._compounder?.tier) return row;
  const payload = compactCompounderPayload(latestRow._compounder);
  if (!payload) return row;
  return { ...row, compounder: { ...(row.compounder || {}), ...payload } };
}

/**
 * Enrich score rows with compounder data from KV only (read-time, no live TD fetches).
 */
/**
 * Backfill missing companyName on holdbook/score rows from timed:context
 * and optional D1 ticker_metadata (read-time, no live provider calls).
 */
export async function enrichHoldbookRowNames(rows, kvGetJSON, opts = {}) {
  const out = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const syms = [...new Set(
    out
      .filter((row) => row?.ticker && !row.companyName)
      .map((row) => String(row.ticker).toUpperCase()),
  )];
  if (!syms.length) return out;

  const nameBySym = {};
  for (let b = 0; b < syms.length; b += 50) {
    const batch = syms.slice(b, b + 50);
    const kvResults = await Promise.all(
      batch.map((sym) => kvGetJSON(`timed:context:${sym}`)),
    );
    for (let i = 0; i < batch.length; i++) {
      const ctx = kvResults[i];
      const nm = ctx?.name || ctx?.companyName || ctx?.company_name || null;
      if (nm) nameBySym[batch[i]] = String(nm);
    }
  }

  if (typeof opts.loadMetadataNames === "function") {
    try {
      const meta = await opts.loadMetadataNames(syms);
      if (meta && typeof meta === "object") {
        for (const [sym, nm] of Object.entries(meta)) {
          const T = String(sym || "").toUpperCase();
          if (T && nm && !nameBySym[T]) nameBySym[T] = String(nm);
        }
      }
    } catch (_) { /* best-effort */ }
  }

  return out.map((row) => {
    const sym = String(row.ticker || "").toUpperCase();
    if (row.companyName || !nameBySym[sym]) return row;
    return { ...row, companyName: nameBySym[sym] };
  });
}

export async function enrichHoldbookScoreRows(rows, kvGetJSON, kvKeyFn, opts = {}) {
  const cap = Number(opts.enrichCap) || 30;
  const latestKeyFn = typeof opts.latestKeyFn === "function" ? opts.latestKeyFn : null;
  const out = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));

  const needEnrich = out
    .filter((row) => !row?.compounder?.tier && isHoldbookCandidateRow(row))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, cap);

  await Promise.all(needEnrich.map(async (row) => {
    const idx = out.findIndex((r) => r.ticker === row.ticker);
    if (idx < 0) return;
    try {
      let next = out[idx];
      if (latestKeyFn) {
        const latest = await kvGetJSON(latestKeyFn(row.ticker));
        next = attachCompounderFromLatest(next, latest);
      }
      if (!next.compounder?.tier) {
        const snap = await kvGetJSON(kvKeyFn(row.ticker));
        next = attachCompounderFromSnapshot(next, snap);
      }
      out[idx] = next;
    } catch (_) { /* best-effort */ }
  }));

  return out;
}

/**
 * Portfolio-level holdbook — compounders in book, building, or on radar.
 * Input rows are /timed/investor/scores entries (already enriched).
 */
export function buildInvestorHoldbook(scoreRows, opts = {}) {
  const minTier = opts.minTier || "growth_watch";
  const minRank = TIER_RANK[minTier] || 1;
  const rows = (Array.isArray(scoreRows) ? scoreRows : [])
    .filter((row) => {
      const tier = row?.compounder?.tier;
      if (!tier || !TIER_RANK[tier] || TIER_RANK[tier] < minRank) return false;
      return isHoldbookCandidateRow(row);
    })
    .map((row) => ({
      ticker: row.ticker,
      companyName: row.companyName || null,
      sector: row.sector || null,
      stage: row.stage,
      score: row.score,
      rsRank: row.rsRank,
      owned: row?.position?.owned === true,
      tier: row.compounder.tier,
      tier_label: row.compounder.tier_label || COMPOUNDER_TIER_LABELS[row.compounder.tier],
      hold_thesis: row.compounder.hold_thesis || row.compounder.why_hold || [],
      trajectory: row.compounder.trajectory || null,
      dip_buy: row.compounder.dip_buy === true,
      price: row.price ?? null,
      dailyChgPct: row.dailyChgPct ?? null,
      fair_value_price: row.compounder.fair_value ?? null,
      fv_class: row.compounder.fv_class ?? null,
      fv_premium_pct: row.compounder.fv_premium_pct ?? null,
    }));

  const bucket = (stage, owned) => {
    if (owned || stage === "core_hold") return "in_book";
    if (stage === "accumulate") return "building";
    return "on_radar";
  };

  const sorted = rows.sort((a, b) => {
    const tr = (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0);
    if (tr !== 0) return tr;
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  });

  const groups = {
    in_book: [],
    building: [],
    on_radar: [],
  };
  for (const row of sorted) {
    groups[bucket(row.stage, row.owned)].push(row);
  }

  return {
    ok: true,
    count: sorted.length,
    title: "Growth Ideas",
    subtitle: "Fundamentally growing names worth watching for pullbacks",
    group_labels: {
      in_book: "In Position",
      building: "Accumulate Lane",
      on_radar: "Watch for Pullback",
    },
    groups,
    holdings: sorted,
  };
}
