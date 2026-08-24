import { describe, it, expect } from "vitest";
import { buildListPresets, MAG7_TICKERS } from "../worker/list-presets.js";

describe("list-presets", () => {
  it("builds Ripster-style presets with expected ids", () => {
    const presets = buildListPresets();
    const ids = presets.map((p) => p.id);
    expect(ids).toEqual(["mag7", "ai_ecosystem", "cybersecurity", "saas_cloud"]);
  });

  it("MAG7 preset matches static cohort", () => {
    const mag7 = buildListPresets().find((p) => p.id === "mag7");
    expect(mag7?.tickers).toEqual(MAG7_TICKERS);
    expect(mag7?.tickers).toContain("NVDA");
  });

  it("cybersecurity preset includes CRWD and ZS", () => {
    const sec = buildListPresets().find((p) => p.id === "cybersecurity");
    expect(sec?.tickers).toContain("CRWD");
    expect(sec?.tickers).toContain("ZS");
  });

  it("saas_cloud matches ai_software theme members", () => {
    const saas = buildListPresets().find((p) => p.id === "saas_cloud");
    expect(saas?.tickers).toContain("PLTR");
    expect(saas?.tickers).toContain("SNOW");
  });
});
