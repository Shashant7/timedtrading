import { describe, it, expect } from "vitest";
import {
  extractBriefThreadSignals,
  fetchWeekBriefThread,
  buildWeekJourneyLabel,
  formatWeekBriefThreadForPrompt,
} from "./daily-brief.js";

describe("extractBriefThreadSignals", () => {
  it("pulls Today's Three, editorial header, and thesis snippet", () => {
    const content = [
      "1. SPY/QQQ regime: range-bound chop",
      "2. Sector rotation: defensives leading",
      "3. Today's catalyst: CPI at 8:30 ET",
      "",
      "## Range-Bound Purgatory",
      "",
      "We're still stuck between 580 and 595 on SPY. Until we get a daily close outside that box, the playbook is fade the edges.",
      "",
      "## SPY: Stuck above 580",
    ].join("\n");
    const sig = extractBriefThreadSignals(content);
    expect(sig.todaysThree).toHaveLength(3);
    expect(sig.todaysThree[0].line).toMatch(/range-bound/i);
    expect(sig.editorialHeader).toBe("Range-Bound Purgatory");
    expect(sig.thesisSnippet).toMatch(/580 and 595/);
  });
});

describe("fetchWeekBriefThread", () => {
  it("includes prior days and same-day morning when generating evening", async () => {
    const rows = [
      { date: "2026-07-07", type: "morning", content: "## Mon Open\n1. a", es_prediction: "SPY bull above 590" },
      { date: "2026-07-07", type: "evening", content: "## Mon Close\n1. b", es_prediction: null },
      { date: "2026-07-08", type: "morning", content: "## Tue Open\n1. c", es_prediction: "SPY neutral" },
      { date: "2026-07-08", type: "evening", content: "## Tue Close\n1. d", es_prediction: null },
    ];
    const db = {
      prepare() {
        return {
          bind() {
            return {
              all: async () => ({ results: rows }),
            };
          },
        };
      },
    };
    const thread = await fetchWeekBriefThread(db, "2026-07-07", "2026-07-09", "evening");
    expect(thread.map((t) => `${t.date}:${t.type}`)).toEqual([
      "2026-07-07:morning",
      "2026-07-07:evening",
      "2026-07-08:morning",
      "2026-07-08:evening",
    ]);
    const morningOnly = await fetchWeekBriefThread(db, "2026-07-07", "2026-07-08", "morning");
    expect(morningOnly.map((t) => `${t.date}:${t.type}`)).toEqual([
      "2026-07-07:morning",
      "2026-07-07:evening",
    ]);
  });
});

describe("formatWeekBriefThreadForPrompt", () => {
  it("lists chronology and anti-repetition guidance", () => {
    const thread = [
      {
        date: "2026-07-08",
        type: "morning",
        signals: {
          todaysThree: [{ n: 1, line: "SPY chop" }],
          editorialHeader: "Ketamine Tape",
          thesisSnippet: "Still range-bound.",
        },
        esPrediction: "SPY holds 580",
      },
    ];
    const out = formatWeekBriefThreadForPrompt(thread, "Wednesday evening recap", "evening");
    expect(out).toMatch(/Week position/);
    expect(out).toMatch(/2026-07-08 morning/);
    expect(out).toMatch(/Ketamine Tape/);
    expect(out).toMatch(/NEXT chapter/i);
    expect(out).toMatch(/Morning index call/);
  });

  it("handles empty week thread for Monday morning", () => {
    const out = formatWeekBriefThreadForPrompt([], "Monday morning setup", "morning");
    expect(out).toMatch(/First brief slot/i);
  });
});

describe("buildWeekJourneyLabel", () => {
  it("counts trading days Mon–Wed as day 3", () => {
    const label = buildWeekJourneyLabel("2026-07-09", "2026-07-07", "evening", "Wednesday");
    expect(label).toMatch(/Wednesday evening recap/);
    expect(label).toMatch(/trading day 3/);
  });
});
