import { describe, it, expect } from "vitest";
import {
  SECTOR_MAP,
  getSector,
  getTickerType,
  isUnknownSector,
  normalizeSectorLabel,
  pickTickerSector,
  stampResolvedSector,
} from "./sector-mapping.js";
import { TT_SELECTED_DEFAULT } from "./focus-tier.js";

describe("normalizeSectorLabel", () => {
  it("maps vendor / Granny labels onto GICS", () => {
    expect(normalizeSectorLabel("Technology")).toBe("Information Technology");
    expect(normalizeSectorLabel("Semiconductors")).toBe("Information Technology");
    expect(normalizeSectorLabel("Healthcare")).toBe("Health Care");
    expect(normalizeSectorLabel("Financial Services")).toBe("Financials");
    expect(normalizeSectorLabel("Retail")).toBe("Consumer Discretionary");
    expect(normalizeSectorLabel("Commodities")).toBe("Commodity ETF");
    expect(normalizeSectorLabel("Information Technology")).toBe("Information Technology");
  });

  it("rejects Unknown and empty labels", () => {
    expect(isUnknownSector("Unknown")).toBe(true);
    expect(normalizeSectorLabel("Unknown")).toBeNull();
    expect(normalizeSectorLabel("")).toBeNull();
    expect(normalizeSectorLabel("(none)")).toBeNull();
  });
});

describe("registry first-class sectors", () => {
  it("gives every live Uptick a GICS / ETF sleeve", () => {
    const missing = [...TT_SELECTED_DEFAULT].filter((t) => !getSector(t));
    expect(missing).toEqual([]);
  });

  it("covers the Sep 2026 blind names (DDOG/TEAM/ALL/DAL/DBA/FTNT)", () => {
    expect(getSector("DDOG")).toBe("Information Technology");
    expect(getSector("TEAM")).toBe("Information Technology");
    expect(getSector("ALL")).toBe("Financials");
    expect(getSector("DAL")).toBe("Industrials");
    expect(getSector("DBA")).toBe("Commodity ETF");
    expect(getSector("FTNT")).toBe("Information Technology");
    expect(getSector("CEG")).toBe("Utilities");
    expect(getSector("IRM")).toBe("Real Estate");
    expect(getSector("MRVL")).toBe("Information Technology");
    expect(SECTOR_MAP.ALL).toBe("Financials");
  });

  it("does not treat a map miss as a type of Unknown", () => {
    expect(getSector("ZZZZNOPE")).toBeNull();
    expect(getTickerType("FTNT")).toBe("growth");
    expect(getTickerType("DBA")).toBe("commodity_etf");
  });

  it("prefers a real GICS hint over a stale Unknown payload", () => {
    expect(pickTickerSector("NET", { payloadSector: "Unknown" })).toBe("Information Technology");
    const row = stampResolvedSector("CRDO", { sector: "Semiconductors", rank: 90 });
    expect(row.sector).toBe("Information Technology");
    expect(row._sector).toBe("Information Technology");
  });
});
