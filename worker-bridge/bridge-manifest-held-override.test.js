import { describe, it, expect } from "vitest";
import { manifestAwareReducerCheck, evaluateReducerAgainstPositions } from "./bridge-guards.js";

function makeManifestDb(row) {
  return {
    prepare(sql) {
      const isSelect = /^\s*SELECT/i.test(String(sql || ""));
      return {
        bind() { return this; },
        async run() { return { success: true }; },
        async first() { return isSelect ? row : null; },
        async all() { return { results: isSelect && row ? [row] : [] }; },
      };
    },
  };
}

const user = {
  user_id: "op@x.com#webull#main",
  broker: "webull",
  webull_account_id: "WB-MAIN",
};

const baseRow = {
  user_id: user.user_id,
  trade_id: "DPZ-1788443309854-hlxfbubhx",
  broker_account_id: "WB-MAIN",
  model_intended_qty: 0.8285,
  broker_entry_order_ids: JSON.stringify(["wb-1"]),
};

describe("manifestAwareReducerCheck — a sleeve that still holds shares is always reducible", () => {
  it("allows EXIT on a rejected + mirror_suppressed sleeve with broker_remaining_qty > 0 (DPZ 0.2714)", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "rejected",
        mirror_suppressed: 1,
        mirror_suppressed_reason: "insufficient_cash_for_one_unit_0_lt_346.75",
        broker_filled_qty: 0.2714,
        broker_remaining_qty: 0.2714,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBe(true);
    expect(r.broker_remaining_qty).toBeCloseTo(0.2714, 6);
    expect(r.held_override_reason).toMatch(/^mirror_suppressed:insufficient_cash/);
  });

  it("allows TRIM on a mothership_orphan sleeve that still shows remaining qty", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        trade_id: "TSLA-1",
        sync_state: "mothership_orphan",
        mirror_suppressed: 0,
        broker_filled_qty: 0.44542,
        broker_remaining_qty: 0.22271,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: "TSLA-1", ticker: "TSLA", side: "trim", qty: 0.95,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBe(true);
    expect(r.held_override_reason).toBe("sync_state:mothership_orphan");
  });

  it("still rejects a suppressed sleeve that holds nothing", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "rejected",
        mirror_suppressed: 1,
        mirror_suppressed_reason: "account_equity_unknown_sync_required",
        broker_filled_qty: 0,
        broker_remaining_qty: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toMatch(/^mirror_suppressed:/);
  });

  it("in_sync rows keep the normal path (no held_override flag)", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "in_sync",
        mirror_suppressed: 0,
        broker_filled_qty: 0.8285,
        broker_remaining_qty: 0.8285,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBeUndefined();
  });
});

// 2026-09-15 — The index-trend lane's REDUCE side had never been observed
// firing: the mirror log held 118 skipped BUYs + 2 placed BUYs and zero
// reduce rows. Its sleeves all sat at `sync_state: untracked` (because the
// rows were misfiled as options, fixed separately), and `untracked` is in
// the reducer's BLOCKED set. The lane is in fact reducible via the
// held-override, but nothing pinned that, so a change to the blocked-state
// handling could have silently stranded every index-trend exit.
describe("manifestAwareReducerCheck — an untracked index-trend sleeve can still exit", () => {
  const letfRow = {
    user_id: user.user_id,
    trade_id: "it:IWM:TNA:LONG:2026-W37",
    broker_account_id: "WB-MAIN",
    model_intended_qty: 5,
    broker_entry_order_ids: JSON.stringify(["wb-letf-1"]),
    sync_state: "untracked",
    mirror_suppressed: 0,
    broker_filled_qty: 5,
    broker_remaining_qty: 5,
  };

  it("allows a full EXIT on the live TNA W37 sleeve", async () => {
    const env = { BROKER_MANIFEST_ENFORCE: "on", BRIDGE_DB: makeManifestDb({ ...letfRow }) };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: letfRow.trade_id, ticker: "TNA", side: "exit", qty: 5,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBe(true);
    expect(r.held_override_reason).toBe("sync_state:untracked");
  });

  it("allows a partial TRIM on the same sleeve", async () => {
    const env = { BROKER_MANIFEST_ENFORCE: "on", BRIDGE_DB: makeManifestDb({ ...letfRow }) };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: letfRow.trade_id, ticker: "TNA", side: "trim", qty: 1.25,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.broker_remaining_qty).toBe(5);
  });

  it("blocks a TRIM once the sleeve is genuinely flat", async () => {
    // A trim needs a tracked position to size against, and `untracked` is in
    // the reduce REJECT set, so with nothing held there is no override to
    // carry it. This is the one index-trend reduce the manifest does stop.
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...letfRow,
        trade_id: "it:IWM:TNA:LONG:2026-W36",
        broker_remaining_qty: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: "it:IWM:TNA:LONG:2026-W36", ticker: "TNA", side: "trim", qty: 1,
    }, user);
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toBe("reducer_blocked_by_sync_state:untracked");
  });

  it("lets a full EXIT through even on a flat sleeve, and the position guard stops it", async () => {
    // `untracked` is in the close PROCEED set, so the stale W36 claim does
    // not bounce here — by design, since a flatten should always be able to
    // chase shares the manifest has lost track of. The protection against
    // acting on that stale claim is the live-position guard, not the
    // manifest, which is what keeps the W36 4 + W37 5 over-claim against a
    // single 5-share position from ever reaching the broker as 9 shares.
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...letfRow,
        trade_id: "it:IWM:TNA:LONG:2026-W36",
        broker_remaining_qty: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: "it:IWM:TNA:LONG:2026-W36", ticker: "TNA", side: "exit", qty: 4,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.manifest_sync_state).toBe("untracked");

    // Broker holds 5 for the whole ticker; W36's stale claim of 4 would be
    // an oversell on top of W37's live 5. Flat means reject, over means clamp.
    expect(evaluateReducerAgainstPositions({
      ticker: "TNA", requestedQty: 4, positions: [],
    })).toMatchObject({ action: "reject", reason: "no_broker_position" });
    expect(evaluateReducerAgainstPositions({
      ticker: "TNA", requestedQty: 9, positions: [{ symbol: "TNA", qty: 5 }],
    })).toMatchObject({ action: "clamp", clampQty: 5 });
  });
});
