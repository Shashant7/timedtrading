#!/usr/bin/env node
/**
 * Trust Spine forward validation — Phase B: live conviction outcomes.
 *
 * Joins decision_records ENTRY rows to closed trades and applies the same
 * promotion gates as scripts/validate-conviction-corpus.mjs (Slice E), but
 * on version-pinned live inputs (focus_conviction, EMA21, etc.).
 *
 * Prerequisite: scripts/validate-decision-records-live.mjs PASS (provenance accrual).
 *
 * Usage:
 *   node scripts/validate-conviction-live.mjs --wrangler-d1 production --remote
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { fuseConviction } from "../worker/conviction.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";

const MIN_CLOSED = 30;
const GATE_MIN_N_OOS = 30;
const OOS_HOLD_RATIO = 0.7;

function d1Query(sql) {
  const remoteFlag = remote ? " --remote" : "";
  const envFlag = envName !== "production" ? ` --env ${envName}` : " --env production";
  const escaped = sql.replace(/'/g, "'\"'\"'");
  const cmd = `cd worker && npx wrangler d1 execute timed-trading-ledger${envFlag}${remoteFlag} --command '${escaped}'`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const m = out.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

function stats(rows) {
  const n = rows.length;
  if (!n) return { n: 0, wr: null, mean: null, sqn: null };
  const wins = rows.filter((r) => Number(r.pnl) > 0).length;
  const pnls = rows.map((r) => Number(r.pnl_pct) || 0);
  const mean = pnls.reduce((a, b) => a + b, 0) / n;
  const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sqn = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  return {
    n,
    wr: Math.round((wins / n) * 1000) / 10,
    mean: Math.round(mean * 1000) / 1000,
    sqn: Math.round(sqn * 100) / 100,
  };
}

function fmt(label, s) {
  return `${label.padEnd(28)} n=${String(s.n).padStart(3)}  WR=${s.wr == null ? "—" : (s.wr + "%").padStart(6)}  meanPnl=${s.mean == null ? "—" : String(s.mean).padStart(7)}  SQN=${s.sqn == null ? "—" : String(s.sqn).padStart(6)}`;
}

function parseInputs(row) {
  if (!row?.inputs_json) return null;
  try {
    const parsed = JSON.parse(row.inputs_json);
    return parsed?.payload || parsed?.tickerData || parsed;
  } catch {
    return null;
  }
}

const rows = d1Query(
  `SELECT dr.decision_id, dr.trade_id, dr.ticker, dr.ts, dr.conviction_tier,
          dr.config_hash, dr.scoring_version, dr.inputs_json,
          t.entry_ts, t.pnl, t.pnl_pct, t.status, t.direction
   FROM decision_records dr
   JOIN trades t ON t.trade_id = dr.trade_id
   WHERE dr.event_type = 'ENTRY'
     AND t.status IN ('WIN','LOSS')
     AND (t.run_id IS NULL OR t.run_id = '')
   ORDER BY t.entry_ts ASC`,
);

const enriched = rows.map((r) => {
  const inputs = parseInputs(r);
  const direction = r.direction || inputs?.trigger_dir || inputs?.direction;
  const conv = inputs
    ? fuseConviction(inputs, { direction })
    : { tier: r.conviction_tier || "?", score: null, sizeMult: 1 };
  const confirmFired = !!(inputs?.setup_gates?.stack_full_confirm?.fires);
  return { ...r, _inputs: inputs, _conv: conv, _confirm: confirmFired };
});

const baseline = stats(enriched);
const tierA = stats(enriched.filter((r) => (r._conv.tier || r.conviction_tier) === "A"));
const tierB = stats(enriched.filter((r) => (r._conv.tier || r.conviction_tier) === "B"));
const tierC = stats(enriched.filter((r) => (r._conv.tier || r.conviction_tier) === "C"));
const confirmFired = stats(enriched.filter((r) => r._confirm));
const confirmNot = stats(enriched.filter((r) => !r._confirm));

const split = Math.floor(enriched.length * 0.75);
const inSample = enriched.slice(0, split);
const outSample = enriched.slice(split);
const isBase = stats(inSample);
const oosBase = stats(outSample);
const isConfirm = stats(inSample.filter((r) => r._confirm));
const oosConfirm = stats(outSample.filter((r) => r._confirm));
const oosHoldsRatio = (isConfirm.sqn && oosConfirm.sqn)
  ? oosConfirm.sqn / isConfirm.sqn
  : null;

const prereqPass = enriched.length >= MIN_CLOSED;

const checks = prereqPass
  ? {
      gate_fired_n_oos: {
        value: oosConfirm.n,
        pass: oosConfirm.n >= GATE_MIN_N_OOS,
        want: `>=${GATE_MIN_N_OOS}`,
      },
      confirm_beats_baseline_wr: {
        value: confirmFired.wr,
        pass: confirmFired.wr != null && baseline.wr != null && confirmFired.wr > baseline.wr,
        want: `> baseline ${baseline.wr}%`,
      },
      confirm_positive_expectancy: {
        value: confirmFired.mean,
        pass: confirmFired.mean > 0,
        want: "> 0",
      },
      oos_sqn_holds_70pct: {
        value: oosHoldsRatio == null ? null : Math.round(oosHoldsRatio * 100) / 100,
        pass: oosHoldsRatio != null && oosHoldsRatio >= OOS_HOLD_RATIO,
        want: `>= ${OOS_HOLD_RATIO} of in-sample`,
      },
      tierA_beats_tierC_wr: {
        value: [tierA.wr, tierC.wr],
        pass: tierA.wr != null && tierC.wr != null && tierA.n >= 5 && tierC.n >= 5 && tierA.wr > tierC.wr,
        want: "Tier A WR > Tier C WR (n>=5 each)",
      },
    }
  : {
      min_closed_trades: {
        value: enriched.length,
        pass: false,
        want: `>= ${MIN_CLOSED} closed ENTRY rows joined to trades`,
      },
    };

const allPass = Object.values(checks).every((c) => c.pass);

const lines = [];
lines.push("# Conviction Fusion — Live Forward Validation (Phase B)");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Prerequisite");
lines.push("");
lines.push(`Closed ENTRY decision_records joined to WIN/LOSS trades: **${enriched.length}** (need >= ${MIN_CLOSED})`);
lines.push("");
if (!prereqPass) {
  lines.push("**NOT READY** — let more live trades close with provenance. Re-run weekly.");
  lines.push("");
  lines.push("Phase A (provenance accrual) may already PASS — run:");
  lines.push("```bash");
  lines.push("node scripts/validate-decision-records-live.mjs --wrangler-d1 production --remote");
  lines.push("```");
} else {
  lines.push("## Live outcomes (version-pinned inputs)");
  lines.push("```");
  lines.push(fmt("BASELINE (all)", baseline));
  lines.push(fmt("confirm_stack FIRED", confirmFired));
  lines.push(fmt("confirm_stack NOT fired", confirmNot));
  lines.push(fmt("conviction Tier A", tierA));
  lines.push(fmt("conviction Tier B", tierB));
  lines.push(fmt("conviction Tier C", tierC));
  lines.push("```");
  lines.push("");
  lines.push("## Walk-forward (75/25 by entry_ts)");
  lines.push("```");
  lines.push(fmt("in-sample  BASELINE", isBase));
  lines.push(fmt("in-sample  confirm FIRED", isConfirm));
  lines.push(fmt("out-sample BASELINE", oosBase));
  lines.push(fmt("out-sample confirm FIRED", oosConfirm));
  lines.push("```");
  lines.push("");
  lines.push("## Verdict vs promotion gates");
  lines.push("```");
  for (const [k, c] of Object.entries(checks)) {
    lines.push(`${c.pass ? "PASS" : "FAIL"}  ${k.padEnd(28)} value=${JSON.stringify(c.value)} want ${c.want}`);
  }
  lines.push("");
  lines.push(`OVERALL: ${allPass ? "PASS — eligible to flip deep_audit_conviction_fusion_enabled ON (live small under governor)" : "PARTIAL — do NOT flip live yet"}`);
  lines.push("```");
}

const outDir = "data/trust-spine";
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mdPath = `${outDir}/conviction-live-${stamp}.md`;
const jsonPath = `${outDir}/conviction-live-${stamp}.json`;
fs.writeFileSync(mdPath, lines.join("\n") + "\n");
fs.writeFileSync(jsonPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  closed_joined: enriched.length,
  prereq_pass: prereqPass,
  baseline,
  confirmFired,
  tierA,
  tierB,
  tierC,
  walk_forward: { isConfirm, oosConfirm, oosHoldsRatio },
  checks,
  overall_pass: allPass,
}, null, 2));

console.log(lines.join("\n"));
console.log(`\nWrote ${mdPath}`);

process.exit(allPass ? 0 : 2);
