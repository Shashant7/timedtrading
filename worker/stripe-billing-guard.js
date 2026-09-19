// worker/stripe-billing-guard.js
//
// 2026-09-19 — Make "VIP" actually stop the money.
//
// VIP is a D1 entitlement flag (tier='vip', subscription_status='manual')
// that grants Pro access without a paid Stripe subscription. The admin tier
// endpoint was supposed to cancel any live Stripe subscription when flipping
// a user to VIP, and the VIP welcome email tells the member their billing has
// been canceled. Neither was reliably true:
//
//   1. ORDERING. A 2026-06-05 change committed the grant BEFORE canceling, to
//      remove a race with the customer.subscription.deleted webhook. But the
//      cancel branch then re-SELECTed subscription_status and skipped when it
//      read 'manual' — which the UPDATE three lines earlier had just written.
//      The guard could never pass, so the DELETE never ran. The comment
//      explaining the race is still correct; only the read-back was wrong.
//
//   2. MISSING ID. The cancel needs users.stripe_subscription_id, and that
//      column is empty for accounts whose checkout webhook never stored it
//      (mihir@pcginvestment.com is VIP with a customer id and no subscription
//      id). Even with the ordering fixed there was nothing to cancel, while
//      Stripe held a live subscription against that customer.
//
// Result: six subscriptions were still active in Stripe against users the
// operator had already set to VIP, trials ended between 2026-03 and 2026-08,
// and the owner believed nobody was being billed.
//
// The lesson generalizes: a flag that means "don't charge this person" has to
// reach the system that does the charging. Entitlement state in our database
// and billing state at the processor are two different facts, and only one of
// them moves money.

/** Stripe statuses that can still produce a charge. */
export const BILLABLE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

/** Tiers that are comped — these users must never have live billing. */
export const COMPED_TIERS = new Set(["vip", "admin"]);

/**
 * Does this tier mean "never charge"? Note that `pro` does NOT: an admin can
 * grant Pro manually (subscription_status='manual'), but Pro is also the
 * paying tier, so cancelling on a Pro flip would cut off real subscribers.
 */
export function isCompedTier(tier) {
  return COMPED_TIERS.has(String(tier || "").toLowerCase());
}

/**
 * Pick the subscriptions that still need cancelling from a Stripe list.
 *
 * Pure so the selection rule is testable without a Stripe handle. Anything
 * already `canceled`/`incomplete_expired` is left alone, and a subscription
 * merely set to `cancel_at_period_end` is still returned: it bills at least
 * once more, which is exactly the surprise charge this is meant to prevent.
 */
export function selectCancelableSubscriptions(subs) {
  const out = [];
  for (const s of Array.isArray(subs) ? subs : []) {
    const id = typeof s === "string" ? s : s?.id;
    if (!id) continue;
    const status = String((typeof s === "object" && s?.status) || "").toLowerCase();
    // A bare id with no status (e.g. the one column D1 carries) cannot be
    // filtered on status — attempt it and let Stripe be the authority.
    if (status && !BILLABLE_SUBSCRIPTION_STATUSES.has(status)) continue;
    out.push({ id, status: status || "unknown" });
  }
  return out;
}

/** Merge D1's remembered subscription id with what Stripe actually has. */
export function mergeSubscriptionCandidates(d1SubscriptionId, stripeSubs) {
  const seen = new Map();
  for (const row of selectCancelableSubscriptions(stripeSubs)) seen.set(row.id, row);
  const remembered = String(d1SubscriptionId || "").trim();
  if (remembered && !seen.has(remembered)) {
    seen.set(remembered, { id: remembered, status: "unknown" });
  }
  return [...seen.values()];
}

async function stripeFetch(env, path, init = {}) {
  const key = env?.STRIPE_SECRET_KEY;
  if (!key) return { ok: false, status: 0, data: { error: { message: "no_stripe_key" } } };
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

/**
 * List every subscription Stripe holds for a customer, regardless of status.
 * Returns [] when the customer id is absent or the call fails — the caller
 * still has D1's remembered id to fall back on.
 */
export async function listCustomerSubscriptions(env, customerId) {
  const cid = String(customerId || "").trim();
  if (!cid) return [];
  const r = await stripeFetch(
    env,
    `subscriptions?customer=${encodeURIComponent(cid)}&status=all&limit=100`,
  );
  if (!r.ok) {
    console.warn(`[BILLING_GUARD] list subscriptions failed for ${cid}:`,
      String(r.data?.error?.message || r.status).slice(0, 160));
    return [];
  }
  return Array.isArray(r.data?.data) ? r.data.data : [];
}

/**
 * Cancel every live subscription for one user.
 *
 * Looks the customer up at Stripe rather than trusting D1's single
 * `stripe_subscription_id`, because that column is the thing that was
 * missing. Idempotent: a subscription Stripe reports as already canceled is
 * counted as such, not as a failure, so a sweep can run repeatedly.
 *
 * @returns {{ ok: boolean, canceled: string[], already: string[],
 *   failed: Array<{id:string, error:string}>, checked: number }}
 */
export async function cancelBillingForUser(env, { customerId, subscriptionId } = {}) {
  const stripeSubs = await listCustomerSubscriptions(env, customerId);
  const candidates = mergeSubscriptionCandidates(subscriptionId, stripeSubs);
  const canceled = [];
  const already = [];
  const failed = [];
  for (const cand of candidates) {
    const r = await stripeFetch(env, `subscriptions/${encodeURIComponent(cand.id)}`, {
      method: "DELETE",
    });
    if (r.ok) {
      canceled.push(cand.id);
      continue;
    }
    const msg = String(r.data?.error?.message || `http_${r.status}`);
    // Stripe answers 404 for an id that no longer exists and complains about
    // a subscription already canceled; neither is a billing risk.
    if (r.status === 404 || /already canceled|no such subscription/i.test(msg)) {
      already.push(cand.id);
      continue;
    }
    failed.push({ id: cand.id, error: msg.slice(0, 200) });
  }
  return { ok: failed.length === 0, canceled, already, failed, checked: candidates.length };
}
