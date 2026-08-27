import { describe, it, expect } from "vitest";
import {
  classifyWebullFractError,
  roundToWholeShares,
  adaptWebullEquityQtyForSession,
  ensureWebullEthOrderFields,
  isNyRegularSession,
} from "./bridge-webull-fract.js";

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
    expect(r.isFractHoursError).toBe(false);
  });

  it("detects fractional-outside-RTH hours reject (AMAT ETH 2026-07-30)", () => {
    const r = classifyWebullFractError({
      ok: false,
      error: "You cannot place fractional share orders at this moment. Fractional shares trading is only available during regular trading hours: 9:30 a.m. - 4:00 p.m. ET (Business Day).",
    });
    expect(r.isFractHoursError).toBe(true);
    expect(r.isFractAgreementError).toBe(false);
    expect(r.errorCode).toBe("FRACTIONAL_OUTSIDE_RTH");
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

describe("adaptWebullEquityQtyForSession", () => {
  const ah = new Date("2026-08-27T16:53:00-04:00");
  const rth = new Date("2026-08-27T14:00:00-04:00");

  it("floors a fractional AH trim so 1.359 TSLA still sells 1 share", () => {
    const r = adaptWebullEquityQtyForSession({ qty: 1.359, session: "ALL", now: ah });
    expect(r).toMatchObject({ qty: 1, adapted: true, deferred: false });
  });

  it("defers a leftover under 1 share until RTH", () => {
    const r = adaptWebullEquityQtyForSession({ qty: 0.42, session: "ALL", now: ah });
    expect(r.deferred).toBe(true);
    expect(r.qty).toBe(0);
    expect(r.reason).toBe("fractional_trim_deferred_to_rth");
  });

  it("leaves fractionals alone during RTH with CORE session", () => {
    const r = adaptWebullEquityQtyForSession({ qty: 1.359, session: "CORE", now: rth });
    expect(r).toMatchObject({ qty: 1.359, adapted: false, deferred: false });
  });

  it("floors when the clock is after 16:00 ET even if session was omitted", () => {
    const r = adaptWebullEquityQtyForSession({ qty: 1.359, now: ah });
    expect(r.qty).toBe(1);
    expect(r.adapted).toBe(true);
  });
});

describe("ensureWebullEthOrderFields", () => {
  const ah = new Date("2026-08-27T16:14:00-04:00");

  it("fills LIMIT+ALL+GTC for an AH sell missing session fields", () => {
    const r = ensureWebullEthOrderFields({ side: "trim", entry: 354.66, qty: 1 }, ah);
    expect(r.order_type).toBe("limit");
    expect(r.support_trading_session).toBe("ALL");
    expect(r.tif).toBe("GTC");
    expect(r.limit_price).toBeLessThan(354.66);
  });

  it("does not rewrite during RTH", () => {
    const order = { side: "trim", entry: 354.66, qty: 1 };
    expect(ensureWebullEthOrderFields(order, new Date("2026-08-27T14:00:00-04:00"))).toBe(order);
  });
});

describe("isNyRegularSession", () => {
  it("is open at 2pm ET weekday and closed at 4:14pm ET", () => {
    expect(isNyRegularSession(new Date("2026-08-27T14:00:00-04:00"))).toBe(true);
    expect(isNyRegularSession(new Date("2026-08-27T16:14:00-04:00"))).toBe(false);
  });
});
