import { describe, it, expect } from "vitest";
import {
  buildInvestorRebalanceDiscordEmbed,
  buildInvestorRebalanceDigestBody,
} from "./email.js";

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

  it("classifies total_shares_after=0 as exit when remaining missing", () => {
    const embed = buildInvestorRebalanceDiscordEmbed({
      trims: [{
        ticker: "IESC",
        shares: 7.16,
        price: 681.71,
        total_shares_after: 0,
        reason: "auto_reduce",
        stageReason: "primary_invalidation_breach",
      }],
    });
    expect(embed.title).toContain("1 exited");
    expect(embed.fields.some((f) => f.name.includes("EXITED"))).toBe(true);
  });
});

describe("buildInvestorRebalanceDigestBody", () => {
  const baseUrl = "https://timed-trading.com";

  it("puts full exits in EXITED section with correct labels and thesis", () => {
    const { bodyHtml, headlineBits, closes, trims } = buildInvestorRebalanceDigestBody({
      trims: [
        {
          ticker: "IESC",
          shares: 7.16,
          price: 681.71,
          remaining: 0,
          reason: "PRIMARY_INVALIDATION_BREACH",
          invalidation_price: 700,
          score: 0,
          stage: "exited",
          executed_at: Date.UTC(2026, 6, 2, 16, 1, 0),
        },
        {
          ticker: "NBIS",
          shares: 5,
          price: 40,
          remaining: 12,
          reason: "auto_reduce",
          score: 42,
          stage: "reduce",
        },
      ],
    }, baseUrl);

    expect(headlineBits).toEqual(["1 exited", "1 trimmed/reduced"]);
    expect(closes).toHaveLength(1);
    expect(trims).toHaveLength(1);
    expect(bodyHtml).toContain("EXITED — FULL CLOSE");
    expect(bodyHtml).toContain("FULL EXIT");
    expect(bodyHtml).toContain("Position closed — 0 sh remaining");
    expect(bodyHtml).toContain("Model closed the position — no longer held");
    expect(bodyHtml).toContain("TRIMMED / REDUCED");
    expect(bodyHtml).toContain("TRIM / REDUCE");
    expect(bodyHtml).toContain("Model trimmed part of the position");
  });

  it("reclassifies remaining=0 mislabeled trims as full exits in the card", () => {
    const { bodyHtml } = buildInvestorRebalanceDigestBody({
      trims: [{
        ticker: "IONQ",
        shares: 94.5,
        price: 49.95,
        total_shares_after: 0,
        reason: "auto_reduce",
        stageReason: "primary_invalidation_breach",
        score: 0,
      }],
    }, baseUrl);

    expect(bodyHtml).toContain("EXITED — FULL CLOSE");
    expect(bodyHtml).toContain("FULL EXIT");
    expect(bodyHtml).toContain("Full exit — invalidation floor breached");
    expect(bodyHtml).not.toContain("TRIMMED / REDUCED");
  });

  it("annotates chart URL with execution price and cache bust", () => {
    const execAt = Date.UTC(2026, 6, 2, 16, 1, 0);
    const { bodyHtml } = buildInvestorRebalanceDigestBody({
      trims: [{
        ticker: "IESC",
        shares: 7.16,
        price: 681.71,
        remaining: 0,
        closed: true,
        invalidation_price: 700,
        executed_at: execAt,
        reason: "PRIMARY_INVALIDATION_BREACH",
      }],
    }, baseUrl);

    expect(bodyHtml).toContain("entry=681.71");
    expect(bodyHtml).toContain("sl=700");
    expect(bodyHtml).toContain(`v=${Math.floor(execAt)}`);
    expect(bodyHtml).toContain("subtitle=EXIT");
  });
});
