#!/usr/bin/env node
/**
 * Dedupe move-replay summary-*.json files — keep newest per move_id, archive rest.
 *
 * Usage:
 *   node scripts/cleanup-move-replay-summaries.mjs
 *   node scripts/cleanup-move-replay-summaries.mjs --prefix summary-2026-06-20
 *   node scripts/cleanup-move-replay-summaries.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const hasFlag = (n) => process.argv.includes(n);
const DRY_RUN = hasFlag("--dry-run");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/move-replay");
const ARCHIVE_DIR = argValue("--archive-dir", path.join(OUT_DIR, "archive", "dedupe-" + new Date().toISOString().slice(0, 10)));
const PREFIX = argValue("--prefix", "summary-");

const files = fs.readdirSync(OUT_DIR)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith(".json"))
  .sort((a, b) => b.localeCompare(a));

const newestByMove = new Map();
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    for (const it of j.summary?.items || j.items || []) {
      if (!it?.move_id || newestByMove.has(it.move_id)) continue;
      newestByMove.set(String(it.move_id), f);
    }
  } catch (_) { /* skip */ }
}

const keep = new Set(newestByMove.values());
const toArchive = files.filter((f) => !keep.has(f));

console.log(JSON.stringify({
  dry_run: DRY_RUN,
  prefix: PREFIX,
  total_files: files.length,
  keep: keep.size,
  archive: toArchive.length,
  archive_dir: ARCHIVE_DIR,
}, null, 2));

if (!toArchive.length) {
  console.log("Nothing to archive.");
  process.exit(0);
}

if (!DRY_RUN) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

for (const f of toArchive) {
  const jsonSrc = path.join(OUT_DIR, f);
  const mdSrc = path.join(OUT_DIR, f.replace(/\.json$/, ".md"));
  if (DRY_RUN) {
    console.log(`would archive ${f}`);
    continue;
  }
  fs.renameSync(jsonSrc, path.join(ARCHIVE_DIR, f));
  if (fs.existsSync(mdSrc)) {
    fs.renameSync(mdSrc, path.join(ARCHIVE_DIR, path.basename(mdSrc)));
  }
}

console.log(DRY_RUN ? "Dry run complete." : `Archived ${toArchive.length} duplicate summary file(s) to ${ARCHIVE_DIR}`);
