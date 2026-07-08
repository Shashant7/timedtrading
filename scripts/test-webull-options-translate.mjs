#!/usr/bin/env node
// scripts/test-webull-options-translate.mjs — unit smoke for play → Webull payload

import { playToWebullOptionOrder, buildWebullOptionOrderPayload } from "../worker-bridge/bridge-webull-options.js";

const play = {
  archetype: "long_call",
  contracts: 2,
  premium: { mid: 4.25 },
  legs: [{
    action: "BUY",
    optionType: "CALL",
    strike: 220,
    expiration: "2026-06-19",
    qty: 2,
    premium_mid: 4.25,
  }],
};

const order = playToWebullOptionOrder(play, "AAPL");
if (!order || order.limit_price !== 4.25) {
  console.error("playToWebullOptionOrder failed", order);
  process.exit(1);
}

const body = buildWebullOptionOrderPayload(
  { webull_account_id: "TEST_ACCT" },
  order,
  { preview: true },
);

if (!body.new_orders?.[0]?.legs?.[0]?.strike_price) {
  console.error("buildWebullOptionOrderPayload failed", body);
  process.exit(1);
}

console.log("ok", JSON.stringify({ order, new_orders: body.new_orders.length }));
