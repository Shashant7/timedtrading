import { describe, it, expect } from "vitest";
import { extractPdfLinksFromHtml } from "./fsd-client.js";

describe("extractPdfLinksFromHtml", () => {
  it("finds absolute and relative PDF hrefs", () => {
    const html = `
      <p>Please <a href="https://fundstratdirect.com/wp-content/uploads/2026/06/SectorAllocation.pdf">download</a></p>
      <a href="/files/report-v2.pdf?token=abc">alt</a>
    `;
    const links = extractPdfLinksFromHtml(html, "https://fundstratdirect.com");
    expect(links).toContain("https://fundstratdirect.com/wp-content/uploads/2026/06/SectorAllocation.pdf");
    expect(links).toContain("https://fundstratdirect.com/files/report-v2.pdf?token=abc");
  });

  it("dedupes repeated links", () => {
    const html = '<a href="/a.pdf">1</a><a href="/a.pdf">2</a>';
    expect(extractPdfLinksFromHtml(html, "https://example.com")).toEqual(["https://example.com/a.pdf"]);
  });
});
