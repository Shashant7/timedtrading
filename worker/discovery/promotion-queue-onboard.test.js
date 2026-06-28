import { describe, it, expect, vi } from "vitest";
import { decideOnCandidate } from "./promotion-queue.js";

describe("decideOnCandidate ensureOnboard hook", () => {
  it("calls ensureOnboard on approve when provided", async () => {
    const ensureOnboard = vi.fn().mockResolvedValue(undefined);
    let tickers = [];
    const env = {
      DB: {
        prepare: vi.fn((sql) => ({
          bind: (...args) => ({
            first: async () => {
              if (sql.includes("SELECT ticker FROM discovery_promotion_queue")) {
                return { ticker: "SMCI" };
              }
              return null;
            },
            run: async () => ({}),
          }),
        })),
      },
      KV_TIMED: {
        get: async (key, type) => {
          if (key === "timed:removed") return type === "json" ? [] : "[]";
          if (key === "timed:tickers") return type === "json" ? tickers : JSON.stringify(tickers);
          return null;
        },
        put: async (key, val) => {
          if (key === "timed:tickers") tickers = typeof val === "string" ? JSON.parse(val) : val;
        },
      },
    };

    const result = await decideOnCandidate(env, {
      candidate_id: "cand-1",
      decision: "approve",
      decided_by: "test",
      ensureOnboard,
    });

    expect(result.ok).toBe(true);
    expect(result.universe_added).toBe(true);
    expect(ensureOnboard).toHaveBeenCalledOnce();
    expect(ensureOnboard.mock.calls[0][0]).toBe("SMCI");
  });

  it("does not call ensureOnboard on decline", async () => {
    const ensureOnboard = vi.fn();
    const env = {
      DB: {
        prepare: vi.fn((sql) => ({
          bind: () => ({
            first: async () => ({ ticker: "SMCI" }),
            run: async () => ({}),
          }),
        })),
      },
    };

    const result = await decideOnCandidate(env, {
      candidate_id: "cand-1",
      decision: "decline",
      decided_by: "test",
      ensureOnboard,
    });

    expect(result.ok).toBe(true);
    expect(ensureOnboard).not.toHaveBeenCalled();
  });
});
