// worker/calibration/intelligence-context.test.js

import { describe, it, expect } from "vitest";
import { applyIntelligenceToCalibration } from "./intelligence-context.js";

function makeKv(store = {}) {
  const data = { ...store };
  return {
    async get(k) { return data[k] ?? null; },
    async put(k, v) { data[k] = v; },
  };
}

function makeEnv(over = {}) {
  const decisions = over.decisions || [];
  return {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("ai_cio_decisions")) return { results: decisions };
                return { results: [] };
              },
            };
          },
        };
      },
    },
    KV_TIMED: makeKv(over.kv || {}),
    ...over,
  };
}

describe("calibration intelligence-context", () => {
  it("nudges rank_threshold up when CIO reject rate is high", async () => {
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      ticker: "MU",
      decision: i < 7 ? "REJECT" : "APPROVE",
      created_at: Date.now() - i * 1000,
      shadow: 0,
      is_replay: 0,
      proposal_json: JSON.stringify({ bucket: "entry" }),
    }));

    const env = makeEnv({ decisions });
    const base = { rank_threshold: 55, adaptive_rank_weights: { sector_biases: {} } };
    const out = await applyIntelligenceToCalibration(env, base);

    expect(out.recommendations.rank_threshold).toBeGreaterThan(55);
    expect(out.adjustments.some((a) => a.source === "cio_entry")).toBe(true);
    expect(out.intelligence_context.cio.entry.reject_rate_pct).toBe(70);
  });

  it("applies desk caution sector bias from tactical override", async () => {
    const kv = {
      "cro:tactical_overrides": JSON.stringify({
        tactical_overlay: "Tech extended — fade rallies",
        tactical_signals: [{
          signal: "semis_caution",
          direction: "caution / trim",
          affected_tier1_themes: ["AI Infrastructure"],
        }],
        sector_notes: [{
          sector: "Information Technology",
          tactical_note: "Reduce exposure — stretched",
        }],
      }),
      "timed:cro:latest": JSON.stringify({
        as_of_date: "2026-06-05",
        verdict: "Risk-off into weekend",
        observations: [{ section: "macro", text: "Tech leadership fading" }],
      }),
    };

    const env = makeEnv({ kv, decisions: [] });
    const base = {
      rank_threshold: 55,
      tp_tiers: { trim: 2.0, exit: 3.0, runner: 4.0 },
      adaptive_rank_weights: { sector_biases: {} },
    };
    const out = await applyIntelligenceToCalibration(env, base);

    expect(out.intelligence_context.desk.caution_sectors.length).toBeGreaterThan(0);
    expect(out.recommendations.adaptive_rank_weights.sector_biases["Information Technology"]).toBeLessThan(0);
    expect(out.recommendations.desk_cro_verdict_excerpt).toContain("Risk-off");
  });
});
