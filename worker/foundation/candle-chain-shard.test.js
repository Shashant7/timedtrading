// worker/foundation/candle-chain-shard.test.js
import { describe, it, expect } from "vitest";
import { CandleChainShardCore, shardForTicker } from "./candle-chain-shard.js";
import { expectedIntradayBuckets, sessionBoundsUtc } from "./trading-calendar.js";

function memStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(prefix) { const r = new Map(); for (const [k, v] of m) if (k.startsWith(prefix)) r.set(k, v); return r; },
  };
}
function session5m(dateStr) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({ ts, o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i + 0.2, v: 10 }));
}

describe("shard assignment", () => {
  it("is deterministic and within range", () => {
    expect(shardForTicker("AAPL", 16)).toBe(shardForTicker("aapl", 16));
    for (const t of ["AAPL", "MU", "GS", "TSLA", "XLE"]) {
      const s = shardForTicker(t, 16);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(16);
    }
  });
  it("spreads a universe across shards (not all in one)", () => {
    const universe = ["AA","AAPL","CLS","FSLR","GS","MU","NFLX","SNDK","TSLA","XLE","DE","TT","OKE","PWR","NXT","BG"];
    const used = new Set(universe.map((t) => shardForTicker(t, 8)));
    expect(used.size).toBeGreaterThan(1);
  });
});

describe("shard core: ingest + derive", () => {
  const DAY = "2026-06-12";
  const { openMs, closeMs } = sessionBoundsUtc(DAY);

  it("ingests 5m chunked by session and derives a complete 30m view", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("AAPL", "5", session5m(DAY));
    // stored as one session chunk
    expect((await core.storage.list("b5:AAPL:")).size).toBe(1);

    const v = await core.getSeries("AAPL", "30", { startMs: openMs, endMs: closeMs, asOf: closeMs });
    expect(v.tf).toBe("30");
    expect(v.bars.length).toBe(13);
    expect(v.complete).toBe(true);
  });

  it("ingest is idempotent (re-ingest same bars → same base length)", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("MU", "5", session5m(DAY));
    await core.ingest("MU", "5", session5m(DAY));
    const base = await core.loadBase5("MU", openMs, closeMs);
    expect(base.length).toBe(78);
  });

  it("integrity flags a missing 5m bucket as a heal range", async () => {
    const core = new CandleChainShardCore(memStorage());
    const bars = session5m(DAY).filter((b, i) => i !== 20);
    await core.ingest("GS", "5", bars);
    const integ = await core.integrity("GS", { startMs: openMs, endMs: closeMs });
    expect(integ.complete).toBe(false);
    expect(integ.healRanges.length).toBe(1);
  });

  it("derives D/W/M from the stored daily base", async () => {
    const core = new CandleChainShardCore(memStorage());
    const daily = Array.from({ length: 40 }, (_, d) => ({ ts: Date.UTC(2026, 2, 16) + d * 7 * 86400000, o: d, h: d + 1, l: d - 1, c: d, v: 1 }));
    await core.ingest("TSLA", "D", daily);
    const vd = await core.getSeries("TSLA", "D", { startMs: daily[0].ts, endMs: daily[daily.length - 1].ts + 1, asOf: Date.now() });
    expect(vd.bars.length).toBe(40);
  });

  it("normalizes daily ts to the canonical anchor + dedups the 00:00Z/04:00Z double-write", async () => {
    const core = new CandleChainShardCore(memStorage());
    const day = Date.UTC(2026, 5, 1); // 2026-06-01 00:00 UTC
    // legacy dual-write: same trading day stamped at 00:00Z AND 00:00 ET (04:00Z),
    // plus a session-open (13:30Z) stamp — all are the SAME trading day.
    await core.ingest("AAPL", "D", [
      { ts: day, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { ts: day + 4 * 3600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { ts: day + 13.5 * 3600000, o: 1, h: 2, l: 0.5, c: 1.9, v: 11 }, // last write wins
    ]);
    const base = await core.loadBaseDaily("AAPL");
    expect(base.length).toBe(1);               // collapsed to one bar
    expect(base[0].ts).toBe(day);              // canonical 00:00 UTC anchor
    expect(base[0].c).toBe(1.9);               // last write wins on dedup
    // re-ingest is idempotent (no second bar appears)
    await core.ingest("AAPL", "D", [{ ts: day + 4 * 3600000, o: 1, h: 2, l: 0.5, c: 1.9, v: 11 }]);
    expect((await core.loadBaseDaily("AAPL")).length).toBe(1);
  });

  it("listTickers returns held tickers", async () => {
    const core = new CandleChainShardCore(memStorage());
    await core.ingest("AAPL", "5", session5m(DAY));
    await core.ingest("MU", "5", session5m(DAY));
    expect(await core.listTickers()).toEqual(["AAPL", "MU"]);
  });
});

