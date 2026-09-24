// The slim `timed:all:snapshot` index.
//
// Background for anyone reading a failure here: the snapshot used to hold the
// full scoring payload per ticker. On 2026-08-14 it reached 26,195,645 bytes
// against KV's 26,214,400-byte value ceiling, every write after that was
// rejected, and the blob served 40-day-old scores to every reader that had no
// freshness gate. Rebuilding it also cost ~182 MB of heap in a 128 MB isolate,
// which is what put tt-engine's five-minute scoring tick into
// `outcome: exceededMemory`.
//
// So these tests pin the three things that stop that recurring: the projection
// stays slim, the build degrades instead of blowing the budget, and a reader
// cannot accidentally accept a stale index.

import { describe, it, expect, vi } from "vitest";
import {
  ALL_SNAPSHOT_KEY,
  ALL_SNAPSHOT_SCHEMA,
  ALL_SNAPSHOT_FIELDS,
  ALL_SNAPSHOT_MAX_BYTES,
  projectAllSnapshotRow,
  projectSnapshotPatch,
  isAllSnapshotField,
  applySnapshotEnrichment,
  buildAllSnapshot,
  allSnapshotEnvelope,
  isSlimAllSnapshot,
  readAllSnapshot,
  hydrateSnapshotRows,
  selectAndHydrate,
} from "./all-snapshot.js";
import { extractSliceFields } from "./trust-spine/plays-today.js";

/** The detail-view fields that are 60% of a payload's bytes. */
const DETAIL_FIELDS = [
  "tf_tech", "_tickerProfile", "_journey", "atr_levels", "regime_forecast",
  "move_phase_profile", "td_sequential", "confluence_verdict",
  "__entry_setup_snapshot",
];

function payload(sym, extra = {}) {
  return {
    ticker: sym,
    price: 100.5,
    prev_close: 99,
    day_change: 1.5,
    day_change_pct: 1.51,
    rank: 72,
    state: "BULL_MOMENTUM",
    kanban_stage: "accumulate",
    direction: "LONG",
    sl: 96,
    tp: 110,
    ts: 1700000000000,
    entry_quality: { score: 8.1, reasons: ["a".repeat(400)] },
    // The bulk a real payload carries and the index must not.
    tf_tech: { blob: "x".repeat(27000) },
    _journey: { blob: "y".repeat(7800) },
    _tickerProfile: { blob: "z".repeat(4000) },
    ...extra,
  };
}

describe("projectAllSnapshotRow", () => {
  it("drops the detail blobs that pushed the snapshot into the KV ceiling", () => {
    const row = projectAllSnapshotRow("NVDA", payload("NVDA"));
    for (const f of DETAIL_FIELDS) expect(row[f]).toBeUndefined();
  });

  it("is two orders of magnitude smaller than the payload it projects", () => {
    const p = payload("NVDA");
    const full = JSON.stringify(p).length;
    const slim = JSON.stringify(projectAllSnapshotRow("NVDA", p)).length;
    expect(slim).toBeLessThan(full / 50);
  });

  it("keeps what the cards, the rail and the movers bar render", () => {
    const row = projectAllSnapshotRow("NVDA", payload("NVDA"));
    expect(row.price).toBe(100.5);
    expect(row.prev_close).toBe(99);
    expect(row.day_change_pct).toBe(1.51);
    expect(row.rank).toBe(72);
    expect(row.kanban_stage).toBe("accumulate");
    expect(row.sl).toBe(96);
    expect(row.tp).toBe(110);
  });

  it("flattens entry_quality to a scalar but leaves .score resolvable", () => {
    const row = projectAllSnapshotRow("NVDA", payload("NVDA"));
    expect(row.entry_quality_score).toBe(8.1);
    expect(row.entry_quality.score).toBe(8.1);
    expect(row.entry_quality.reasons).toBeUndefined();
  });

  it("only copies fields that are actually present, so a barely-scored ticker stays tiny", () => {
    const row = projectAllSnapshotRow("XYZ", { ticker: "XYZ", price: 4 });
    expect(Object.keys(row).sort()).toEqual(["price", "ticker"]);
  });

  it("names the ticker even when the payload does not", () => {
    expect(projectAllSnapshotRow("amd", { price: 1 }).ticker).toBe("AMD");
  });

  it("refuses a non-object", () => {
    expect(projectAllSnapshotRow("X", null)).toBeNull();
    expect(projectAllSnapshotRow("X", "nope")).toBeNull();
  });
});

