// worker/investor-peak-price-contract.test.js
//
// 2026-09-22 — `investor_positions.peak_price` is a high-water mark, and
// the only thing that keeps it high is reading the stored value before
// writing it back:
//
//   const peakPrice = Math.max(Number(pos.peak_price) || 0, price, avgEntry);
//   if (peakPrice > (Number(pos.peak_price) || 0)) UPDATE ... peak_price
//
// Select the row without that column and `pos.peak_price` is undefined,
// so the stored peak reads as 0, every run "improves" on it, and the
// column silently degrades into "spot, floored at avg entry".
//
// That is what happened to CF. It ran 115.90 -> 141.66 (+22.2%) between
// 2026-07-15 and 2026-09-10 and closed on 09-21 with peak_price = 125.21,
// a price from its final session. resolveInvestorMfeExtensionTrim sizes
// trim-into-strength off that peak, so the extension it was built to bank
// was never visible to it.
//
// This is a source contract rather than a behavioural test because the
// query and the reader sit ~1,000 lines apart inside the auto-rebalance
// cron, which is not reachable in isolation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.js"),
  "utf8",
);

// Blank out whole-line comments, keeping length so line numbers and
// offsets still line up with the real file. Prose about peak_price (the
// note explaining this very bug) is not a read.
const CODE = SRC.split("\n")
  .map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? " ".repeat(l.length) : l))
  .join("\n");

/** Every `SELECT ... FROM investor_positions` with its column list. */
function investorPositionSelects(src) {
  const out = [];
  const re = /SELECT\s+([\s\S]*?)\s+FROM\s+investor_positions/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ index: m.index, columns: m[1].replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** Every place the code reads `<something>.peak_price` off a row object. */
function peakPriceReads(src) {
  const out = [];
  const re = /\b([A-Za-z_$][\w$]*)\.peak_price\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ index: m.index, object: m[1], line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

function lineAt(index) {
  return SRC.slice(0, index).split("\n").length;
}

describe("investor_positions.peak_price stays a high-water mark", () => {
  const selects = investorPositionSelects(CODE);
  const reads = peakPriceReads(CODE);

  it("finds the queries and the readers (guards against the regex rotting)", () => {
    expect(selects.length).toBeGreaterThan(5);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("every query pulling the trim-lane row shape carries peak_price", () => {
    // The trim lanes all consume the same row shape — cost basis, average
    // entry, the notes blob holding _mfe_extension_trim, and the open
    // timestamp for the minimum-hold gate. Any query assembling that shape
    // is feeding a lane that reasons about the peak, so it has to carry it.
    const offenders = [];
    for (const s of selects) {
      if (/(^|[\s,(])\*/.test(s.columns)) continue;
      const shaped = ["avg_entry", "cost_basis", "notes", "first_entry_ts"]
        .every(c => new RegExp(`\\b${c}\\b`).test(s.columns));
      if (!shaped || /\bpeak_price\b/.test(s.columns)) continue;
      offenders.push(`line ${lineAt(s.index)} selects: ${s.columns.slice(0, 200)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the auto-rebalance query that feeds the MFE extension lane carries it", () => {
    // Pin the specific regression: the trim-into-strength loop iterates
    // `existingPos`, so that SELECT in particular must not drop the column.
    const q = SRC.match(
      /const existingPos = \(await env\.DB\.prepare\(\s*"([^"]+)"/,
    );
    expect(q).toBeTruthy();
    expect(q[1]).toMatch(/\bpeak_price\b/);
    expect(q[1]).toMatch(/FROM investor_positions WHERE status = 'OPEN'/);
  });
});
