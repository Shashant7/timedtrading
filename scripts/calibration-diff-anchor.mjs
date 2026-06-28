#!/usr/bin/env node
/**
 * Compare frozen anchor run config vs current pre-prod model_config.
 * Wrapper around scripts/diff-run-config.js for the July anchor WR investigation.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/calibration-diff-anchor.mjs \
 *     [--anchor-run-id=phase-c-slice-2025-07-v1] \
 *     [--output=data/trade-analysis/calibration-diff-2025-07-v11.md]
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const ANCHOR = getArg("anchor-run-id", "phase-c-slice-2025-07-v1");
const OUT_JSON = getArg("output-json", "data/trade-analysis/calibration-diff-2025-07-anchor.json");
const OUT_MD = getArg("output", "data/trade-analysis/calibration-diff-2025-07-anchor.md");
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";

if (!API_KEY) {
  console.error("TIMED_API_KEY required");
  process.exit(1);
}

async function fetchRunConfig(runId) {
  const url = `${PREPROD}/timed/admin/runs/config?run_id=${encodeURIComponent(runId)}&key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(`anchor config fetch failed: ${JSON.stringify(data)}`);
  return data.config || {};
}

async function fetchCurrentConfig() {
  const url = `${PREPROD}/timed/admin/model-config?prefix=deep_audit_&key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(`model_config fetch failed: ${JSON.stringify(data)}`);
  const cfg = {};
  for (const it of data.items || []) cfg[it.key] = it.value;
  return cfg;
}

function writeBaselineFile(anchorCfg) {
  const p = path.join(REPO, "data/trade-analysis/.anchor-config-snapshot.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ run_id: ANCHOR, config: anchorCfg }, null, 2));
  return p;
}

function toMarkdown(diff) {
  const lines = [
    `# Calibration diff — anchor vs current pre-prod`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Anchor run | \`${ANCHOR}\` |`,
    `| Compare | current pre-prod \`deep_audit_*\` |`,
    `| Generated | ${diff.generated_at} |`,
    `| Changed keys | ${diff.summary.changed} |`,
    `| Anchor-only keys | ${diff.summary.baseline_only} |`,
    `| Current-only keys | ${diff.summary.compare_only} |`,
    "",
  ];
  if (diff.changed_keys?.length) {
    lines.push("## Changed keys (likely WR/selectivity drivers)", "", "| Key | Anchor | Current |", "|---|---|---|");
    for (const row of diff.changed_keys.slice(0, 80)) {
      lines.push(`| \`${row.key}\` | ${String(row.baseline).slice(0, 60)} | ${String(row.compare).slice(0, 60)} |`);
    }
    if (diff.changed_keys.length > 80) lines.push("", `_…${diff.changed_keys.length - 80} more in JSON artifact_`);
  } else {
    lines.push("_No changed keys in overlapping set._");
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  console.log(`Fetching anchor config: ${ANCHOR}`);
  const anchorCfg = await fetchRunConfig(ANCHOR);
  const baselineFile = writeBaselineFile(anchorCfg);

  console.log("Fetching current pre-prod deep_audit_* …");
  const currentCfg = await fetchCurrentConfig();
  const compareFile = path.join(REPO, "data/trade-analysis/.current-preprod-config-snapshot.json");
  fs.writeFileSync(compareFile, JSON.stringify({ run_id: "preprod-current", config: currentCfg }, null, 2));

  const outJsonAbs = path.resolve(REPO, OUT_JSON);
  execFileSync(process.execPath, [
    path.join(REPO, "scripts/diff-run-config.js"),
    "--baseline-file", baselineFile,
    "--compare-file", compareFile,
    "--output", outJsonAbs,
  ], { stdio: "inherit", env: { ...process.env, WORKER_BASE: PREPROD } });

  const diff = JSON.parse(fs.readFileSync(outJsonAbs, "utf8"));
  const md = toMarkdown(diff);
  const outMdAbs = path.resolve(REPO, OUT_MD);
  fs.mkdirSync(path.dirname(outMdAbs), { recursive: true });
  fs.writeFileSync(outMdAbs, md);
  console.log(`Wrote ${outMdAbs}`);
  console.log(JSON.stringify(diff.summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
