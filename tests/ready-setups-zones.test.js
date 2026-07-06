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

describe("Ready Setups zone-bar cards", () => {
  beforeAll(() => {
    window.React = React;
    window._ttIsPro = true;
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
  });

  it("row exposes traderZone with INV<price<TGT ladder when trader lane primed", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const rows = rank({
      NVDA: {
        ticker: "NVDA",
        kanban_stage: "enter",
        price: 500,
        _live_price: 500,
        sl: 480,
        entry_ref: 495,
        tp_trim: 540,
        tp_exit: 555,
        tp_runner: 580,
        rank: 5,
        flags: { momentum_elite: true },
      },
    });
    expect(rows.length).toBe(1);
    const [row] = rows;
    expect(row.traderPrimed).toBe(true);
    expect(row.traderZone).not.toBeNull();
    expect(row.traderZone.inv).toBe(480);
    expect(row.traderZone.tgt).toBe(540);
    expect(row.traderZone.price).toBe(500);
    expect(row.traderZone.pct(row.traderZone.inv)).toBeLessThan(row.traderZone.pct(row.traderZone.price));
    expect(row.traderZone.pct(row.traderZone.price)).toBeLessThan(row.traderZone.pct(row.traderZone.tgt));
  });

  it("row exposes investorZone using fair value as target when investor lane primed", () => {
    const rank = window.TimedVerdictUI.rankReadySetupsFromData;
    const rows = rank({
      PANW: {
        ticker: "PANW",
        investor_stage: "accumulate",
        investor_score: 72,
        price: 357.82,
        _live_price: 357.82,
        _fair_value: { fair_value: 420 },
        rank: 77,
        flags: { momentum_elite: true },
      },
    });
    const panw = rows.find((r) => r.ticker === "PANW");
    expect(panw).toBeTruthy();
    expect(panw.investorPrimed).toBe(true);
    expect(panw.investorZone).not.toBeNull();
    expect(panw.investorZone.tgt).toBe(420);
    expect(panw.investorZone.inv).toBeLessThan(357.82);
  });

  it("card renders both zone bars when trader + investor lanes are primed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Board = window.TimedVerdictUI.ReadySetupsBoard;
    const data = {
      NVDA: {
        ticker: "NVDA",
        kanban_stage: "enter",
        investor_stage: "accumulate",
        investor_score: 80,
        price: 500,
        _live_price: 500,
        sl: 480,
        entry_ref: 495,
        tp_trim: 540,
        tp_runner: 580,
        _fair_value: { fair_value: 620 },
        rank: 3,
        flags: { momentum_elite: true, thesis_match: true },
      },
    };
    act(() => {
      root.render(React.createElement(Board, {
        embedded: true,
        tickerData: data,
        onSelectTicker: () => {},
        savedSet: new Set(),
        onToggleSaved: () => {},
      }));
    });
    const html = container.innerHTML;
    expect(html).toContain("tt-ready-zone__seg--inv");
    expect(html).toContain("tt-ready-zone__seg--pb");
    expect(html).toContain("tt-ready-zone__seg--tgt");
    expect(html).toContain("tt-ready-zone__marker");
    expect(container.textContent).toMatch(/Invalidation/);
    expect(container.textContent).toMatch(/Pullback/);
    expect(container.textContent).toMatch(/Target/);
    // Both lane badges present.
    expect(container.textContent).toMatch(/TRADER/);
    expect(container.textContent).toMatch(/INVESTOR/);
    // Save star (unfilled).
    expect(container.textContent).toContain("\u2606");
    act(() => { root.unmount(); });
  });
});
