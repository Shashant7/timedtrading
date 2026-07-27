// worker/stripe-vip-code.test.js
//
// 2026-07-27 — Coverage for the checkout-time VIP promo-code
// detection. Bug: a user pasted a VIP code at checkout and the
// webhook handler set tier='pro' anyway because it never looked at
// the applied promotion_code — operator flipped by hand.

import { describe, it, expect, vi } from "vitest";
import {
  extractSubscriptionPromoCode,
  lookupVipCodeRow,
  resolveCheckoutTierGrant,
} from "./stripe-vip-code.js";

describe("extractSubscriptionPromoCode — accepts both Stripe shapes", () => {
  it("returns {} when the subscription has no discount / discounts", () => {
    expect(extractSubscriptionPromoCode({})).toEqual({});
    expect(extractSubscriptionPromoCode(null)).toEqual({});
    expect(extractSubscriptionPromoCode({ discount: null, discounts: [] })).toEqual({});
  });

  it("legacy shape: discount.promotion_code = string id", () => {
    expect(extractSubscriptionPromoCode({
      discount: { promotion_code: "promo_ABC" },
    })).toEqual({ promoId: "promo_ABC" });
  });

  it("legacy shape: discount.promotion_code = expanded object (id + code)", () => {
    expect(extractSubscriptionPromoCode({
      discount: { promotion_code: { id: "promo_ABC", code: "VIP123" } },
    })).toEqual({ promoId: "promo_ABC", code: "VIP123" });
  });

  it("newer shape: discounts[0].promotion_code = expanded object", () => {
    expect(extractSubscriptionPromoCode({
      discounts: [{ promotion_code: { id: "promo_XYZ", code: "SUMMER" } }],
    })).toEqual({ promoId: "promo_XYZ", code: "SUMMER" });
  });

  it("newer shape: discounts[0].promotion_code = string id (unexpanded)", () => {
    expect(extractSubscriptionPromoCode({
      discounts: [{ promotion_code: "promo_QRS" }],
    })).toEqual({ promoId: "promo_QRS" });
  });

  it("returns the first non-empty bucket when both shapes exist (idempotent read)", () => {
    expect(extractSubscriptionPromoCode({
      discount: { promotion_code: "promo_LEGACY" },
      discounts: [{ promotion_code: "promo_NEW" }],
    })).toEqual({ promoId: "promo_LEGACY" });
  });

  it("skips buckets with no promotion_code", () => {
    // Third discount is the first with a real promotion_code — extract yields
    // { promoId: null, code: 'VIP7' } (id absent on the expanded object).
    expect(extractSubscriptionPromoCode({
      discounts: [{}, { promotion_code: null }, { promotion_code: { code: "VIP7" } }],
    })).toEqual({ promoId: null, code: "VIP7" });
  });
});

function makeDb({ byPromoId = null, byCode = null } = {}) {
  const seen = { promoId: [], code: [] };
  return {
    seen,
    prepare(sql) {
      const isById = /stripe_promo_id\s*=\s*\?1/i.test(sql);
      const isByCode = /UPPER\(code\)\s*=\s*UPPER\(\?1\)/i.test(sql);
      return {
        bind(arg) {
          if (isById) seen.promoId.push(arg);
          if (isByCode) seen.code.push(arg);
          return {
            async first() {
              if (isById) return byPromoId;
              if (isByCode) return byCode;
              return null;
            },
          };
        },
      };
    },
  };
}

