import { describe, it, expect } from "vitest";
import {
  moveEndingEnforceGateOpen,
  evaluateMoveEndingEnforce,
  MOVE_ENDING_TRIM_REASON,
  MOVE_ENDING_EXIT_REASON,
} from "./move-ending-enforce.js";

describe("move-ending enforce gate", () => {
  const daCfgOn = { deep_audit_move_ending_enforce_enabled: "true" };

  it("stays closed until n and keep-rate clear", () => {
    expect(moveEndingEnforceGateOpen({
      family_attribution: { ok: true, closed: 10, avg_mfe_keep_rate: 0.5 },
    }, daCfgOn).open).toBe(false);

    expect(moveEndingEnforceGateOpen({
      family_attribution: { ok: true, closed: 40, avg_mfe_keep_rate: 0.2 },
    }, daCfgOn).open).toBe(false);

    expect(moveEndingEnforceGateOpen({
      family_attribution: { ok: true, closed: 40, avg_mfe_keep_rate: 0.4 },
    }, daCfgOn).open).toBe(true);
  });

  it("forces trim then exit based on trim state", () => {
    const gov = { family_attribution: { ok: true, closed: 40, avg_mfe_keep_rate: 0.5 } };
    const trim = evaluateMoveEndingEnforce({
      tickerData: {},
      openTrade: { trimmedPct: 0 },
      daCfg: daCfgOn,
      governorReport: gov,
      signal: { level: "EXIT", score: 70 },
    });
    expect(trim.forceTrim).toBe(true);
    expect(trim.reason).toBe(MOVE_ENDING_TRIM_REASON);

    const exit = evaluateMoveEndingEnforce({
      tickerData: {},
      openTrade: { trimmedPct: 0.5 },
      daCfg: daCfgOn,
      governorReport: gov,
      signal: { level: "EXIT", score: 70 },
    });
    expect(exit.forceExit).toBe(true);
    expect(exit.reason).toBe(MOVE_ENDING_EXIT_REASON);
  });

  it("no-ops when flag off", () => {
    const r = evaluateMoveEndingEnforce({
      tickerData: {},
      openTrade: { trimmedPct: 0 },
      daCfg: { deep_audit_move_ending_enforce_enabled: "false" },
      governorReport: { family_attribution: { ok: true, closed: 40, avg_mfe_keep_rate: 0.5 } },
      signal: { level: "EXIT", score: 80 },
    });
    expect(r.forceExit).toBe(false);
    expect(r.forceTrim).toBe(false);
  });
});
