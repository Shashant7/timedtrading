// worker/foundation/score-contract.test.js
import { describe, it, expect } from "vitest";
import { isInputBad, evaluateScore } from "./score-contract.js";

const sumFormula = (inputs) => ({
  value: (inputs.a || 0) + (inputs.b || 0) + (inputs.sector || 0),
  components: { a: inputs.a, b: inputs.b, sector: inputs.sector },
});

describe("score-contract: isInputBad", () => {
  it("bad when unavailable or explicitly stale", () => {
    expect(isInputBad({ available: false })).toBe(true);
    expect(isInputBad({ available: true, stale: true })).toBe(true);
    expect(isInputBad(undefined)).toBe(true);
  });
  it("good when available and not stale", () => {
    expect(isInputBad({ available: true })).toBe(false);
    expect(isInputBad({ available: true, stale: false })).toBe(false);
  });
  it("derives staleness from age vs max_age_ms", () => {
    expect(isInputBad({ available: true, age_ms: 100, max_age_ms: 50 })).toBe(true);
    expect(isInputBad({ available: true, age_ms: 10, max_age_ms: 50 })).toBe(false);
  });
});

describe("score-contract: evaluateScore", () => {
  const inputs = { a: 1, b: 2, sector: 3 };

  it("SCORABLE when all inputs are fresh", () => {
    const r = evaluateScore({
      version: "score@1.0.0", formula: sumFormula, inputs,
      inputs_meta: { a: { available: true }, b: { available: true }, sector: { available: true } },
      critical: ["a", "b"],
    });
    expect(r.status).toBe("SCORABLE");
    expect(r.value).toBe(6);
    expect(r.missing_critical).toEqual([]);
    expect(r.degraded_inputs).toEqual([]);
  });

  it("UNSCORABLE (value null) when a CRITICAL input is missing — the core guarantee", () => {
    const r = evaluateScore({
      version: "score@1.0.0", formula: sumFormula, inputs,
      inputs_meta: { a: { available: true }, b: { available: false }, sector: { available: true } },
      critical: ["a", "b"],
    });
    expect(r.status).toBe("UNSCORABLE");
    expect(r.value).toBeNull();
    expect(r.missing_critical).toContain("b");
  });

  it("UNSCORABLE when a critical input is stale by age", () => {
    const r = evaluateScore({
      version: "score@1.0.0", formula: sumFormula, inputs,
      inputs_meta: { a: { available: true, age_ms: 999, max_age_ms: 100 }, b: { available: true } },
      critical: ["a"],
    });
    expect(r.status).toBe("UNSCORABLE");
    expect(r.missing_critical).toContain("a");
  });

  it("DEGRADED (value still emitted) when only a NON-critical input is bad", () => {
    const r = evaluateScore({
      version: "score@1.0.0", formula: sumFormula, inputs,
      inputs_meta: { a: { available: true }, b: { available: true }, sector: { available: false } },
      critical: ["a", "b"],
    });
    expect(r.status).toBe("DEGRADED");
    expect(r.value).toBe(6);
    expect(r.degraded_inputs).toContain("sector");
  });

  it("UNSCORABLE when the formula throws or returns non-finite", () => {
    const boom = evaluateScore({
      version: "v", formula: () => { throw new Error("nope"); }, inputs,
      inputs_meta: { a: { available: true } }, critical: ["a"],
    });
    expect(boom.status).toBe("UNSCORABLE");
    expect(boom.missing_critical[0]).toMatch(/formula_error:nope/);

    const nan = evaluateScore({
      version: "v", formula: () => ({ value: NaN }), inputs,
      inputs_meta: { a: { available: true } }, critical: ["a"],
    });
    expect(nan.status).toBe("UNSCORABLE");
    expect(nan.missing_critical).toContain("formula_returned_nonfinite");
  });
});
