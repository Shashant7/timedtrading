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

describe("VerdictGuideBlock — unowned watch demotes to On Radar", () => {
  beforeAll(() => {
    window.React = React;
    window._ttIsPro = true;
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
    expect(typeof window.TimedVerdictUI?.VerdictGuideBlock).toBe("function");
    expect(typeof window.TimedRailHelpers?.resolveInvestorKanbanStage).toBe("function");
  });

  it("unowned stage=watch renders as 'On Radar' — not 'Hold & Watch' (owned)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Block = window.TimedVerdictUI.VerdictGuideBlock;

    // PANW-shaped: unowned, watch stage, score 56.
    const verdictData = {
      ok: true,
      trader: { verdict: "WAIT", why: "no trigger" },
      investor: { verdict: "WAIT", why: "score fell" },
    };
    const investorData = {
      ticker: "PANW",
      stage: "watch",
      score: 56,
      position: { owned: false },
    };

    act(() => {
      root.render(
        React.createElement(Block, {
          ticker: "PANW",
          data: verdictData,
          loading: false,
          tickerPayload: { price: 356.58, ticker: "PANW", investor_stage: "watch" },
          investorData,
          livePrice: 356.58,
        })
      );
    });

    const text = container.textContent || "";
    expect(text).toContain("On Radar");
    expect(text).not.toContain("Owned but signals are mixed");
    expect(text).not.toContain("Hold & Watch");
  });

  it("owned stage=watch renders as 'Hold & Watch'", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Block = window.TimedVerdictUI.VerdictGuideBlock;

    const verdictData = {
      ok: true,
      trader: { verdict: "WAIT", why: "no trigger" },
      investor: { verdict: "HOLD", why: "hold flat" },
    };
    const investorData = {
      ticker: "TWLO",
      stage: "watch",
      score: 57,
      position: { owned: true, shares: 33.2, avg_entry: 211 },
    };

    act(() => {
      root.render(
        React.createElement(Block, {
          ticker: "TWLO",
          data: verdictData,
          loading: false,
          tickerPayload: { price: 209, ticker: "TWLO" },
          investorData,
          livePrice: 209,
        })
      );
    });

    const text = container.textContent || "";
    expect(text).toContain("Hold & Watch");
  });
});
