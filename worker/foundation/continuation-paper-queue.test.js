import { describe, it, expect } from "vitest";
import {
  detectMomentumContinuation,
  buildContinuationPaperQueueProposal,
  stampContinuationThinSlice,
  continuationPaperSizeMult,
  CONTINUATION_FAMILY,
} from "./continuation-paper-queue.js";

const hotLong = {
  kanban_stage: "setup_watch",
  state: "HTF_BULL_LTF_BULL",
  direction: "LONG",
  rank: 88,
  htf_score: 18,
  price: 120,
  prev_close: 112,
  day_change_pct: 7.1,
  confluence_mode: "RIDE",
  __conviction_tier: "A",
  flags: { sq30_release: true },
  tf_tech: { D: { ema21: 110 } },
};

describe("momentum continuation paper queue", () => {
  it("detects hot aligned impulse above EMA21", () => {
    const d = detectMomentumContinuation(hotLong, {});
    expect(d?.fires).toBe(true);
    expect(d.direction).toBe("LONG");
  });

  it("rejects below EMA21 on long", () => {
    expect(detectMomentumContinuation({
      ...hotLong,
      price: 100,
      tf_tech: { D: { ema21: 110 } },
    }, {})).toBeNull();
  });

  it("builds paper Queued proposal at 0.1×", () => {
    const p = buildContinuationPaperQueueProposal(hotLong, {});
    expect(p?.family).toBe(CONTINUATION_FAMILY);
    expect(p.paper).toBe(true);
    expect(p.size_mult).toBe(0.1);
  });

  it("does not override confirm-stack proposal", () => {
    const out = stampContinuationThinSlice({
      ...hotLong,
      _sequence_queue_proposal: {
        family: "confirm_stack_ema21",
        paper: true,
        state: "queued",
      },
    }, {});
    expect(out._sequence_queue_proposal.family).toBe("confirm_stack_ema21");
    expect(out.momentum_continuation).toBe(true);
  });

  it("stamps options-first play on Tier-A RIDE", () => {
    const out = stampContinuationThinSlice(hotLong, {});
    expect(out._sequence_queue_proposal?.family).toBe(CONTINUATION_FAMILY);
    expect(out._model_play?.play_vehicle).toBe("options");
  });

  it("continuationPaperSizeMult returns proposal size", () => {
    expect(continuationPaperSizeMult({
      _sequence_queue_proposal: { paper: true, family: CONTINUATION_FAMILY, size_mult: 0.1 },
    }, {})).toBe(0.1);
    expect(continuationPaperSizeMult({}, {})).toBe(1);
  });
});
