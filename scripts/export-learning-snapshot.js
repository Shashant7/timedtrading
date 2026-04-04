#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const args = process.argv.slice(2);

function getArg(name, fallback = "") {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const repoRoot = path.resolve(__dirname, "..");
const label = getArg("label", "learning-snapshot");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(repoRoot, "data", "reference-intel", "history", `${label}-${ts}`);

const include = [
  "configs/dynamic-engine-rules-reference-v1.json",
];

function copyReferenceIntel() {
  const srcDir = path.join(repoRoot, "data", "reference-intel");
  const destDir = path.join(outDir, "reference-intel");
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "history") continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    fs.cpSync(src, dest, { recursive: true });
    copied.push(path.join("data/reference-intel", entry.name));
  }
}

fs.mkdirSync(outDir, { recursive: true });

const copied = [];
copyReferenceIntel();
for (const rel of include) {
  const src = path.join(repoRoot, rel);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(outDir, path.basename(src));
  fs.cpSync(src, dest, { recursive: true });
  copied.push(rel);
}

let gitSha = "";
try {
  gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {}

const manifest = {
  ok: true,
  label,
  captured_at: new Date().toISOString(),
  git_sha: gitSha || null,
  copied,
};

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`${path.relative(repoRoot, outDir)}\n`);
