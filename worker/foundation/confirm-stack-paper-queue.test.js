import { describe, it, expect } from "vitest";
import {
  CONFIRM_STACK_FAMILY,
  buildSequencePaperQueueProposal,
  buildConfirmStackOptionsFirstPlay,
  stampConfirmStackThinSlice,
  paperQueueSizeMult,
  resolveEntryPaperSizeMult,
  isCanonicalCapitalEntryPath,
  hydrateConfirmStackSliceInputs,
  thinSliceKvPatch,
  applyConfirmStackOptionsFirstToMenu,
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

  it("canonical capital paths are recognized (AXON Support Bounce class)", () => {
    expect(isCanonicalCapitalEntryPath("tt_n_test_support")).toBe(true);
    expect(isCanonicalCapitalEntryPath("tt_ath_breakout")).toBe(true);
    expect(isCanonicalCapitalEntryPath("orb_long")).toBe(true);
    expect(isCanonicalCapitalEntryPath("confirm_stack_ema21")).toBe(false);
    expect(isCanonicalCapitalEntryPath("tt_cloud_pivot_long")).toBe(false);
    expect(isCanonicalCapitalEntryPath("")).toBe(false);
  });

  it("resolveEntryPaperSizeMult ignores paper stamp on canonical paths (AXON repro)", () => {
    const td = {
      _sequence_queue_proposal: { paper: true, family: CONFIRM_STACK_FAMILY, size_mult: 0.1 },
    };
    // Stale/coincident Queued stamp must NOT crush Prime Support Bounce.
    expect(resolveEntryPaperSizeMult(td, {}, "tt_n_test_support", {
      continuationMult: 0.1,
      cloudPivotMult: 0.1,
    })).toBe(1);
    // Thin-slice-only entry still papersizes.
    expect(resolveEntryPaperSizeMult(td, {}, "confirm_stack_ema21", {
      continuationMult: 1,
      cloudPivotMult: 1,
    })).toBe(0.1);
  });

  it("hydrateConfirmStackSliceInputs copies gates/sequences from prior KV", () => {
    const prior = {
      setup_gates: { stack_full_confirm: { fires: true } },
      setup_sequences: [{ status: "entry_ready" }],
    };
    const out = hydrateConfirmStackSliceInputs({ kanban_stage: "setup_watch" }, prior);
    expect(out.setup_gates.stack_full_confirm.fires).toBe(true);
    expect(out.setup_sequences[0].status).toBe("entry_ready");
    const stamped = stampConfirmStackThinSlice(out, {});
    expect(stamped._sequence_queue_proposal?.state).toBe("queued");
  });

  it("thinSliceKvPatch returns only changed shadow/proposal fields", () => {
    const patch = thinSliceKvPatch(
      { price: 10 },
      {
        price: 10,
        setup_gates: { stack_full_confirm: { fires: true } },
        _sequence_queue_proposal: { state: "queued", paper: true },
      },
    );
    expect(patch.setup_gates.stack_full_confirm.fires).toBe(true);
    expect(patch.confirm_stack).toBe(true);
    expect(patch._sequence_queue_proposal.state).toBe("queued");
  });

  it("applyConfirmStackOptionsFirstToMenu forces options pick", () => {
    const menu = {
      entries: [
        { vehicle: "shares", play_vehicle: "shares", label: "Buy shares", suitability: 80 },
        { vehicle: "option", play_vehicle: "options", label: "Calls", suitability: 60 },
      ],
      pick: { vehicle: "shares", play_vehicle: "shares", suitability: 80 },
    };
    const { menu: next, applied } = applyConfirmStackOptionsFirstToMenu(menu, readyPayload, {});
    expect(applied).toBe(true);
    expect(next.pick.play_vehicle).toBe("options");
    expect(next.pick.why).toMatch(/confirm_stack/);
  });
});
