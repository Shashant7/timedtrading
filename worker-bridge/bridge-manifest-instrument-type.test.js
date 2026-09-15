/**
 * 2026-09-15 — Index-trend LETF sleeves were filed as OPTIONS.
 *
 * TNA / UDOW / SPYU / TQQQ are leveraged ETFs, so the index-trend mirror
 * sends ordinary share orders. But `inferInstrument` treated any non-empty
 * `vehicle` other than `equity_long` as an options structure, and the mirror
 * tags its orders `vehicle: "index_trend_letf"`. Every index-trend manifest
 * row therefore landed as `instrument_type: 'options'`, and from there:
 *
 *   - the reconciler took the options path, looked for `model_intended_legs`,
 *     found none, and parked the row at `sync_state: untracked` with
 *     "cannot leg-compare" — permanently, because the equity classifier that
 *     converges `broker_remaining_qty` to broker truth never ran;
 *   - `claimedOpenEquityByTicker` and `_readOpenClaimRowsForUser` both filter
 *     on `instrument_type = 'equity'`, so the sleeves were invisible to the
 *     sibling-claim math. TNA W36 (CLOSED) went on claiming 4 shares while
 *     W37 (OPEN) claimed 5, against a single 5-share broker position.
 *
 * Of 245 live manifest rows, the only 5 that were not classifiable were
 * exactly these index-trend rows, and all 5 were untracked.
 */
import { describe, it, expect, vi } from "vitest";
import {
  inferInstrument,
  EQUITY_MIRROR_VEHICLES,
  ensureMirrorManifestSchema,
} from "./bridge-manifest.js";
import { claimedOpenEquityByTicker } from "./bridge-reconciler.js";

describe("inferInstrument — a share vehicle is not an options structure", () => {
  it("files the index-trend LETF vehicle as equity", () => {
    const out = inferInstrument({ vehicle: "index_trend_letf", ticker: "TNA", qty: 5 });
    expect(out.instrument_type).toBe("equity");
    expect(out.options_structure).toBeNull();
  });

  it("files every share vehicle the worker actually sends as equity", () => {
    // These are the vehicle strings equity orders leave the worker with;
    // only `equity_long` and the empty case used to be recognised.
    for (const vehicle of ["shares", "equity", "equity_long", "shares_primary", "letf", "index_trend_letf"]) {
      expect(inferInstrument({ vehicle }).instrument_type, vehicle).toBe("equity");
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(inferInstrument({ vehicle: "  Index_Trend_LETF " }).instrument_type).toBe("equity");
  });

  it("still files a missing vehicle as equity", () => {
    expect(inferInstrument({}).instrument_type).toBe("equity");
    expect(inferInstrument({ vehicle: "" }).instrument_type).toBe("equity");
  });

  it("still files real options structures as options, keeping the structure", () => {
    for (const vehicle of ["long_call", "long_put", "vertical_spread", "leaps", "straddle", "moonshot"]) {
      const out = inferInstrument({ vehicle });
      expect(out.instrument_type, vehicle).toBe("options");
      expect(out.options_structure, vehicle).toBe(vehicle);
    }
  });

  it("does not let an options structure sneak into the equity set", () => {
    for (const vehicle of ["long_call", "long_put", "vertical_spread", "leaps", "straddle", "moonshot"]) {
      expect(EQUITY_MIRROR_VEHICLES.has(vehicle), vehicle).toBe(false);
    }
  });
});

describe("claimedOpenEquityByTicker — the LETF sleeve now claims its shares", () => {
  /** The live TNA pair: W36 closed at 4, W37 open at 5, broker holds 5. */
  const pair = (instrumentType) => [
    {
      ticker: "TNA",
      mode: "trader",
      instrument_type: instrumentType,
      options_structure: instrumentType === "options" ? "index_trend_letf" : null,
      model_status: "OPEN",
      broker_remaining_qty: 5,
      model_intended_qty: 5,
      trade_id: "it:IWM:TNA:LONG:2026-W37",
    },
    {
      ticker: "TNA",
      mode: "trader",
      instrument_type: instrumentType,
      options_structure: instrumentType === "options" ? "index_trend_letf" : null,
      model_status: "CLOSED",
      broker_remaining_qty: 4,
      model_intended_qty: 4,
      trade_id: "it:IWM:TNA:LONG:2026-W36",
    },
  ];

  it("claimed nothing while the sleeves were filed as options", () => {
    // The shape that produced the over-claim: the OPEN sibling contributes
    // no claim, so nothing tells the CLOSED row its shares are already
    // accounted for and its stale remaining=4 never converges.
    expect(claimedOpenEquityByTicker(pair("options")).get("TNA")).toBeUndefined();
  });

  it("claims the open sleeve's 5 shares once filed as equity", () => {
    // 5 (the open sleeve), not 9 — the CLOSED row is not double counted, so
    // the reconciler can hand W36 a residual of 0 and converge it.
    expect(claimedOpenEquityByTicker(pair("equity")).get("TNA")).toBe(5);
  });
});

describe("ensureMirrorManifestSchema — repairs rows written by the old classifier", () => {
  it("reclassifies share-vehicle options rows to equity", async () => {
    // The entry upsert is DO NOTHING on conflict and never revisits
    // instrument_type, so the five live rows cannot self-correct from a
    // later entry — they need a one-shot repair on deploy.
    const run = vi.fn(async () => ({ meta: { changes: 5 } }));
    const statements = [];
    const db = {
      prepare: (sql) => {
        const st = { sql, binds: null, bind(...a) { this.binds = a; return this; }, run };
        statements.push(st);
        return st;
      },
    };
    await ensureMirrorManifestSchema({ BRIDGE_DB: db });

    const repair = statements.find((s) => /UPDATE mirror_trade_manifest/i.test(s.sql)
      && /instrument_type = 'equity'/i.test(s.sql));
    expect(repair).toBeTruthy();
    // Scoped to rows the old classifier got wrong: options rows whose
    // structure names a share vehicle. Real options rows must not be touched.
    expect(repair.sql).toMatch(/options_structure = NULL/i);
    expect(repair.sql).toMatch(/LOWER\(COALESCE\(instrument_type, ''\)\) = 'options'/i);
    expect(repair.sql).toMatch(/options_structure.*IN \(/is);
    expect(repair.binds).toContain("index_trend_letf");
    expect(repair.binds).not.toContain("long_call");
    // sync_state is left to the reconciler, which now classifies these rows
    // on the equity path; rewriting it here would drop the reducer's
    // held_override safety net before anything had converged.
    expect(repair.sql).not.toMatch(/sync_state\s*=/i);
  });
});
