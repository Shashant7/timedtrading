import { describe, it, expect } from "vitest";
import { formatEmailSetupName } from "../worker/email.js";

describe("formatEmailSetupName", () => {
  it("maps tt_n_test_support to TT Support Bounce (not Tt N Test Support)", () => {
    expect(formatEmailSetupName("tt_n_test_support")).toBe("TT Support Bounce");
    expect(formatEmailSetupName("TT Support Bounce")).toBe("TT Support Bounce");
    // Legacy title-case artifact normalizes back to the canonical label
    expect(formatEmailSetupName("Tt N Test Support")).toBe("TT Support Bounce");
  });

  it("never emits the Tt title-case artifact", () => {
    expect(formatEmailSetupName("tt_gap_reversal_long")).toBe("TT Gap Reversal (Long)");
    expect(formatEmailSetupName("tt_custom_path")).toMatch(/^TT /);
    expect(formatEmailSetupName("tt_custom_path")).not.toMatch(/\bTt\b/);
  });
});
