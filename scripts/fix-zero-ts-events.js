#!/usr/bin/env node
/**
 * Fix EXIT/TRIM events with zero or missing timestamps (removes "Dec 31, 1969" from By day).
 * Calls POST /timed/admin/fix-zero-ts-events.
 *
 * Usage: TIMED_API_KEY=your_key node scripts/fix-zero-ts-events.js
 */
const fs = require("fs");
const path = require("path");

try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const buf = fs.readFileSync(envPath, "utf8");
    buf.split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    });
  }
} catch (_) {}

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }
  const url = `${API_BASE}/timed/admin/fix-zero-ts-events?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    console.error("Failed:", data);
    process.exit(1);
  }
  console.log(data.message || `Fixed KV: ${data.fixedKV}, D1: ${data.fixedD1}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