describe("the projection covers every reader that scans the whole universe", () => {
  // /timed/plays/today filters and builds the Today queue off the index
  // alone. If extractSliceFields needs a field the index does not carry, the
  // queue silently empties -- so assert on the extractor, not on a list.
  it("satisfies extractSliceFields from a projected row", () => {
    const rich = payload("NVDA", {
      _model_lifecycle: { state: "queued", label: "Queued", why: "curl" },
      _model_play: { play_vehicle: "shares", why: "trend" },
      setup_gates: { stack_full_confirm: { fires: true }, gate_runway_full: { fires: true } },
      _business_character: { archetype: "compounder", lens_summary: "trend" },
      __conviction_tier: "A",
      __conviction_score: 91,
      setup_sequences: [{ status: "entry_ready" }],
      setup_shadow_posture: { posture: "lean_long" },
      confluence_mode: "RIDE",
      _sequence_queue_proposal: { family: "tt_cloud_pivot", state: "queued", size_mult: 0.1 },
      tt_cloud_pivot: true,
      setup_gate_shadow: true,
      _cloud_magnet: { px: 108, label: "1h_5_12" },
      _cloud_session_plan: { note: "if 10m holds" },
      _cloud_leader_follow: { leader: "SPY", direction: "LONG" },
    });
    const fromRow = extractSliceFields(projectAllSnapshotRow("NVDA", rich));
    const fromPayload = extractSliceFields(rich);
    expect(fromRow).toEqual(fromPayload);
    expect(fromRow.confirm_stack).toBe(true);
    expect(fromRow.conviction_tier).toBe("A");
    expect(fromRow.sequence_entry_ready).toBe(true);
    expect(fromRow.business_character).toBe("compounder");
    expect(fromRow.cloud_magnet.px).toBe(108);
    expect(fromRow.leader_follow.leader).toBe("SPY");
  });

  it("carries the fields the Today scan filters on", () => {
    for (const f of [
      "kanban_stage", "_model_lifecycle", "setup_gates", "flags",
      "__pullback_confirmed", "tt_cloud_pivot", "_sequence_queue_proposal",
      "_cloud_pivot_detect", "momentum_continuation", "_continuation_detect",
    ]) {
      expect(isAllSnapshotField(f), `${f} must be scannable across the universe`).toBe(true);
    }
  });

  it("does not carry a detail blob", () => {
    for (const f of DETAIL_FIELDS) expect(isAllSnapshotField(f)).toBe(false);
  });

  it("has no duplicate field names", () => {
    expect(new Set(ALL_SNAPSHOT_FIELDS).size).toBe(ALL_SNAPSHOT_FIELDS.length);
  });
});

