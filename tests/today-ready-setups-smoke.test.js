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
    act(() => { root.unmount(); });
  });

  it("rankReadySetupsFromData filters recently exited accumulate names", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const rows = rank({
      IESC: {
        ticker: "IESC",
        investor_stage: "accumulate",
        recentlyExited: { last_action_type: "SELL" },
        investor_score: 60,
      },
      NVDA: {
        ticker: "NVDA",
        investor_stage: "accumulate",
        investor_score: 80,
        rank: 5,
        flags: { momentum_elite: true },
      },
    });
    const syms = rows.map((r) => r.ticker);
    expect(syms).toContain("NVDA");
    expect(syms).not.toContain("IESC");
  });

  it("rankReadySetupsFromData caps output and prefers high-confluence names", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const data = {};
    for (let i = 0; i < 30; i++) {
      data[`T${i}`] = {
        ticker: `T${i}`,
        kanban_stage: "enter",
        rank: 60 + i,
      };
    }
    data.HOT = {
      ticker: "HOT",
      kanban_stage: "enter_now",
      rank: 3,
      flags: { momentum_elite: true, thesis_match: true, sq30_release: true },
      _theme_tilt: 4,
      market_internals: { sector_rotation: { state: "risk_on" } },
    };
    const rows = rank(data, 10);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows[0].ticker).toBe("HOT");
    expect(rows[0].confluence.length).toBeGreaterThanOrEqual(3);
  });

  it("rankReadySetupsFromData surfaces blocker labels", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const rows = rank({
      CAPITAL: {
        ticker: "CAPITAL",
        kanban_stage: "enter",
        rank: 4,
        flags: { portfolio_no_cash: true, momentum_elite: true },
      },
      QUEUED: {
        ticker: "QUEUED",
        investor_stage: "accumulate_queued",
        rank: 5,
        investor_score: 80,
      },
    });
    const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(byTicker.CAPITAL?.blocker).toMatch(/capital/i);
    expect(byTicker.QUEUED?.blocker).toMatch(/rebalance/i);
  });
});
