// worker/foundation/parity.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeParityReport, summarizeParity } from "./parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "golden-day-sample.json"), "utf-8"));

describe("parity: golden-day fixture (the format the baseline runner emits)", () => {
  it("reports IDENTICAL when live and replay match on the golden day", () => {
    const report = computeParityReport(golden.live, golden.replay, {
      fields: ["status", "value", "tier", "components.sector", "components.rs"],
    });
    expect(report.identical).toBe(true);
    expect(report.tickers_compared).toBe(3);
    expect(summarizeParity(report)).toMatch(/PARITY OK/);
  });

  it("detects the exact field that diverges (e.g. a gappy candle window shifting a component)", () => {
    const replay = JSON.parse(JSON.stringify(golden.replay));
    replay.NVDA.components.sector = 0; // simulate sector input that was stale live but fresh in replay
    replay.NVDA.value = 71;
    const report = computeParityReport(golden.live, replay, {
      fields: ["value", "components.sector"],
    });
    expect(report.identical).toBe(false);
    expect(report.summary.divergence_count).toBe(2);
    const fields = report.divergent.filter((d) => d.ticker === "NVDA").map((d) => d.field).sort();
    expect(fields).toEqual(["components.sector", "value"]);
    expect(summarizeParity(report)).toMatch(/PARITY DIVERGENCE/);
  });
});

describe("parity: core behavior", () => {
  it("honors numeric tolerance", () => {
    const a = { X: { value: 10.0 } };
    const b = { X: { value: 10.0004 } };
    expect(computeParityReport(a, b, { fields: ["value"], tolerance: 0.001 }).identical).toBe(true);
    expect(computeParityReport(a, b, { fields: ["value"], tolerance: 0 }).identical).toBe(false);
  });

  it("reports tickers present on only one side", () => {
    const live = { A: { value: 1 }, B: { value: 2 } };
    const replay = { A: { value: 1 }, C: { value: 3 } };
    const r = computeParityReport(live, replay, { fields: ["value"] });
    expect(r.only_in_live).toEqual(["B"]);
    expect(r.only_in_replay).toEqual(["C"]);
    expect(r.identical).toBe(false);
  });

  it("treats null/undefined as equal and matches strings exactly", () => {
    const live = { A: { tier: "B", note: null } };
    const replay = { A: { tier: "B" } };
    const r = computeParityReport(live, replay, { fields: ["tier", "note"] });
    expect(r.identical).toBe(true);
  });

  it("UNSCORABLE vs a number is a divergence (status field)", () => {
    const live = { A: { status: "UNSCORABLE", value: null } };
    const replay = { A: { status: "SCORABLE", value: 80 } };
    const r = computeParityReport(live, replay, { fields: ["status", "value"] });
    expect(r.summary.divergence_count).toBe(2);
  });
});