describe("buildAllSnapshot", () => {
  const reader = (store) => (sym) => Promise.resolve(store[sym] || null);

  it("reads one payload at a time and never holds two", async () => {
    const store = { A: payload("A"), B: payload("B"), C: payload("C") };
    let live = 0;
    let peak = 0;
    const built = await buildAllSnapshot(["A", "B", "C"], async (sym) => {
      live++;
      peak = Math.max(peak, live);
      const p = store[sym];
      live--;
      return p;
    });
    expect(peak).toBe(1);
    expect(built.count).toBe(3);
  });

  it("omits rows instead of busting the budget, so the write still lands", async () => {
    const store = { A: payload("A"), B: payload("B"), C: payload("C") };
    const oneRow = JSON.stringify(projectAllSnapshotRow("A", store.A)).length;
    const built = await buildAllSnapshot(["A", "B", "C"], reader(store), {
      byteBudget: oneRow * 2,
    });
    expect(built.count).toBe(1);
    expect(built.omitted).toBe(2);
    expect(built.bytes).toBeLessThanOrEqual(oneRow * 2);
  });

  it("stays far under the KV value ceiling at 330 tickers", async () => {
    const syms = Array.from({ length: 330 }, (_, i) => `T${i}`);
    const store = Object.fromEntries(syms.map((s) => [s, payload(s)]));
    const built = await buildAllSnapshot(syms, reader(store));
    const wire = JSON.stringify(allSnapshotEnvelope(built)).length;
    expect(built.count).toBe(330);
    // KV's hard limit is 26,214,400. The 2026-08-14 blob was 26,195,645.
    expect(wire).toBeLessThan(26214400 / 4);
    expect(built.bytes).toBeLessThan(ALL_SNAPSHOT_MAX_BYTES);
  });

  it("skips a symbol whose read throws rather than losing the build", async () => {
    const store = { A: payload("A"), C: payload("C") };
    const built = await buildAllSnapshot(["A", "B", "C"], async (sym) => {
      if (sym === "B") throw new Error("kv timeout");
      return store[sym];
    });
    expect(Object.keys(built.data).sort()).toEqual(["A", "C"]);
  });

  it("dedupes and upper-cases the requested symbols", async () => {
    const store = { A: payload("A") };
    const built = await buildAllSnapshot(["a", "A", "", null], reader(store));
    expect(built.count).toBe(1);
    expect(built.data.A).toBeTruthy();
  });

  it("hands onRow the slim row and the full payload, and keeps the mutation", async () => {
    const store = { A: payload("A") };
    const seen = [];
    const built = await buildAllSnapshot(["A"], reader(store), {
      onRow: (sym, row, full) => {
        seen.push([sym, !!full.tf_tech, !!row.tf_tech]);
        row._sparkline = [1, 2, 3];
      },
    });
    expect(seen).toEqual([["A", true, false]]);
    expect(built.data.A._sparkline).toEqual([1, 2, 3]);
  });

  it("survives an onRow that throws", async () => {
    const built = await buildAllSnapshot(["A"], reader({ A: payload("A") }), {
      onRow: () => { throw new Error("enrichment blew up"); },
    });
    expect(built.count).toBe(1);
  });

  it("counts the enrichment onRow added toward the byte budget", async () => {
    const store = { A: payload("A"), B: payload("B") };
    const bare = await buildAllSnapshot(["A", "B"], reader(store));
    const fat = await buildAllSnapshot(["A", "B"], reader(store), {
      onRow: (_s, row) => { row._sparkline = Array(200).fill(1.2345); },
    });
    expect(fat.bytes).toBeGreaterThan(bare.bytes);
  });
});

describe("allSnapshotEnvelope / isSlimAllSnapshot", () => {
  it("stamps the schema so a reader can tell a slim index from a legacy blob", () => {
    const env = allSnapshotEnvelope({ data: { A: { ticker: "A" } }, count: 1, bytes: 20 });
    expect(env.schema).toBe(ALL_SNAPSHOT_SCHEMA);
    expect(isSlimAllSnapshot(env)).toBe(true);
    expect(env.built_at).toBeGreaterThan(0);
  });

  it("does not mistake a pre-migration full blob for a slim index", () => {
    expect(isSlimAllSnapshot({ data: {}, built_at: Date.now() })).toBe(false);
    expect(isSlimAllSnapshot(null)).toBe(false);
  });

  it("reports the omitted count only when rows were dropped", () => {
    expect(allSnapshotEnvelope({ data: {}, omitted: 0 }).omitted).toBeUndefined();
    expect(allSnapshotEnvelope({ data: {}, omitted: 3 }).omitted).toBe(3);
  });

  it("counts the rows when the builder did not", () => {
    expect(allSnapshotEnvelope({ data: { A: {}, B: {} } }).count).toBe(2);
  });
});

