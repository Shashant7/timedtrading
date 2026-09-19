// 2026-09-19 — Regression tests for "VIP but still billed".
//
// Six Stripe subscriptions were live against users the operator had already
// flipped to VIP. Two independent faults produced that, and each gets a test
// here so neither can come back:
//
//   1. The admin tier endpoint wrote subscription_status='manual' and THEN
//      re-read it to decide whether to cancel, guarding on
//      `prevStatus !== 'manual'`. The guard could never pass.
//   2. The cancel only ever looked at users.stripe_subscription_id, which was
//      empty for accounts whose checkout webhook never stored it — so there
//      was nothing to cancel while Stripe held a live subscription.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BILLABLE_SUBSCRIPTION_STATUSES,
  cancelBillingForUser,
  isCompedTier,
  listCustomerSubscriptions,
  mergeSubscriptionCandidates,
  selectCancelableSubscriptions,
} from "./stripe-billing-guard.js";

const ENV = { STRIPE_SECRET_KEY: "sk_test_x" };

function stripeStub(handlers) {
  return vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    for (const [match, fn] of handlers) {
      if (u.includes(match) && (!match.method || match.method === method)) {
        return fn(u, init);
      }
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${method} ${u}` } }), { status: 500 });
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("isCompedTier", () => {
  it("treats vip and admin as never-charge", () => {
    expect(isCompedTier("vip")).toBe(true);
    expect(isCompedTier("admin")).toBe(true);
    expect(isCompedTier("VIP")).toBe(true);
  });

  it("does NOT comp pro — pro is the paying tier", () => {
    // Cancelling on a Pro flip would cut off real paying subscribers.
    expect(isCompedTier("pro")).toBe(false);
    expect(isCompedTier("free")).toBe(false);
    expect(isCompedTier(null)).toBe(false);
  });
});

describe("selectCancelableSubscriptions", () => {
  it("picks every status that can still produce a charge", () => {
    const out = selectCancelableSubscriptions([
      { id: "sub_active", status: "active" },
      { id: "sub_trial", status: "trialing" },
      { id: "sub_due", status: "past_due" },
      { id: "sub_unpaid", status: "unpaid" },
    ]);
    expect(out.map((s) => s.id)).toEqual(["sub_active", "sub_trial", "sub_due", "sub_unpaid"]);
  });

  it("leaves already-dead subscriptions alone", () => {
    const out = selectCancelableSubscriptions([
      { id: "sub_gone", status: "canceled" },
      { id: "sub_dead", status: "incomplete_expired" },
    ]);
    expect(out).toEqual([]);
  });

  it("still cancels one merely set to cancel_at_period_end", () => {
    // It bills at least once more, which is the surprise charge in question.
    const out = selectCancelableSubscriptions([
      { id: "sub_x", status: "active", cancel_at_period_end: true },
    ]);
    expect(out.map((s) => s.id)).toEqual(["sub_x"]);
  });

  it("keeps a bare id with no status and lets Stripe be the authority", () => {
    expect(selectCancelableSubscriptions(["sub_bare"])).toEqual([{ id: "sub_bare", status: "unknown" }]);
  });

  it("survives junk", () => {
    expect(selectCancelableSubscriptions(null)).toEqual([]);
    expect(selectCancelableSubscriptions([null, {}, { status: "active" }])).toEqual([]);
  });
});

describe("mergeSubscriptionCandidates", () => {
  it("finds the subscription Stripe knows about when D1 has forgotten it", () => {
    // mihir@pcginvestment.com exactly: a customer id, a live Stripe
    // subscription, and NULL in users.stripe_subscription_id.
    const out = mergeSubscriptionCandidates(null, [{ id: "sub_live", status: "active" }]);
    expect(out.map((s) => s.id)).toEqual(["sub_live"]);
  });

  it("keeps D1's remembered id even when the Stripe list is empty", () => {
    const out = mergeSubscriptionCandidates("sub_remembered", []);
    expect(out.map((s) => s.id)).toEqual(["sub_remembered"]);
  });

  it("does not cancel the same subscription twice", () => {
    const out = mergeSubscriptionCandidates("sub_a", [{ id: "sub_a", status: "active" }]);
    expect(out).toHaveLength(1);
  });

  it("collects every live subscription on one customer", () => {
    const out = mergeSubscriptionCandidates("sub_a", [
      { id: "sub_a", status: "active" },
      { id: "sub_b", status: "trialing" },
      { id: "sub_old", status: "canceled" },
    ]);
    expect(out.map((s) => s.id).sort()).toEqual(["sub_a", "sub_b"]);
  });
});

describe("cancelBillingForUser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cancels the live subscription found via the customer, with no id in D1", async () => {
    const deleted = [];
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ data: [{ id: "sub_live", status: "active" }] })],
      ["/subscriptions/", (u, init) => {
        if (init.method === "DELETE") { deleted.push(u.split("/").pop()); return json({ id: "sub_live", status: "canceled" }); }
        return json({}, 404);
      }],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x", subscriptionId: null });
    expect(out.ok).toBe(true);
    expect(out.canceled).toEqual(["sub_live"]);
    expect(deleted).toEqual(["sub_live"]);
  });

  it("is idempotent — an already-canceled subscription is not a failure", async () => {
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ data: [{ id: "sub_a", status: "active" }] })],
      ["/subscriptions/", () => json({ error: { message: "No such subscription: sub_a" } }, 404)],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x" });
    expect(out.ok).toBe(true);
    expect(out.already).toEqual(["sub_a"]);
    expect(out.failed).toEqual([]);
  });

  it("reports a real Stripe failure instead of claiming success", async () => {
    // The VIP welcome email tells the member their billing is canceled, so a
    // silent failure here is worse than an error.
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ data: [{ id: "sub_a", status: "active" }] })],
      ["/subscriptions/", () => json({ error: { message: "api is down" } }, 500)],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x" });
    expect(out.ok).toBe(false);
    expect(out.failed[0]).toMatchObject({ id: "sub_a", error: "api is down" });
  });

  it("falls back to D1's id when the customer lookup fails", async () => {
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ error: { message: "nope" } }, 500)],
      ["/subscriptions/", () => json({ id: "sub_d1", status: "canceled" })],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x", subscriptionId: "sub_d1" });
    expect(out.canceled).toEqual(["sub_d1"]);
  });

  it("does nothing when there is nothing to cancel", async () => {
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ data: [{ id: "sub_old", status: "canceled" }] })],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x" });
    expect(out).toMatchObject({ ok: true, canceled: [], checked: 0 });
  });

  it("cancels every live subscription when a customer somehow has two", async () => {
    const deleted = [];
    vi.stubGlobal("fetch", stripeStub([
      ["/subscriptions?customer=", () => json({ data: [
        { id: "sub_a", status: "active" },
        { id: "sub_b", status: "trialing" },
      ] })],
      ["/subscriptions/", (u) => { deleted.push(u.split("/").pop()); return json({ status: "canceled" }); }],
    ]));
    const out = await cancelBillingForUser(ENV, { customerId: "cus_x" });
    expect(out.canceled.sort()).toEqual(["sub_a", "sub_b"]);
    expect(deleted).toHaveLength(2);
  });
});

describe("listCustomerSubscriptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for every status, not just active", async () => {
    // A trialing subscription has not charged yet and is the one most likely
    // to become a surprise charge, so the sweep must see it.
    let seen = "";
    vi.stubGlobal("fetch", stripeStub([["/subscriptions?", (u) => { seen = u; return json({ data: [] }); }]]));
    await listCustomerSubscriptions(ENV, "cus_x");
    expect(seen).toContain("status=all");
    expect(seen).toContain("customer=cus_x");
  });

  it("returns empty without a customer id rather than listing the whole account", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await listCustomerSubscriptions(ENV, null)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("BILLABLE_SUBSCRIPTION_STATUSES", () => {
  it("includes trialing — the state every stranded user was in", () => {
    expect(BILLABLE_SUBSCRIPTION_STATUSES.has("trialing")).toBe(true);
    expect(BILLABLE_SUBSCRIPTION_STATUSES.has("active")).toBe(true);
    expect(BILLABLE_SUBSCRIPTION_STATUSES.has("canceled")).toBe(false);
  });
});
