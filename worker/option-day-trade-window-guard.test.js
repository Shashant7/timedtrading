// Regression guard — 2026-09-22 index day-trade blackout.
//
// The monolith's per-minute cron gates the index day-trade dispatch on the
// options sell window. Commit 03b5b5d9c (2026-08-28) replaced the
// legitimately no-arg `isNyRegularMarketOpen()` with
// `isOptionsSellWindowEt()` but kept the no-arg call shape.
// `isOptionsSellWindowEt(undefined)` reached `new Date(NaN)` and threw
// RangeError out of Intl.DateTimeFormat.
//
// The gate sits in the bare body of `scheduled()`, so the throw aborted the
// whole tick. Cloudflare recorded 1,152 `scriptThrewException` invocations a
// day on timed-trading-ingest — exactly 4 of every 5 minutes — every day from
// 2026-08-28 until this was found on 2026-09-22, and the paper options book
// fired nothing in that window.
//
// Two independent guards below: the helpers tolerate a missing clock, and the
// cron gate is not allowed to reintroduce the no-arg call shape.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isOptionsSellWindowEt,
  isOptionsBuyWindowEt,
} from "./option-day-trade-plan.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Tue 2026-09-22 — a plain trading day, the session the blackout was found on.
const TUE_0900_ET = Date.parse("2026-09-22T09:00:00-04:00");
const TUE_0930_ET = Date.parse("2026-09-22T09:30:00-04:00");
const TUE_1430_ET = Date.parse("2026-09-22T14:30:00-04:00");
const TUE_1620_ET = Date.parse("2026-09-22T16:20:00-04:00");
const SAT_1430_ET = Date.parse("2026-09-26T14:30:00-04:00");

describe("options session windows survive a missing clock", () => {
  it("isOptionsSellWindowEt() with no argument does not throw", () => {
    expect(() => isOptionsSellWindowEt()).not.toThrow();
    expect(typeof isOptionsSellWindowEt()).toBe("boolean");
  });

  it("isOptionsBuyWindowEt() with no argument does not throw", () => {
    expect(() => isOptionsBuyWindowEt()).not.toThrow();
    expect(typeof isOptionsBuyWindowEt()).toBe("boolean");
  });

  it("the no-arg call means now, not an invalid date", () => {
    const now = Date.now();
    expect(isOptionsSellWindowEt()).toBe(isOptionsSellWindowEt(now));
    expect(isOptionsBuyWindowEt()).toBe(isOptionsBuyWindowEt(now));
  });

  it("an explicitly unusable timestamp is closed, not an exception", () => {
    for (const bad of [undefined, null, NaN, "", "not-a-date", {}]) {
      expect(() => isOptionsSellWindowEt(bad)).not.toThrow();
      expect(() => isOptionsBuyWindowEt(bad)).not.toThrow();
    }
    // An instant that cannot be read is in no window.
    for (const bad of [NaN, "not-a-date", {}]) {
      expect(isOptionsSellWindowEt(bad)).toBe(false);
      expect(isOptionsBuyWindowEt(bad)).toBe(false);
    }
    // null means "no clock given", same as omitting it.
    expect(isOptionsSellWindowEt(null)).toBe(isOptionsSellWindowEt());
  });

  it("still reports the real windows once given a clock", () => {
    expect(isOptionsSellWindowEt(TUE_0900_ET)).toBe(false); // premarket
    expect(isOptionsSellWindowEt(TUE_0930_ET)).toBe(true);  // sells open at the bell
    expect(isOptionsSellWindowEt(TUE_1430_ET)).toBe(true);
    expect(isOptionsSellWindowEt(TUE_1620_ET)).toBe(false); // past the 16:15 close
    expect(isOptionsSellWindowEt(SAT_1430_ET)).toBe(false); // weekend

    expect(isOptionsBuyWindowEt(TUE_0930_ET)).toBe(false);  // inside the open print
    expect(isOptionsBuyWindowEt(TUE_1430_ET)).toBe(true);
  });
});

describe("the */1 cron day-trade gate", () => {
  const src = readFileSync(join(HERE, "index.js"), "utf8");

  it("never calls the sell-window helper without a timestamp", () => {
    expect(src).not.toMatch(/_isOptionsSellWindowEt\(\s*\)/);
  });

  it("evaluates the gate behind a catch so a throw cannot kill the tick", () => {
    const gate = src.slice(
      src.indexOf("const _dtSellWindowOpen"),
      src.indexOf("const _dtSellWindowOpen") + 900,
    );
    expect(gate).toContain("_isOptionsSellWindowEt(Date.now())");
    expect(gate).toContain("catch");
  });
});
