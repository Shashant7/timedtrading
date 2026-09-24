import { describe, it, expect } from "vitest";
import {
  optionsMirrorTargets,
  scaleContractsForAccount,
  clampReduceToHeld,
  optionsMirrorPayload,
  modelPremiumMid,
  modelContractsOf,
  DEFAULT_STOP_FRACTION,
} from "./bridge-options-fanout.js";
import { playToWebullOptionOrder } from "./bridge-webull-options.js";
import { applyOptionsSellGuard } from "./bridge-options-guard.js";

// The exact play the index day-trade lane builds.
function modelPlay(over = {}) {
  return {
    archetype: "long_put",
    contracts: 2,
    premium: { mid: 0.64 },
    max_loss_usd: 128,
    legs: [{
      action: "BUY", optionType: "PUT", strike: 279,
      expiration: "2026-09-25", qty: 2, premium_mid: 0.64,
    }],
    ...over,
  };
}

// Shapes taken from the live bridge:user rows on 2026-09-24.
const partnerCash = {
  user_id: "shahpritesh206@gmail.com#webull#individual-cash",
  owner_email: "shahpritesh206@gmail.com",
  broker: "webull",
  status: "connected",
  webull_account_class: "INDIVIDUAL_CASH",
  webull_account_id: "8675309001",
  broker_integration_enabled: true,
  mirror_participant: true,
  options_enabled: true,
  equity_usd: 12000,
};
const partnerFutures = {
  user_id: "shahpritesh206@gmail.com#webull#futures",
  broker: "webull",
  status: "connected",
  webull_account_class: "FUTURES",
  broker_integration_enabled: true,
  mirror_participant: true,
  options_enabled: false,
};

describe("optionsMirrorTargets", () => {
  it("keeps an account that opted into options", () => {
    expect(optionsMirrorTargets([partnerCash]).map((u) => u.user_id))
      .toEqual([partnerCash.user_id]);
  });

  // Stock mirroring and options are separate consents. A partner who
  // enabled shares has not thereby authorized 1DTE index options.
  it("drops an account that mirrors stock but never enabled options", () => {
    expect(optionsMirrorTargets([{ ...partnerCash, options_enabled: false }])).toEqual([]);
  });

  it("accepts a vehicle-level opt-in without the master flag", () => {
    const viaVehicle = {
      ...partnerCash,
      options_enabled: false,
      options_prefs: { vehicles: { long_put: { enabled: true } } },
    };
    expect(optionsMirrorTargets([viaVehicle])).toHaveLength(1);
  });

  it("drops the futures sub-account", () => {
    expect(optionsMirrorTargets([partnerFutures])).toEqual([]);
  });

  it("tolerates junk", () => {
    expect(optionsMirrorTargets(null)).toEqual([]);
    expect(optionsMirrorTargets([null, undefined, {}])).toEqual([]);
  });
});

