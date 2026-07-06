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
  eval(src);
}

describe("Ready Setups card labels", () => {
  let rank;
  let resolveDisplay;

  beforeAll(() => {
    window.React = React;
    window._ttIsPro = true;
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
    rank = window.TimedVerdictUI.rankReadySetupsFromData;
    resolveDisplay = window.TimedVerdictUI.resolveReadySetupCardDisplay;
  });

  it("shows ACCUMULATE when investor thesis is live but price is above the PB band", () => {
    const rows = rank({
      PANW: {
        ticker: "PANW",
        investor_stage: "accumulate",
        investor_score: 77,
        price: 356.97,
        _live_price: 356.97,
        _fair_value: { fair_value: 392.67 },
        rank: 77,
        flags: { momentum_elite: true },
      },
    });
    const panw = rows.find((r) => r.ticker === "PANW");
    expect(panw).toBeTruthy();
    expect(panw.display.label).toBe("ACCUMULATE");
    expect(panw.display.cls).toBe("accumulate");
    expect(panw.display.hint).toMatch(/dips/i);
  });

  it("shows BUY when accumZone.inZone is true", () => {
    const rows = rank({
      CRS: {
        ticker: "CRS",
        investor_stage: "accumulate",
        investor_score: 81,
        price: 590,
        _live_price: 590,
        accumZone: { inZone: true, zoneBottom: 576, zoneTop: 602 },
        rank: 66,
      },
    });
    expect(rows[0].display.label).toBe("BUY");
    expect(rows[0].display.cls).toBe("buy");
  });

  it("shows SCALE IN when price sits inside the planned PB band", () => {
    const rows = rank({
      GS: {
        ticker: "GS",
        investor_stage: "accumulate",
        investor_score: 79,
        price: 345,
        _live_price: 345,
        primary_invalidation_price: 314,
        _fair_value: { fair_value: 392 },
        rank: 79,
      },
    });
    const gs = rows[0];
    expect(gs.investorZone).not.toBeNull();
    expect(gs.display.label).toBe("SCALE IN");
    expect(gs.display.cls).toBe("accumulate");
  });

  it("shows BUY NOW for trader entry lane", () => {
    const rows = rank({
      NVDA: {
        ticker: "NVDA",
        kanban_stage: "enter_now",
        price: 500,
        sl: 480,
        tp_trim: 540,
        rank: 3,
      },
    });
    expect(rows[0].display.label).toBe("BUY NOW");
    expect(rows[0].display.cls).toBe("buy");
  });

  it("shows QUEUED for accumulate_queued investor names", () => {
    const rows = rank({
      QUE: {
        ticker: "QUE",
        investor_stage: "accumulate_queued",
        investor_score: 80,
        price: 100,
        rank: 10,
      },
    });
    expect(rows[0].display.label).toBe("QUEUED");
    expect(rows[0].display.cls).toBe("queued");
  });

  it("renders the zone-aware label on the card surface", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Board = window.TimedVerdictUI.ReadySetupsBoard;
    act(() => {
      root.render(React.createElement(Board, {
        embedded: true,
        tickerData: {
          PANW: {
            ticker: "PANW",
            investor_stage: "accumulate",
            investor_score: 77,
            price: 356.97,
            _fair_value: { fair_value: 392.67 },
            rank: 77,
          },
        },
        onSelectTicker: () => {},
      }));
    });
    expect(container.textContent).toContain("ACCUMULATE");
    expect(container.textContent).toMatch(/add on dips/i);
    expect(container.textContent).not.toContain("BUY NOW");
    act(() => { root.unmount(); });
  });

  it("resolveReadySetupCardDisplay prefers trader headline when both lanes primed", () => {
    const row = {
      traderPrimed: true,
      investorPrimed: true,
      trader: { verdict: "BUY", why: "entry lane (enter)" },
      price: 500,
    };
    const disp = resolveDisplay(row, { kanban_stage: "enter", investor_stage: "accumulate" });
    expect(disp.label).toBe("BUY NOW");
  });
});
