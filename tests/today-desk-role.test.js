import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("Today Cloud Desk plan copy", () => {
  const src = readFileSync(join(process.cwd(), "react-app/today.html"), "utf8");

  it("does not use an undeclared role in the desk card map", () => {
    expect(src).toContain("cloudDeskPlanCopy");
    expect(src).toContain("copy.action");
    expect(src).not.toMatch(/title:\s*role\s*===\s*"fire"/);
    expect(src).not.toMatch(/title:\s*copy\.ticketNow/);
  });

  it("uses one call word and an INV/PB/TGT progress bar, not ENTER plus FIRE plus Lead", () => {
    expect(src).toContain("Monthly 21 EMA");
    expect(src).toContain("last cover, already behind");
    expect(src).toContain("10m Cloud Desk");
    expect(src).toContain("Not the index options lean");
    expect(src).toContain("deskCoverProgressBar");
    expect(src).toContain('label: "INV"');
    expect(src).toContain('label: "PB"');
    expect(src).toContain('label: "TGT"');
    expect(src).not.toContain('label: "LAST"');
    expect(src).not.toContain('label: "COVER"');
    expect(src).not.toMatch(/label:\s*"Lead"/);
    expect(src).not.toMatch(/deskRoleChipClass/);
    expect(src).not.toMatch(/String\(copy\.role \|\| "watch"\)\.toUpperCase\(\)/);
    expect(src).not.toContain("`cover $${nextPx.toFixed(2)}`");
    expect(src).not.toContain("`last $${lastPx.toFixed(2)}`");
  });

  it("keeps Today universe chips to the key call only", () => {
    expect(src).not.toMatch(/key:\s*"flat"/);
    expect(src).not.toMatch(/key:\s*"lean"/);
    expect(src).not.toMatch(/"Day-trade"/);
    expect(src).not.toMatch(/Lean \$\{p\.day_lean\}/);
    expect(src).not.toMatch(/isMoon \? "MOONSHOT" : "LOTTO"/);
    expect(src).toContain("height: 260px");
    expect(src).toContain(".tt-universe-panel .tt-strip-card .tt-lane-card__ext { display: none; }");
    expect(src).not.toContain("Paper 0.1");
    expect(src).toContain("stripCallChips");
    expect(src).toContain("CONFIRM-STACK");
  });
});
