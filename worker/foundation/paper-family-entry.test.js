import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { isCanonicalCapitalEntryPath, resolveEntryPaperSizeMult } from "./confirm-stack-paper-queue.js";
import { isTtCloudPivotTrade } from "./tt-cloud-pivot.js";
import {
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
  isPaperFamilyEntryPath,
  paperFamilyEntryPath,
  paperFamilySetupLabel,
  resolvePaperFamilyStandaloneEntry,
  paperFamilyBudgetAllows,
  stampPaperFamilyOnTrade,
} from "./paper-family-entry.js";

describe("paper family standalone entry", () => {
  const cloudProposal = {
    paper: true,
    family: CLOUD_PIVOT_FAMILY,
    size_mult: 0.1,
    direction: "LONG",
    reason: "tt_cloud_pivot:curl",
  };

  it("encodes direction on the family path", () => {
    expect(paperFamilyEntryPath(CLOUD_PIVOT_FAMILY, "LONG")).toBe("tt_cloud_pivot_long");
    expect(paperFamilyEntryPath(CLOUD_PIVOT_FAMILY, "SHORT")).toBe("tt_cloud_pivot_short");
    expect(paperFamilyEntryPath(CONFIRM_STACK_FAMILY, "LONG")).toBe("confirm_stack_ema21_long");
  });

  it("recognizes family paths including direction suffixes", () => {
    expect(isPaperFamilyEntryPath("tt_cloud_pivot_long")).toBe(true);
    expect(isPaperFamilyEntryPath("tt_cloud_pivot_short")).toBe(true);
    expect(isPaperFamilyEntryPath("confirm_stack_ema21")).toBe(true);
    expect(isPaperFamilyEntryPath("momentum_continuation_long")).toBe(true);
    expect(isPaperFamilyEntryPath("tt_n_test_support")).toBe(false);
    expect(isPaperFamilyEntryPath("tt_gap_reversal_long")).toBe(false);
    expect(isPaperFamilyEntryPath("tt_ath_breakout")).toBe(false);
  });

  it("does not treat family paths as canonical capital (0.1× can apply)", () => {
    expect(isCanonicalCapitalEntryPath("tt_cloud_pivot")).toBe(false);
    expect(isCanonicalCapitalEntryPath("tt_cloud_pivot_long")).toBe(false);
    expect(isCanonicalCapitalEntryPath("tt_cloud_pivot_short")).toBe(false);
    expect(isCanonicalCapitalEntryPath("confirm_stack_ema21_long")).toBe(false);
    expect(isCanonicalCapitalEntryPath("momentum_continuation_short")).toBe(false);
    expect(isCanonicalCapitalEntryPath("tt_n_test_support")).toBe(true);
    expect(isCanonicalCapitalEntryPath("tt_gap_reversal_long")).toBe(true);
    expect(isCanonicalCapitalEntryPath("tt_ath_breakout")).toBe(true);
  });

  it("sizes family paths at the proposal mult and leaves core paths at 1.0", () => {
    const td = { _sequence_queue_proposal: cloudProposal };
    expect(resolveEntryPaperSizeMult(td, {}, "tt_cloud_pivot_long", {
      continuationMult: 1,
      cloudPivotMult: 0.1,
    })).toBe(0.1);
    expect(resolveEntryPaperSizeMult(td, {}, "tt_n_test_support", {
      continuationMult: 0.1,
      cloudPivotMult: 0.1,
    })).toBe(1);
  });

  it("resolves a standalone ticket from a live paper proposal", () => {
    const got = resolvePaperFamilyStandaloneEntry({
      kanban_stage: "setup_watch",
      _sequence_queue_proposal: cloudProposal,
    }, {});
    expect(got).toMatchObject({
      family: CLOUD_PIVOT_FAMILY,
      path: "tt_cloud_pivot_long",
      direction: "LONG",
      size_mult: 0.1,
      paper: true,
    });
  });

  it("infers SHORT from a bear state when the proposal has no direction", () => {
    const got = resolvePaperFamilyStandaloneEntry({
      kanban_stage: "setup_watch",
      state: "HTF_BEAR_LTF_BEAR",
      _sequence_queue_proposal: {
        paper: true,
        family: CONFIRM_STACK_FAMILY,
        size_mult: 0.1,
      },
    }, {});
    expect(got.path).toBe("confirm_stack_ema21_short");
    expect(got.direction).toBe("SHORT");
  });

  it("does not open when already bought / held", () => {
    expect(resolvePaperFamilyStandaloneEntry({
      _model_lifecycle: { state: "bought" },
      _sequence_queue_proposal: cloudProposal,
    }, {})).toBeNull();
    expect(resolvePaperFamilyStandaloneEntry({
      kanban_stage: "just_entered",
      _sequence_queue_proposal: cloudProposal,
    }, {})).toBeNull();
  });

  it("is off in replay unless the replay flag is on", () => {
    const payload = {
      kanban_stage: "setup_watch",
      _sequence_queue_proposal: cloudProposal,
      _env: { _isReplay: true },
    };
    expect(resolvePaperFamilyStandaloneEntry(payload, {})).toBeNull();
    expect(resolvePaperFamilyStandaloneEntry(payload, {
      deep_audit_paper_family_standalone_entry_replay: "true",
    })).toBeTruthy();
    expect(resolvePaperFamilyStandaloneEntry(payload, {}, { isReplay: true })).toBeNull();
    expect(resolvePaperFamilyStandaloneEntry(payload, {
      deep_audit_paper_family_standalone_entry_replay: "true",
    }, { isReplay: true })).toBeTruthy();
  });

  it("can be disabled", () => {
    expect(resolvePaperFamilyStandaloneEntry({
      kanban_stage: "setup_watch",
      _sequence_queue_proposal: cloudProposal,
    }, { deep_audit_paper_family_standalone_entry_enabled: "false" })).toBeNull();
  });

  it("pretty-labels family paths without looking like a core catalog play", () => {
    expect(paperFamilySetupLabel("tt_cloud_pivot_long")).toBe("TT Cloud Pivot");
    expect(paperFamilySetupLabel("confirm_stack_ema21_short")).toBe("TT Confirm-stack");
    expect(paperFamilySetupLabel("momentum_continuation_long")).toBe("TT Continuation");
    expect(paperFamilySetupLabel("tt_n_test_support")).toBeNull();
  });

  it("stamps family + paper flags on the standalone ticket only", () => {
    const td = {
      __paper_family_ticket: true,
      _sequence_queue_proposal: { paper: true, family: CONTINUATION_FAMILY, size_mult: 0.1 },
    };
    const trade = stampPaperFamilyOnTrade({ id: "x" }, td, "momentum_continuation_long");
    expect(trade.slice_family).toBe(CONTINUATION_FAMILY);
    expect(trade.paper).toBe(true);
    expect(trade.paper_mult).toBe(0.1);
    expect(td.__entry_family).toBe(CONTINUATION_FAMILY);
    const core = stampPaperFamilyOnTrade(
      { id: "y", entry_path: "tt_n_test_support" },
      { _sequence_queue_proposal: { paper: true, family: CLOUD_PIVOT_FAMILY, size_mult: 0.1 } },
      "tt_n_test_support",
    );
    expect(core.slice_family).toBeUndefined();
    expect(core.paper).toBeUndefined();
  });

  it("wires standalone promote + broker qty into the entry writer", () => {
    const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(src).toContain("resolvePaperFamilyStandaloneEntry");
    expect(src).toContain("[PAPER_FAMILY_ENTRY]");
    expect(src).toContain("stampPaperFamilyOnTrade");
    expect(src).toContain("qty: Number(trade.shares)");
    expect(src).toContain("forwardOrderToBridge");
  });

  it("lets Cloud Pivot exits attach to the standalone path, not a core path", () => {
    expect(isTtCloudPivotTrade({
      entry_path: "tt_cloud_pivot_long",
      slice_family: CLOUD_PIVOT_FAMILY,
    })).toBe(true);
    expect(isTtCloudPivotTrade({
      entry_path: "tt_n_test_support",
      slice_family: CLOUD_PIVOT_FAMILY,
    })).toBe(false);
  });
});

