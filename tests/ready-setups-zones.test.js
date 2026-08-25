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
    loadScript("react-app/shared-lane-card.js");
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
    expect(html).toContain("tt-strip-card");
    expect(html).toContain("tt-strip-card__foot");
    expect(html).toContain("tt-zone-plan");
    expect(html).toContain("tt-zone-plan__dot");
    expect(html).toContain("tt-lane-card__pos-track");
    expect(container.textContent).toMatch(/INV/);
    expect(container.textContent).toMatch(/PB/);
    expect(container.textContent).toMatch(/TGT/);
    // Capital-shortlist cards render facts through the shared stripFactsGrid
    // 2-col stack (.tt-strip-fact-stack), unified with the options-lotto grid.
    expect(html).toContain("tt-strip-fact-stack");
    expect(container.textContent).toMatch(/INV\$480/);
    expect(container.textContent).toMatch(/PB\$495/);
    expect(container.textContent).toMatch(/TGT\$540/);
    // Both lane badges present (compact strip labels: ST / LT).
    expect(html).toMatch(/tt-lane-badge--trader[^>]*>ST</);
    expect(html).toMatch(/tt-lane-badge--investor[^>]*>LT</);
    // Save star (unfilled).
    expect(container.textContent).toContain("\u2606");
    act(() => { root.unmount(); });
  });

  it("computeLiveZoneRr returns reward/risk from zone ladder", () => {
    const fn = window.TimedVerdictUI.computeLiveZoneRr;
    const rr = fn({ inv: 480, tgt: 540, price: 500 }, "LONG");
    expect(rr).toBeCloseTo(2, 5);
    const shortRr = fn({ inv: 520, tgt: 460, price: 500 }, "SHORT");
    expect(shortRr).toBeCloseTo(2, 5);
  });

  it("resolveLivePlayRr prefers zone ladder over ticker.rr", () => {
    const fn = window.TimedVerdictUI.resolveLivePlayRr;
    const rr = fn({
      zone: { inv: 96, tgt: 109, price: 97 },
      ticker: { rr: 1.1 },
      side: "LONG",
    });
    expect(rr).toBeCloseTo((109 - 97) / (97 - 96), 5);
  });

  it("factsWithLiveRr inserts R:R immediately after Tgt row", () => {
    const fn = window.TimedVerdictUI.factsWithLiveRr;
    const out = fn([
      { label: "Inv", value: "$96" },
      { label: "PB", value: "$100–$103" },
      { label: "Tgt", value: "$109" },
    ], {
      zone: { inv: 96, tgt: 109, price: 97 },
      side: "LONG",
    });
    expect(out.map((f) => f.label)).toEqual(["Inv", "PB", "Tgt", "R:R"]);
    expect(out[3].value).toBe("12.00");
  });

  it("attachCtoProbToZone adds hit/reach probabilities from CTO payload", () => {
    const attach = window.TimedVerdictUI.attachCtoProbToZone;
    const zm = { inv: 96, tgt: 109, pb: [100, 103], price: 97 };
    const out = attach(zm, {
      ticker: "MNST",
      top_downside: { price: 96.54, adj_prob: 0.97 },
      top_upside: { price: 109, adj_prob: 0.94 },
    });
    expect(out.invProb).toBe(0.97);
    expect(out.tgtProb).toBe(0.94);
    const meta = window.TTLaneCard.zoneBarMeta(out);
    const html = document.createElement("div");
    const root = createRoot(html);
    act(() => { root.render(meta); });
    expect(html.textContent).toMatch(/97% hit/);
    expect(html.textContent).toMatch(/94% reach/);
    act(() => { root.unmount(); });
  });
});
