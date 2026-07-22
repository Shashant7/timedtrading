import { describe, it, expect } from "vitest";
import { classifyWebullFractError, roundToWholeShares } from "./bridge-webull-fract.js";

describe("classifyWebullFractError — live HALO/RPG/RTX repro", () => {
  it("detects the exact error_code from the live HALO 2026-07-22 response", () => {
    const r = classifyWebullFractError({
      ok: false,
      response: {
        error_code: "OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE",
        message: "https://sp.webull.com/agreement/third-party?bizTypes=TRADE_FRACT_PRO&secAccountId=28050567&hl=en",
      },
    });
    expect(r.isFractAgreementError).toBe(true);
    expect(r.errorCode).toBe("OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE");
    expect(r.agreementUrl).toBe("https://sp.webull.com/agreement/third-party?bizTypes=TRADE_FRACT_PRO&secAccountId=28050567&hl=en");
  });

  it("also detects via the message hint alone when error_code is elided", () => {
    const r = classifyWebullFractError({
      ok: false,
      response: { message: "See https://sp.webull.com/agreement/third-party?bizTypes=TRADE_FRACT_PRO&secAccountId=X" },
    });
    expect(r.isFractAgreementError).toBe(true);
    expect(r.agreementUrl).toContain("TRADE_FRACT_PRO");
  });

  it("does NOT match unrelated Webull errors (INSUFFICIENT_BUYING_POWER etc)", () => {
    const r = classifyWebullFractError({
      ok: false,
      response: { error_code: "INSUFFICIENT_BUYING_POWER", message: "buying power too low" },
    });
    expect(r.isFractAgreementError).toBe(false);
  });

  it("does NOT match a successful place (ok:true)", () => {
    expect(classifyWebullFractError({ ok: true, response: {} }).isFractAgreementError).toBe(false);
  });

  it("does NOT match a missing response object", () => {
    expect(classifyWebullFractError({ ok: false }).isFractAgreementError).toBe(false);
    expect(classifyWebullFractError(null).isFractAgreementError).toBe(false);
  });
});

describe("roundToWholeShares", () => {
  it("rounds DOWN so we never over-buy", () => {
    expect(roundToWholeShares(6.9060)).toBe(6);    // HALO
    expect(roundToWholeShares(5.58)).toBe(5);      // RTX (scaled)
    expect(roundToWholeShares(2.44024)).toBe(2);   // ETN (scaled)
    expect(roundToWholeShares(0.99)).toBe(0);      // sub-share → skip
  });
  it("returns 0 for non-positive / invalid input", () => {
    expect(roundToWholeShares(0)).toBe(0);
    expect(roundToWholeShares(-1)).toBe(0);
    expect(roundToWholeShares(NaN)).toBe(0);
    expect(roundToWholeShares(null)).toBe(0);
  });
  it("passes through when already whole", () => {
    expect(roundToWholeShares(7)).toBe(7);
    expect(roundToWholeShares(100)).toBe(100);
  });
});
