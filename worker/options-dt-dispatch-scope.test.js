// Contract: index day-trade paper/mirror dispatch must have a local
// queueBackground in the /timed/options/all handler. processTradeSimulation
// and investor rebalance each bind their own — calling the name from
// options/all without a local binding throws ReferenceError, the
// try/catch logs [OPTIONS-DT-PLAN], and BUY/TRIM/EXIT never persist.
// Same class of bug as the SATS investor exhaustion-trim miss (2026-06-02).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "index.js"), "utf8");

function handlerBlock(marker) {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("routeKey === \"", start + marker.length);
  return src.slice(start, next > start ? next : start + 20000);
}

describe("index day-trade dispatch scope", () => {
  it("binds queueBackground inside GET /timed/options/all", () => {
    const block = handlerBlock("routeKey === \"GET /timed/options/all\"");
    expect(block).toMatch(/const queueBackground = \(promise\) =>/);
    expect(block).toMatch(/_dtDispatchAllowed\) queueBackground\(_optDtNotifyPaper/);
    expect(block).toMatch(/queueBackground\(maybeAutoMirrorIndexDayTradeEvent/);
    expect(block).toMatch(/queueBackground\(\(async \(\) => \{/);
  });

  it("runs the */1 day-trade lane through the options sell window (not RTH-only)", () => {
    const idx = src.indexOf("1-minute index day-trade dispatch");
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 1800);
    expect(slice).toMatch(/_isOptionsSellWindowEt\(/);
    expect(slice).toMatch(/dt_only=1/);
  });
});
