import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dcaSweepShouldMarkClean } from "./investor-dca-sweep.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("dcaSweepShouldMarkClean", () => {
  it("does not mark clean when no lots are in the window yet", () => {
    expect(dcaSweepShouldMarkClean({
      ok: true,
      lots: 0,
      healed_count: 0,
      mirror_checked: true,
      catchup: null,
    })).toBe(false);
  });

  it("does not mark clean when catch-up never ran (mirror:false / off)", () => {
    expect(dcaSweepShouldMarkClean({
      ok: true,
      lots: 1,
      healed_count: 0,
      mirror_checked: true,
      catchup: null,
    })).toBe(false);
  });

  it("marks clean only after lots exist, nothing healed, and catch-up planned 0", () => {
    expect(dcaSweepShouldMarkClean({
      ok: true,
      lots: 1,
      healed_count: 0,
      mirror_checked: true,
      catchup: { planned: 0, forwarded_ok: 0, forwarded_fail: 0 },
    })).toBe(true);
  });

  it("keeps retrying when catch-up still has work or a failure", () => {
    expect(dcaSweepShouldMarkClean({
      ok: true,
      lots: 1,
      healed_count: 0,
      mirror_checked: true,
      catchup: { planned: 1, forwarded_ok: 0, forwarded_fail: 0 },
    })).toBe(false);
    expect(dcaSweepShouldMarkClean({
      ok: true,
      lots: 1,
      healed_count: 0,
      mirror_checked: true,
      catchup: { planned: 0, forwarded_fail: 1 },
    })).toBe(false);
  });
});

describe("DCA execute awaits the broker mirror (PLTR 2026-09-11)", () => {
  const src = readFileSync(join(__dirname, "index.js"), "utf8");
  const start = src.indexOf('routeKey === "POST /timed/investor/dca/execute"');
  const next = src.indexOf('routeKey === "', start + 10);
  const block = src.slice(start, next > start ? next : start + 12000);

  it("collects DCA mirrors and awaits them before the HTTP response", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/_dcaMirrorPs/);
    expect(block).toMatch(/await Promise\.all\(_dcaMirrorPs/);
    expect(block.indexOf("await Promise.all(_dcaMirrorPs")).toBeLessThan(block.indexOf("return sendJSON"));
  });
});

describe("DCA sweep uses dcaSweepShouldMarkClean", () => {
  const src = readFileSync(join(__dirname, "index.js"), "utf8");
  it("imports and applies the empty-window guard", () => {
    expect(src).toMatch(/dcaSweepShouldMarkClean/);
    expect(src).toMatch(/from "\.\/investor-dca-sweep\.js"/);
  });
});
