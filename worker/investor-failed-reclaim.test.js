// Failed entry-reclaim exit — MTZ Jul 2 movie (underwater → near BE → reject).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVESTOR_CONFIG,
  resolveInvestorFailedEntryReclaim,
  parseInvestorPositionNotes,
} from "./investor.js";

const entry = 391.04;

function td({ below233 = true, cloudBear = true } = {}) {
  return {
    price: 360,
    tf_tech: {
      "10": {
        ema: { ema233: below233 ? 380 : 340 },
        ripster: {
          c5_12: cloudBear
            ? { bear: true, crossDn: true, crossUp: false }
            : { bull: true, crossUp: true, bear: false },
        },
      },
    },
  };
}

describe("resolveInvestorFailedEntryReclaim", () => {
  it("arms after a ≥3% underwater print", () => {
    const r = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: entry * 0.96, // -4%
      priorState: null,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 1,
    });
    expect(r.fire).toBe(false);
    expect(r.state?.armed).toBe(true);
    expect(r.state.mae_pct).toBeLessThan(-3);
  });

  it("does not fire until recovery tags the breakeven band", () => {
    const armed = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: entry * 0.90,
      priorState: null,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 1,
    }).state;
    const mid = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: entry * 0.94, // still >1.5% below entry
      priorState: armed,
      tickerData: td(),
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 2,
    });
    expect(mid.fire).toBe(false);
    expect(mid.state.saw_near_be).toBe(false);
  });

  it("fires on MTZ-style near-BE then reject (giveback + fail 233)", () => {
    let state = null;
    // 1) Hard drop
    state = resolveInvestorFailedEntryReclaim({
      avgEntry: entry, price: 350, priorState: state, now: 1,
    }).state;
    expect(state.armed).toBe(true);
    // 2) Nearly back to entry
    state = resolveInvestorFailedEntryReclaim({
      avgEntry: entry, price: 388, priorState: state, now: 2,
    }).state;
    expect(state.saw_near_be).toBe(true);
    // 3) Reject — pullback + below 233 + bear cloud
    const fire = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: 370,
      priorState: state,
      tickerData: td({ below233: true, cloudBear: true }),
      now: 3,
    });
    expect(fire.fire).toBe(true);
    expect(fire.reason).toBe("FAILED_ENTRY_RECLAIM");
    expect(["giveback_from_recovery_high", "fail_10m_233", "fail_10m_5_12"]).toContain(fire.reject);
  });

  it("clears arm when price rescues above entry", () => {
    const armed = {
      armed: true, armed_ts: 1, mae_pct: -8, high_since_arm: 380, saw_near_be: true,
    };
    const r = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: entry * 1.03,
      priorState: armed,
      cfg: DEFAULT_INVESTOR_CONFIG,
      now: 9,
    });
    expect(r.fire).toBe(false);
    expect(r.state).toBeNull();
    expect(r.reason).toBe("cleared_above_entry");
  });

  it("can be disabled via config", () => {
    const r = resolveInvestorFailedEntryReclaim({
      avgEntry: entry,
      price: 350,
      cfg: { ...DEFAULT_INVESTOR_CONFIG, investor_failed_reclaim_exit_enabled: false },
    });
    expect(r.state).toBeNull();
    expect(r.fire).toBe(false);
  });
});

describe("parseInvestorPositionNotes", () => {
  it("round-trips failed_reclaim state", () => {
    const raw = JSON.stringify({ _failed_reclaim: { armed: true, mae_pct: -5 }, other: 1 });
    const n = parseInvestorPositionNotes(raw);
    expect(n._failed_reclaim.armed).toBe(true);
    expect(n.other).toBe(1);
  });
});