describe("lookupVipCodeRow — matches by stripe_promo_id OR case-insensitive code", () => {
  it("returns null when the DB handle is missing (best-effort — never throws)", async () => {
    expect(await lookupVipCodeRow({}, { promoId: "promo_ABC" })).toBeNull();
  });

  it("returns null when neither promoId nor code is provided", async () => {
    const db = makeDb();
    expect(await lookupVipCodeRow({ DB: db }, {})).toBeNull();
  });

  it("prefers a hit on stripe_promo_id and short-circuits (no code query)", async () => {
    const row = { id: 1, code: "VIP1", stripe_promo_id: "promo_ABC" };
    const db = makeDb({ byPromoId: row });
    const found = await lookupVipCodeRow({ DB: db }, { promoId: "promo_ABC", code: "VIP1" });
    expect(found).toEqual(row);
    expect(db.seen.promoId).toEqual(["promo_ABC"]);
    expect(db.seen.code).toEqual([]);
  });

  it("falls back to case-insensitive code lookup when promoId misses", async () => {
    const row = { id: 2, code: "VIP2", stripe_promo_id: "promo_XYZ" };
    const db = makeDb({ byPromoId: null, byCode: row });
    const found = await lookupVipCodeRow({ DB: db }, { promoId: "promo_MISSED", code: "vip2" });
    expect(found).toEqual(row);
    expect(db.seen.promoId).toEqual(["promo_MISSED"]);
    expect(db.seen.code).toEqual(["vip2"]);
  });

  it("returns null when neither match", async () => {
    const db = makeDb({ byPromoId: null, byCode: null });
    expect(await lookupVipCodeRow({ DB: db }, { promoId: "promo_MISSED", code: "MISSING" })).toBeNull();
  });

  it("swallows DB errors and returns null (never crashes the webhook)", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return { async first() { throw new Error("d1 boom"); } };
          },
        };
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lookupVipCodeRow({ DB: db }, { promoId: "promo_ABC" })).toBeNull();
    warn.mockRestore();
  });
});

describe("resolveCheckoutTierGrant — VIP grant vs Pro grant decision", () => {
  it("no promotion_code → pro grant", async () => {
    const grant = await resolveCheckoutTierGrant({
      subObj: { status: "trialing" },
      lookup: async () => null,
    });
    expect(grant.tier).toBe("pro");
    expect(grant.vip_code_row).toBeNull();
    expect(grant.promo).toEqual({});
  });

  it("promotion_code applied but NOT a VIP row → pro grant (non-VIP promo, e.g. launch discount)", async () => {
    const grant = await resolveCheckoutTierGrant({
      subObj: { discount: { promotion_code: "promo_LAUNCH" } },
      lookup: async () => null,
    });
    expect(grant.tier).toBe("pro");
    expect(grant.vip_code_row).toBeNull();
    expect(grant.promo).toEqual({ promoId: "promo_LAUNCH" });
  });

  it("VIP promotion_code applied → vip grant + subscription_status=manual", async () => {
    const vipRow = { id: 42, code: "VIP42", stripe_promo_id: "promo_VIP42" };
    const grant = await resolveCheckoutTierGrant({
      subObj: { discount: { promotion_code: { id: "promo_VIP42", code: "VIP42" } } },
      lookup: async ({ promoId, code }) => {
        if (promoId === "promo_VIP42" || code === "VIP42") return vipRow;
        return null;
      },
    });
    expect(grant.tier).toBe("vip");
    expect(grant.subscription_status).toBe("manual");
    expect(grant.vip_code_row).toEqual(vipRow);
    expect(grant.promo).toEqual({ promoId: "promo_VIP42", code: "VIP42" });
  });

  it("VIP promotion_code applied via newer discounts[] shape", async () => {
    const vipRow = { id: 7, code: "SUMMER7", stripe_promo_id: "promo_SUM7" };
    const grant = await resolveCheckoutTierGrant({
      subObj: { discounts: [{ promotion_code: "promo_SUM7" }] },
      lookup: async ({ promoId }) => (promoId === "promo_SUM7" ? vipRow : null),
    });
    expect(grant.tier).toBe("vip");
    expect(grant.vip_code_row).toEqual(vipRow);
  });

  it("null subObj → pro grant (best-effort default; sub fetch may have failed)", async () => {
    const grant = await resolveCheckoutTierGrant({ subObj: null, lookup: async () => null });
    expect(grant.tier).toBe("pro");
  });
});
