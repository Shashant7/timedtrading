import { describe, it, expect } from "vitest";
import { horizonFromMode, horizonLabel, horizonPrefix, isLongTermHorizon } from "./horizon-labels.js";

describe("horizon-labels", () => {
  it("maps investor → long_term and trader → short_term", () => {
    expect(horizonFromMode("investor")).toBe("long_term");
    expect(horizonFromMode("trader")).toBe("short_term");
    expect(horizonFromMode("long_term")).toBe("long_term");
    expect(isLongTermHorizon("investor")).toBe(true);
  });

  it("formats user-facing labels", () => {
    expect(horizonLabel("trader")).toBe("Short Term");
    expect(horizonLabel("investor")).toBe("Long Term");
    expect(horizonLabel("investor", { upper: true })).toBe("LONG TERM");
    expect(horizonPrefix("trader")).toBe("SHORT TERM · ");
    expect(horizonPrefix("investor")).toBe("LONG TERM · ");
  });
});
