import { describe, it, expect } from "vitest";
import { formatTvLevelsCompact } from "./tv-levels.js";

describe("tv-levels compact format", () => {
  it("formatTvLevelsCompact encodes universe, bias, stop, targets, levels", () => {
    const compact = formatTvLevelsCompact({
      in_universe: true,
      direction: "LONG",
      bias: "BULL_PULLBACK",
      stage: "setup",
      rank: 68,
      stop: 178.5,
      tp_trim: 195,
      tp_exit: 200,
      tp_runner: 208,
      levels: [
        { price: 192.3, label: "Swing High", role: "resistance" },
        { price: 185.1, label: "Support", role: "support" },
      ],
    });
    expect(compact.startsWith("TTV1|1|LONG|BULL_PULLBACK|setup|68|178.5|195|200|208|")).toBe(true);
    expect(compact).toContain("192.3:Swing High:R");
    expect(compact).toContain("185.1:Support:S");
  });
});
