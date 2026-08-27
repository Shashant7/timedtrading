import { describe, it, expect, vi, beforeEach } from "vitest";

const catchupMock = vi.fn();
const skipMock = vi.fn();
vi.mock("./broker-bridge-catchup-exit.js", () => ({
  catchupTraderExit: (...args) => catchupMock(...args),
}));
vi.mock("./broker-bridge-client.js", () => ({
  recordBridgeMirrorSkip: (...args) => skipMock(...args),
}));

import { planTraderExitCatchup, runTraderExitCatchup, rowHoldsReducerQty } from "./trader-exit-catchup.js";

const AMZN_EXIT = {
  position_id: "AMZN-1787578395449-2nbtbch14",
  ticker: "AMZN",
  ts: Date.parse("2026-08-27T21:07:34Z"),
  qty: 1.6749,
  price: 256.22,
};
const EXPE_EXIT = {
  position_id: "EXPE-1787578684218-d0sfqqd72",
  ticker: "EXPE",
  ts: Date.parse("2026-08-27T20:57:21Z"),
  qty: 2.9219,
  price: 318.945,
};
const AMZN_HELD = {
  trade_id: "AMZN-1787578395449-2nbtbch14",
  ticker: "AMZN",
  user_id: "shashant@gmail.com",
  broker_account_id: "LJJ84GKUVIVG998B8DO3069DKA",
  broker_remaining_qty: 0.27239,
  sync_state: "in_sync",
  mirror_suppressed: 0,
};
const CASH_REJECTED = {
  trade_id: "AMZN-1787578395449-2nbtbch14",
  ticker: "AMZN",
  user_id: "other@x.com#webull#individual-cash",
  broker_account_id: "CASH-1",
  broker_remaining_qty: 0,
  sync_state: "rejected",
  mirror_suppressed: 0,
};

describe("planTraderExitCatchup", () => {
  it("plans AMZN leftover and ignores EXPE with no manifest", () => {
    const ops = planTraderExitCatchup({
      exits: [AMZN_EXIT, EXPE_EXIT],
      manifests: [AMZN_HELD, CASH_REJECTED],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].ticker).toBe("AMZN");
    expect(ops[0].qty).toBe(0.27239);
    expect(ops[0].user_id).toBe("shashant@gmail.com");
  });

  it("skips rejected / zero-remaining sleeves", () => {
    expect(rowHoldsReducerQty(CASH_REJECTED)).toBe(false);
    expect(rowHoldsReducerQty(AMZN_HELD)).toBe(true);
  });
});

describe("runTraderExitCatchup", () => {
  beforeEach(() => {
    catchupMock.mockReset();
    skipMock.mockReset();
    catchupMock.mockResolvedValue({ ok: true });
    skipMock.mockResolvedValue({ ok: false, skip: "fractional_trim_deferred_to_rth" });
  });

  it("defers a sub-share leftover after the close and records one skip", async () => {
    const kv = new Map();
    const env = {
      KV_TIMED: {
        async get(k) { return kv.get(k) || null; },
        async put(k, v) { kv.set(k, v); },
      },
    };
    const out = await runTraderExitCatchup(env, {
      dry_run: false,
      now: new Date("2026-08-27T17:10:00-04:00"),
      exits: [AMZN_EXIT],
      manifests: [AMZN_HELD],
    });
    expect(out.results[0].skip).toBe("fractional_trim_deferred_to_rth");
    expect(catchupMock).not.toHaveBeenCalled();
    expect(skipMock).toHaveBeenCalledTimes(1);
  });

  it("forwards the leftover during RTH", async () => {
    const out = await runTraderExitCatchup({}, {
      dry_run: false,
      now: new Date("2026-08-28T10:05:00-04:00"),
      exits: [AMZN_EXIT],
      manifests: [AMZN_HELD],
    });
    expect(out.forwarded).toBe(1);
    expect(catchupMock).toHaveBeenCalledTimes(1);
    const opts = catchupMock.mock.calls[0][1];
    expect(opts.qty).toBe(0.27239);
    expect(opts.price).toBe(256.22);
    expect(opts.dry_run).toBe(false);
  });
});
