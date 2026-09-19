# Billing + Sales Tax

**WHEN to use:** a member reports an unexpected charge, someone is set to
VIP but Stripe is still billing them, or you need the revenue / sales-tax
numbers for a PA Department of Revenue filing.

---

## The one thing to remember

Entitlement state and billing state live in two different systems, and only
one of them moves money.

`users.tier = 'vip'` in D1 grants access. It does **nothing** to Stripe. If
the Stripe subscription is still `active`, the member keeps getting charged
no matter what the tier says — and the VIP welcome email will have told them
their billing was cancelled. On 2026-09-19 six subscriptions were live
against users already flipped to VIP for exactly this reason.

Never conclude "they're VIP so they aren't being billed". Ask Stripe.

---

## Is anyone being billed who shouldn't be?

```bash
BASE=https://timed-trading-ingest.shashant.workers.dev
curl -s -H "X-API-Key: $TIMED_API_KEY" "$BASE/timed/admin/stripe/subscriptions" \
  | python3 -m json.tool
```

`mismatch: true` means D1 says comped (`vip`/`admin`) or `free` while Stripe
says `active`/`trialing`. Any row with status `active`, `trialing`,
`past_due` or `unpaid` can still produce a charge.

### Fix it

```bash
# Preview first — always.
curl -s -X POST -H "X-API-Key: $TIMED_API_KEY" \
  "$BASE/timed/admin/stripe/reconcile-vip?dry_run=true" | python3 -m json.tool

# Then execute. Idempotent; safe to re-run.
curl -s -X POST -H "X-API-Key: $TIMED_API_KEY" \
  "$BASE/timed/admin/stripe/reconcile-vip" | python3 -m json.tool

# One user only:
curl -s -X POST -H "X-API-Key: $TIMED_API_KEY" \
  "$BASE/timed/admin/stripe/reconcile-vip?email=someone@example.com"
```

The sweep only touches **comped** tiers (`vip`, `admin`). `pro` is excluded
on purpose — it is also the paying tier, and cancelling on a Pro flip would
cut off real subscribers. To cancel one paying subscription, use
`POST /timed/admin/stripe/cancel?sub=sub_xxx`.

Cancelling does **not** refund past charges. Refunds are a Dashboard action
and a deliberate decision.

### Why it broke (don't reintroduce either)

1. The admin tier endpoint wrote `subscription_status='manual'` and then
   re-read that same column to decide whether to cancel, guarding on
   `prevStatus !== 'manual'`. The guard could never pass. Capture the Stripe
   ids **before** the `UPDATE`; the 2026-06-05 write-first ordering is
   deliberate (it removes a `customer.subscription.deleted` race) and should
   stay.
2. The cancel only read `users.stripe_subscription_id`, which is NULL for
   accounts whose checkout webhook never stored it.
   `cancelBillingForUser` in `worker/stripe-billing-guard.js` now asks Stripe
   what the customer holds, so D1 drift cannot strand a live subscription.

---

## Revenue and sales tax numbers

```bash
curl -s -H "X-API-Key: $TIMED_API_KEY" "$BASE/timed/admin/stripe/revenue-audit" \
  > /tmp/audit.json
```

Read-only. Returns every settled charge and invoice with gross / refunded /
net, the **billing address**, and tax per invoice. The address matters
because sales tax is sourced to the *customer's* location, not the seller's.

Gotcha: Stripe moved the invoice tax field. Older API versions expose `tax` +
`total_tax_amounts`, newer ones `total_taxes`. Reading only `tax` reported
`$0.00` against invoices whose total was 8% above subtotal. The endpoint now
takes whichever exists and falls back to `total - subtotal`; `tax_source` on
each row says which. Always cross-foot `subtotal + tax == total`.

---

## PA sales tax rules that actually apply here

- **SaaS is taxable.** PA taxes canned software accessed remotely "whether
  accessed and purchased singly, or by subscription or in any other manner"
  (Act 84 of 2016, effective 2016-08-01). A hosted subscription app is in
  scope.
- **Rate: 8% in Philadelphia** — 6% state + 2% Philadelphia local. Allegheny
  County is 6% + 1%. Everywhere else in PA is 6%. All reported on one return
  under the same account ID.
- **Sourcing is the customer, not us.** Tax applies when the *user* is in PA.
  A PA billing address creates a presumption that the users are in PA. An
  out-of-state customer is not subject to PA tax (they'd give REV-1220 to
  document an exemption claim).
- **Zero returns are still required.** "Returns are to be filed whether or
  not taxable transactions occur in a period."
- **Frequency follows annual liability** (REV-588). New filers start
  quarterly, but the department reviews yearly:
  - monthly — over $600 tax per quarter
  - quarterly — over $300 annually; periods end Mar/Jun/Sep/Dec, due the
    20th of the following month
  - **semi-annual — $300 or less annually**; Jan–Jun due **Aug 20**,
    Jul–Dec due **Feb 20**
  At current volume this business is semi-annual, which matters because a
  semi-annual "period ending 06/30" covers **January through June**, not
  April through June. Check the period list in myPATH before computing a
  return; assuming quarterly understates the period by a third.
- Filing **on time** earns a vendor discount (quarterly: lesser of $75 or 1%
  of tax). Filing late forfeits it.

Filing is done at [mypath.pa.gov](https://mypath.pa.gov): Summary tab → Sales
and Use Tax panel → the period → *File or amend a return* → answer whether
there are PA sales to report → submit.

**This is not tax advice.** Get a CPA to sign off before filing anything
consequential — particularly on whether charges to the operator's own test
account are taxable sales.

---

## Turning tax collection on

`worker/index.js` checkout now always sets
`billing_address_collection=required` (the address is both the input to any
tax calculation and the evidence for why a sale was or wasn't taxed).

`automatic_tax` is **opt-in** behind `STRIPE_AUTOMATIC_TAX=true`. Do not flip
it before both Dashboard prerequisites are done, or checkout breaks:

1. The Price must have a `tax_behavior` (set it to `exclusive` so $60 stays
   the pre-tax price). Stripe rejects the session outright without it.
2. Stripe Tax must have a **PA registration** added, otherwise it computes
   $0 everywhere and nothing changes.

Then:

```bash
cd worker && ../node_modules/.bin/wrangler secret put STRIPE_AUTOMATIC_TAX
# value: true   (repeat with --env production)
```

Verify with a real checkout that the invoice shows subtotal $60 + tax $4.80
for a Philadelphia address.

Stripe is a payment processor, not a marketplace facilitator — it does not
remit sales tax on our behalf. Stripe Tax calculates and reports; filing and
remitting is still on us (or on Stripe Tax's filing add-on if enabled).
