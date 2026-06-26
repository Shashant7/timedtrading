import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  computeConfigHash,
  buildDecisionRecord,
  loadDeepAuditConfigFromDb,
  DECISION_RECORD_SCHEMA_VERSION,
  DECISION_RECORD_COLUMNS,
  DECISION_RECORDS_DDL,
} from "./decision-records.js";

describe("loadDeepAuditConfigFromDb", () => {
  it("filters allowed keys and returns the same hash as computeConfigHash", async () => {
    const rows = [
      { config_key: "deep_audit_max_loss_pct", config_value: "-4.5" },
      { config_key: "ignored_key", config_value: "1" },
      { config_key: "gates", config_value: '{"g1":true}' },
    ];
    const db = {
      prepare: () => ({
        all: async () => ({ results: rows }),
      }),
    };
    const allowed = ["deep_audit_max_loss_pct", "gates"];
    const { config, configHash } = await loadDeepAuditConfigFromDb(db, allowed);
    expect(config.ignored_key).toBeUndefined();
    expect(config.deep_audit_max_loss_pct).toBe(-4.5);
    expect(config.gates).toEqual({ g1: true });
    expect(configHash).toBe(computeConfigHash(config));
  });

  it("returns empty config/hash when db or allowlist missing", async () => {
    expect(await loadDeepAuditConfigFromDb(null, ["a"])).toEqual({ config: {}, configHash: "" });
    expect(await loadDeepAuditConfigFromDb({}, [])).toEqual({ config: {}, configHash: "" });
  });
});

describe("computeConfigHash", () => {
  it("is deterministic and key-order independent", () => {
    const a = computeConfigHash({ b: 2, a: 1, nested: { y: 9, x: 8 } });
    const b = computeConfigHash({ a: 1, nested: { x: 8, y: 9 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when a config value changes", () => {
    const before = computeConfigHash({ deep_audit_max_loss_pct: -4.5 });
    const after = computeConfigHash({ deep_audit_max_loss_pct: -3.0 });
    expect(before).not.toBe(after);
  });

  it("returns empty string for empty/missing config", () => {
    expect(computeConfigHash(null)).toBe("");
    expect(computeConfigHash({})).toBe("");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("buildDecisionRecord", () => {
  it("builds a normalized, idempotent record with parsed ticker", () => {
    const rec = buildDecisionRecord({
      engine: "trader",
      tradeId: "MU-1782141273382-abc",
      eventType: "trim",
      ts: 1782141273382,
      reason: "atr_tp_ladder_tier3_trim",
      scoringVersion: "2.1.0-2026-03-20",
      engineGitSha: "deadbeef",
      configHash: "1a2b3c4d",
      convictionTier: "A",
      inputs: { pnl_pct: 4.2 },
    });
    expect(rec.event_type).toBe("TRIM");
    expect(rec.ticker).toBe("MU");
    expect(rec.engine).toBe("trader");
    expect(rec.decision_id).toBe("MU-1782141273382-abc:TRIM:1782141273382");
    expect(rec.schema_version).toBe(DECISION_RECORD_SCHEMA_VERSION);
    expect(rec.inputs_json).toBe('{"pnl_pct":4.2}');
  });

  it("captures DEFEND with engine tagging (investor stays separate)", () => {
    const rec = buildDecisionRecord({
      engine: "investor",
      tradeId: "AAPL-1",
      eventType: "DEFEND",
      ts: 100,
      reason: "soft_fuse_deferred",
    });
    expect(rec.engine).toBe("investor");
    expect(rec.event_type).toBe("DEFEND");
  });

  it("returns null on a bad event (no type / ts)", () => {
    expect(buildDecisionRecord({ tradeId: "X-1", ts: 0 })).toBeNull();
    expect(buildDecisionRecord({ eventType: "ENTRY" })).toBeNull();
  });

  it("accepts a pre-stringified inputs blob unchanged", () => {
    const rec = buildDecisionRecord({ tradeId: "X-1", eventType: "ENTRY", ts: 1, inputs: '{"a":1}' });
    expect(rec.inputs_json).toBe('{"a":1}');
  });
});

describe("schema wiring", () => {
  it("DDL creates the table and the binding columns line up", () => {
    expect(DECISION_RECORDS_DDL[0]).toMatch(/CREATE TABLE IF NOT EXISTS decision_records/);
    expect(DECISION_RECORD_COLUMNS).toHaveLength(15);
    expect(DECISION_RECORD_COLUMNS[0]).toBe("decision_id");
  });
});
