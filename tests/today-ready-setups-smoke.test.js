// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function loadScript(relPath) {
  const src = readFileSync(join(process.cwd(), relPath), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
}

describe("Today ReadySetupsBoard smoke", () => {
  beforeAll(() => {
    window.React = React;
    window._ttIsPro = true;
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
    expect(typeof window.TimedRailHelpers?.isInvestorBuyZoneThesis).toBe("function");
    expect(typeof window.TimedVerdictUI?.ReadySetupsBoard).toBe("function");
  });

  it("renders embedded ReadySetupsBoard without throwing on /timed/all-shaped data", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Board = window.TimedVerdictUI.ReadySetupsBoard;
    const data = {
      AAPL: { ticker: "AAPL", investor_stage: "accumulate", score: 72, price: 190, rank: 5 },
      MSFT: { ticker: "MSFT", kanban_stage: "enter", price: 420, rank: 2 },
      IESC: {
        ticker: "IESC",
        investor_stage: "accumulate",
        recentlyExited: { closed_at: Date.now() - 3600000 },
        score: 60,
        price: 681,
      },
    };
    expect(() => {
      act(() => {
        root.render(React.createElement(Board, {
          embedded: true,
          tickerData: data,
          onSelectTicker: () => {},
        }));
      });
    }).not.toThrow();
    expect(container.textContent).toMatch(/READY SETUPS/);
    root.unmount();
  });

  it("rankReadySetupsFromData filters recently exited accumulate names", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const rows = rank({
      IESC: { investor_stage: "accumulate", recentlyExited: { last_action_type: "SELL" }, score: 60 },
      NVDA: { investor_stage: "accumulate", score: 80, simEligible: true, accumZone: { inZone: true } },
    });
    const syms = rows.map((r) => r.ticker);
    expect(syms).toContain("NVDA");
    expect(syms).not.toContain("IESC");
  });
});
