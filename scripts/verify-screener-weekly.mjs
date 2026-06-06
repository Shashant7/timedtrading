#!/usr/bin/env node
/**
 * Smoke-test POST /timed/admin/screener/run (weekly) end-to-end.
 * Requires TIMED_TRADING_API_KEY in the environment.
 *
 * Usage:
 *   TIMED_TRADING_API_KEY=... node scripts/verify-screener-weekly.mjs
 *   TIMED_TRADING_API_KEY=... node scripts/verify-screener-weekly.mjs --base https://timed-trading-ingest.shashant.workers.dev
 */
import process from "node:process";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_TRADING_API_KEY || process.env.TIMED_API_KEY;
const LIMIT = 12;

if (!KEY) {
  console.error("Missing TIMED_TRADING_API_KEY");
  process.exit(1);
}

async function parseJson(res) {
  const text = await res.text();
  if (text.trim().startsWith("<")) {
    throw new Error(`HTML response HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const runUrl = `${BASE}/timed/admin/screener/run?key=${encodeURIComponent(KEY)}`;
  const t0 = Date.now();
  const runRes = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "weekly", limit: LIMIT }),
  });
  const runJson = await parseJson(runRes);
  console.log(`POST ${runRes.status} in ${Date.now() - t0}ms`, runJson);
  if (runRes.status === 200 && runJson?.result) {
    const result = runJson.result;
    if (!result.ok) {
      console.error("sync run failed:", JSON.stringify(result, null, 2));
      process.exit(1);
    }
    console.log("OK weekly scan (sync):", {
      candidates: result.candidates,
      stored: result.stored,
      pool_source: result.pool_source,
      elapsed_ms: result.elapsed_ms,
    });
    process.exit(0);
  }
  if (runRes.status !== 202) {
    throw new Error(`Expected HTTP 200 or 202, got ${runRes.status}`);
  }
  if (!runJson.accepted && !runJson.already_running) {
    throw new Error(`Expected accepted scan, got ${JSON.stringify(runJson)}`);
  }
  if (runJson.already_running) {
    console.log("Reusing in-flight scan (already_running)");
  }

  const statusUrl = `${BASE}/timed/admin/screener/status?key=${encodeURIComponent(KEY)}`;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const stRes = await fetch(statusUrl, { cache: "no-store" });
    const stJson = await parseJson(stRes);
    const st = stJson?.status;
    console.log(`poll: ${st?.status || "unknown"} mode=${st?.mode || "?"}`);
    if (st?.status === "completed") {
      const result = st.result || {};
      if (!result.ok) {
        console.error("completed but failed:", JSON.stringify(result, null, 2));
        process.exit(1);
      }
      console.log("OK weekly scan:", {
        candidates: result.candidates,
        stored: result.stored,
        pool_source: result.pool_source,
        elapsed_ms: result.elapsed_ms,
      });
      process.exit(0);
    }
    if (st?.status === "failed") {
      console.error("scan failed:", JSON.stringify(st, null, 2));
      process.exit(1);
    }
  }
  throw new Error("Timed out waiting for screener completion");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e.message || e);
  process.exit(1);
});
