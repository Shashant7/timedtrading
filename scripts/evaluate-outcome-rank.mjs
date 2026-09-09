// Offline chronological ranking diagnostic; no network or database mutations.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { fitOutcomeRank, scoreOutcomeRank, isUsableOutcome, OUTCOME_RANK_DEFAULTS, OUTCOME_RANK_VERSION } from "../worker/ranking/outcome-rank.js";

const round = x => Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
function summary(rows) {
  const dollars = rows.map(r => Number(r.pnl));
  const grossWin = dollars.filter(x => x > 0).reduce((a,b) => a+b, 0);
  const grossLoss = -dollars.filter(x => x < 0).reduce((a,b) => a+b, 0);
  const costCoverage = rows.filter(r => r.notional != null && Number.isFinite(Number(r.notional)) && Number(r.notional) > 0).length;
  const cost = costCoverage === rows.length ? rows.reduce((s,r) => s + Number(r.notional) * OUTCOME_RANK_DEFAULTS.roundTripCostBps / 10000, 0) : null;
  const pnl = grossWin - grossLoss;
  return { n: rows.length, pnl_usd: round(pnl), cost_covered: costCoverage,
    estimated_cost_usd: round(cost), net_usd: cost === null ? null : round(pnl-cost),
    profit_factor_gross: grossLoss ? round(grossWin/grossLoss) : null,
    mean_return_pct: rows.length ? round(rows.reduce((s,r)=>s+Number(r.pnl_pct),0)/rows.length) : null,
    without_best_usd: rows.length ? round(pnl-Math.max(...dollars)) : null };
}
function corr(rows, field) {
  if (rows.length < 3) return null;
  const n=rows.length, mx=rows.reduce((s,r)=>s+r[field],0)/n, my=rows.reduce((s,r)=>s+Number(r.pnl_pct),0)/n;
  let xy=0, xx=0, yy=0;
  for(const r of rows){const x=r[field]-mx,y=Number(r.pnl_pct)-my;xy+=x*y;xx+=x*x;yy+=y*y;}
  return xx*yy>0?round(xy/Math.sqrt(xx*yy)):null;
}
export function evaluateOutcomeRank(rows, { from = Date.parse("2026-05-01T00:00:00Z"), to = Infinity } = {}) {
  if (!Number.isFinite(from) || from <= 0 || !(Number.isFinite(to) || to === Infinity) || to <= from) throw new Error("invalid_evaluation_window");
  const counts = new Map();
  for (const r of rows) if (r?.trade_id) counts.set(r.trade_id, (counts.get(r.trade_id) || 0) + 1);
  const eligible = rows.filter(r=>r?.entry_ts>=from && r.entry_ts<to &&
    counts.get(r.trade_id) === 1 && isUsableOutcome(r) && r.pnl!=null && Number.isFinite(Number(r.pnl)));
  const predicted=[], unscored={};
  for(const r of eligible){
    const model=fitOutcomeRank(rows,Number(r.entry_ts));
    const p=scoreOutcomeRank(r,model,Number(r.entry_ts));
    if(p.available) predicted.push({...r, legacy:Number(r.rank), challenger:p.score});
    else unscored[p.reason] = (unscored[p.reason] || 0) + 1;
  }
  // Rank contemporaneous entries, not all months globally. Weekly cohorts are
  // diagnostics on observed trades, NOT executable simultaneous candidate sets.
  const groups=new Map();
  for(const r of predicted){const week=Math.floor((Number(r.entry_ts)-Date.UTC(1970,0,5))/(7*86400000));
    if(!groups.has(week))groups.set(week,[]);groups.get(week).push(r);}
  const select=field=>[...groups.values()].filter(g=>g.length>=3).flatMap(g=>[...g]
    .sort((a,b)=>b[field]-a[field]||a.entry_ts-b.entry_ts||a.trade_id.localeCompare(b.trade_id))
    .slice(0,Math.ceil(g.length/3)));
  const old=select("legacy"), challenger=select("challenger");
  return { from:new Date(from).toISOString(),to:Number.isFinite(to)?new Date(to).toISOString():null,
    model_version:OUTCOME_RANK_VERSION,eligible:eligible.length,scored:predicted.length,unscored,all:summary(predicted),
    correlation:{legacy:corr(predicted,"legacy"),challenger:corr(predicted,"challenger")},
    weekly_top_third:{legacy:summary(old),challenger:summary(challenger)},
    limitations:["Selected closed ledger, not complete candidate universe or portfolio replay.",
      "Weekly comparison includes candidates arriving at different times; ranking diagnostic only.",
      "Only observed closed outcomes are evaluated; trades still open at export are censored.",
      "Legacy entry rank and quoted R:R may reflect historical scoring/config versions.",
      "Ledger R:R can be recomputed after stop selection and may differ from the pre-entry quote.",
      "No market-bar validation in public export; cost is a 10bps round-trip assumption."] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file=process.argv[2];
  if(!file) throw new Error("Usage: node scripts/evaluate-outcome-rank.mjs ledger.json [from-ISO] [to-ISO]");
  const raw=readFileSync(file,"utf8"),j=JSON.parse(raw),rows=Array.isArray(j)?j:j.trades;
  if(!Array.isArray(rows)||j.hasMore) throw new Error("Complete ledger export required");
  const from=process.argv[3]?Date.parse(process.argv[3]):undefined;
  const to=process.argv[4]?Date.parse(process.argv[4]):undefined;
  console.log(JSON.stringify({source_sha256:createHash("sha256").update(raw).digest("hex"),
    defaults:OUTCOME_RANK_DEFAULTS,...evaluateOutcomeRank(rows,{...(from!==undefined?{from}:{}),...(to!==undefined?{to}:{})})},null,2));
}
