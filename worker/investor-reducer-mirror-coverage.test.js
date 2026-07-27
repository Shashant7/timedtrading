// Contract test: every investor reducer path in worker/index.js that writes
// a SELL to investor_lots must also call the broker-bridge mirror before
// closing the block. This is the class-of-bug guard for "trim recorded in
// D1 but not forwarded to Webull" — the KO PRE_EARNINGS_RISK_REDUCTION
// regression on 2026-07-27, which never mirrored because the event-risk
// trim loop wrote lots + fired Discord but never called _bridgeMirrorInvestor.
//
// The check is intentionally source-level (not a runtime unit test) because
// index.js is a 100k-line orchestrator with many interleaved cron paths;
// asserting on the compiled surface would require standing up half the
// worker. A grep contract catches "someone added a new reducer loop and
// forgot the bridge mirror" without any runtime plumbing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "index.js");
const src = readFileSync(INDEX_PATH, "utf8");
const lines = src.split("\n");

/**
 * Return the nearest preceding `routeKey === "..."` marker for a given line,
 * so the contract can distinguish AUTO (cron / rebalance) SELL blocks —
 * which MUST mirror — from admin/manual route handlers where the operator
 * triggers the sell explicitly and the broker side is handled out-of-band
 * (or intentionally not mirrored). Returns `null` when the SELL is not
 * inside any recent route handler (i.e., it's in a cron/rebalance loop).
 */
function nearestRouteMarker(idx, lookback = 2500) {
  const start = Math.max(0, idx - lookback);
  for (let i = idx; i >= start; i--) {
    const m = lines[i].match(/routeKey\s*===\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

// Admin/manual route handlers that write SELL lots but do NOT auto-mirror
// to the broker (operator invokes them by hand — a UI edit or a cleanup
// script). If a new manual route is added, allow-list it here with a
// one-line justification. Everything else — auto-rebalance, event-risk,
// exhaustion, invalidation — must mirror.
const MANUAL_ROUTE_ALLOWLIST = new Set([
  "DELETE /timed/investor/positions",   // operator-driven manual close/partial
  "POST /timed/investor/positions/lot", // operator-driven manual lot insert
]);

/** Return every line index where an investor AUTO SELL is written to investor_lots. */
function findInvestorSellLotInserts() {
  const hits = [];
  // Pattern: `INSERT INTO investor_lots ... 'SELL'` — supports both bind-style
  // and inline literal (there is only one form in tree today, but keep permissive).
  const re = /INSERT\s+INTO\s+investor_lots[\s\S]{0,400}?'SELL'/i;
  for (let i = 0; i < lines.length; i++) {
    // Cheap first-pass filter to avoid re-running the multi-line regex over
    // every line — only start when we see the INSERT keyword pair.
    if (!/INSERT\s+INTO\s+investor_lots/i.test(lines[i])) continue;
    // Reconstruct up to 8 lines ahead so multi-line prepared statements match.
    const window = lines.slice(i, i + 8).join("\n");
    if (!re.test(window)) continue;
    const route = nearestRouteMarker(i);
    if (route && MANUAL_ROUTE_ALLOWLIST.has(route)) continue;
    hits.push(i);
  }
  return hits;
}

/** True when a bridge mirror call appears within `windowLines` lines below `startIdx`. */
function hasBridgeMirrorWithin(startIdx, windowLines = 120) {
  const end = Math.min(lines.length, startIdx + windowLines);
  for (let i = startIdx; i < end; i++) {
    if (/_bridgeMirrorInvestor\s*\(/.test(lines[i])) return true;
    if (/forwardInvestorMirror\s*\(/.test(lines[i])) return true;
  }
  return false;
}

describe("investor reducer paths mirror to broker bridge (source contract)", () => {
  it("finds at least one investor SELL lot insert (sanity — regex still matches the codebase)", () => {
    const hits = findInvestorSellLotInserts();
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("every investor SELL lot insert has a bridge mirror call within 120 lines", () => {
    const hits = findInvestorSellLotInserts();
    const missing = [];
    for (const idx of hits) {
      if (!hasBridgeMirrorWithin(idx, 120)) {
        // 1-index line numbers for the error message.
        const lineNo = idx + 1;
        const snippet = lines.slice(idx, Math.min(lines.length, idx + 4)).join("\n").slice(0, 240);
        missing.push(`worker/index.js:${lineNo} — ${snippet}`);
      }
    }
    // Fail-loud: enumerate each un-mirrored reducer so a regressing PR
    // sees the concrete line, not "expected true got false".
    expect(
      missing,
      `Un-mirrored investor SELL block(s) — every investor_lots SELL must be followed by _bridgeMirrorInvestor(...) or forwardInvestorMirror(...) within ~120 lines:\n${missing.join("\n\n")}`,
    ).toEqual([]);
  });
});
