import { describe, it, expect } from "vitest";
import {
  buildSequencePaperQueueProposal,
  buildConfirmStackOptionsFirstPlay,
  stampConfirmStackThinSlice,
  paperQueueSizeMult,
} from "./confirm-stack-paper-queue.js";

describe("confirm-stack paper queue", () => {
  const readyPayload = {
    kanban_stage: "setup_watch",
    setup_gates: { stack_full_confirm: { fires: true } },
    setup_sequences: [{ status: "entry_ready", name: "td_phase_mean_reversion_long" }],
    confluence_mode: "RIDE",
    __conviction_tier: "A",
  };

  it("proposes Queued paper when confirm-stack + entry_ready", () => {
    const p = buildSequencePaperQueueProposal(readyPayload, {});
    expect(p).toBeTruthy();
    expect(p.state).toBe("queued");
    expect(p.paper).toBe(true);
    expect(p.size_mult).toBe(0.1);
  });

  it("does not propose when flag off", () => {
    expect(buildSequencePaperQueueProposal(readyPayload, {
      deep_audit_confirm_stack_sequence_paper_queue_enabled: "false",
    })).toBeNull();
  });

  it("does not propose without sequence entry_ready", () => {
    expect(buildSequencePaperQueueProposal({
      ...readyPayload,
      setup_sequences: [{ status: "forming" }],
    }, {})).toBeNull();
  });

  it("stamps options-first play on Tier-A RIDE", () => {
    const play = buildConfirmStackOptionsFirstPlay(readyPayload, {});
    expect(play?.play_vehicle).toBe("options");
  });

  it("stampConfirmStackThinSlice attaches both proposal and play", () => {
    const out = stampConfirmStackThinSlice(readyPayload, {});
    expect(out._sequence_queue_proposal?.state).toBe("queued");
    expect(out._model_play?.play_vehicle).toBe("options");
  });

  it("paperQueueSizeMult returns proposal size", () => {
    expect(paperQueueSizeMult({
      _sequence_queue_proposal: { paper: true, size_mult: 0.1 },
    }, {})).toBe(0.1);
    expect(paperQueueSizeMult({}, {})).toBe(1);
  });
});
