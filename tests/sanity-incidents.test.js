import { describe, it, expect } from "vitest";
import {
  SANITY_CHECK_PLAYBOOK,
  syncIncidentsFromSweep,
  summarizeIncidents,
  buildAgentIssueBody,
  formatIncidentActionLines,
} from "../worker/sanity-incidents.js";

describe("sanity incidents playbook", () => {
  it("marks code checks as needs_pr", () => {
    expect(SANITY_CHECK_PLAYBOOK.classifier_consistency.needs_pr).toBe(true);
    expect(SANITY_CHECK_PLAYBOOK.candle_freshness_open.auto_heal).toBe(true);
  });
});

describe("syncIncidentsFromSweep", () => {
  it("opens incident on fail and closes when check passes", async () => {
    const kv = {};
    const env = {
      KV_TIMED: {
        get: async (k) => kv[k] || null,
        put: async (k, v) => { kv[k] = v; },
      },
    };
    const sweep = {
      kind: "fast",
      checks: [{
        id: "classifier_consistency",
        label: "Classifier consistency",
        status: "fail",
        remediation: "recompute",
        anomalies: [{ ticker: "MU", detail: "stage=accumulate warnings=3", severity: "fail" }],
      }],
    };
    const summary1 = await syncIncidentsFromSweep(env, sweep, { healed: [], skipped: [] });
    expect(summary1.open_count).toBe(1);
    expect(summary1.open[0].needs_pr).toBe(true);

    const sweepOk = {
      kind: "fast",
      checks: [{
        id: "classifier_consistency",
        label: "Classifier consistency",
        status: "ok",
        anomalies: [],
      }],
    };
    const summary2 = await syncIncidentsFromSweep(env, sweepOk, null);
    expect(summary2.open_count).toBe(0);
  });

  it("escalates after repeated failed auto-heal attempts", async () => {
    const map = {
      compute_freshness: {
        id: "compute_freshness",
        label: "Compute freshness",
        status: "open",
        severity: "warn",
        kind: "runtime",
        needs_pr: false,
        auto_heal: true,
        heal_attempts: [
          { ts: 1, ok: false, detail: "HTTP 500" },
        ],
        anomalies: [{ detail: "stale 180min" }],
        first_seen_ts: 1,
        last_seen_ts: 1,
      },
    };
    const sweep = {
      checks: [{
        id: "compute_freshness",
        label: "Compute freshness",
        status: "warn",
        anomalies: [{ detail: "stale 200min" }],
      }],
    };
    const env = {
      KV_TIMED: {
        get: async () => JSON.stringify(map),
        put: async (k, v) => { map[k] = JSON.parse(v); },
      },
    };
    const next = await syncIncidentsFromSweep(env, sweep, {
      healed: [],
      skipped: [{ check: "compute_freshness", reason: "HTTP 500" }],
    });
    expect(next.open[0].status).toBe("escalated");
  });
});

describe("agent issue body", () => {
  it("includes agent prompt and file hints", () => {
    const body = buildAgentIssueBody({
      id: "classifier_consistency",
      label: "Classifier consistency",
      severity: "fail",
      status: "escalated",
      kind: "code",
      needs_pr: true,
      agent_prompt: "Fix exhaustion gate",
      files_hint: ["worker/investor.js"],
      remediation: "Re-run compute",
      anomalies: [{ ticker: "MU", detail: "3 warnings" }],
      heal_attempts: [],
    });
    expect(body).toContain("classifier_consistency");
    expect(body).toContain("worker/investor.js");
    expect(body).toContain("Fix exhaustion gate");
  });
});

describe("formatIncidentActionLines", () => {
  it("summarizes heal and open incidents", () => {
    const lines = formatIncidentActionLines(
      {
        open_count: 1,
        needs_pr_count: 1,
        open: [{ id: "classifier_consistency", status: "open", needs_pr: true }],
      },
      { healed: [{ check: "candle_freshness_open" }], skipped: [] },
    );
    expect(lines.join("\n")).toMatch(/Auto-heal applied/);
    expect(lines.join("\n")).toMatch(/classifier_consistency/);
  });
});
