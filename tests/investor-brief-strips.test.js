// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadInvestorPanelHelpers() {
  globalThis.React = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  const src = readFileSync(join(process.cwd(), "react-app/investor-panel.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TTInvestorLane;
}

describe("Investor brief strip helpers", () => {
  let lane;

  beforeAll(() => {
    lane = loadInvestorPanelHelpers();
  });

  it("keeps model lot actions within the last five days", () => {
    const now = Date.parse("2026-07-06T12:00:00Z");
    const actions = [
      { ticker: "MU", action: "BUY", ts: now - 3 * 86400000 },
      { ticker: "NVDA", action: "BUY", ts: now - 5 * 86400000 },
      { ticker: "CSCO", action: "BUY", ts: now - 6 * 86400000 },
      { ticker: "CRS", action: "SELL", ts: now - 16 * 86400000 },
    ];
    const filtered = lane.filterRecentInvestorActions(actions, now, lane.INVESTOR_RECENT_WINDOW_MS);
    expect(filtered.map((a) => a.ticker)).toEqual(["MU", "NVDA"]);
  });

  it("formats action age labels", () => {
    expect(lane.formatInvestorActionAgo(3 * 86400000)).toBe("3d ago");
    expect(lane.formatInvestorActionAgo(45 * 60000)).toBe("45m ago");
  });
});