describe("scaleContractsForAccount", () => {
  const base = { modelContracts: 2, premium: 0.64, modelBookUsd: 100000, dailyLossLimitUsd: 500 };

  it("never scales a partner UP past the model size", () => {
    const out = scaleContractsForAccount({ ...base, accountEquity: 5000000 });
    expect(out.contracts).toBe(2);
    expect(out.ratio).toBe(1);
  });

  it("scales down on the equity ratio like the equity lane does", () => {
    // $50k against a $100k book -> half of 2 contracts.
    const out = scaleContractsForAccount({ ...base, modelContracts: 4, accountEquity: 50000 });
    expect(out.contracts).toBe(2);
    expect(out.reason).toBe("scaled");
  });

  // Flooring alone sends every small account to zero forever, which is the
  // same as not shipping the feature.
  it("floors at one lot when the ratio rounds to nothing", () => {
    const out = scaleContractsForAccount({ ...base, accountEquity: 12000 });
    expect(out.contracts).toBe(1);
    expect(out.reason).toBe("one_lot_floor");
  });

  it("refuses the one-lot floor when a single contract breaks the day-loss limit", () => {
    // $8.00 premium = $800 a contract; a $100 day-stop tolerates $200.
    const out = scaleContractsForAccount({
      ...base, premium: 8.0, accountEquity: 12000, dailyLossLimitUsd: 100,
    });
    expect(out.contracts).toBe(0);
    expect(out.reason).toBe("one_lot_over_daily_loss_limit");
  });

  it("caps a scaled size at the account's day-loss limit", () => {
    // $2.00 premium = $200 a contract; a $300 limit at a 50% stop
    // tolerates $600 of debit, so 3 contracts, not the 5 equity allows.
    const out = scaleContractsForAccount({
      modelContracts: 5, premium: 2.0, accountEquity: 100000,
      modelBookUsd: 100000, dailyLossLimitUsd: 300,
    });
    expect(out.contracts).toBe(3);
    expect(out.reason).toBe("capped_by_daily_loss_limit");
  });

  it("treats a zero limit as the gate being off, not as zero tolerance", () => {
    const out = scaleContractsForAccount({
      ...base, premium: 8.0, accountEquity: 12000, dailyLossLimitUsd: 0,
    });
    expect(out.contracts).toBe(1);
  });

  it("sits out rather than guessing when equity is unknown", () => {
    expect(scaleContractsForAccount({ ...base, accountEquity: null }))
      .toMatchObject({ contracts: 0, reason: "account_equity_unknown" });
  });

  it("sits out a one-lot floor with no premium to price it", () => {
    expect(scaleContractsForAccount({ ...base, premium: null, accountEquity: 12000 }))
      .toMatchObject({ contracts: 0, reason: "no_premium_for_one_lot" });
  });

  it("uses the same stop fraction as the main worker's risk budget", () => {
    expect(DEFAULT_STOP_FRACTION).toBe(0.5);
  });
});

describe("clampReduceToHeld", () => {
  // The whole point: a partner who took 1 on the way in must still get out
  // when the model closes 2, instead of tripping sell_qty_exceeds_held.
  it("clamps a model close down to what the partner holds", () => {
    expect(clampReduceToHeld(2, 1)).toMatchObject({ qty: 1, reason: "clamped_to_held" });
  });

  it("passes a matching close straight through", () => {
    expect(clampReduceToHeld(2, 2)).toMatchObject({ qty: 2, reason: "full" });
  });

  it("never sells more than held, even when the model asks for more", () => {
    for (const [want, held] of [[5, 2], [3, 1], [10, 4]]) {
      expect(clampReduceToHeld(want, held).qty).toBeLessThanOrEqual(held);
    }
  });

  it("reports nothing to close rather than sending a zero order", () => {
    expect(clampReduceToHeld(2, 0)).toMatchObject({ qty: 0, reason: "no_held_position" });
  });

  it("never clamps UP a partner who somehow holds more", () => {
    expect(clampReduceToHeld(1, 4).qty).toBe(1);
  });
});

describe("optionsMirrorPayload", () => {
  const payload = {
    user_id: "shashant@gmail.com",
    trade_id: "dt:IWM:2026-09-24:2026-09-25:P:279",
    ticker: "IWM",
    client_order_id: "ttoptiwm279",
    play: { archetype: "long_put", contracts: 2, premium: 0.64 },
  };

  it("retargets the order at the partner account", () => {
    const out = optionsMirrorPayload(payload, partnerCash);
    expect(out.user_id).toBe(partnerCash.user_id);
    expect(out.ticker).toBe("IWM");
  });

  it("overrides contracts without mutating the model's play", () => {
    const out = optionsMirrorPayload(payload, partnerCash, { contracts: 1 });
    expect(out.play.contracts).toBe(1);
    expect(payload.play.contracts).toBe(2);
  });

  // One shared claim key would let the first target consume the claim and
  // every other account come back "deduped" having placed nothing.
  it("gives each account its own idempotency key", () => {
    const a = optionsMirrorPayload(payload, partnerCash);
    const b = optionsMirrorPayload(payload, { ...partnerCash, webull_account_id: "9999000111" });
    expect(a.client_order_id).not.toBe(b.client_order_id);
    expect(a.client_order_id.length).toBeLessThanOrEqual(40);
  });

  it("leaves the key absent when the model sent none", () => {
    const out = optionsMirrorPayload({ ...payload, client_order_id: undefined }, partnerCash);
    expect(out.client_order_id).toBeUndefined();
  });
});

