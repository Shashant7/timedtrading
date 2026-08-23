import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("Today Cloud Desk plan copy", () => {
  const src = readFileSync(join(process.cwd(), "react-app/today.html"), "utf8");

  it("reads copy.role so SetupFamiliesStrip does not throw ReferenceError", () => {
    expect(src).toContain('title: copy.ticketNow');
    expect(src).toContain('copy.role === "fire"');
    expect(src).not.toMatch(/title:\s*role\s*===\s*"fire"/);
  });

  it("uses one call word and cover, not ENTER plus FIRE plus Lead", () => {
    expect(src).toContain("last cover $");
    expect(src).toContain("10m Cloud Desk");
    expect(src).toContain("Not the index options lean");
    expect(src).not.toMatch(/label:\s*"Lead"/);
    expect(src).not.toMatch(/deskRoleChipClass/);
    expect(src).not.toMatch(/String\(copy\.role \|\| "watch"\)\.toUpperCase\(\)/);
    expect(src).toContain("`cover $${magPx.toFixed(2)}`");
  });
});
