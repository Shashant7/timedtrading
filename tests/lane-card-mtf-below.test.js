/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Scored universe lane card MTF row", () => {
  it("marks mtfBelow cards so the 118px cap cannot clip the chip row", () => {
    const src = readFileSync(resolve("react-app/shared-lane-card.js"), "utf8");
    expect(src).toContain("tt-lane-card--mtf-below");
    expect(src).toMatch(/mtfBelowClass.*mtfBelow/);
  });

  it("drops max-height on mtf-below cards and on the Today viewport lane", () => {
    const tokens = readFileSync(resolve("react-app/tt-tokens.css"), "utf8");
    expect(tokens).toMatch(/tt-lane-card--mtf-below[\s\S]*max-height:\s*none/);
    expect(tokens).toMatch(/tt-lane-card--mtf-below[\s\S]*padding-bottom:\s*10px/);
    expect(tokens).toMatch(/\.tt-lane-card__chiprow[\s\S]*overflow:\s*visible/);

    const today = readFileSync(resolve("react-app/today.html"), "utf8");
    expect(today).toMatch(/\.vp-lane \.ds-tickercard\.tt-lane-card[\s\S]*max-height:\s*none/);
    expect(today).toMatch(/\.vp-list \.ds-tickercard\.tt-lane-card[\s\S]*max-height:\s*none/);
  });
});