describe("reading the model play the day-trade lane actually sends", () => {
  // premium is an object on every real order; Number() on it is NaN, which
  // would silently switch off every premium-priced rule downstream.
  it("reads the mid out of the premium object", () => {
    expect(modelPremiumMid(modelPlay())).toBe(0.64);
  });

  it("falls back through the leg and a bare number", () => {
    expect(modelPremiumMid({ legs: [{ premium_mid: 1.25 }] })).toBe(1.25);
    expect(modelPremiumMid({ premium: 0.5 })).toBe(0.5);
    expect(modelPremiumMid({})).toBeNull();
  });

  it("reads contracts off the leg, which is what the translator uses", () => {
    expect(modelContractsOf(modelPlay())).toBe(2);
    expect(modelContractsOf({ contracts: 3 })).toBe(3);
    expect(modelContractsOf({})).toBe(1);
  });
});

// playToWebullOptionOrder resolves qty as `leg.qty ?? play.contracts`, so
// rewriting `contracts` alone hands the partner the operator's size while
// every log claims it was scaled down. Assert against the real translator.
describe("resizing a mirror reaches the broker order", () => {
  const payload = { user_id: "op@x.com", ticker: "IWM", play: modelPlay() };

  it("resizes the order the broker actually receives", () => {
    const out = optionsMirrorPayload(payload, partnerCash, { contracts: 1 });
    const order = playToWebullOptionOrder(out.play, "IWM");
    expect(order.qty).toBe(1);
  });

  it("leaves the model's own order untouched at full size", () => {
    optionsMirrorPayload(payload, partnerCash, { contracts: 1 });
    expect(playToWebullOptionOrder(payload.play, "IWM").qty).toBe(2);
  });

  it("restates max loss at the partner's size", () => {
    const out = optionsMirrorPayload(payload, partnerCash, { contracts: 1 });
    expect(out.play.max_loss_usd).toBe(64);
  });

  it("keeps strike, expiry and right identical to the model's", () => {
    const mine = playToWebullOptionOrder(payload.play, "IWM");
    const theirs = playToWebullOptionOrder(
      optionsMirrorPayload(payload, partnerCash, { contracts: 1 }).play, "IWM",
    );
    expect(theirs.strike).toBe(mine.strike);
    expect(theirs.expiration).toBe(mine.expiration);
    expect(theirs.option_type).toBe(mine.option_type);
    expect(theirs.action).toBe(mine.action);
  });
});

// The clamp only helps if the clamped order then passes the real guard.
describe("a clamped reduce satisfies the live sell guard", () => {
  const held = [{
    symbol: "IWM", right: "P", strike: 279,
    expiration: "2026-09-25", qty: 1,
  }];
  const sellOrder = {
    type: "single", symbol: "IWM", action: "SELL", qty: 2,
    strike: 279, expiration: "2026-09-25", option_type: "PUT",
  };

  it("refuses the model's qty against a smaller partner position", () => {
    const guard = applyOptionsSellGuard({ ...sellOrder }, held);
    expect(guard.ok).toBe(false);
    expect(guard.held_qty).toBe(1);
  });

  it("passes once clamped to what the partner holds", () => {
    const first = applyOptionsSellGuard({ ...sellOrder }, held);
    const clamped = clampReduceToHeld(sellOrder.qty, first.held_qty);
    expect(clamped.qty).toBe(1);
    expect(applyOptionsSellGuard({ ...sellOrder, qty: clamped.qty }, held).ok).toBe(true);
  });
});
