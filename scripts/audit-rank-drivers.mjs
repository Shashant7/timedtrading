#!/usr/bin/env node
// Read-only component study. Usage:
// node scripts/audit-rank-drivers.mjs INPUT.json > report.json
// Does not fit weights, substitute current quotes, or simulate unentered trades.
import fs from "node:fs";
import crypto from "node:crypto";
import { finiteRankInput as num, rankFlag, rankDirection, supertrendRankDirection } from "../worker/ranking/rank-drivers.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/audit-rank-drivers.mjs INPUT.json");
const bytes = fs.readFileSync(file);
const input = JSON.parse(bytes);
const sourceRows = (Array.isArray(input) ? input : input.trades || input.rows || input.data?.trades || [])
  .map(t => ({ ...t, pnl_pct: t.pnl_pct ?? t.pnlPct }));
const parse = x => { try { return typeof x === "string" ? JSON.parse(x) : x || null; } catch { return null; } };
const knownBool = (obj, key) => Object.hasOwn(obj || {}, key) ? rankFlag(obj[key]) : null;
const threshold = (x, fn) => num(x) === null ? null : fn(num(x));
const rows = sourceRows.filter(t => (t.exit_ts != null || ["WIN", "LOSS", "CLOSED"].includes(t.status)) && num(t.pnl_pct) !== null)
  .map(t => {
    const snapshot = parse(t.entry_signals_json || t.signal_snapshot_json || t.entrySignals);
    const trace = parse(t.rank_trace_json || t.rankTraceJson);
    const d = snapshot || {};
    const lineage = d.lineage || {};
    const side = rankDirection(t.direction);
    const sign = side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;
    const st = supertrendRankDirection(d.tf_tech ? d : { supertrend: lineage.supertrend || d.supertrend }, "30");
    const rsi = d.rsi_divergence || d.rsi?.divergence || lineage.rsi_divergence;
    let bull = false, bear = false;
    if (rsi?.type && (rsi.active == null || rankFlag(rsi.active))) {
      bull = rsi.type === "bullish"; bear = rsi.type === "bearish";
    } else if (rsi && !rsi.type) {
      for (const v of Object.values(rsi)) {
        bull ||= rankFlag(v?.bull?.active); bear ||= rankFlag(v?.bear?.active);
      }
    }
    const saty = d.saty_phase || lineage.saty_phase || {};
    const atr = d.atr_disp || lineage.atr_disp || {};
    const regime = d.regime?.class || d.regime_class || lineage.regime_class;
    const setup = t.setup_name || lineage.entry_path || t.entry_path || "UNKNOWN";
    const ts = num(t.entry_ts);
    const month = ts !== null && Number.isFinite(new Date(ts).getTime()) ? new Date(ts).toISOString().slice(0, 7) : "UNKNOWN";
    return { side, setup, month, pnl: num(t.pnl), ret: num(t.pnl_pct), has_snapshot: !!snapshot,
      has_trace: !!trace?.parts?.length, driver_version: trace?.driver_version || null,
      features: {
        completion_early: threshold(d.completion ?? trace?.completion, x => x >= 0 && x <= 0.2),
        phase_early: threshold(d.phase_pct ?? trace?.phase, x => x >= 0 && x <= 0.3),
        htf_strong_absolute: threshold(d.htf_score ?? trace?.htf, x => Math.abs(x) >= 25),
        ltf_strong_absolute: threshold(d.ltf_score ?? trace?.ltf, x => Math.abs(x) >= 20),
        rr_at_least_2: threshold(d.rr ?? trace?.rr, x => x >= 2),
        momentum_elite_flag: knownBool(d.flags, "momentum_elite"),
        phase_extreme_flag: knownBool(d.flags, "phase_zone_change"),
        squeeze_release_flag: knownBool(d.flags, "sq30_release"),
        squeeze_on_flag: knownBool(d.flags, "sq30_on"),
        ema_cross_1h_flag: knownBool(d.flags, "ema_cross_1h_13_48"),
        buyable_dip_1h_flag: knownBool(d.flags, "buyable_dip_1h_13_48"),
        rsi_aligned_unopposed: !rsi || !side ? null : side === "LONG" ? bull && !bear : bear && !bull,
        st30_aligned_pine: !st || !side ? null : st === side,
        phase_1h_extended_aligned: !sign ? null : threshold(saty["1H"]?.v, x => x * sign > 70),
        phase_d_extended_aligned: !sign ? null : threshold(saty.D?.v, x => x * sign > 70),
        atr_week_extended_aligned: !sign ? null : threshold(atr.week?.d, x => x * sign >= 0.3),
        atr_day_extended_aligned: !sign ? null : threshold(atr.day?.d, x => x * sign >= 0.3),
        regime_trending: regime ? regime === "TRENDING" : null,
        ltf30_bias_aligned: !sign ? null : threshold(d.tf?.["30m"]?.bias, x => x * sign > 0.5),
        grade_confirmed_post_rank: t.setup_grade ? t.setup_grade.toLowerCase() === "confirmed" : null,
      } };
  });
