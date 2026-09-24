// worker/sanity-incident-sample.test.js
//
// An incident keeps a five-anomaly sample out of however many the check
// found. 2026-09-24: `model_broker_coverage` found 29, eighteen of them
// `fail`, and the sample held five investor cash warnings and none of the
// failures — so the record said "fail" over nothing anybody could act on.

import { describe, it, expect } from "vitest";
import {
  worstAnomalies,
  buildAgentIssueBody,
  syncIncidentsFromSweep,
  INCIDENT_ANOMALY_SAMPLE,
} from "./sanity-incidents.js";

function kvEnv() {
  const store = new Map();
  return {
    _store: store,
    KV_TIMED: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
}

const warn = (t) => ({ ticker: t, detail: `${t} mirrored only in part`, severity: "warn" });
const fail = (t) => ({ ticker: t, detail: `${t} ENTRY unmatched`, severity: "fail" });

describe("worstAnomalies", () => {
  it("puts failures ahead of warnings", () => {
    const out = worstAnomalies([warn("A"), warn("B"), warn("C"), warn("D"), warn("E"), fail("Z")]);
    expect(out).toHaveLength(5);
    expect(out[0].ticker).toBe("Z");
    expect(out[0].severity).toBe("fail");
  });

  it("keeps the check's own order within a severity", () => {
    const out = worstAnomalies([warn("W1"), fail("F1"), fail("F2"), warn("W2")], 4);
    expect(out.map((a) => a.ticker)).toEqual(["F1", "F2", "W1", "W2"]);
  });

  it("reproduces the live shape: 11 warnings first, 18 failures after", () => {
    const anomalies = [
      ...Array.from({ length: 11 }, (_, i) => warn(`W${i}`)),
      ...Array.from({ length: 18 }, (_, i) => fail(`F${i}`)),
    ];
    // The bug: plain order kept nothing but warnings.
    expect(anomalies.slice(0, 5).every((a) => a.severity === "warn")).toBe(true);
    expect(worstAnomalies(anomalies).every((a) => a.severity === "fail")).toBe(true);
  });

  it("does not invent entries when the check found fewer than the sample", () => {
    expect(worstAnomalies([fail("A")])).toHaveLength(1);
    expect(worstAnomalies([])).toEqual([]);
    expect(worstAnomalies(null)).toEqual([]);
  });

  it("sorts an unlabelled severity last, behind warn", () => {
    const out = worstAnomalies([{ detail: "no severity" }, warn("W"), fail("F")], 3);
    expect(out.map((a) => a.severity)).toEqual(["fail", "warn", undefined]);
  });

  it("samples five by default", () => {
    expect(INCIDENT_ANOMALY_SAMPLE).toBe(5);
  });
});

describe("syncIncidentsFromSweep", () => {
  const sweep = {
    kind: "cron",
    checks: [{
      id: "model_broker_coverage",
      label: "Model actions reached the broker (all lanes)",
      status: "fail",
      anomalies: [
        ...Array.from({ length: 11 }, (_, i) => warn(`W${i}`)),
        ...Array.from({ length: 18 }, (_, i) => fail(`F${i}`)),
      ],
      remediation: "run the lane catch-ups",
    }],
  };

  it("stores the failures in the sample and the true counts alongside", async () => {
    const env = kvEnv();
    const out = await syncIncidentsFromSweep(env, sweep);
    const incident = out.open.find((i) => i.id === "model_broker_coverage");
    expect(incident.severity).toBe("fail");
    expect(incident.anomaly_count).toBe(29);
    expect(incident.anomaly_fail_count).toBe(18);
    expect(incident.anomalies).toHaveLength(5);
    expect(incident.anomalies.every((a) => a.severity === "fail")).toBe(true);
  });

  it("says how many were held back in the agent issue body", async () => {
    const env = kvEnv();
    const out = await syncIncidentsFromSweep(env, sweep);
    const body = buildAgentIssueBody(out.open.find((i) => i.id === "model_broker_coverage"));
    expect(body).toContain("29 anomalies");
    expect(body).toContain("18 of severity `fail`");
    expect(body).toContain("worst 5 shown");
    expect(body).toContain("**fail**");
  });

  it("an all-warn check keeps its warn severity and prints no fail count", async () => {
    const env = kvEnv();
    const out = await syncIncidentsFromSweep(env, {
      checks: [{
        id: "model_broker_coverage",
        label: "Model actions reached the broker (all lanes)",
        status: "warn",
        anomalies: [warn("TSM"), warn("AMD")],
      }],
    });
    const incident = out.open.find((i) => i.id === "model_broker_coverage");
    expect(incident.severity).toBe("warn");
    expect(incident.anomaly_fail_count).toBe(0);
    expect(buildAgentIssueBody(incident)).toContain("0 of severity `fail`");
  });
});
