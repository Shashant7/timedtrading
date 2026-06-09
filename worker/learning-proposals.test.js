// Tests for the learning-proposals apply bus (P3.L4) and the CIO
// authority evaluator (P3.L2). D1 is mocked with an in-memory stub —
// the same pattern used by the discovery/coo tests.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  submitProposal,
  processProposals,
  decideProposal,
  listProposals,
} from "./learning-proposals.js";
import { evaluateCioAuthority, computeCioScorecard } from "./cio/cio-authority.js";

// ── Minimal D1 stub ───────────────────────────────────────────────────
// Supports the exact SQL shapes the modules issue. Stores proposals and
// model_config in plain maps.

function makeDb(state) {
  const exec = async (sql, binds) => {
    sql = sql.replace(/\s+/g, " ").trim();
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return { results: [] };

    if (sql.startsWith("SELECT id FROM learning_proposals WHERE status = 'pending' AND source =")) {
      const [source, key] = binds;
      const hit = state.proposals.find((p) => p.status === "pending" && p.source === source && p.config_key === key);
      return { first: hit ? { id: hit.id } : null };
    }
    if (sql.startsWith("SELECT config_value FROM model_config WHERE config_key =")) {
      const v = state.config.get(binds[0]);
      return { first: v === undefined ? null : { config_value: v } };
    }
    if (sql.startsWith("UPDATE learning_proposals SET proposed_value =")) {
      const [proposed, evidence, tier, current, ts, note, id] = binds;
      const p = state.proposals.find((x) => x.id === id);
      Object.assign(p, { proposed_value: proposed, evidence_json: evidence, tier, current_value: current, created_at: ts, note });
      return {};
    }
    if (sql.startsWith("INSERT INTO learning_proposals")) {
      const [ts, source, kind, key, current, proposed, evidence, tier, note] = binds;
      const id = state.proposals.length + 1;
      state.proposals.push({
        id, created_at: ts, source, kind, config_key: key, current_value: current,
        proposed_value: proposed, evidence_json: evidence, tier, status: "pending", note,
      });
      return { meta: { last_row_id: id } };
    }
    if (sql.startsWith("SELECT * FROM learning_proposals WHERE status = 'pending' ORDER BY")) {
      return { results: state.proposals.filter((p) => p.status === "pending") };
    }
    if (sql.startsWith("SELECT * FROM learning_proposals WHERE id =")) {
      const p = state.proposals.find((x) => x.id === Number(binds[0]) && x.status === "pending");
      return { first: p || null };
    }
    if (sql.startsWith("SELECT * FROM learning_proposals WHERE status =")) {
      return { results: state.proposals.filter((p) => p.status === binds[0]) };
    }
    if (sql.startsWith("SELECT * FROM learning_proposals ORDER BY")) {
      return { results: [...state.proposals] };
    }
    if (sql.startsWith("INSERT INTO model_config")) {
      // upsert: key + value are the first two binds for the bus's write;
      // the authority auto-demote write has description first — handle both.
      if (sql.includes("'ai_cio_shadow_mode'")) {
        state.config.set("ai_cio_shadow_mode", "true");
      } else {
        state.config.set(binds[0], binds[1]);
      }
      return {};
    }
    if (sql.startsWith("UPDATE learning_proposals SET status = 'applied'")) {
      const id = binds[4];
      const p = state.proposals.find((x) => x.id === id);
      Object.assign(p, { status: "applied", applied_at: binds[0], decided_by: binds[1], rollback_value: binds[2] });
      return {};
    }
    if (sql.startsWith("UPDATE learning_proposals SET status = 'rejected'")) {
      const p = state.proposals.find((x) => x.id === binds[2]);
      Object.assign(p, { status: "rejected", decided_at: binds[0], decided_by: binds[1] });
      return {};
    }
    if (sql.includes("FROM ai_cio_decisions")) {
      return { results: state.cioDecisions || [] };
    }
    throw new Error(`unhandled sql: ${sql.slice(0, 90)}`);
  };

  return {
    prepare(sql) {
      const stmt = {
        _binds: [],
        bind(...args) { stmt._binds = args; return stmt; },
        async run() { return exec(sql, stmt._binds); },
        async first() { const r = await exec(sql, stmt._binds); return r.first ?? null; },
        async all() { const r = await exec(sql, stmt._binds); return { results: r.results || [] }; },
      };
      return stmt;
    },
  };
}