describe("shard core: base-fidelity shadow gate", () => {
  const DAY = "2026-06-12";
  const { openMs, closeMs } = sessionBoundsUtc(DAY);
  // a faithful daily bar = exact rollup of the 5m session, stamped at 00:00 UTC
  function trueDailyFromSession(dateStr, bars) {
    let o = bars[0].o, h = bars[0].h, l = bars[0].l, c = bars[bars.length - 1].c, v = 0;
    for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; v += b.v; }
    return { ts: Date.UTC(2026, 5, 12), o, h, l, c, v };
  }

  it("is DORMANT by default (no gate runs, no fid: key written)", async () => {
    const core = new CandleChainShardCore(memStorage());
    const res = await core.ingest("AAPL", "5", session5m(DAY));
    expect(res.fidelity).toBeUndefined();
    expect(await core.lastFidelity("AAPL")).toBeNull();
  });

  it("gateOnIngest runs the shadow gate and records a report without blocking the write", async () => {
    const core = new CandleChainShardCore(memStorage(), { gateOnIngest: true });
    const s5 = session5m(DAY);
    await core.ingest("AAPL", "D", [trueDailyFromSession(DAY, s5)]);
    const res = await core.ingest("AAPL", "5", s5);
    expect(res.written).toBe(78);                 // write still happened
    expect(res.fidelity).toBeDefined();
    expect(res.fidelity.reconcile.ok).toBe(true); // 5m rollup matches the daily H/L/V
    expect((await core.lastFidelity("AAPL")).reconcile.ok).toBe(true);
  });

  it("flags a base gap via the reconcile report (shadow, still ok=false but no throw)", async () => {
    const core = new CandleChainShardCore(memStorage());
    const s5 = session5m(DAY);
    const provDaily = trueDailyFromSession(DAY, s5);   // provider saw the full day
    await core.ingest("MU", "D", [provDaily]);
    await core.ingest("MU", "5", s5.filter((b, i) => i !== s5.length - 1)); // drop the high bar
    const report = await core.runShadowGate("MU", { startMs: openMs, endMs: closeMs });
    expect(report.reconcile.ok).toBe(false);
    expect(report.reconcile.mismatches.some((m) => m.field === "high")).toBe(true);
  });

  it("cross-source consensus flags a disagreeing alternate provider", async () => {
    const core = new CandleChainShardCore(memStorage());
    const day = Date.UTC(2026, 5, 1);
    await core.ingest("GS", "D", [{ ts: day, o: 1000, h: 1036.92, l: 1000.45, c: 1035.64, v: 1 }]);
    const report = await core.baseFidelity("GS", { startMs: day, endMs: day + 86400000 }, {
      altDaily: {
        alpaca: [{ ts: day + 4 * 3600000, h: 1036.9, l: 1000.45, c: 1035.64, v: 1 }],  // agrees (rel band)
        bad:    [{ ts: day, h: 1100, l: 1000.45, c: 1035.64, v: 1 }],                  // H way off
      },
    });
    expect(report.consensus.days).toBe(1);
    expect(report.consensus.outlier_counts.bad).toBe(1);
    expect(report.consensus.outlier_counts.chain).toBeUndefined();
  });

  it("shadow gate NEVER throws even on a broken storage read", async () => {
    const core = new CandleChainShardCore(memStorage());
    core.loadBase5 = async () => { throw new Error("storage exploded"); };
    const report = await core.runShadowGate("AAPL", { startMs: 0, endMs: 1 });
    expect(report.ok).toBeNull();
    expect(report.error).toContain("storage exploded");
  });
});

describe("shard core: bounded retention", () => {
  it("drops session chunks older than the hot window", async () => {
    const core = new CandleChainShardCore(memStorage(), { retentionTradingDays: 5 });
    await core.ingest("AAPL", "5", session5m("2026-01-05")); // old
    await core.ingest("AAPL", "5", session5m("2026-06-12")); // recent
    expect((await core.storage.list("b5:AAPL:")).size).toBe(2);
    const res = await core.retentionSweep("AAPL", sessionBoundsUtc("2026-06-12").closeMs);
    expect(res.dropped.length).toBe(1);
    expect(res.dropped[0]).toContain("2026-01-05");
    expect((await core.storage.list("b5:AAPL:")).size).toBe(1);
  });
});
