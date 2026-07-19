import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_STATES,
  resolveModelLifecycle,
  formatLifecycleHeadline,
} from "./model-lifecycle.js";

describe("resolveModelLifecycle", () => {
  it("maps trader enter_now to queued", () => {
    const r = resolveModelLifecycle({ ticker: "NVDA", kanban_stage: "enter_now" });
    expect(r.state).toBe(LIFECYCLE_STATES.QUEUED);
    expect(r.horizon).toBe("swing");
    expect(r.label).toBe("Queued");
  });

  it("maps investor accumulate + act_now to queued", () => {
    const r = resolveModelLifecycle({
      ticker: "MCD",
      investor_stage: "accumulate",
      actionTier: "act_now",
    });
    expect(r.state).toBe(LIFECYCLE_STATES.QUEUED);
    expect(r.horizon).toBe("long_haul");
    expect(r.book).toBe("investor");
  });

  it("open trader position → held (or bought if fresh)", () => {
    const held = resolveModelLifecycle({
      ticker: "AAPL",
      kanban_stage: "hold",
      open_trader: true,
      entry_ts: Date.now() - 2 * 86400000,
    });
    expect(held.state).toBe(LIFECYCLE_STATES.HELD);

    const bought = resolveModelLifecycle({
      ticker: "AAPL",
      kanban_stage: "hold",
      open_trader: true,
      entry_ts: Date.now() - 30 * 60 * 1000,
    });
    expect(bought.state).toBe(LIFECYCLE_STATES.BOUGHT);
  });

  it("trimmed today → trimming", () => {
    const r = resolveModelLifecycle({
      ticker: "MSFT",
      kanban_stage: "hold",
      open_trader: true,
      trimmed_today: true,
    });
    expect(r.state).toBe(LIFECYCLE_STATES.TRIMMING);
  });

  it("investor reduce with open → trimming", () => {
    const r = resolveModelLifecycle({
      ticker: "KO",
      investor_stage: "reduce",
      open_investor: true,
    });
    expect(r.state).toBe(LIFECYCLE_STATES.TRIMMING);
    expect(r.horizon).toBe("long_haul");
  });

  it("same ticker: open investor beats trader watching", () => {
    const r = resolveModelLifecycle({
      ticker: "COST",
      kanban_stage: "setup",
      investor_stage: "core_hold",
      open_investor: true,
    });
    expect(r.state).toBe(LIFECYCLE_STATES.HELD);
    expect(r.book).toBe("investor");
  });

  it("carries why + levels", () => {
    const r = resolveModelLifecycle({
      ticker: "NVDA",
      kanban_stage: "hold",
      open_trader: true,
      why: "EMA21 reclaim + confirm stack",
      entry: 120,
      sl: 110,
      tp1: 140,
    });
    expect(r.why).toMatch(/EMA21/);
    expect(r.levels.entry).toBe(120);
    expect(r.levels.invalidation).toBe(110);
    expect(r.levels.target_1).toBe(140);
    expect(formatLifecycleHeadline(r)).toMatch(/Held/);
  });

  it("carries model play vehicle (shares|letf|options)", () => {
    const r = resolveModelLifecycle({
      ticker: "QQQ",
      kanban_stage: "just_entered",
      open_trader: true,
      entry_ts: Date.now(),
      play: { play_vehicle: "options", label: "Long Call", why: "convexity on 8% move" },
    });
    expect(r.play.play_vehicle).toBe("options");
    expect(r.play.label).toMatch(/Call/);
    expect(formatLifecycleHeadline(r)).toMatch(/options/);
  });
});