describe("readAllSnapshot", () => {
  const kvWith = (value) => ({ get: vi.fn(async () => (value == null ? null : JSON.stringify(value))) });

  it("refuses the 40-day-old blob that froze on 2026-08-14", async () => {
    const wedged = Date.parse("2026-08-14T08:03:11.385Z");
    const kv = kvWith({ data: { NVDA: { price: 225.3 } }, built_at: wedged, schema: ALL_SNAPSHOT_SCHEMA });
    const got = await readAllSnapshot(kv, {
      maxAgeMs: 6 * 3600 * 1000,
      nowMs: wedged + (40 * 86400000),
    });
    expect(got).toBeNull();
  });

  it("serves an index inside the caller's window", async () => {
    const now = 1_800_000_000_000;
    const kv = kvWith({ data: { NVDA: {} }, built_at: now - 60_000, schema: ALL_SNAPSHOT_SCHEMA });
    expect(await readAllSnapshot(kv, { maxAgeMs: 6 * 3600 * 1000, nowMs: now })).toBeTruthy();
  });

  it("refuses a blob with no built_at when the caller asked for freshness", async () => {
    const kv = kvWith({ data: { NVDA: {} } });
    expect(await readAllSnapshot(kv, { maxAgeMs: 1000 })).toBeNull();
  });

  it("reads the canonical key", async () => {
    const kv = kvWith({ data: {}, built_at: Date.now() });
    await readAllSnapshot(kv, { maxAgeMs: 1000 });
    expect(kv.get).toHaveBeenCalledWith(ALL_SNAPSHOT_KEY);
  });

  it("refuses a pre-slim blob on SIZE, without paying to parse it", async () => {
    // A 26 MB legacy blob parses to ~38 MB of object graph, and then gets
    // refused on age anyway. Refuse it on size first so no reader pays that
    // just to learn the value is stale.
    const oversized = `{"data":{"X":{"pad":"${"y".repeat(13 * 1024 * 1024)}"}},"built_at":${Date.now()}}`;
    const parse = vi.spyOn(JSON, "parse");
    try {
      const got = await readAllSnapshot({ get: async () => oversized }, { maxAgeMs: 6 * 3600 * 1000 });
      expect(got).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("returns null on unparseable, empty or missing KV rather than throwing", async () => {
    expect(await readAllSnapshot(null, { maxAgeMs: 1 })).toBeNull();
    expect(await readAllSnapshot(kvWith(null), { maxAgeMs: 1 })).toBeNull();
    expect(await readAllSnapshot({ get: async () => "{oops" }, { maxAgeMs: 1 })).toBeNull();
    expect(await readAllSnapshot(kvWith({ count: 0 }), { maxAgeMs: 1 })).toBeNull();
  });
});

describe("hydrateSnapshotRows", () => {
  it("caps a careless caller so it cannot pull the universe", async () => {
    const reads = [];
    const out = await hydrateSnapshotRows(null, Array.from({ length: 500 }, (_, i) => `T${i}`), {
      limit: 60,
      chunkSize: 25,
      readPayload: async (sym) => { reads.push(sym); return { ticker: sym }; },
    });
    expect(reads.length).toBe(60);
    expect(Object.keys(out).length).toBe(60);
  });

  it("chunks the reads instead of firing them all at once", async () => {
    let live = 0;
    let peak = 0;
    await hydrateSnapshotRows(null, Array.from({ length: 50 }, (_, i) => `T${i}`), {
      chunkSize: 10,
      limit: 50,
      readPayload: async (sym) => {
        live++;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live--;
        return { ticker: sym };
      },
    });
    expect(peak).toBeLessThanOrEqual(10);
  });

  it("keeps the rest of a chunk when one read rejects", async () => {
    const out = await hydrateSnapshotRows(null, ["A", "B", "C"], {
      readPayload: async (sym) => {
        if (sym === "B") throw new Error("nope");
        return { ticker: sym };
      },
    });
    expect(Object.keys(out).sort()).toEqual(["A", "C"]);
  });

  it("reads timed:latest per ticker by default, not the blob", async () => {
    const keys = [];
    const KV = { get: async (k) => { keys.push(k); return JSON.stringify({ ticker: "A" }); } };
    await hydrateSnapshotRows(KV, ["A", "B"]);
    expect(keys).toEqual(["timed:latest:A", "timed:latest:B"]);
  });

  it("dedupes and upper-cases", async () => {
    const reads = [];
    await hydrateSnapshotRows(null, ["a", "A", "b", null, ""], {
      readPayload: async (sym) => { reads.push(sym); return { ticker: sym }; },
    });
    expect(reads).toEqual(["A", "B"]);
  });
});

describe("selectAndHydrate", () => {
  it("returns the slim row with the full payload merged over it", async () => {
    const snapshot = allSnapshotEnvelope({
      data: { A: { ticker: "A", price: 10, _sparkline: [1, 2] }, B: { ticker: "B", price: 20 } },
    });
    const out = await selectAndHydrate(null, snapshot, () => ["A"], {
      readPayload: async (sym) => ({ ticker: sym, tf_tech: { deep: true } }),
    });
    expect(out.length).toBe(1);
    expect(out[0]._sparkline).toEqual([1, 2]);
    expect(out[0].tf_tech.deep).toBe(true);
  });
});

describe("projectSnapshotPatch", () => {
  it("keeps a thin-slice stamp from growing the index back toward the ceiling", () => {
    const patch = projectSnapshotPatch({
      kanban_stage: "act_now",
      rank: 91,
      tf_tech: { blob: "x".repeat(27000) },
      __entry_setup_snapshot: { blob: "y".repeat(9000) },
    });
    expect(patch).toEqual({ kanban_stage: "act_now", rank: 91 });
  });

  it("returns null when nothing in the patch belongs in the index", () => {
    expect(projectSnapshotPatch({ tf_tech: {} })).toBeNull();
    expect(projectSnapshotPatch(null)).toBeNull();
  });
});

describe("applySnapshotEnrichment", () => {
  it("hands the build's live-price overlay to a payload read back from KV", () => {
    // The D1 sync used to inherit this for free by mutating the same objects.
    // It reads payloads back now, so without this D1 serves scoring-time price.
    const full = { ticker: "A", price: 100, prev_close: 99 };
    applySnapshotEnrichment(full, {
      price: 104.2, close: 104.2, prev_close: 101, day_change: 3.2,
      day_change_pct: 3.17, _sparkline: [1, 2, 3], investor_stage: "MARKUP",
      _cloud_leader_follow: { leader: "SPY" },
    });
    expect(full.price).toBe(104.2);
    expect(full.prev_close).toBe(101);
    expect(full.day_change_pct).toBe(3.17);
    expect(full._sparkline).toEqual([1, 2, 3]);
    expect(full.investor_stage).toBe("MARKUP");
    expect(full._cloud_leader_follow.leader).toBe("SPY");
  });

  it("leaves a payload field alone when the row has nothing to say", () => {
    const full = { ticker: "A", price: 100, investor_stage: "ACCUM" };
    applySnapshotEnrichment(full, { rank: 4 });
    expect(full.price).toBe(100);
    expect(full.investor_stage).toBe("ACCUM");
  });

  it("tolerates a missing row or payload", () => {
    expect(applySnapshotEnrichment(null, { price: 1 })).toBeNull();
    expect(applySnapshotEnrichment({ price: 1 }, null).price).toBe(1);
  });
});
