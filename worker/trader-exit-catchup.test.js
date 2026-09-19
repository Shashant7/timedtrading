import { describe, it, expect, vi, beforeEach } from "vitest";

const catchupMock = vi.fn();
const skipMock = vi.fn();
vi.mock("./broker-bridge-catchup-exit.js", () => ({
  catchupTraderExit: (...args) => catchupMock(...args),
}));
vi.mock("./broker-bridge-client.js", () => ({
  recordBridgeMirrorSkip: (...args) => skipMock(...args),
}));

import {
  planTraderExitCatchup,
  runTraderExitCatchup,
  rowHoldsReducerQty,
  clampExitOpsToHoldings,
} from "./trader-exit-catchup.js";

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

  it("skips zero-remaining sleeves", () => {
    expect(rowHoldsReducerQty(CASH_REJECTED)).toBe(false);
    expect(rowHoldsReducerQty(AMZN_HELD)).toBe(true);
  });

  // 2026-09-04 DPZ regression: entry preflight-rejected for cash and
  // auto-suppressed, but a later fill left 0.2714 sh at the broker. The
  // model's doctrine_force_exit then skipped the close because this check
  // gated on entry-time suppression — shares stranded at Webull. Exits
  // must reduce whatever the broker actually holds.
  it("still sells a suppressed/rejected sleeve that holds broker qty (DPZ)", () => {
    const DPZ_SUPPRESSED_HELD = {
      trade_id: "DPZ-1788443309854-hlxfbubhx",
      ticker: "DPZ",
      user_id: "shashant@gmail.com",
      broker_account_id: "LJJ84GKUVIVG998B8DO3069DKA",
      broker_remaining_qty: 0.2714,
      sync_state: "rejected",
      mirror_suppressed: 1,
      mirror_suppressed_reason: "insufficient_cash_for_one_unit_0_lt_346.75",
    };
    expect(rowHoldsReducerQty(DPZ_SUPPRESSED_HELD)).toBe(true);
    const ops = planTraderExitCatchup({
      exits: [{
        position_id: "DPZ-1788443309854-hlxfbubhx",
        ticker: "DPZ",
        ts: Date.parse("2026-09-04T13:58:40Z"),
        qty: 0.8284602556976093,
        price: 340.61,
      }],
      manifests: [DPZ_SUPPRESSED_HELD],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].qty).toBe(0.2714);
  });

  it("plans leftover on a stale OPEN sleeve when the mothership trade is closed", () => {
    const stale = {
      trade_id: "ULTA-1788443015769-b6e9u2f8g",
      ticker: "ULTA",
      user_id: "shashant@gmail.com",
      broker_account_id: "LJJ84GKUVIVG998B8DO3069DKA",
      broker_remaining_qty: 0.07902,
      model_status: "OPEN",
      sync_state: "rejected",
      mirror_suppressed: 1,
    };
    const ops = planTraderExitCatchup({
      exits: [],
      manifests: [stale],
      closedTradeIds: ["ULTA-1788443015769-b6e9u2f8g"],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].qty).toBe(0.07902);
  });
});

// 2026-09-14 — the live plan wanted 30 ops against a Roth that held one
// residual per ticker: PH 0.13612 claimed by four stale sleeves, DPZ 0.2714
// by two, XLRE 1.35379 by two. Every claim is a real manifest row; only the
// first is a real share.
describe("clampExitOpsToHoldings", () => {
  const ROTH = "LJJ84GKUVIVG998B8DO3069DKA";
  const op = (ticker, tradeId, qty, exitTs = 0) => ({
    trade_id: tradeId,
    ticker,
    user_id: "shashant@gmail.com",
    broker_account_id: ROTH,
    qty,
    exit_ts: exitTs,
  });
  const PH_CLAIMS = [
    op("PH", "PH-1787771392989-f9iyi0rgr", 0.13612),
    op("PH", "PH-1786982842280-z9qno23xt", 0.13612),
    op("PH", "PH-1786648976564-i9c7t6uqg", 0.13612),
    op("PH", "PH-1785949382582-y6a0jrjtr", 0.13612),
  ];

  it("sells the PH residual once, not four times", () => {
    const { ops, dropped } = clampExitOpsToHoldings(PH_CLAIMS, { PH: { qty: 0.13612 } });
    expect(ops).toHaveLength(1);
    expect(ops[0].qty).toBe(0.13612);
    expect(dropped).toHaveLength(3);
    expect(dropped.every((d) => d.skip === "broker_position_already_flat")).toBe(true);
  });

  it("dedupes to one claim even when the broker cannot be asked", () => {
    const { ops, dropped } = clampExitOpsToHoldings(PH_CLAIMS, null);
    expect(ops).toHaveLength(1);
    expect(dropped).toHaveLength(3);
  });

  it("clamps a claim larger than the position instead of shorting it", () => {
    const { ops } = clampExitOpsToHoldings(
      [op("DPZ", "DPZ-1788443309854-hlxfbubhx", 0.2714)],
      { DPZ: { qty: 0.1 } },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].qty).toBe(0.1);
    expect(ops[0].claimed_qty).toBe(0.2714);
    expect(ops[0].clamped).toBe(true);
  });

  it("drops every claim on a ticker the broker is flat in", () => {
    const { ops, dropped } = clampExitOpsToHoldings(
      [op("TNA", "it:IWM:TNA:LONG:2026-W36", 4)],
      { DPZ: { qty: 0.2714 } },
    );
    expect(ops).toHaveLength(0);
    expect(dropped[0].skip).toBe("broker_position_already_flat");
    expect(dropped[0].held_qty).toBe(0);
  });

  // The zombies filled the hourly max_ops window ahead of a real miss.
  it("spends the position on the newest exit first", () => {
    const { ops } = clampExitOpsToHoldings([
      op("XLRE", "XLRE-1784747320549-quvjz2sxa", 1.35379, 0),
      op("XLRE", "XLRE-1786723521379-gan8kwxju", 1.35379, Date.parse("2026-09-14T16:35:05Z")),
    ], { XLRE: { qty: 1.35379 } });
    expect(ops).toHaveLength(1);
    expect(ops[0].trade_id).toBe("XLRE-1786723521379-gan8kwxju");
  });

  it("splits one position across two accounts' claims", () => {
    const { ops } = clampExitOpsToHoldings([
      { ...op("UNP", "UNP-1786730641396-bl2td32wf", 2), broker_account_id: "9QHQ6RKN0POS4JU54D4TJTKH98" },
      op("UNP", "UNP-1786125805120-po3kjcj7z", 1.90357),
    ], { UNP: { qty: 1.90357 } });
    expect(ops).toHaveLength(1);
    expect(ops[0].qty).toBe(1.90357);
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

  it("reports the flat claims without spending a max_ops slot on them", async () => {
    const out = await runTraderExitCatchup({}, {
      dry_run: false,
      now: new Date("2026-08-28T10:05:00-04:00"),
      max_ops: 1,
      held: { AMZN: { qty: 0.27239 } },
      exits: [AMZN_EXIT],
      manifests: [
        AMZN_HELD,
        { ...AMZN_HELD, trade_id: "AMZN-1780000000000-oldlot", model_status: "CLOSED" },
      ],
    });
    expect(out.claimed).toBe(2);
    expect(out.planned).toBe(1);
    expect(out.flat_dropped).toBe(1);
    expect(out.held_known).toBe(true);
    expect(out.forwarded).toBe(1);
    expect(catchupMock).toHaveBeenCalledTimes(1);
  });
});
