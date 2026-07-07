#!/usr/bin/env node
/**
 * Trust Spine forward validation — live decision_records accrual + coverage.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/validate-decision-records-live.mjs --wrangler-d1 production --remote
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";

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

const MIN_ROWS = 50;
const REQUIRED_EVENTS = ["ENTRY", "EXIT", "TRIM", "DEFEND"];

const summary = d1Query(
  `SELECT COUNT(*) as total,
          COUNT(DISTINCT config_hash) as config_epochs,
          COUNT(DISTINCT engine_git_sha) as engine_builds,
          SUM(CASE WHEN config_hash IS NOT NULL AND config_hash != '' THEN 1 ELSE 0 END) as with_hash,
          SUM(CASE WHEN engine_git_sha IS NOT NULL AND engine_git_sha != 'unset' THEN 1 ELSE 0 END) as with_sha
   FROM decision_records`,
)[0];

const byEvent = d1Query(
  `SELECT engine, event_type, COUNT(*) as n FROM decision_records
   GROUP BY engine, event_type ORDER BY n DESC`,
);

const investorTrim = byEvent.find((r) => r.engine === "investor" && r.event_type === "TRIM")?.n || 0;

const lines = [];
lines.push("# Decision records — live forward validation");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push(`| Metric | Value | Gate |`);
lines.push(`|--------|------:|------|`);
lines.push(`| Total rows | ${summary.total} | >= ${MIN_ROWS} |`);
lines.push(`| Config epochs | ${summary.config_epochs} | >= 2 for attribution |`);
lines.push(`| Engine builds | ${summary.engine_builds} | informational |`);
lines.push(`| With config_hash | ${summary.with_hash} | 100% |`);
lines.push(`| With engine_git_sha | ${summary.with_sha} | 100% |`);
lines.push(`| Investor TRIM rows | ${investorTrim} | > 0 after provenance PR |`);
lines.push("");
lines.push("## By engine / event");
lines.push("");
lines.push("| engine | event_type | n |");
lines.push("|--------|------------|--:|");
for (const r of byEvent) {
  lines.push(`| ${r.engine} | ${r.event_type} | ${r.n} |`);
}

const gates = [];
if (Number(summary.total) < MIN_ROWS) gates.push(`total < ${MIN_ROWS}`);
if (Number(summary.config_epochs) < 2) gates.push("need >= 2 config epochs for attribution");
const legacyHash = Number(summary.total) - Number(summary.with_hash);
const legacySha = Number(summary.total) - Number(summary.with_sha);
const warnings = [];
if (legacyHash > 0) warnings.push(`${legacyHash} legacy rows missing config_hash`);
if (legacySha > 0) warnings.push(`${legacySha} legacy rows missing engine_git_sha`);
if (investorTrim === 0) warnings.push("no investor TRIM rows yet (deploy provenance PR)");

lines.push("");
lines.push("## Verdict");
lines.push("");
if (gates.length === 0) {
  lines.push("**PASS (provenance accrual)** — sufficient rows for forward conviction validation.");
  if (warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("Next: join ENTRY rows to trades on trade_id; re-run validate-conviction-corpus against live inputs.");
} else {
  lines.push("**PARTIAL** — gates not cleared:");
  for (const g of gates) lines.push(`- ${g}`);
}

const outDir = "data/trust-spine";
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mdPath = `${outDir}/decision-records-live-${stamp}.md`;
fs.writeFileSync(mdPath, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nWrote ${mdPath}`);

process.exit(gates.length === 0 ? 0 : 2);
