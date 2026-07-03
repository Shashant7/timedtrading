// tests/wrangler-binding-parity.test.js
//
// A3 (2026-07-03 stabilization plan) — BINDING PARITY CI GUARD.
//
// The role workers (tt-feed / tt-engine / tt-research) deploy the SAME
// monolith bundle but each wrangler.toml declares its OWN bindings + vars.
// A binding added to worker/wrangler.toml is NOT automatically present on
// the role workers; the code's `if (env.SOME_BINDING)` guard then silently
// falls back — invisibly. That exact gap (tt-engine missing
// CANDLE_CHAIN_SHARD + SCORE_CANDLE_SOURCE) caused the 2026-06-15
// "scores not fresh / 93-95% investor exclusion" incident
// (tasks/2026-06-15-freshness-rca-and-build-plan.md), and the CI guard was
// planned then but never built. This test is that guard: config drift
// between the four wrangler.tomls now fails CI instead of failing live.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ── Minimal TOML reader (sections, array tables, quoted scalars) ───────────
// Only what wrangler.toml needs — avoids adding a TOML dependency.
function stripComment(line) {
  let quotes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quotes++;
    if (ch === "#" && quotes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

function parseWranglerToml(path) {
  const src = readFileSync(join(process.cwd(), path), "utf8");
  const doc = { tables: { root: {} }, arrays: {} };
  let cur = doc.tables.root;
  for (const raw of src.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^\[\[(.+)\]\]$/))) {
      const key = m[1].trim();
      doc.arrays[key] = doc.arrays[key] || [];
      cur = {};
      doc.arrays[key].push(cur);
    } else if ((m = line.match(/^\[(.+)\]$/))) {
      const key = m[1].trim();
      doc.tables[key] = doc.tables[key] || {};
      cur = doc.tables[key];
    } else if ((m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"\s*,?$/))) {
      cur[m[1]] = m[2];
    } else if ((m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*([^"[].*)$/))) {
      cur[m[1]] = m[2].trim();
    }
    // multi-line arrays (crons = [ ... ]) are intentionally skipped —
    // cron parity is owned by the role gating in scheduled().
  }
  return doc;
}

function doBindings(doc, prefix = "") {
  const key = prefix ? `${prefix}.durable_objects.bindings` : "durable_objects.bindings";
  const out = new Map();
  for (const b of doc.arrays[key] || []) out.set(b.name, b);
  return out;
}

function kvId(doc, prefix = "") {
  const key = prefix ? `${prefix}.kv_namespaces` : "kv_namespaces";
  return (doc.arrays[key] || []).find((k) => k.binding === "KV_TIMED")?.id || null;
}

function d1Id(doc, prefix = "") {
  const key = prefix ? `${prefix}.d1_databases` : "d1_databases";
  return (doc.arrays[key] || []).find((d) => d.binding === "DB")?.database_id || null;
}

function services(doc, prefix = "") {
  const key = prefix ? `${prefix}.services` : "services";
  return new Map((doc.arrays[key] || []).map((s) => [s.binding, s]));
}

function vars(doc, prefix = "") {
  const key = prefix ? `${prefix}.vars` : "vars";
  return doc.tables[key] || {};
}

const monolith = parseWranglerToml("worker/wrangler.toml");
const engine = parseWranglerToml("worker-engine/wrangler.toml");
const feed = parseWranglerToml("worker-feed/wrangler.toml");
const research = parseWranglerToml("worker-research/wrangler.toml");

const MONOLITH_SCRIPT = "timed-trading-ingest";

// Lane requirements: which bindings/vars each role worker's cron lanes
// actually consume. EXTEND THIS when a lane gains a new binding.
const ROLE_REQUIREMENTS = [
  {
    label: "tt-engine (*/5 scoring + lifecycle)",
    doc: engine,
    requiredDOs: ["PRICE_HUB", "PRICE_STREAM", "ALPACA_STREAM", "TRADOVATE_STREAM", "BACKTEST_RUNNER", "CANDLE_CHAIN_SHARD"],
    requiredServices: ["BROKER_BRIDGE"],
    requiredVars: ["WORKER_ROLE", "SCORE_CANDLE_SOURCE", "CANDLE_CHAIN_INGEST", "DATA_PROVIDER", "ENTRY_ENGINE", "MANAGEMENT_ENGINE"],
  },
  {
    label: "tt-feed (*/1 price feed + live-candle sync)",
    doc: feed,
    requiredDOs: ["PRICE_HUB", "PRICE_STREAM", "ALPACA_STREAM", "TRADOVATE_STREAM"],
    requiredServices: [],
    requiredVars: ["DATA_PROVIDER"],
  },
  {
    label: "tt-research (hourly arms + nightly batch)",
    doc: research,
    requiredDOs: ["PRICE_HUB", "PRICE_STREAM", "ALPACA_STREAM", "TRADOVATE_STREAM", "BACKTEST_RUNNER"],
    requiredServices: ["BROKER_BRIDGE"],
    requiredVars: ["WORKER_ROLE", "DATA_PROVIDER"],
  },
];

describe("binding parity: role workers have every binding their lanes need", () => {
  for (const req of ROLE_REQUIREMENTS) {
    describe(req.label, () => {
      it("declares all required DO bindings", () => {
        const dos = doBindings(req.doc);
        for (const name of req.requiredDOs) {
          expect(dos.has(name), `missing DO binding ${name}`).toBe(true);
        }
      });

      it("DO stubs point at the monolith script (never own the DOs)", () => {
        const monolithDOs = doBindings(monolith);
        for (const [name, b] of doBindings(req.doc)) {
          expect(b.script_name, `${name} must use script_name=${MONOLITH_SCRIPT}`).toBe(MONOLITH_SCRIPT);
          const mono = monolithDOs.get(name);
          expect(mono, `${name} must exist on the monolith`).toBeTruthy();
          expect(b.class_name, `${name} class_name must match the monolith`).toBe(mono.class_name);
        }
      });

      it("shares the monolith's KV namespace and D1 database", () => {
        expect(kvId(req.doc)).toBe(kvId(monolith));
        expect(d1Id(req.doc)).toBe(d1Id(monolith));
      });

      it("declares all required service bindings", () => {
        const svc = services(req.doc);
        for (const name of req.requiredServices) {
          expect(svc.has(name), `missing service binding ${name}`).toBe(true);
        }
      });

      it("declares all required vars", () => {
        const v = vars(req.doc);
        for (const name of req.requiredVars) {
          expect(v[name], `missing var ${name}`).toBeTruthy();
        }
      });
    });
  }
});

describe("binding parity: engine scores on the SAME candle source as the monolith", () => {
  // The 2026-06-15 incident pin: tt-engine defaulting to "legacy" while the
  // monolith fed the chain DO meant the live scorer consumed stale candles.
  it("SCORE_CANDLE_SOURCE matches", () => {
    expect(vars(engine).SCORE_CANDLE_SOURCE).toBe(vars(monolith).SCORE_CANDLE_SOURCE);
  });
  it("CANDLE_CHAIN_INGEST matches", () => {
    expect(vars(engine).CANDLE_CHAIN_INGEST).toBe(vars(monolith).CANDLE_CHAIN_INGEST);
  });
  it("CANDLE_CHAIN_SHARD class matches the monolith's", () => {
    const e = doBindings(engine).get("CANDLE_CHAIN_SHARD");
    const m = doBindings(monolith).get("CANDLE_CHAIN_SHARD");
    expect(e?.class_name).toBe(m?.class_name);
  });
});

describe("binding parity: monolith default and production envs match", () => {
  it("same DO binding names", () => {
    const root = [...doBindings(monolith).keys()].sort();
    const prod = [...doBindings(monolith, "env.production").keys()].sort();
    expect(prod).toEqual(root);
  });
  it("same KV namespace + D1 database", () => {
    expect(kvId(monolith, "env.production")).toBe(kvId(monolith));
    expect(d1Id(monolith, "env.production")).toBe(d1Id(monolith));
  });
  it("same candle-source cutover flags", () => {
    const prodVars = vars(monolith, "env.production");
    expect(prodVars.SCORE_CANDLE_SOURCE).toBe(vars(monolith).SCORE_CANDLE_SOURCE);
    expect(prodVars.CANDLE_CHAIN_INGEST).toBe(vars(monolith).CANDLE_CHAIN_INGEST);
  });
});