function makeEnv(state, extra = {}) {
  return {
    DB: makeDb(state),
    KV_TIMED: {
      _kv: new Map(),
      async put(k, v) { this._kv.set(k, v); },
      async get(k) { return this._kv.get(k) ?? null; },
    },
    ...extra,
  };
}

let state;
beforeEach(() => {
  state = { proposals: [], config: new Map(), cioDecisions: [] };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("learning-proposals bus", () => {
  it("submits and dedupes pending proposals per (source, config_key)", async () => {
    const env = makeEnv(state);
    const a = await submitProposal(env, { source: "test", kind: "x", config_key: "k1", proposed_value: "5", tier: "tier1" });
    const b = await submitProposal(env, { source: "test", kind: "x", config_key: "k1", proposed_value: "6", tier: "tier1" });
    expect(a.ok && b.ok).toBe(true);
    expect(b.updated).toBe(true);
    expect(state.proposals.length).toBe(1);
    expect(state.proposals[0].proposed_value).toBe("6");
  });

  it("tier-1 auto-applies within ±10% when COO_AUTO_APPLY_TIER1=true", async () => {
    state.config.set("rank_min", "50");
    const env = makeEnv(state, { COO_AUTO_APPLY_TIER1: "true" });
    await submitProposal(env, { source: "calib", kind: "nudge", config_key: "rank_min", proposed_value: "52", tier: "tier1" });
    const r = await processProposals(env);
    expect(r.applied.length).toBe(1);
    expect(state.config.get("rank_min")).toBe("52");
    expect(state.proposals[0].status).toBe("applied");
    expect(state.proposals[0].rollback_value).toBe("50");
  });

  it("tier-1 CLAMPS to ±10% when the proposal overshoots", async () => {
    state.config.set("rank_min", "50");
    const env = makeEnv(state, { COO_AUTO_APPLY_TIER1: "true" });
    await submitProposal(env, { source: "calib", kind: "nudge", config_key: "rank_min", proposed_value: "80", tier: "tier1" });
    const r = await processProposals(env);
    expect(r.applied[0].clamped).toBe(true);
    expect(Number(state.config.get("rank_min"))).toBeCloseTo(55, 5); // 50 × 1.10
  });

  it("tier-1 stays dry-run when COO_AUTO_APPLY_TIER1 is off", async () => {
    state.config.set("rank_min", "50");
    const env = makeEnv(state, { COO_AUTO_APPLY_TIER1: "false" });
    await submitProposal(env, { source: "calib", kind: "nudge", config_key: "rank_min", proposed_value: "52", tier: "tier1" });
    const r = await processProposals(env);
    expect(r.applied.length).toBe(0);
    expect(r.dry_run.length).toBe(1);
    expect(state.config.get("rank_min")).toBe("50");
  });

  it("tier-2 NEVER auto-applies; operator approve applies it verbatim", async () => {
    state.config.set("ai_cio_shadow_mode", "true");
    const env = makeEnv(state, { COO_AUTO_APPLY_TIER1: "true" });
    await submitProposal(env, { source: "cio_authority", kind: "flag_flip", config_key: "ai_cio_shadow_mode", proposed_value: "false", tier: "tier2" });
    const nightly = await processProposals(env);
    expect(nightly.applied.length).toBe(0);
    expect(nightly.awaiting_operator.length).toBe(1);

    const decided = await decideProposal(env, 1, "approve");
    expect(decided.ok).toBe(true);
    expect(state.config.get("ai_cio_shadow_mode")).toBe("false");
  });

  it("operator reject closes the proposal without touching config", async () => {
    state.config.set("k", "1");
    const env = makeEnv(state);
    await submitProposal(env, { source: "s", kind: "x", config_key: "k", proposed_value: "9", tier: "tier2" });
    const r = await decideProposal(env, 1, "reject");
    expect(r.status).toBe("rejected");
    expect(state.config.get("k")).toBe("1");
    const list = await listProposals(env, { status: "rejected" });
    expect(list.proposals.length).toBe(1);
  });
});

describe("CIO authority evaluator", () => {
  const mkDecision = (decision, outcome, shadow = 1) => ({
    decision, shadow, trade_outcome: outcome, trade_pnl_pct: outcome === "WIN" ? 2 : -1, created_at: Date.now(),
  });

  it("computes scorecard metrics from attributed decisions", async () => {
    state.cioDecisions = [
      mkDecision("APPROVE", "WIN"), mkDecision("APPROVE", "LOSS"),
      mkDecision("REJECT", "LOSS"), mkDecision("REJECT", "WIN"),
      mkDecision("STALL_HOLD", "WIN"),
    ];
    const env = makeEnv(state);
    const card = await computeCioScorecard(env);
    expect(card.entry.approve_wr).toBe(0.5);
    expect(card.entry.reject_precision).toBe(0.5);
    expect(card.lifecycle.hold_save_rate).toBe(1);
  });

  it("proposes promotion (tier-2) when shadow + precision above floors", async () => {
    state.cioDecisions = [
      ...Array(15).fill(0).map(() => mkDecision("APPROVE", "WIN")),
      ...Array(10).fill(0).map(() => mkDecision("REJECT", "LOSS")),
    ];
    const env = makeEnv(state, { _deepAuditConfig: { ai_cio_shadow_mode: "true" } });
    const submit = vi.fn(async () => ({ ok: true, id: 7 }));
    const r = await evaluateCioAuthority(env, { submitProposal: submit });
    expect(r.sampled).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][1].config_key).toBe("ai_cio_shadow_mode");
    expect(submit.mock.calls[0][1].proposed_value).toBe("false");
    expect(submit.mock.calls[0][1].tier).toBe("tier2");
    expect(r.actions[0].action).toBe("promote_proposed");
  });

  it("auto-demotes live→shadow on degradation ONLY with autoscale=true", async () => {
    state.cioDecisions = [
      ...Array(20).fill(0).map(() => mkDecision("APPROVE", "LOSS", 0)),
      ...Array(10).fill(0).map(() => mkDecision("REJECT", "WIN", 0)),
    ];
    // live + autoscale OFF → proposal only
    let env = makeEnv(state, { _deepAuditConfig: { ai_cio_shadow_mode: "false", ai_cio_authority_autoscale: "false" } });
    const submit = vi.fn(async () => ({ ok: true, id: 3 }));
    let r = await evaluateCioAuthority(env, { submitProposal: submit });
    expect(r.actions[0].action).toBe("demote_proposed");
    expect(state.config.get("ai_cio_shadow_mode")).toBeUndefined();

    // live + autoscale ON → direct demotion write
    env = makeEnv(state, { _deepAuditConfig: { ai_cio_shadow_mode: "false", ai_cio_authority_autoscale: "true" } });
    const discord = vi.fn(async () => {});
    r = await evaluateCioAuthority(env, { submitProposal: submit, notifyDiscord: discord });
    expect(r.actions[0].action).toBe("auto_demoted_to_shadow");
    expect(state.config.get("ai_cio_shadow_mode")).toBe("true");
    expect(discord).toHaveBeenCalledOnce();
  });

  it("does nothing below the minimum sample", async () => {
    state.cioDecisions = [mkDecision("APPROVE", "WIN"), mkDecision("REJECT", "LOSS")];
    const env = makeEnv(state, { _deepAuditConfig: { ai_cio_shadow_mode: "true" } });
    const submit = vi.fn();
    const r = await evaluateCioAuthority(env, { submitProposal: submit });
    expect(r.sampled).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(r.actions.length).toBe(0);
  });
});
