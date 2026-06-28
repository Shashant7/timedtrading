#!/usr/bin/env node
/**
 * Generate PNG PWA / apple-touch icons from react-app/logo.svg.
 * Run: node scripts/generate-pwa-icons.js
 */
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const svgPath = path.join(repoRoot, "react-app", "logo.svg");
const outDir = path.join(repoRoot, "react-app");

async function main() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (_) {
    console.error("[generate-pwa-icons] sharp is required — npm install sharp");
    process.exit(1);
  }

  if (!fs.existsSync(svgPath)) {
    console.error(`[generate-pwa-icons] missing ${svgPath}`);
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath);
  const sizes = [
    { name: "apple-touch-icon.png", size: 180 },
    { name: "icon-192.png", size: 192 },
    { name: "icon-512.png", size: 512 },
  ];

  for (const { name, size } of sizes) {
    const out = path.join(outDir, name);
    await sharp(svg)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`[generate-pwa-icons] wrote ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
