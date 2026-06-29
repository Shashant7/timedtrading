import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sanitySweepSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../worker/sanity-sweep.js"),
  "utf8",
);

describe("sanity sweep discord routing", () => {
  it("uses notifyDiscord system lane, not trade webhook fetch", () => {
    expect(sanitySweepSrc).toContain('notifyDiscord(env,');
    expect(sanitySweepSrc).toContain('"system"');
    expect(sanitySweepSrc).not.toMatch(/DISCORD_WEBHOOK_URL.*sanity/i);
    expect(sanitySweepSrc).not.toContain("fetch(webhook,");
  });

  it("candle_freshness_open uses calendar-aware open-position evaluation", () => {
    expect(sanitySweepSrc).toContain("evaluateOpenPositionCandleMap");
    expect(sanitySweepSrc).toContain("computeMarketSessionReference");
    expect(sanitySweepSrc).not.toContain("staleThresholdMs");
  });
});
