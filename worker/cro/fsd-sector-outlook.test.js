import { describe, it, expect } from "vitest";
import {
  FSD_SECTOR_OUTLOOK_AUG_2026,
  parseFsdSectorOutlookTable,
  parseFsdEtfOutlookHtml,
  buildSectorRatingsPatchFromOutlook,
  getAnalystSectorRating,
  compositeRatingFromOutlook,
  outlookFingerprint,
  assessSectorOutlookFreshness,
  isEtfOutlookPaywall,
} from "./fsd-sector-outlook.js";

const SAMPLE_HTML = `
<table>
<tr><td>Health Care</td><td>XLV</td><td>7.50%</td><td>9.50%</td><td>2.0%</td><td>N</td><td>OW</td></tr>
<tr><td>Financials</td><td>XLF</td><td>10.40%</td><td>13.40%</td><td>3.0%</td><td>OW</td><td>OW</td></tr>
</table>
`;

const PAYWALL_HTML = `<h1>Become a Member To Access Fundstrat Research</h1>`;

const PASTED_TABLE = `
Sector	ETF	S&P Weight	FSI Weight	Delta		
Health Care	XLV	7.50%	9.50%	2.0%	N	OW
Financials	XLF	10.40%	13.40%	3.0%	OW	OW
Energy	XLE	2.70%	0.70%	-2.0%	OW	UW
Consumer Staples	XLP	3.80%	0.30%	-3.5%	UW	UW
`;

describe("fsd-sector-outlook", () => {
  it("canonical August 2026 has Newton OW on Health Care", () => {
    const hc = FSD_SECTOR_OUTLOOK_AUG_2026.sectors["Health Care"];
    expect(hc.newton).toBe("overweight");
    expect(hc.lee).toBe("neutral");
    expect(hc.delta_pct).toBe(2.0);
  });

  it("parses pasted operator table rows", () => {
    const out = parseFsdSectorOutlookTable(PASTED_TABLE);
    expect(out.sectors["Health Care"].etf).toBe("XLV");
    expect(out.sectors["Health Care"].newton).toBe("overweight");
    expect(out.sectors["Financials"].lee).toBe("overweight");
    expect(out.sectors["Energy"].newton).toBe("underweight");
  });

  it("builds sector ratings patch with per-analyst fields", () => {
    const patch = buildSectorRatingsPatchFromOutlook(FSD_SECTOR_OUTLOOK_AUG_2026);
    expect(patch["Health Care"]).toMatchObject({
      rating: "overweight",
      delta: 2.0,
      lee_rating: "neutral",
      newton_rating: "overweight",
      etf: "XLV",
    });
    expect(patch.Energy.rating).toBe("underweight");
    expect(patch["Consumer Staples"].rating).toBe("underweight");
  });

  it("resolves analyst-specific rating lookup", () => {
    expect(getAnalystSectorRating(FSD_SECTOR_OUTLOOK_AUG_2026, "Health Care", "newton")).toBe("overweight");
    expect(getAnalystSectorRating(FSD_SECTOR_OUTLOOK_AUG_2026, "Health Care", "lee")).toBe("neutral");
    expect(getAnalystSectorRating(FSD_SECTOR_OUTLOOK_AUG_2026, "Energy", "newton")).toBe("underweight");
  });

  it("uses negative delta when strategists disagree (Energy, XLC)", () => {
    expect(compositeRatingFromOutlook(FSD_SECTOR_OUTLOOK_AUG_2026.sectors.Energy)).toBe("underweight");
    expect(compositeRatingFromOutlook(FSD_SECTOR_OUTLOOK_AUG_2026.sectors["Communication Services"])).toBe("underweight");
    expect(compositeRatingFromOutlook(FSD_SECTOR_OUTLOOK_AUG_2026.sectors.Industrials)).toBe("neutral");
  });

  it("parses authenticated HTML table rows", () => {
    const out = parseFsdEtfOutlookHtml(SAMPLE_HTML);
    expect(out.sectors["Health Care"].newton).toBe("overweight");
    expect(out.sectors.Financials.lee).toBe("overweight");
  });

  it("detects paywall shell without sector rows", () => {
    expect(isEtfOutlookPaywall(PAYWALL_HTML)).toBe(true);
    expect(isEtfOutlookPaywall(SAMPLE_HTML)).toBe(false);
  });

  it("fingerprints outlook for change detection", () => {
    const a = outlookFingerprint(FSD_SECTOR_OUTLOOK_AUG_2026);
    const b = outlookFingerprint(FSD_SECTOR_OUTLOOK_AUG_2026);
    expect(a).toBe(b);
    const mutated = {
      ...FSD_SECTOR_OUTLOOK_AUG_2026,
      sectors: {
        ...FSD_SECTOR_OUTLOOK_AUG_2026.sectors,
        "Health Care": { ...FSD_SECTOR_OUTLOOK_AUG_2026.sectors["Health Care"], newton: "neutral" },
      },
    };
    expect(outlookFingerprint(mutated)).not.toBe(a);
  });

  it("flags stale outlook older than 35 days", () => {
    const fresh = assessSectorOutlookFreshness({ generated_at: Date.now() - (10 * 24 * 60 * 60 * 1000) });
    const stale = assessSectorOutlookFreshness({ generated_at: Date.now() - (40 * 24 * 60 * 60 * 1000) });
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
  });
});