const round = x => Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
function stats(group) {
  if (!group.length) return { n: 0 };
  const returns = group.map(r => r.ret).sort((a, b) => a - b);
  const dollars = group.filter(r => r.pnl !== null);
  const gains = dollars.reduce((sum, r) => sum + Math.max(0, r.pnl), 0);
  const losses = -dollars.reduce((sum, r) => sum + Math.min(0, r.pnl), 0);
  const mid = Math.floor(returns.length / 2);
  return { n: group.length, win_rate: round(returns.filter(r => r > 0).length / returns.length),
    loss_rate: round(returns.filter(r => r < 0).length / returns.length),
    mean_return_pct: round(returns.reduce((s, x) => s + x, 0) / returns.length),
    median_return_pct: round(returns.length % 2 ? returns[mid] : (returns[mid - 1] + returns[mid]) / 2),
    profit_factor_dollars: losses > 0 ? round(gains / losses) : null, dollar_coverage: dollars.length };
}
function comparison(group, key) {
  return { present: stats(group.filter(r => r.features[key] === true)),
    absent: stats(group.filter(r => r.features[key] === false)) };
}
const features = {};
for (const key of Object.keys(rows[0]?.features || {})) {
  const known = rows.filter(r => r.features[key] !== null);
  const strata = new Map();
  for (const r of known) {
    const k = [r.side || "UNKNOWN", r.setup, r.month].join("|");
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k).push(r);
  }
  const matched = [...strata].map(([stratum, group]) => ({ stratum, ...comparison(group, key) }))
    .filter(s => !s.stratum.includes("UNKNOWN") && s.present.n >= 3 && s.absent.n >= 3);
  let weightedLift = 0, weight = 0;
  for (const s of matched) {
    const w = Math.min(s.present.n, s.absent.n);
    weight += w; weightedLift += w * (s.present.mean_return_pct - s.absent.mean_return_pct);
  }
  features[key] = { observed: known.length, missing: rows.length - known.length,
    ...comparison(known, key),
    by_side: Object.fromEntries(["LONG", "SHORT"].map(side => [side, comparison(known.filter(r => r.side === side), key)])),
    matched_side_setup_month: { min_per_arm: 3, strata: matched.length,
      mean_return_difference_pct: weight ? round(weightedLift / weight) : null, comparisons: matched } };
}
console.log(JSON.stringify({
  schema: "rank-driver-audit-v1",
  source_canonical_json_sha256: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  rows: sourceRows.length, closed_with_return: rows.length,
  snapshot_coverage: rows.filter(r => r.has_snapshot).length,
  trace_coverage: rows.filter(r => r.has_trace).length,
  driver_version_coverage: rows.filter(r => r.driver_version).length,
  limits: ["Exploratory selected-trade comparisons; no causal or portfolio-PnL claim.",
    "Snapshot presence does not prove the signal was available before scoring; verify source lineage and timestamp.",
    "No candidate-universe rejects, controlled exits, unseen holdout or correction for multiple comparisons.",
    "Matched cells require both signal states within the same side, setup and entry month; sparse cells remain unestimated."],
  features,
}, null, 2));
