import { describe, it, expect } from "vitest";
import { buildInvestorRebalanceDiscordEmbed } from "./email.js";

describe("buildInvestorRebalanceDiscordEmbed", () => {
  it("routes full closes to EXITED, not TRIMMED", () => {
    const embed = buildInvestorRebalanceDiscordEmbed({
      trims: [
        {
          ticker: "AMD",
          shares: 10,
          price: 120,
          pnl: -50,
          remaining: 0,
          closed: true,
          reason: "PRIMARY_INVALIDATION_BREACH",
          invalidation_price: 125,
          executed_at: Date.UTC(2026, 6, 1, 15, 2, 0),
          cio_reasoning: "Thesis broken below weekly floor.",
        },
        {
          ticker: "NBIS",
          shares: 5,
          price: 40,
          pnl: 10,
          remaining: 15,
          closed: false,
          reason: "auto_reduce",
        },
      ],
    });
    expect(embed).not.toBeNull();
    expect(embed.title).toContain("1 exited");
    expect(embed.title).toContain("1 trimmed");
    const exitField = embed.fields.find((f) => f.name.includes("EXITED"));
    const trimField = embed.fields.find((f) => f.name.includes("TRIMMED"));
    expect(exitField?.value).toContain("AMD");
    expect(exitField?.value).toContain("EXITED");
    expect(exitField?.value).toContain("sold 10 sh");
    expect(exitField?.value).toContain("floor $125.00");
    expect(trimField?.value).toContain("NBIS");
    expect(trimField?.value).toContain("TRIMMED");
    expect(embed.fields.some((f) => f.name.includes("AMD — AI CIO"))).toBe(true);
  });

  it("classifies remaining=0 as exit even without closed flag", () => {
    const embed = buildInvestorRebalanceDiscordEmbed({
      trims: [{ ticker: "FIX", shares: 8, price: 500, remaining: 0, reason: "PRIMARY_INVALIDATION_BREACH" }],
    });
    expect(embed.title).toContain("1 exited");
    expect(embed.fields.some((f) => f.name.includes("EXITED"))).toBe(true);
    expect(embed.fields.some((f) => f.name.includes("TRIMMED"))).toBe(false);
  });
});
