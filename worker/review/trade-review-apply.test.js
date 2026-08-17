import { describe, it, expect, vi, beforeEach } from "vitest";
import { mergeOperatorPatch, buildOnePager } from "./trade-review-apply.js";
import { normalizeGithubRepo, githubFilingEnabled } from "./trade-review-github.js";

describe("mergeOperatorPatch", () => {
  const analysis = {
    grade: "C",
    verdict: "GOOD_EXIT",
    headline: "Clean exit on the flip.",
    failure_modes: ["a"],
    should_have_held: false,
    probability_of_success: 0.5,
    engine_findings: [{ finding: "original", kind: "none" }],
  };

  it("lets the operator overrule the grade and verdict", () => {
    const out = mergeOperatorPatch(analysis, { grade: "D", verdict: "PREMATURE_EXIT" });
    expect(out.grade).toBe("D");
    expect(out.verdict).toBe("PREMATURE_EXIT");
    // Untouched fields survive.
    expect(out.headline).toBe("Clean exit on the flip.");
  });

  it("ignores blank edits rather than erasing the analysis", () => {
    const out = mergeOperatorPatch(analysis, { grade: "   ", headline: "" });
    expect(out.grade).toBe("C");
    expect(out.headline).toBe("Clean exit on the flip.");
  });

  it("replaces findings wholesale when the operator supplies them", () => {
    const out = mergeOperatorPatch(analysis, {
      engine_findings: [{ finding: "operator's version", kind: "engine" }],
    });
    expect(out.engine_findings).toEqual([{ finding: "operator's version", kind: "engine" }]);
  });

  it("accepts a false boolean (not treated as missing)", () => {
    const out = mergeOperatorPatch({ ...analysis, should_have_held: true }, { should_have_held: false });
    expect(out.should_have_held).toBe(false);
  });

  it("rejects out-of-range probability edits", () => {
    expect(mergeOperatorPatch(analysis, { probability_of_success: 3 }).probability_of_success).toBe(0.5);
    expect(mergeOperatorPatch(analysis, { probability_of_success: 0.9 }).probability_of_success).toBe(0.9);
  });

  it("is a no-op for a missing patch", () => {
    expect(mergeOperatorPatch(analysis, null)).toEqual(analysis);
  });
});

describe("buildOnePager", () => {
  const review = {
    review_id: "T1::EXIT::0",
    trade_id: "HALO-1782912602137-abc",
    ticker: "HALO",
    leg_kind: "EXIT",
    leg_seq: 0,
  };
  const context = {
    trade: { ticker: "HALO", direction: "LONG" },
    engine_claim: { setup_name: "TT Support Bounce", setup_grade: "A", entry_path: "tt_n_test_support" },
    tape: {
      capture: {
        realized_pct: 3.94, mfe_pct: 8.35, mae_pct: -1.2,
        capture_ratio: 0.47, post_exit_pct: 23.4,
        big_move: { pct: 29.87 }, big_move_capture_ratio: 0.132,
      },
    },
  };
  const analysis = {
    grade: "D", verdict: "PREMATURE_EXIT",
    price_action: "Held the hourly 233 and resumed the trend.",
    assessment: "Exit fired on a single bar close against an intact structure.",
  };

  it("writes an actionable requirement with the evidence table", () => {
    const { title, body } = buildOnePager({
      finding: { finding: "Exit fires on one bar close", scope: "recurring", kind: "engine", rationale: "Two closes would have held." },
      review, context, analysis,
    });
    expect(title).toBe("[trade-review] Exit fires on one bar close");
    expect(body).toContain("## Requirement");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("flag-gated");
    expect(body).toContain("HALO-1782912602137-abc");
    expect(body).toContain("| Realized | 3.94% |");
    expect(body).toContain("| Share of that move captured | 13% |");
  });

  it("says a one-off is not a population", () => {
    const { body } = buildOnePager({
      finding: { finding: "x", scope: "one_off", kind: "engine" },
      review, context, analysis,
    });
    expect(body).toContain("ONE-OFF");
    expect(body).toContain("a single trade is not a population");
  });

  it("points a config finding at the learning bus", () => {
    const { body } = buildOnePager({
      finding: { finding: "raise confirm bars", scope: "recurring", kind: "config", config_key: "exit_confirm_bars", proposed_value: "2" },
      review, context, analysis,
    });
    expect(body).toContain("`exit_confirm_bars`");
    expect(body).toContain("learning_proposals");
  });

  it("degrades gracefully when the capture math is empty", () => {
    const { body } = buildOnePager({
      finding: { finding: "x", scope: "one_off", kind: "engine" },
      review, context: { trade: {}, tape: {} }, analysis: {},
    });
    expect(body).toContain("| Realized | n/a |");
  });
});

describe("normalizeGithubRepo", () => {
  it("accepts owner/repo and strips URL wrappers", () => {
    expect(normalizeGithubRepo("Shashant7/timedtrading")).toBe("Shashant7/timedtrading");
    expect(normalizeGithubRepo("https://github.com/Shashant7/timedtrading.git")).toBe("Shashant7/timedtrading");
  });
  it("rejects junk", () => {
    expect(normalizeGithubRepo("not a repo")).toBe("");
    expect(normalizeGithubRepo("")).toBe("");
  });
});

describe("githubFilingEnabled", () => {
  it("defaults off", () => {
    expect(githubFilingEnabled({})).toBe(false);
    expect(githubFilingEnabled({ _deepAuditConfig: { trade_review_github_enabled: "true" } })).toBe(true);
  });
});

describe("createGithubIssue", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("refuses to call GitHub when unconfigured", async () => {
    const { createGithubIssue } = await import("./trade-review-github.js");
    const res = await createGithubIssue({}, { title: "t", body: "b" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("github_not_configured");
  });

  it("posts the issue with the trade-review label and returns the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ number: 42, html_url: "https://github.com/o/r/issues/42" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createGithubIssue } = await import("./trade-review-github.js");
    const res = await createGithubIssue(
      { GITHUB_TOKEN: "tok", GITHUB_REPO: "o/r" },
      { title: "t", body: "b", labels: ["agent-ready"] },
    );
    expect(res).toEqual({ ok: true, number: 42, url: "https://github.com/o/r/issues/42" });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.labels).toEqual(["trade-review", "agent-ready"]);
    vi.unstubAllGlobals();
  });

  it("surfaces a GitHub error instead of pretending it filed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => "forbidden",
    }));
    const { createGithubIssue } = await import("./trade-review-github.js");
    const res = await createGithubIssue({ GITHUB_TOKEN: "tok", GITHUB_REPO: "o/r" }, { title: "t", body: "b" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("github_http_403");
    vi.unstubAllGlobals();
  });
});

describe("dispatchAgent", () => {
  it("skips cleanly when no Cursor key is configured", async () => {
    const { dispatchAgent } = await import("./trade-review-github.js");
    const res = await dispatchAgent({ GITHUB_REPO: "o/r" }, { title: "t", body: "b" });
    expect(res.skipped).toBe(true);
    expect(res.error).toBe("cursor_api_key_missing");
  });
});
