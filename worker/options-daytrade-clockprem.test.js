import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./index.js", import.meta.url)), "utf8");

/**
 * `[OPTIONS-ALL] day-trade build failed for SPY: _clockPrem is not defined`,
 * live on every pass since 2026-08-27.
 *
 * `_clockPrem` and `_clockBid` were declared with `let` inside the try block
 * that computes the option clock, but both are read further down — `_clockBid`
 * by the mirror block and `_clockPrem` by the `position:` IIFE inside the
 * `_dtPlays.push({...})` object literal. Both of those sit outside the try, so
 * every ticker holding an open day-trade book threw a ReferenceError while
 * building its card. The throw is caught by the outer per-ticker handler, so
 * the play was dropped and its tier was never recorded to the scorecard —
 * silent except for one warn line.
 */
describe("the options day-trade clock premium outlives its try block", () => {
  const decl = src.indexOf("                let _clockPrem = null;");
  const tryOpen = src.indexOf("                  const _clockFlavor = _dtUseCarry && _dtOpenBook?.flavor");
  const catchClose = src.indexOf("} catch (_clockErr) {");

  it("declares both bindings in the scope that outlives the clock try", () => {
    expect(decl).toBeGreaterThan(0);
    expect(src).toContain("                let _clockBid = null;");
    expect(tryOpen).toBeGreaterThan(decl);
  });

  it("assigns rather than re-declares them inside the try", () => {
    expect(src).toContain("                  _clockPrem = _estimatePrem;");
    expect(src).toContain("                  _clockBid = _dtPrimary?.premium?.bid ?? _dtPlay?.premium?.bid ?? null;");
    // A second `let` would shadow the outer binding and restore the bug.
    expect(src.match(/let _clockPrem\b/g)).toHaveLength(1);
    expect(src.match(/let _clockBid\b/g)).toHaveLength(1);
  });

  it("keeps every read that escapes the try after the catch", () => {
    expect(catchClose).toBeGreaterThan(tryOpen);
    const escaping = [
      "?? _clockBid",
      "last_premium: (Number(_clockPrem) > 0 ? Number(_clockPrem) : _dtOpenBook.last_premium),",
      "const lp = Number(_clockPrem) > 0 ? Number(_clockPrem) : Number(_dtOpenBook.last_premium);",
    ];
    for (const use of escaping) {
      const at = src.indexOf(use);
      expect(at, use).toBeGreaterThan(catchClose);
      expect(at, use).toBeGreaterThan(decl);
    }
  });

  it("guards every escaping read against the unset value", () => {
    // The bindings start null now instead of the estimate, so a clock that
    // throws before assigning must not produce a NaN premium downstream.
    expect(src).toContain("Number(_clockPrem) > 0 ? Number(_clockPrem) : _dtOpenBook.last_premium");
    expect(src).toContain("Number(_clockPrem) > 0 ? Number(_clockPrem) : 0");
    expect(src).toContain("const lp = Number(_clockPrem) > 0 ? Number(_clockPrem) : Number(_dtOpenBook.last_premium);");
    // `?? _clockBid` sits in a nullish chain that continues past it.
    expect(src).toContain("?? _clockBid\n                            ?? _dtPrimary?.premium?.bid");
  });
});
