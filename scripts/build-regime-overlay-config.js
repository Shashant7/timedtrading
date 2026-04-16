#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function usage() {
  console.error("Usage: node scripts/build-regime-overlay-config.js <base-config.json> <overlay-patch.json> <output.json>");
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const [, , baseArg, patchArg, outputArg] = process.argv;
  if (!baseArg || !patchArg || !outputArg) usage();

  const basePath = path.resolve(baseArg);
  const patchPath = path.resolve(patchArg);
  const outputPath = path.resolve(outputArg);

  const baseDoc = readJson(basePath);
  const patchDoc = readJson(patchPath);

  const baseConfig = baseDoc && typeof baseDoc === "object" && baseDoc.config && typeof baseDoc.config === "object"
    ? { ...baseDoc.config }
    : { ...baseDoc };

  const overrides = patchDoc.overrides && typeof patchDoc.overrides === "object"
    ? patchDoc.overrides
    : {};

  const mergedConfig = {
    ...baseConfig,
    ...overrides,
  };

  const outputDoc = {
    ok: true,
    source_run_id: baseDoc.source_run_id || baseDoc.run_id || null,
    derived_from: {
      base_config_path: path.relative(process.cwd(), basePath),
      overlay_patch_path: path.relative(process.cwd(), patchPath),
      overlay_version: patchDoc.version || null,
    },
    provenance: {
      generated_at: new Date().toISOString(),
      builder: "scripts/build-regime-overlay-config.js",
      description: patchDoc.description || null,
    },
    config_key_count: Object.keys(mergedConfig).length,
    config: mergedConfig,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(outputDoc, null, 2)}\n`, "utf8");

  const changedKeys = Object.keys(overrides).sort();
  console.log(JSON.stringify({
    ok: true,
    output: path.relative(process.cwd(), outputPath),
    changed_keys: changedKeys,
    config_key_count: outputDoc.config_key_count,
  }, null, 2));
}

main();
