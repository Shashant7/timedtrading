import { describe, it, expect } from "vitest";
import {
  deskTriageProposal,
  parseDemotionKey,
  planRecoveredRestores,
  formatLearningDeskDiscord,
} from "./learning-desk-review.js";

const NOW = Date.UTC(2026, 7, 27, 22, 0, 0);

describe("parseDemotionKey", () => {
  it("maps Support Bounce and flags mangled TT Tt keys", () => {
    const sb = parseDemotionKey("deep_audit_setup_demotion_TT Support Bounce_long");
    expect(sb.play_id).toBe("tt_n_test_support");
    expect(sb.mangled).toBe(false);
    const mangled = parseDemotionKey("deep_audit_setup_demotion_TT Tt Ath Breakout_long");
    expect(mangled.play_id).toBe("tt_ath_breakout");
    expect(mangled.mangled).toBe(true);
  });
});

describe("deskTriageProposal", () => {
  it("CTO acks a block that is already live", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_setup_demotion_TT ATH Breakout_long", proposed_value: "blocked" },
      { liveValue: "\"blocked\"", now: NOW },
    );
    expect(v).toMatchObject({ action: "ack", desk: "cto", reason: "already_in_effect" });
  });

  it("CRO rejects Gap Reversal workhorse demotion", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_setup_demotion_TT Gap Reversal (Long)_long", proposed_value: "blocked" },
      { liveValue: null, now: NOW },
    );
    expect(v).toMatchObject({ action: "reject", desk: "cro", reason: "workhorse_protected" });
  });

  it("CIO restores Support Bounce when 30d is +EV, even if already blocked", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_setup_demotion_TT Support Bounce_long", proposed_value: "blocked" },
      {
        liveValue: "blocked",
        now: NOW,
        perSetup30: [{ setup: "tt_n_test_support", direction: "long", stats: { n: 20, pnl_usd: 312 } }],
      },
    );
    expect(v).toMatchObject({ action: "restore", desk: "cio", reason: "setup_recovered_30d" });
  });

  it("CRO restores a workhorse that is already blocked", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_setup_demotion_TT Gap Reversal (Long)_long", proposed_value: "blocked" },
      { liveValue: "blocked", now: NOW },
    );
    expect(v).toMatchObject({ action: "restore", desk: "cro", reason: "workhorse_protected" });
  });

  it("CRO approves block_widen when WoW is red", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_weekly_governor_block_widen", proposed_value: "true" },
      { wow: { regressing: true }, now: NOW },
    );
    expect(v).toMatchObject({ action: "approve", desk: "cro", reason: "wow_regressing_block_widen" });
  });

  it("CTO rejects discovery notes that only increment the same numbers", () => {
    const v = deskTriageProposal(
      {
        source: "discovery",
        config_key: "deep_audit_trail_atr_mult",
        proposed_value: "3.5",
        note: "Widen trailing stop to reduce 8 churn events",
        created_at: NOW,
      },
      {
        now: NOW,
        appliedSameKey: [{
          config_key: "deep_audit_trail_atr_mult",
          note: "Widen trailing stop to reduce 7 churn events",
          applied_at: NOW - 60 * 86400000,
        }],
      },
    );
    expect(v).toMatchObject({ action: "reject", desk: "cto", reason: "recycled_discovery_note" });
  });

  it("CTO rejects recycled discovery notes", () => {
    const v = deskTriageProposal(
      {
        source: "discovery",
        config_key: "deep_audit_trail_atr_mult",
        proposed_value: "3.5",
        note: "Widen trailing stop to reduce 7 churn events",
        created_at: NOW - 86400000,
      },
      {
        now: NOW,
        appliedSameKey: [{
          config_key: "deep_audit_trail_atr_mult",
          note: "Widen trailing stop to reduce 7 churn events",
        }],
      },
    );
    expect(v).toMatchObject({ action: "reject", desk: "cto", reason: "recycled_discovery_note" });
  });

  it("CTO rejects mangled legacy demotion keys", () => {
    const v = deskTriageProposal(
      { config_key: "deep_audit_setup_demotion_TT Tt N Test Support_long", proposed_value: "blocked" },
      { liveValue: null, now: NOW },
    );
    expect(v.action).toBe("reject");
    expect(v.reason).toBe("mangled_demotion_key");
  });
});

describe("planRecoveredRestores", () => {
  it("lists Support Bounce when 30d recovered and currently blocked", () => {
    const out = planRecoveredRestores(
      [{ setup: "TT Support Bounce", direction: "long", stats: { n: 20, pnl_usd: 312 } }],
      { "deep_audit_setup_demotion_TT Support Bounce_long": "blocked" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].play_id).toBe("tt_n_test_support");
  });
});

describe("formatLearningDeskDiscord", () => {
  it("lists decided and leftover restores, not empty queues", () => {
    expect(formatLearningDeskDiscord({ decided: [], escalated: [], restored: [] })).toBe("");
    const text = formatLearningDeskDiscord({
      decided: [{ desk: "cio", action: "restore", id: 18, config_key: "deep_audit_setup_demotion_TT Support Bounce_long", reason: "setup_recovered_30d" }],
      restored: [{ config_key: "deep_audit_setup_demotion_TT Support Bounce_long", play_id: "tt_n_test_support" }],
      escalated: [{ desk: "cio", id: 99, config_key: "other", reason: "demotion_mixed_windows" }],
    });
    expect(text).toContain("CIO restore #18");
    expect(text).toContain("ESCALATE cio #99");
    expect(text.match(/Support Bounce/g)?.length).toBe(1);
  });
});