describe("paper family entry budget (2026-09-05)", () => {
  const entry = { family: CLOUD_PIVOT_FAMILY, path: "tt_cloud_pivot_long", direction: "LONG", conviction: 2 };

  it("carries the proposal conviction onto the resolved entry", () => {
    const res = resolvePaperFamilyStandaloneEntry({
      _sequence_queue_proposal: { paper: true, family: CLOUD_PIVOT_FAMILY, direction: "LONG", conviction: 2.5 },
    });
    expect(res?.conviction).toBe(2.5);
  });

  it("allows within defaults (4 open, 3 today, conviction >= 2)", () => {
    expect(paperFamilyBudgetAllows(entry, { open: 3, today: 2 })).toEqual({ allow: true, reason: null });
  });

  it("holds when the open cap is full", () => {
    expect(paperFamilyBudgetAllows(entry, { open: 4, today: 0 }).reason).toBe("family_open_cap:4/4");
  });

  it("holds when the daily cap is full", () => {
    expect(paperFamilyBudgetAllows(entry, { open: 0, today: 3 }).reason).toBe("family_daily_cap:3/3");
  });

  it("holds a low-conviction proposal even with room", () => {
    // 2026-09-04 burst: 12 Cloud Pivot opens in 3 min, most with a soft-opposed cloud.
    expect(paperFamilyBudgetAllows({ ...entry, conviction: 1 }, { open: 0, today: 0 }).reason).toBe("conviction:1<2");
  });

  it("does not apply the conviction floor to families without a score", () => {
    expect(paperFamilyBudgetAllows({ ...entry, conviction: null }, { open: 0, today: 0 }).allow).toBe(true);
  });

  it("is configurable via DA config", () => {
    const da = { deep_audit_paper_family_max_open: "10", deep_audit_paper_family_max_daily: "8", deep_audit_paper_family_min_conviction: "0" };
    expect(paperFamilyBudgetAllows({ ...entry, conviction: 0 }, { open: 9, today: 7 }, da).allow).toBe(true);
  });
});
