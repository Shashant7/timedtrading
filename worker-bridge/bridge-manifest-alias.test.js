// readManifestRow — legacy trade_id prefix alias
//
// KO PRE_EARNINGS trim (2026-07-27) reject_reason=no_manifest_for_trade
// tracked back to a prefix mismatch: the manifest row was written by a
// pre-normalization DCA with trade_id=inv-inv-KO-auto-<pos>, while the
// current forwardInvestorMirror looks it up as inv-KO-auto-<pos>. Every
// investor position that existed BEFORE the client_order_id fix has the
// same shape, so any first reducer against them would have hit the
// same 500-ish "no_manifest" wall.
//
// readManifestRow now transparently retries the flipped prefix so legacy
// rows keep working while new writes stay single-prefix.

import { describe, it, expect, vi } from "vitest";

function makeDb(rows) {
  const map = new Map();
  for (const r of rows) map.set(`${r.user_id}|${r.trade_id}|${r.broker_account_id}`, r);
  return {
    prepare(sql) {
      return {
        _bind: null,
        bind(...args) { this._bind = args; return this; },
        async first() {
          const [uid, tid, acct] = this._bind || [];
          return map.get(`${uid}|${tid}|${acct}`) || null;
        },
        async run() { return { success: true }; },
        async all() { return { results: [...map.values()] }; },
      };
    },
    exec: vi.fn(async () => ({})),
  };
}

const ROW = {
  user_id: "op@example.com",
  trade_id: "inv-inv-KO-auto-1782223315559",
  broker_account_id: "WB-ROTH",
  ticker: "KO",
  sync_state: "in_sync",
  broker_filled_qty: 4.04569,
  broker_remaining_qty: 4.04569,
  model_intended_qty: 4.04569,
  broker_entry_order_ids: "[]",
  mirror_suppressed: 0,
};

describe("readManifestRow — legacy inv-inv-* alias", () => {
  it("finds a legacy inv-inv-KO-* row when reader asks for inv-KO-*", async () => {
    const env = { BRIDGE_DB: makeDb([ROW]) };
    const { readManifestRow } = await import("./bridge-manifest.js");
    const found = await readManifestRow(env, "op@example.com", "inv-KO-auto-1782223315559", "WB-ROTH");
    expect(found).toBeTruthy();
    expect(found.trade_id).toBe("inv-inv-KO-auto-1782223315559");
    expect(found.broker_remaining_qty).toBe(4.04569);
  });

  it("still finds a modern inv-KO-* row directly (no alias needed)", async () => {
    const modern = { ...ROW, trade_id: "inv-KO-auto-1782223315559" };
    const env = { BRIDGE_DB: makeDb([modern]) };
    const { readManifestRow } = await import("./bridge-manifest.js");
    const found = await readManifestRow(env, "op@example.com", "inv-KO-auto-1782223315559", "WB-ROTH");
    expect(found).toBeTruthy();
    expect(found.trade_id).toBe("inv-KO-auto-1782223315559");
  });

  it("falls back the other direction: inv-inv-* lookup finds a modern inv-* row", async () => {
    const modern = { ...ROW, trade_id: "inv-KO-auto-1782223315559" };
    const env = { BRIDGE_DB: makeDb([modern]) };
    const { readManifestRow } = await import("./bridge-manifest.js");
    const found = await readManifestRow(env, "op@example.com", "inv-inv-KO-auto-1782223315559", "WB-ROTH");
    expect(found).toBeTruthy();
    expect(found.trade_id).toBe("inv-KO-auto-1782223315559");
  });

  it("returns null when neither prefix has a row (no false positives)", async () => {
    const env = { BRIDGE_DB: makeDb([]) };
    const { readManifestRow } = await import("./bridge-manifest.js");
    const found = await readManifestRow(env, "op@example.com", "inv-KO-auto-1782223315559", "WB-ROTH");
    expect(found).toBeNull();
  });

  it("does not alias non-inv trade_ids (trader trades untouched)", async () => {
    const trader = { ...ROW, trade_id: "KO-1784900000000-abc" };
    const env = { BRIDGE_DB: makeDb([trader]) };
    const { readManifestRow } = await import("./bridge-manifest.js");
    const direct = await readManifestRow(env, "op@example.com", "KO-1784900000000-abc", "WB-ROTH");
    expect(direct?.trade_id).toBe("KO-1784900000000-abc");
    const alias = await readManifestRow(env, "op@example.com", "inv-KO-1784900000000-abc", "WB-ROTH");
    expect(alias).toBeNull();
  });
});
