import { describe, it, expect } from "vitest";
import {
  resolveSliceFamily,
  isPaperSized,
  resolvePaperFamily,
  paperAlertFields,
  paperSignalMeta,
  paperFamilyTitlePrefix,
  CLOUD_PIVOT_FAMILY,
  CONFIRM_STACK_FAMILY,
} from "./paper-family-label.js";

describe("paper-family-label", () => {
  it("labels a paper Cloud Pivot fill (AXON / NVDA style)", () => {
    const tickerData = {
      __paper_queue_size_mult: 0.1,
      _sequence_queue_proposal: { family: CLOUD_PIVOT_FAMILY, paper: true },
      tt_cloud_pivot: true,
    };
    const r = resolvePaperFamily({ tickerData });
    expect(r.paper).toBe(true);
    expect(r.family).toBe(CLOUD_PIVOT_FAMILY);
    expect(r.familyLabel).toBe("Cloud Pivot");
    expect(r.titlePrefix).toBe("PAPER · Cloud Pivot");
    expect(r.sizeNote).toContain("0.1×");
    expect(r.discordFieldName).toBe("Paper experiment");
    expect(paperFamilyTitlePrefix({ tickerData })).toBe("PAPER · Cloud Pivot · ");
    expect(paperAlertFields({ tickerData })).toEqual({
      paper: true,
      slice_family: CLOUD_PIVOT_FAMILY,
      slice_family_label: "Cloud Pivot",
      paper_mult: 0.1,
    });
  });

  it("labels confirm-stack from proposal family", () => {
    const r = resolvePaperFamily({
      tickerData: {
        __paper_queue_size_mult: 0.1,
        _sequence_queue_proposal: { family: CONFIRM_STACK_FAMILY, paper: true },
      },
    });
    expect(r.titlePrefix).toBe("PAPER · Confirm-stack");
    expect(paperSignalMeta({ tickerData: {
      __paper_queue_size_mult: 0.1,
      _sequence_queue_proposal: { family: CONFIRM_STACK_FAMILY },
    } }).family).toBe(CONFIRM_STACK_FAMILY);
  });

  it("leaves full-size canonical entries unlabeled", () => {
    const tickerData = {
      setupName: "tt_n_test_support",
      price: 100,
    };
    expect(isPaperSized({ tickerData })).toBe(false);
    expect(resolveSliceFamily({ tickerData })).toBeNull();
    expect(resolvePaperFamily({ tickerData }).titlePrefix).toBe("");
    expect(paperAlertFields({ tickerData })).toEqual({});
    expect(paperFamilyTitlePrefix({ tickerData })).toBe("");
  });

  it("reads family from trade.slice_family when ticker flags are absent", () => {
    expect(resolveSliceFamily({
      extra: { slice_family: "tt_cloud_pivot" },
    })).toBe(CLOUD_PIVOT_FAMILY);
  });

  it("treats model-play.paper as paper even without a size mult", () => {
    expect(isPaperSized({
      tickerData: { __model_play: { paper: true, family: CLOUD_PIVOT_FAMILY } },
    })).toBe(true);
  });
});
