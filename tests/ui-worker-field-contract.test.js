// tests/ui-worker-field-contract.test.js
//
// Pages and the worker deploy through completely independent paths:
// Cloudflare Pages serves the committed react-app-dist/ straight off
// `main`, while worker/ ships via the wrangler workflows. So the UI half
// of a change can go live while the half that produces its data does not.
//
// PR 1463 (breakout watch) is the shape to catch. Its UI shipped on
// 2026-09-12 reading `t._breakout_watch`; the `stampBreakoutWatchOnTicker`
// that writes that field sat in the undeployed worker bundle for two days.
// The badges rendered permanently blank with no error on either side —
// nothing to grep, nothing to page, nothing in a test run.
//
// The rule: every underscore-prefixed field the UI reads off a ticker must
// be KNOWN to worker/ or ASSIGNED by react-app/ itself. Deriving the
// client-side set from actual assignments keeps this self-maintaining — a
// new client-computed field needs no allowlist edit, but a read with no
// producer anywhere fails.
//
// Sensitivity, stated honestly: the worker side accepts any mention of the
// field, not specifically an assignment. Requiring an assignment sounds
// stricter but flags shorthand properties (`{ _stDirD, _stDirW }`) and
// alias reads (`payload._event_risk`) as orphans, and a check that needs
// five hand-maintained exceptions is a check nobody keeps. So this catches
// "the UI depends on a field the worker has never heard of" — a typo, a
// deleted stamp, or a UI shipped ahead of its worker — and NOT "the stamp
// was renamed while a reader kept the old name". The targeted assertion at
// the bottom covers the latter for the field that actually broke.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = [], skip = () => false) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip(name)) continue;
    if (statSync(p).isDirectory()) walk(p, out, skip);
    else out.push(p);
  }
  return out;
}

// Source pages only. `*.compiled.js` and react-app-dist/ are build output
// of these files, so scanning them just double-counts.
function frontendSources() {
  return readdirSync(join(ROOT, "react-app"))
    .filter((f) => /\.(html|js)$/.test(f) && !f.includes(".compiled."))
    .map((f) => join(ROOT, "react-app", f));
}

function workerSources() {
  return walk(join(ROOT, "worker"), [], (n) => n === "node_modules")
    .filter((p) => p.endsWith(".js") && !p.endsWith(".test.js"));
}

// `t._foo`, `ticker?._foo`, `tickerData._foo` — a read off a ticker-ish
// object. The name class must accept camelCase: truncating `_stickyExit` at
// the capital letter invents a `_sticky` field that nothing produces.
const READ_RE = /(?:\bt|\bticker|\btickerData)\s*(?:\?\.|\.)(_[a-z][A-Za-z0-9_]*)/g;

describe("UI ticker fields must have a producer", () => {
  const frontend = frontendSources();
  const uiText = frontend.map((p) => readFileSync(p, "utf8")).join("\n");
  const workerText = workerSources().map((p) => readFileSync(p, "utf8")).join("\n");

  const read = new Map(); // field -> first file that reads it
  for (const p of frontend) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(READ_RE)) {
      if (!read.has(m[1])) read.set(m[1], p.slice(ROOT.length));
    }
  }

  it("finds the ticker fields the UI depends on", () => {
    expect(read.size).toBeGreaterThan(20);
    // Anchor on the field whose absence this test exists to catch.
    expect(read.has("_breakout_watch")).toBe(true);
  });

  it("every field is either stamped by the worker or assigned in the UI", () => {
    const orphans = [];
    for (const [field, where] of read) {
      // Worker stamps it (`tickerData._foo = …`, an alias list, a redaction
      // whitelist — any mention means the field is part of the contract).
      if (workerText.includes(field)) continue;
      // Or the UI computes it itself (`_foo: …` in an object literal,
      // `x._foo = …`, destructuring).
      const assigned = new RegExp(`${field}\\s*[:=](?!=)`).test(uiText);
      if (assigned) continue;
      orphans.push(`${field} (read in ${where})`);
    }
    expect(orphans, [
      "These fields are read off a ticker in react-app/ but nothing produces them.",
      "Either worker/ never stamps the field (a UI-ahead-of-worker deploy, the",
      "PR 1463 breakout-badge case) or the read is a typo / leftover. Both render",
      "silently blank in production.",
    ].join("\n")).toEqual([]);
  });

  it("the breakout-watch contract specifically is intact", () => {
    // The concrete regression: the UI reads `_breakout_watch`, and
    // worker/breakout-watch.js must be the thing that assigns it.
    const stamp = readFileSync(join(ROOT, "worker", "breakout-watch.js"), "utf8");
    expect(stamp).toMatch(/tickerData\._breakout_watch\s*=/);
    // …and it must survive tier redaction, or Pro users see blank badges
    // for a different reason.
    const api = readFileSync(join(ROOT, "worker", "api.js"), "utf8");
    expect(api).toMatch(/"_breakout_watch"/);
  });
});
