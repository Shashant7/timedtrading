#!/usr/bin/env node
/**
 * Seed accepted indicator parity fixtures (worker-computed baseline).
 * Full TradingView benchmark exports replace expected values when available.
 *
 * Usage:
 *   node scripts/seed-accepted-parity-fixtures.mjs
 *   node scripts/run-setup-parity-gate.mjs --fixtures data/indicator-fixtures/v1/accepted
 */

import fs from "node:fs";
import path from "node:path";
import {
  computeWorkerParityRow,
  validateParityFixture,
} from "../worker/foundation/indicator-parity.js";

const DAY = 24 * 60 * 60 * 1000;
const OUT_DIR = path.join(process.cwd(), "data/indicator-fixtures/v1/accepted");

const FIXTURES = [
  { ticker: "SPY", tf: "D", session_clip: "exchange" },
  { ticker: "IWM", tf: "D", session_clip: "exchange" },
  { ticker: "QQQ", tf: "D", session_clip: "exchange" },
  { ticker: "SPY", tf: "60", session_clip: "rth" },
  { ticker: "IWM", tf: "60", session_clip: "rth" },
  { ticker: "QQQ", tf: "60", session_clip: "rth" },
];

function syntheticBars(n = 120, startClose = 100) {
  const start = Date.UTC(2025, 0, 2);
  const out = [];
  let close = startClose;
  for (let i = 0; i < n; i += 1) {
    const wave = Math.sin(i / 6) * 1.5;
    close += 0.12 + wave * 0.06;
    const open = close - 0.1;
    const high = close + 0.8 + (i % 4) * 0.05;
    const low = close - 0.8 - (i % 3) * 0.05;
    out.push({
      ts: start + i * DAY,
      o: Number(open.toFixed(4)),
      h: Number(high.toFixed(4)),
      l: Number(low.toFixed(4)),
      c: Number(close.toFixed(4)),
      v: 2_000_000 + i * 5000,
    });
  }
  return out;
}

function buildFixture({ ticker, tf, session_clip }) {
  const candles = syntheticBars(120, ticker === "SPY" ? 480 : ticker === "QQQ" ? 400 : 200);
  const asOfTs = candles[candles.length - 1].ts;
  const computed = computeWorkerParityRow({ ticker, tf, candles, asOfTs });
  if (!computed.ok) throw new Error(`${ticker}/${tf}: ${computed.error}`);

  return {
    fixture_version: 1,
    source: "worker_baseline_v1",
    acceptance: "self_consistent_pending_tv_reexport",
    ticker,
    tf,
    session_clip,
    range: { start: "2025-01-02", end: "2025-05-01" },
    candles_source: "synthetic_seed",
    indicator_params: { supertrend: { factor: 3.0, atr_len: 10 } },
    candles,
    rows: [{ ts: asOfTs, expected: computed.actual }],
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  for (const spec of FIXTURES) {
    const fixture = buildFixture(spec);
    const validation = validateParityFixture(fixture);
    if (!validation.ok) {
      console.error("Invalid fixture", spec, validation.errors);
      process.exit(1);
    }
    const name = `${spec.ticker.toLowerCase()}-${spec.tf.toLowerCase()}-baseline.json`;
    const outPath = path.join(OUT_DIR, name);
    fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    manifest.push({ file: name, ticker: spec.ticker, tf: spec.tf });
    console.log("Wrote", outPath);
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    note: "Worker self-consistent baselines. Replace expected rows after TradingView re-export.",
    fixtures: manifest,
  }, null, 2));
}

main();
