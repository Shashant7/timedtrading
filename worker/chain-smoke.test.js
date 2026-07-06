// worker/chain-smoke.test.js — B2 end-to-end chain smoke contract.

import { describe, it, expect } from "vitest";
import { runChainSmoke } from "./chain-smoke.js";

const NOW = Date.parse("2026-07-06T15:00:00Z"); // Mon 11:00 ET — RTH
const MIN = 60 * 1000;

const RTH_SESSION = { market_open: true, within_operating_hours: true, session_type: "RTH", is_holiday: false, source: "test" };
const CLOSED_SESSION = { market_open: false, within_operating_hours: false, session_type: "CLOSED", is_holiday: true, source: "test" };

function healthyEnv(overrides = {}) {
  const feedRow = { p: 600, t: NOW - 1 * MIN, p_ts: NOW - 2 * MIN, q_ts: NOW - 2 * MIN };
  const latest = {
    ticker: "SPY", price: 600, _live_price: 600.5,
    ingest_ts: NOW - 4 * MIN,
    _freshness: { grade: "FRESH", enforced: true },
  };
  const kvBlobs = {
    "timed:prices": { prices: { SPY: feedRow } },
    "timed:latest:SPY": latest,
    ...(overrides.kvBlobs || {}),
  };
  const candleNewest = overrides.candleNewest ?? {
    "SPY:10": NOW - 5 * MIN,
    "SPY:30": NOW - 20 * MIN,
  };
  return {
    KV_TIMED: {
      async get(key, type) {
        const v = kvBlobs[key];
        if (v === undefined) return null;
        return type === "json" ? v : JSON.stringify(v);
      },
    },
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: Object.entries(candleNewest).map(([k, ts]) => {
                    const [ticker, tf] = k.split(":");
                    return { ticker, tf, newest: ts };
                  }),
                };
              },
            };
          },
        };
      },
    },
  };
}

const OPTS = { nowMs: NOW, sentinels: ["SPY"], session: RTH_SESSION };

describe("runChainSmoke", () => {
  it("healthy chain → ok with all links ok", async () => {
    const res = await runChainSmoke(healthyEnv(), OPTS);
    expect(res.ok).toBe(true);
    expect(res.failing_links).toEqual([]);
    expect(res.links.feed.status).toBe("ok");
    expect(res.links.candles.status).toBe("ok");
    expect(res.links.scoring.status).toBe("ok");
    expect(res.links.overlay.status).toBe("ok");
  });

  it("frozen vendor quote → feed link fails (poll fresh, value stale)", async () => {
    const env = healthyEnv({
      kvBlobs: {
        "timed:prices": { prices: { SPY: { p: 600, t: NOW - 1 * MIN, p_ts: NOW - 40 * MIN, q_ts: NOW - 40 * MIN } } },
      },
    });
    const res = await runChainSmoke(env, OPTS);
    expect(res.failing_links).toContain("feed");
    expect(res.links.feed.detail).toContain("SPY:quote");
  });

  it("quiet-tape vendor lag → feed ok when poll is fresh (SPY/QQQ watchdog shape)", async () => {
    const env = healthyEnv({
      kvBlobs: {
        "timed:prices": { prices: { SPY: { p: 600, t: NOW - 1 * MIN, p_ts: NOW - 24 * MIN, q_ts: NOW - 24 * MIN } } },
      },
    });
    const res = await runChainSmoke(env, OPTS);
    expect(res.ok).toBe(true);
    expect(res.links.feed.status).toBe("ok");
  });

  it("stale 10m candles during RTH → candles link fails (the Jul 2 shape)", async () => {
    const env = healthyEnv({
      candleNewest: { "SPY:10": NOW - 70 * MIN, "SPY:30": NOW - 100 * MIN },
    });
    const res = await runChainSmoke(env, OPTS);
    expect(res.failing_links).toContain("candles");
    expect(res.links.candles.detail).toContain("SPY:10m=70m");
    expect(res.links.candles.detail).toContain("SPY:30m=100m");
  });

  it("quarantined scoring payload → scoring link fails", async () => {
    const env = healthyEnv({
      kvBlobs: {
        "timed:latest:SPY": {
          ticker: "SPY", price: 600, _live_price: 600.5,
          ingest_ts: NOW - 4 * MIN,
          _freshness: { grade: "STALE", enforced: true },
        },
      },
    });
    const res = await runChainSmoke(env, OPTS);
    expect(res.failing_links).toContain("scoring");
    expect(res.links.scoring.detail).toContain("grade=STALE");
  });

  it("latest price diverged from feed → overlay link fails", async () => {
    const env = healthyEnv({
      kvBlobs: {
        "timed:latest:SPY": {
          ticker: "SPY", price: 560, _live_price: 560, // ~6.7% off the 600 feed
          ingest_ts: NOW - 4 * MIN,
          _freshness: { grade: "FRESH", enforced: true },
        },
      },
    });
    const res = await runChainSmoke(env, OPTS);
    expect(res.failing_links).toContain("overlay");
    expect(res.links.overlay.per_ticker.SPY.divergence_pct).toBeGreaterThan(3);
  });

  it("market closed → intraday links idle, nothing fails on stale ages", async () => {
    const env = healthyEnv({
      kvBlobs: {
        "timed:prices": { prices: { SPY: { p: 600, t: NOW - 10 * 60 * MIN, p_ts: NOW - 10 * 60 * MIN } } },
      },
      candleNewest: { "SPY:10": NOW - 20 * 60 * MIN, "SPY:30": NOW - 20 * 60 * MIN },
    });
    const res = await runChainSmoke(env, { ...OPTS, session: CLOSED_SESSION });
    expect(res.ok).toBe(true);
    expect(res.links.feed.status).toBe("idle");
    expect(res.links.candles.status).toBe("idle");
    expect(res.links.scoring.status).toBe("idle");
    expect(res.links.overlay.status).toBe("idle");
  });

  it("missing feed row during operating hours → feed fails with missing marker", async () => {
    const env = healthyEnv({ kvBlobs: { "timed:prices": { prices: {} } } });
    const res = await runChainSmoke(env, OPTS);
    expect(res.failing_links).toContain("feed");
    expect(res.links.feed.detail).toContain("SPY:poll=missing");
  });
});
