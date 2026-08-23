import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("Today Cloud Desk PAPER chip", () => {
  it("reads copy.role so SetupFamiliesStrip does not throw ReferenceError", () => {
    const src = readFileSync(join(process.cwd(), "react-app/today.html"), "utf8");
    expect(src).toContain('title: copy.role === "fire" ? "Paper 0.1× sim + broker ticket"');
    expect(src).not.toMatch(/title:\s*role\s*===\s*"fire"/);
  });
});
