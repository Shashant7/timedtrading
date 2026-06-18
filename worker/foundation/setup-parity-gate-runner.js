// worker/foundation/setup-parity-gate-runner.js
// Node-side fixture parity (importable from scripts without worker env).

import { runParityFixture, validateParityFixture } from "./indicator-parity.js";

export async function runFixtureParityGate(fixtures = []) {
  const results = [];
  for (const fixture of fixtures) {
    const validation = validateParityFixture(fixture);
    if (!validation.ok) {
      results.push({
        ticker: fixture?.ticker,
        tf: fixture?.tf,
        ok: false,
        phase: "validation",
        errors: validation.errors,
      });
      continue;
    }
    const run = runParityFixture(fixture);
    results.push({
      ticker: fixture.ticker,
      tf: fixture.tf,
      ok: run.ok === true,
      phase: "parity",
      mismatches: run.mismatches || [],
      rows_checked: run.rows_checked || 0,
    });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    ok: results.length > 0 && passed === results.length,
    fixtures_checked: results.length,
    fixtures_passed: passed,
    results,
  };
}

export { runParityFixture, validateParityFixture };
