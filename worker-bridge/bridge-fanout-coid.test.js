// worker-bridge/bridge-fanout-coid.test.js
//
// The equity fan-out cut every client_order_id to 28 characters before
// adding the account suffix. Short Term trims are `tt-trim-<trade>-<pct>`,
// so the 50% and 75% trims of one trade became the same id in every account
// and the bridge's claim deduped the second one: it was never placed.

import { describe, it, expect } from "vitest";
import { fanoutClientOrderIdBase } from "./bridge-index.js";

const TRADE = "LULU-1788548997766-jrn7wqw5u";

describe("fanoutClientOrderIdBase", () => {
  it("keeps the two trims of one trade apart", () => {
    const fifty = fanoutClientOrderIdBase(`tt-trim-${TRADE}-50`);
    const seventyFive = fanoutClientOrderIdBase(`tt-trim-${TRADE}-75`);
    expect(fifty).not.toBe(seventyFive);
  });

  it("would have collided under the old 28-character cut (the defect)", () => {
    expect(`tt-trim-${TRADE}-50`.slice(0, 28)).toBe(`tt-trim-${TRADE}-75`.slice(0, 28));
  });

  it("is deterministic, so a re-fire still dedupes", () => {
    expect(fanoutClientOrderIdBase(`tt-trim-${TRADE}-50`)).toBe(fanoutClientOrderIdBase(`tt-trim-${TRADE}-50`));
  });

  it("fits the 28 characters left for the account suffix", () => {
    const base = fanoutClientOrderIdBase(`tt-trim-${TRADE}-50`);
    expect(base.length).toBeLessThanOrEqual(28);
    expect(`${base}-ACC12345`.length).toBeLessThanOrEqual(40);
    expect(base.startsWith("tt-trim-")).toBe(true);
  });

  it("leaves an id that already fits unchanged", () => {
    expect(fanoutClientOrderIdBase("tt-entry-ABC-123")).toBe("tt-entry-ABC-123");
    expect(fanoutClientOrderIdBase("tt-lt-trim-9f2c1a7e")).toBe("tt-lt-trim-9f2c1a7e");
  });

  it("strips characters Webull refuses", () => {
    expect(fanoutClientOrderIdBase("tt:exit/ABC")).toBe("ttexitABC");
  });
});
