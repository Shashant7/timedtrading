import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  INDEX_FOCUS,
  buildCTORefreshTickers,
  cacheTtlForTicker,
  isPriorityTicker,
  mergeRollupResults,
  resolveScoredUniverseTickers,
} from "./cto-universe.js";

describe("cto-universe", () => {
  const env = {
    DB: {
      prepare: vi.fn((sql) => ({
        all: vi.fn(async () => {
          if (sql.includes("positions")) {
            return { results: [{ ticker: "AAPL" }, { ticker: "MSFT" }] };
          }
          if (sql.includes("user_tickers")) {
            return { results: [{ ticker: "PLTR" }] };
          }
          return { results: [] };
        }),
      })),
    },
    KV_TIMED: {
      get: vi.fn(async () => null),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves scored universe from SECTOR_MAP plus user-added tickers", async () => {
    const scored = await resolveScoredUniverseTickers(env);
    expect(scored.length).toBeGreaterThan(100);
    expect(scored).toContain("SPY");
    expect(scored).toContain("PLTR");
  });

  it("builds priority list from indices and open positions without screener", async () => {
    const { tickers, mode } = await buildCTORefreshTickers(env, { mode: "priority" });
    expect(mode).toBe("priority");
    expect(tickers).toContain("SPY");
    expect(tickers).toContain("AAPL");
    expect(tickers.every((t) => INDEX_FOCUS.has(t) || ["AAPL", "MSFT"].includes(t))).toBe(true);
  });

  it("builds full list as scored minus priority", async () => {
    const { tickers, scored } = await buildCTORefreshTickers(env, { mode: "full" });
    expect(tickers.length).toBeGreaterThan(0);
    expect(tickers.length).toBeLessThan(scored.length);
    expect(tickers).not.toContain("SPY");
    expect(tickers).not.toContain("AAPL");
  });

  it("uses 1h cache for priority and 24h for the rest", () => {
    const open = new Set(["AAPL"]);
    expect(cacheTtlForTicker("SPY", { openPositions: open })).toBe(60 * 60);
    expect(cacheTtlForTicker("AAPL", { openPositions: open })).toBe(60 * 60);
    expect(cacheTtlForTicker("KO", { openPositions: open })).toBe(24 * 60 * 60);
    expect(isPriorityTicker("KO", { openPositions: open })).toBe(false);
  });

  it("session mode adds surfaced movers to priority and exposes the extra set", async () => {
    const { tickers, mode, extra, extraSet } = await buildCTORefreshTickers(env, {
      mode: "session",
      surfaced: ["KO", "PLTR", "AAPL", "SPY", "ZZZNOTREAL"],
    });
    expect(mode).toBe("session");
    // indices + positions still present
    expect(tickers).toContain("SPY");
    expect(tickers).toContain("AAPL");
    // surfaced scored mover folded in
    expect(tickers).toContain("KO");
    expect(extra).toContain("KO");
    // surfaced names that are indices/positions OR not scored are NOT in extra
    expect(extra).not.toContain("SPY");
    expect(extra).not.toContain("AAPL");
    expect(extra).not.toContain("ZZZNOTREAL");
    expect(extraSet.has("KO")).toBe(true);
  });

  it("session mode is capped and gives surfaced movers the 1h TTL via extra", () => {
    const open = new Set(["AAPL"]);
    const extra = new Set(["KO"]);
    // KO would be 24h normally, but surfaced (extra) => 1h
    expect(cacheTtlForTicker("KO", { openPositions: open, extra })).toBe(60 * 60);
    expect(isPriorityTicker("KO", { openPositions: open, extra })).toBe(true);
    // a non-surfaced, non-priority name is still 24h
    expect(cacheTtlForTicker("XLU", { openPositions: open, extra })).toBe(24 * 60 * 60);
  });

  it("merges hourly priority rows without dropping prior rollup entries", () => {
    const universe = ["SPY", "KO", "AAPL"];
    const processed = [{ ticker: "SPY", ok: true, narrative: "fresh spy" }];
    const previous = {
      results: [
        { ticker: "KO", ok: true, narrative: "cached ko" },
        { ticker: "AAPL", ok: true, narrative: "cached aapl" },
      ],
    };
    const merged = mergeRollupResults(universe, processed, previous);
    expect(merged.map((r) => r.ticker)).toEqual(["SPY", "KO", "AAPL"]);
    expect(merged.find((r) => r.ticker === "SPY").narrative).toBe("fresh spy");
    expect(merged.find((r) => r.ticker === "KO").narrative).toBe("cached ko");
  });
});
