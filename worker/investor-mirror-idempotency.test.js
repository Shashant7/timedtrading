// worker/investor-mirror-idempotency.test.js
//
// Every trim of an investor position used to share one client_order_id,
// because most trim call sites pass no lot and the id was keyed on the
// position. The bridge's 24h claim deduped the second trim as already
// placed, or Webull refused it as a repeat (MU, 2026-09-23).

import { describe, it, expect } from "vitest";
import { investorMirrorIdempotencyKey } from "./broker-bridge-client.js";

const T = Date.UTC(2026, 8, 23, 17, 0, 0);
const key = (op, extra = {}) => investorMirrorIdempotencyKey({
  op: { action_ts: T, ...op },
  tradeId: "inv-MU-auto-1789653815233",
  side: "trim",
  kind: "trim",
  qty: 0.91295,
  ...extra,
});

describe("investorMirrorIdempotencyKey", () => {
  it("gives two trims of one position different keys", () => {
    const first = key({ reduce_pct: 0.25, reason: "investor_mfe_extension_trim" }, { qty: 1.2173 });
    const second = key({ reduce_pct: 0.25, reason: "investor_mfe_extension_trim" }, { qty: 0.91295 });
    expect(first).not.toBe(second);
  });

  it("still dedupes a re-fire of the same action on the same day", () => {
    const op = { reduce_pct: 0.2, reason: "exhaustion_trim" };
    expect(key(op)).toBe(key(op));
  });

  it("separates the same action on a different day", () => {
    const op = { reduce_pct: 0.2, reason: "exhaustion_trim" };
    expect(key(op)).not.toBe(key({ ...op, action_ts: T + 86400000 }));
  });

  it("uses the lot when the caller names one", () => {
    expect(key({ lot_id: "lot-MU-mfeext-1" })).toBe("lot-MU-mfeext-1");
  });

  it("keys a buy on the position, as before", () => {
    expect(key({}, { side: "buy", kind: "open" })).toBe("inv-MU-auto-1789653815233");
  });

  it("gives an exit its own key too", () => {
    const exit = key({ reason: "invalidation" }, { side: "sell", kind: "exit", qty: 0.5 });
    expect(exit).not.toBe("inv-MU-auto-1789653815233");
    expect(exit).toContain("|exit|");
  });
});
