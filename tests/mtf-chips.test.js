/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";

function loadMtfChips() {
  const src = readFileSync(resolve("react-app/shared-mtf-chips.js"), "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.TimedMtfChips;
}

describe("TimedMtfChips", () => {
  let MTF;
  beforeEach(() => {
    MTF = loadMtfChips();
  });

  it("reads 1H / D / 72 cloud directions with arrows", () => {
    const ticker = {
      tf_tech: {
        "1H": { ripster: { c34_50: { above: true, bull: true } } },
        D: {
          ripster: {
            c34_50: { below: true, bear: true },
            c72_89: { above: true, bull: true },
          },
        },
      },
    };
    const reads = MTF.readsForTicker(ticker);
    expect(reads.map((r) => r.label)).toEqual(["1H↑", "D↓", "72↑"]);
  });

  it("builds stack chip when majority agree", () => {
    const ticker = {
      tf_tech: {
        "1H": { ripster: { c34_50: { above: true } } },
        D: {
          ripster: {
            c34_50: { above: true },
            c72_89: { above: true },
          },
        },
      },
    };
    const chips = [];
    const h = (_tag, props, ...children) => {
      chips.push({ props, children });
      return { props, children };
    };
    MTF.buildChipElements("NVDA", h, { ticker, max: 4, stack: true });
    const labels = chips.map((c) => c.children[0]);
    expect(labels).toContain("MTF 3↑");
    expect(labels.some((l) => String(l).startsWith("1H"))).toBe(true);
  });

  it("returns empty when tf_tech missing", () => {
    expect(MTF.readsForTicker({})).toEqual([]);
    expect(MTF.readsForTicker(null)).toEqual([]);
  });
});
