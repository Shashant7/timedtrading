import { describe, expect, it, vi } from "vitest";
import {
  extractChainGapCandidates,
  detectNewTickers,
  healChainGaps,
  onboardNewUniverseTickers,
  summarizeChainGapBacklog,
} from "./candle-chain-heal.js";

describe("extractChainGapCandidates", () => {
  it("extracts tickers whose freshness summary reports missing/stale tfs", () => {
    const summary = {
      stale_tickers: [
        { ticker: "bg", missing_tfs: ["10", "15", "D"], stale_tfs: [] },
        { ticker: "AAPL", missing_tfs: [], stale_tfs: ["60"] },
        { ticker: "SPX", missing_tfs: [], stale_tfs: [] },
      ],
    };
    const out = extractChainGapCandidates(summary);
    expect(out.map((c) => c.ticker)).toEqual(["BG", "AAPL"]);
    expect(out[0].needs_full_onboard).toBe(true); // has BOTH D + 10 missing
    expect(out[1].needs_full_onboard).toBe(false);
  });

  it("returns empty when summary is missing or shape is off", () => {
    expect(extractChainGapCandidates(null)).toEqual([]);
    expect(extractChainGapCandidates({})).toEqual([]);
    expect(extractChainGapCandidates({ stale_tickers: [] })).toEqual([]);
  });
});

describe("detectNewTickers", () => {
  it("uppercases + returns only tickers absent from the previous snapshot", () => {
    const news = detectNewTickers(["aapl", "MSFT", "SMCI"], ["AAPL", "MSFT"]);
    expect(news).toEqual(["SMCI"]);
  });

  it("returns empty when nothing is new", () => {
    expect(detectNewTickers(["A", "B"], ["A", "B", "C"])).toEqual([]);
  });
});

describe("summarizeChainGapBacklog", () => {
  it("does not page for normal bounded churn", () => {
    const summary = summarizeChainGapBacklog(
      [{ ticker: "A" }, { ticker: "B" }],
      { attempted: ["A", "B"], healed: [{ ticker: "A" }], failed: [] },
    );
    expect(summary.alarm_active).toBe(false);
    expect(summary.candidates_count).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it("pages when backlog reaches the documented threshold", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({ ticker: `T${i}` }));
    const summary = summarizeChainGapBacklog(candidates, {
      attempted: candidates.slice(0, 12),
      healed: [],
      failed: [{ ticker: "T0" }],
    });
    expect(summary.alarm_active).toBe(true);
    expect(summary.threshold).toBe(20);
    expect(summary.attempted).toBe(12);
    expect(summary.failed).toBe(1);
  });
});

describe("healChainGaps budget + priority + rotation", () => {
  it("attempts up to maxTickers, priority first, rotation for the tail", async () => {
    const backfill = vi.fn().mockResolvedValue({ upserted: 0 });
    const onboard = vi.fn().mockResolvedValue();
    const candidates = [
      { ticker: "T01", missing: ["D"], needs_full_onboard: false },
      { ticker: "T02", missing: ["D"], needs_full_onboard: false },
      { ticker: "T03", missing: ["D"], needs_full_onboard: false },
      { ticker: "OPEN", missing: ["D", "10"], needs_full_onboard: true },
    ];
    const res = await healChainGaps(
      {}, null, candidates, { backfill, onboard },
      { maxTickers: 3, priorityTickers: ["OPEN"], rotationOffset: 0 },
    );
    expect(res.attempted.length).toBe(3);
    expect(res.attempted[0]).toBe("OPEN");
    expect(onboard).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledTimes(2); // 2 non-onboard heals × 1 TF each
  });

  it("no-ops on empty candidate list", async () => {
    const backfill = vi.fn();
    const res = await healChainGaps({}, null, [], { backfill });
    expect(res.attempted).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });
});

describe("onboardNewUniverseTickers", () => {
  function mockKV(seed = {}) {
    const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
      store,
      async get(key, type) {
        const raw = store.get(key);
        if (!raw) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key, val) { store.set(key, val); },
    };
  }

  it("onboards new tickers and bumps the seen snapshot", async () => {
    const kv = mockKV({
      "timed:candle_chain:universe_seen": { list: ["AAPL", "MSFT"] },
    });
    const onboard = vi.fn().mockResolvedValue();
    const res = await onboardNewUniverseTickers(
      { KV_TIMED: kv }, null,
      ["AAPL", "MSFT", "SMCI", "NEWCO"],
      { onboardTicker: onboard },
      { maxOnboard: 5 },
    );
    expect(res.new_count).toBe(2);
    expect(res.onboarded).toBe(2);
    const seen = JSON.parse(kv.store.get("timed:candle_chain:universe_seen"));
    expect(seen.list.sort()).toEqual(["AAPL", "MSFT", "NEWCO", "SMCI"]);
  });

  it("returns new_count=0 when nothing is new", async () => {
    const kv = mockKV({
      "timed:candle_chain:universe_seen": { list: ["A", "B"] },
    });
    const onboard = vi.fn();
    const res = await onboardNewUniverseTickers(
      { KV_TIMED: kv }, null, ["A", "B"], { onboardTicker: onboard },
    );
    expect(res.new_count).toBe(0);
    expect(onboard).not.toHaveBeenCalled();
  });
});
