import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SECTOR_MAP } from "./sector-mapping.js";
import { TT_SELECTED_DEFAULT } from "./focus-tier.js";
import {
  diffRegistryAlignment,
  evaluateRegistryAlignment,
  filterTickersNeedingValidation,
  healUnknownSectorMapKeys,
  shouldSkipSymbolValidation,
} from "./registry-alignment.js";

const SEP_2026_UPTICKS = [
  "ALL", "AMGN", "AMZN", "APLD", "BA", "BABA", "BG", "BRK-B", "CRS", "CRWV",
  "CSX", "CVX", "DAL", "DBA", "DDOG", "ETHA", "GEV", "GOOGL", "GS", "JCI",
  "LITE", "MRK", "NVDA", "PH", "PWR", "TSLA", "WMT",
];

describe("shouldSkipSymbolValidation", () => {
  it("skips futures, mapped ETFs, Selected, and live Upticks", () => {
    expect(shouldSkipSymbolValidation("ES1!", { sectorMap: {} })).toBe(true);
    expect(shouldSkipSymbolValidation("DBA", { sectorMap: SECTOR_MAP })).toBe(true);
    expect(shouldSkipSymbolValidation("DDOG", { ttSelected: TT_SELECTED_DEFAULT })).toBe(true);
    expect(shouldSkipSymbolValidation("DBA", { liveUpticks: ["dba"] })).toBe(true);
  });

  it("still validates an unknown equity", () => {
    expect(shouldSkipSymbolValidation("ZZZZNOPE", {
      sectorMap: SECTOR_MAP,
      ttSelected: TT_SELECTED_DEFAULT,
      liveUpticks: SEP_2026_UPTICKS,
    })).toBe(false);
  });

  it("filters the watchlist validation set", () => {
    expect(filterTickersNeedingValidation(
      ["DBA", "ZZZZNOPE", "ES1!"],
      { sectorMap: SECTOR_MAP, liveUpticks: SEP_2026_UPTICKS },
    )).toEqual(["ZZZZNOPE"]);
  });
});

describe("diffRegistryAlignment", () => {
  it("fails when a live Uptick is still on timed:removed (DBA)", () => {
    const diff = diffRegistryAlignment({
      liveUpticks: SEP_2026_UPTICKS,
      ttSelected: [...TT_SELECTED_DEFAULT],
      sectorMapKeys: Object.keys(SECTOR_MAP),
      indexTickers: SEP_2026_UPTICKS.filter((t) => t !== "DBA"),
      removed: ["DBA"],
    });
    expect(diff.ok).toBe(false);
    expect(diff.upticks_on_removed).toEqual(["DBA"]);
    expect(diff.upticks_missing_index).toEqual(["DBA"]);
    const anomalies = evaluateRegistryAlignment(diff);
    expect(anomalies.some((a) => a.ticker === "DBA" && a.severity === "fail")).toBe(true);
  });

  it("fails when live KV drifted from TT_SELECTED_DEFAULT (DDOG)", () => {
    const august = SEP_2026_UPTICKS.filter((t) => !["DDOG", "LITE", "NVDA"].includes(t))
      .concat(["IRM", "MAR", "VLO", "VST"]);
    const diff = diffRegistryAlignment({
      liveUpticks: SEP_2026_UPTICKS,
      ttSelected: august,
      sectorMapKeys: Object.keys(SECTOR_MAP),
      indexTickers: SEP_2026_UPTICKS,
      removed: [],
    });
    expect(diff.ok).toBe(false);
    expect(diff.live_not_in_selected).toEqual(["DDOG", "LITE", "NVDA"]);
    expect(diff.selected_not_live).toEqual(["IRM", "MAR", "VLO", "VST"]);
  });

  it("passes the Sep 2026 aligned book", () => {
    const diff = diffRegistryAlignment({
      liveUpticks: SEP_2026_UPTICKS,
      ttSelected: [...TT_SELECTED_DEFAULT],
      sectorMapKeys: Object.keys(SECTOR_MAP),
      indexTickers: SEP_2026_UPTICKS,
      removed: [],
    });
    expect(diff.ok).toBe(true);
    expect(diff.upticks_missing_gics).toEqual([]);
    expect(evaluateRegistryAlignment(diff)).toEqual([]);
  });

  it("does not fail pulse futures missing from the equity map", () => {
    const diff = diffRegistryAlignment({
      liveUpticks: [],
      ttSelected: [],
      sectorMapKeys: ["AAPL"],
      indexTickers: ["AAPL", "ES1!"],
      removed: [],
    });
    expect(diff.ok).toBe(true);
    expect(diff.missing_gics).toEqual([]);
  });
});

describe("worker wiring", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(root, "index.js"), "utf8");

  it("aliases the file sector map and wires the admin + conviction paths", () => {
    expect(index).toContain("const SECTOR_MAP = SECTOR_MAP_FILE;");
    expect(index).toContain("GET /timed/admin/registry-alignment");
    expect(index).toContain("planRegistryReactivation");
    expect(index).toContain("stampFocusConvictionOnTicker");
    expect(index).toContain("shouldSkipSymbolValidation");
    expect(index).toContain("same_object: SECTOR_MAP === SECTOR_MAP_FILE");
    expect(index).not.toContain('KWEB: "Consumer Discretionary"');
    expect(index).not.toContain("__sectorMapAudit");
  });
});

describe("healUnknownSectorMapKeys", () => {
  it("deletes Unknown overlays and keeps real GICS", async () => {
    const store = {
      "timed:sector_map:TEAM": "Unknown",
      "timed:sector_map:AAPL": "Information Technology",
    };
    const kv = {
      get: async (key) => store[key] ?? null,
      delete: async (key) => { delete store[key]; },
    };
    const healed = await healUnknownSectorMapKeys(kv, ["TEAM", "AAPL"]);
    expect(healed).toEqual(["TEAM"]);
    expect(store["timed:sector_map:TEAM"]).toBeUndefined();
    expect(store["timed:sector_map:AAPL"]).toBe("Information Technology");
  });
});
