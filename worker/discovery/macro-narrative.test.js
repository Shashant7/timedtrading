import { describe, it, expect } from "vitest";
import {
  clusterWirePosts,
  narrativeRiskTone,
  parseNarrativeJson,
  attachNarrativeShadow,
  MIN_CLUSTER_POSTS,
} from "./macro-narrative.js";

// The actual 2026-09-03 premarket sequence that motivated this module:
// six Waller headlines in one hour, individually classified mostly
// neutral, aggregate pulse neutral — while the story was risk-on.
const WALLER_POSTS = [
  {
    post_id: "1",
    text: "U.S. SHORT-TERM INTEREST RATE FUTURES JUMP AFTER WALLER SAYS HE'D SUPPORT HOLDING POLICY RATE STEADY IF AUGUST INFLATION DATA EXTENDS RECENT TREND",
    intel: { sentiment: "bullish", urgency: "high", risk_tone: "risk-on", is_catalyst: true, catalyst_strength: 7, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "2",
    text: "FED'S WALLER SAYS WITH CPI AND PPI IN HAND, HAVE A PRETTY ACCURATE VIEW OF PCE INFLATION",
    intel: { sentiment: "neutral", urgency: "medium", risk_tone: "neutral", is_catalyst: false, catalyst_strength: 3, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "3",
    text: "FED'S WALLER SAYS WE SHOULD START SEE SOME LOWER NUMBERS ON INFLATION, EXPECT A REASONABLE CPI",
    intel: { sentiment: "bullish", urgency: "medium", risk_tone: "neutral", is_catalyst: false, catalyst_strength: 4, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "4",
    text: "FED'S WALLER SAYS WILLING TO SIT AND WAIT AND BE PATIENT",
    intel: { sentiment: "neutral", urgency: "medium", risk_tone: "neutral", is_catalyst: false, catalyst_strength: 3, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "5",
    text: "FED'S WALLER SAYS MORTGAGE RATES, AUTO LOAN RATES ARE NOT LOW",
    intel: { sentiment: "bearish", urgency: "medium", risk_tone: "risk-off", is_catalyst: false, catalyst_strength: 3, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "6",
    text: "FED HOLD ODDS JUMP AFTER JOBS DATA AND WALLER COMMENTS",
    intel: { sentiment: "neutral", urgency: "high", risk_tone: "neutral", is_catalyst: true, catalyst_strength: 6, themes: [], sectors: [], tickers: [] },
  },
];

const NOISE_POSTS = [
  {
    post_id: "n1",
    text: "OPENAI AGENTS REPORTEDLY ESCAPED TEST ENVIRONMENT",
    intel: { sentiment: "neutral", urgency: "low", risk_tone: "neutral", is_catalyst: false, catalyst_strength: 1, themes: [], sectors: [], tickers: [] },
  },
  {
    post_id: "n2",
    text: "U.S. MILITARY BLOCKS AD TRACKERS OVER SECURITY FEARS",
    intel: { sentiment: "neutral", urgency: "low", risk_tone: "neutral", is_catalyst: false, catalyst_strength: 1, themes: [], sectors: [], tickers: [] },
  },
];

describe("clusterWirePosts", () => {
  it("clusters the six Waller posts into one story and leaves noise out", () => {
    const clusters = clusterWirePosts([...WALLER_POSTS, ...NOISE_POSTS]);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const top = clusters[0];
    expect(top.posts.length).toBe(6);
    expect(["WALLER", "FED", "FED'S"]).toContain(top.anchor);
    const clusteredIds = new Set(clusters.flatMap((c) => c.posts.map((p) => p.post_id)));
    expect(clusteredIds.has("n1")).toBe(false);
    expect(clusteredIds.has("n2")).toBe(false);
  });

  it("returns nothing when no subject repeats enough", () => {
    const clusters = clusterWirePosts(NOISE_POSTS);
    expect(clusters).toEqual([]);
  });

  it("ignores unclassified posts", () => {
    const clusters = clusterWirePosts(
      WALLER_POSTS.map((p) => ({ ...p, intel: null, intel_json: null })),
    );
    expect(clusters).toEqual([]);
  });

  it("exposes the min-cluster contract", () => {
    expect(MIN_CLUSTER_POSTS).toBeGreaterThanOrEqual(3);
  });
});

describe("narrativeRiskTone", () => {
  it("lets a sustained high-conviction story override a neutral per-post aggregate", () => {
    const tone = narrativeRiskTone(
      [{ risk_tone: "risk-on", conviction: 8, sustained: true }],
      "neutral",
    );
    expect(tone).toBe("risk-on");
  });

  it("keeps the per-post tone when narratives are weak or not sustained", () => {
    expect(narrativeRiskTone([{ risk_tone: "risk-on", conviction: 4, sustained: true }], "neutral")).toBe("neutral");
    expect(narrativeRiskTone([{ risk_tone: "risk-on", conviction: 9, sustained: false }], "neutral")).toBe("neutral");
    expect(narrativeRiskTone([], "risk-off")).toBe("risk-off");
  });

  it("falls back to per-post tone when strong narratives conflict", () => {
    const tone = narrativeRiskTone(
      [
        { risk_tone: "risk-on", conviction: 8, sustained: true },
        { risk_tone: "risk-off", conviction: 8, sustained: true },
      ],
      "neutral",
    );
    expect(tone).toBe("neutral");
  });
});

describe("parseNarrativeJson", () => {
  it("normalizes a valid synthesis payload", () => {
    const n = parseNarrativeJson(JSON.stringify({
      story: "Waller backs a September hold with inflation cooling; rate futures confirm.",
      risk_tone: "RISK-ON",
      sentiment: "Bullish",
      conviction: 8.6,
      sustained: true,
    }));
    expect(n.risk_tone).toBe("risk-on");
    expect(n.sentiment).toBe("bullish");
    expect(n.conviction).toBe(9);
    expect(n.sustained).toBe(true);
  });

  it("rejects garbage", () => {
    expect(parseNarrativeJson("not json")).toBeNull();
    expect(parseNarrativeJson(null)).toBeNull();
  });
});

describe("attachNarrativeShadow", () => {
  it("is a no-op without an OpenAI key and never mutates decision fields", async () => {
    const payload = { risk_tone: "neutral", posts: [] };
    const out = await attachNarrativeShadow({ OPENAI_API_KEY: null }, payload, WALLER_POSTS);
    expect(out.risk_tone).toBe("neutral");
    expect(out.narratives).toBeUndefined();
  });

  it("attaches shadow fields from a cached synthesis without touching risk_tone", async () => {
    // KV returns a cached narrative so no network call happens.
    const kv = {
      async get(key, type) {
        if (String(key).startsWith("timed:macro-narrative:")) {
          return { narrative: { story: "Fed hold narrative", risk_tone: "risk-on", sentiment: "bullish", conviction: 8, sustained: true } };
        }
        return null;
      },
      async put() {},
    };
    const payload = { risk_tone: "neutral", posts: [] };
    const out = await attachNarrativeShadow({ OPENAI_API_KEY: "test", KV_TIMED: kv }, payload, WALLER_POSTS);
    expect(out.risk_tone).toBe("neutral"); // decision field untouched
    expect(out.narratives?.length).toBeGreaterThanOrEqual(1);
    expect(out.narrative_risk_tone).toBe("risk-on");
    expect(out.narrative_divergence).toBe(true);
  });

  it("respects the kill switch", async () => {
    const out = await attachNarrativeShadow(
      { MACRO_NARRATIVE_ENABLED: "false", OPENAI_API_KEY: "test" },
      { risk_tone: "neutral" },
      WALLER_POSTS,
    );
    expect(out.narratives).toBeUndefined();
  });
});
