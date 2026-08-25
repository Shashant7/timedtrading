import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseFsdGicsSectorPage,
  parseFsdGicsSectorHtml,
  diffSectorMaps,
  normalizeFsdSectorName,
  FSD_TO_TT_SECTOR,
} from "./fsd-gics-sectors.js";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/fsd-gics-sector-snippet.txt"),
  "utf8",
);
const HTML_FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/fsd-gics-sector-html-snippet.html"),
  "utf8",
);

describe("parseFsdGicsSectorPage", () => {
  it("parses GICS sector headers, ETFs, and ticker tables", () => {
    const out = parseFsdGicsSectorPage(FIXTURE);
    expect(out.stats.sector_count).toBe(2);
    expect(out.sectors["Health Care"].etf).toBe("XLV");
    expect(out.sectors["Health Care"].tt_sector).toBe("Health Care");
    expect(out.sectors["Health Care"].tickers).toEqual(expect.arrayContaining(["LLY", "MRK"]));
    expect(out.tickerToSector.LLY).toBe("Health Care");
    expect(out.tickerToEtf.XOM).toBe("XLE");
  });

  it("parses live FSD HTML anchor blocks with Yahoo quote tickers", () => {
    const out = parseFsdGicsSectorHtml(HTML_FIXTURE);
    expect(out.sectors["Health Care"].etf).toBe("XLV");
    expect(out.sectors["Health Care"].tickers).toEqual(expect.arrayContaining(["LLY", "MRK"]));
    expect(out.sectors.Energy.tickers).toContain("XOM");
  });

  it("maps Materials → Basic Materials for TT taxonomy", () => {
    expect(normalizeFsdSectorName("Materials")).toBe("Basic Materials");
    expect(FSD_TO_TT_SECTOR.Materials).toBe("Basic Materials");
  });
});

describe("diffSectorMaps", () => {
  it("flags tickers missing from our curated map", () => {
    const fsd = { LLY: "Health Care", XOM: "Energy", MRK: "Health Care" };
    const ours = { LLY: "Health Care" };
    const diff = diffSectorMaps(fsd, ours);
    expect(diff.missing_from_ours).toContain("XOM");
    expect(diff.missing_from_ours).toContain("MRK");
    expect(diff.extra_in_ours).toHaveLength(0);
  });

  it("flags sector mismatches when ours uses non-GICS buckets", () => {
    const fsd = { UNH: "Health Care", AMZN: "Consumer Discretionary" };
    const ours = { UNH: "value", AMZN: "large_cap" };
    const diff = diffSectorMaps(fsd, ours);
    expect(diff.mismatches).toEqual(expect.arrayContaining([
      { ticker: "UNH", fsd: "Health Care", ours: "value" },
      { ticker: "AMZN", fsd: "Consumer Discretionary", ours: "large_cap" },
    ]));
  });
});
