import { describe, it, expect } from "vitest";
import {
  buildPremarketGapContext,
  liveSpotFromPriceFeedRow,
  liveDayPctFromPriceFeedRow,
  patchBriefIndexDayPctProse,
  formatIndexSessionGroundTruthBlock,
  priorRthCloseFromPriceFeedRow,
  formatBriefInvestorActionsBlock,
  formatBriefInvestorLotLine,
  buildBriefUniverseMovers,
  buildBriefModelActionChips,
  parseBriefTopMoversText,
  formatBriefUniverseMoversText,
  resolveIndexRthSessionMoveFromCandles,
} from "./daily-brief.js";
import { stripBriefTopMoversBody } from "./daily-brief-markdown.js";
import { injectEmailBriefTickerChips, buildEmailCRODeskBlock, buildEmailBriefContentHtml, buildEmailBriefPositionStack } from "./email.js";

describe("buildPremarketGapContext session window", () => {
  const pf = {
    SPY: { p: 600, pc: 590, ahp: 610.5, ahdp: 1.75, p_ts: Date.now() },
  };

  it("returns gap context during pre-market (before 9:30 ET)", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T13:00:00.000Z")); // 9:00 ET
    expect(ctx).toMatch(/pre-market/i);
    expect(ctx).toMatch(/610\.50/);
  });

  it("returns null after the open — ahp vs pc is not a pre-market gap", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T21:00:00.000Z")); // 5:00 PM ET
    expect(ctx).toBeNull();
  });

  it("anchors gap on last RTH close (p) when pc lags one session", () => {
    const stalePc = {
      SPY: { p: 746.77, pc: 741, ahp: 750.5, p_ts: Date.now() },
    };
    const ctx = buildPremarketGapContext(stalePc, false, Date.parse("2026-07-02T13:00:00.000Z"));
    expect(ctx).toMatch(/746\.77/);
    expect(ctx).not.toMatch(/741\.00/);
    expect(priorRthCloseFromPriceFeedRow(stalePc.SPY, false)).toBe(746.77);
  });
});

describe("evening brief RTH session semantics", () => {
  const row = { p: 600.12, pc: 590, dp: 0.19, dc: 1.14, ahp: 610.5, ahdp: 1.71, p_ts: Date.now() };

  it("uses RTH close and dp when sessionOpen=true (evening gather path)", () => {
    expect(liveSpotFromPriceFeedRow(row, true)).toBe(600.12);
    expect(liveDayPctFromPriceFeedRow(row, true)).toBe(0.19);
  });

  it("uses extended print when sessionOpen=false (morning after-hours path)", () => {
    expect(liveSpotFromPriceFeedRow(row, false)).toBe(610.5);
    expect(liveDayPctFromPriceFeedRow(row, false)).toBe(1.71);
  });
});

describe("patchBriefIndexDayPctProse", () => {
  it("rewrites stale gap percentages in evening recap prose", () => {
    const moves = { SPY: { dayPct: 0.78 }, QQQ: { dayPct: 1.70 }, IWM: { dayPct: 0.50 } };
    const raw = "QQQ +2.49% and SPY +1.65% ripped higher while IWM -0.29% lagged.";
    const out = patchBriefIndexDayPctProse(raw, moves);
    expect(out).toContain("QQQ +1.70%");
    expect(out).toContain("SPY +0.78%");
    expect(out).toContain("IWM +0.50%");
  });

  it("rewrites parenthesized At a Glance percentages", () => {
    const moves = { SPY: { dayPct: -0.48 }, QQQ: { dayPct: -1.85 } };
    const raw = "SPY finished green at $747.70 (+0.14%), while QQQ sank to $709.38 (-3.59%).";
    const out = patchBriefIndexDayPctProse(raw, moves);
    expect(out).toContain("SPY finished green at $747.70 (-0.48%)");
    expect(out).toContain("QQQ sank to $709.38 (-1.85%)");
  });

  it("leaves percentages already matching ground truth", () => {
    const moves = { SPY: { dayPct: 0.78 } };
    const raw = "SPY +0.78% closed firm.";
    expect(patchBriefIndexDayPctProse(raw, moves)).toBe(raw);
  });
});

describe("resolveIndexRthSessionMoveFromCandles", () => {
  it("computes today close vs prior session close", () => {
    const candles = [
      { ts: Date.parse("2026-07-05T20:00:00Z"), c: 750.0 },
      { ts: Date.parse("2026-07-07T20:00:00Z"), c: 747.7 },
    ];
    const mv = resolveIndexRthSessionMoveFromCandles(candles, "2026-07-07");
    expect(mv).not.toBeNull();
    expect(mv.price).toBe(747.7);
    expect(mv.priorClose).toBe(750);
    expect(mv.dayPct).toBe(-0.31);
  });
});

describe("stripBriefTopMoversBody", () => {
  it("removes redundant Gainers/Losers ticker lists", () => {
    const body = "Gainers: IOT +15.6%, RBRK +10.0%\nLosers: STRL -14.3%\n\nSoftware names led the tape lower on multiple compression.";
    const out = stripBriefTopMoversBody(body);
    expect(out).not.toMatch(/Gainers:/i);
    expect(out).not.toMatch(/Losers:/i);
    expect(out).toContain("Software names led");
  });
});

describe("formatIndexSessionGroundTruthBlock", () => {
  it("emits mandatory ground-truth lines for evening", () => {
    const block = formatIndexSessionGroundTruthBlock({
      SPY: { dayPct: 0.78, price: 741.47 },
      QQQ: { dayPct: 1.70, price: 723.52 },
    }, { type: "evening" });
    expect(block).toMatch(/GROUND TRUTH/);
    expect(block).toContain("SPY: +0.78%");
    expect(block).toContain("QQQ: +1.70%");
  });
});

describe("evening brief email parity", () => {
  it("buildEmailBriefPositionStack interleaves chip and guidance per holding", () => {
    const stack = buildEmailBriefPositionStack(
      "investorPortfolio",
      {
        investorHoldings: [
          { ticker: "KO", unrealPct: 2.1, dayPct: 0.4, stage: "accumulate" },
          { ticker: "NVDA", unrealPct: -1.2, dayPct: -0.3, stage: "core_hold" },
        ],
      },
      [
        "- **KO** · today +0.4% · return +2.1% · accumulate · hold dips near support",
        "- **NVDA**: thesis intact · add on weakness",
      ].join("\n"),
      "https://timed-trading.com",
    );
    const koIdx = stack.indexOf("KO");
    const nvdaIdx = stack.indexOf("NVDA");
    const koGuidanceIdx = stack.indexOf("hold dips near support");
    const nvdaGuidanceIdx = stack.indexOf("thesis intact");
    expect(koIdx).toBeGreaterThanOrEqual(0);
    expect(nvdaIdx).toBeGreaterThan(koIdx);
    expect(koGuidanceIdx).toBeGreaterThan(koIdx);
    expect(koGuidanceIdx).toBeLessThan(nvdaIdx);
    expect(nvdaGuidanceIdx).toBeGreaterThan(nvdaIdx);
  });

  it("buildEmailBriefContentHtml does not render duplicate investor bullets below chips", () => {
    const html = buildEmailBriefContentHtml(
      [
        "## Investor Portfolio",
        "- **KO** · today +0.4% · return +2.1% · accumulate · hold dips near support",
        "- **NVDA**: thesis intact · add on weakness",
      ].join("\n"),
      {
        investorHoldings: [
          { ticker: "KO", unrealPct: 2.1, dayPct: 0.4, stage: "accumulate" },
          { ticker: "NVDA", unrealPct: -1.2, dayPct: -0.3, stage: "core_hold" },
        ],
        traderPositions: [],
        modelActionChips: [],
        topMovers: { gainers: [], losers: [] },
      },
      "https://timed-trading.com",
    );
    expect(html).toContain("KO");
    expect(html).toContain("hold dips near support");
    expect(html).toContain("NVDA");
    expect(html).toContain("thesis intact");
    expect((html.match(/<li/g) || []).length).toBe(0);
  });

  it("buildEmailBriefPositionStack renders non-zero RTH day change on position chips", () => {
    const stack = buildEmailBriefPositionStack(
      "activeTrader",
      {
        traderPositions: [{ ticker: "GRNY", direction: "LONG", pnlPct: 0.4, dayPct: 0.82 }],
      },
      "- **GRNY** · thesis holding · trim into strength",
      "https://timed-trading.com",
    );
    expect(stack).toContain("0.4%");
    expect(stack).toContain("0.82%");
    expect(stack).not.toContain("0.00% today");
    expect(stack).toContain("thesis holding");
  });

  it("injectEmailBriefTickerChips still renders model action and mover chips", () => {
    const html = injectEmailBriefTickerChips(
      "<h2>Model Actions Today</h2><p>body</p>",
      {
        traderPositions: [],
        investorHoldings: [],
        modelActionChips: [{ ticker: "GRNY", action: "ENTRY", pnlPct: 0.4, dayPct: 0.82 }],
        topMovers: { gainers: [], losers: [] },
      },
      "https://timed-trading.com",
    );
    expect(html).toContain("GRNY");
    expect(html).toContain("0.82%");
  });

  it("buildEmailCRODeskBlock renders structured desk wrap", () => {
    const block = buildEmailCRODeskBlock({
      verdict: "Tech rebound with broad participation.",
      asOfDate: "2026-07-09",
      observations: [{ section: "SECTOR ROTATION", text: "Financials led." }],
    }, "#a78bfa");
    expect(block).toContain("CRO Research Desk");
    expect(block).toContain("Tech rebound");
    expect(block).toContain("SECTOR ROTATION");
  });
});

describe("buildBriefModelActionChips", () => {
  it("stamps RTH dayPct on entry chips for evening brief", () => {
    const now = Date.now();
    const chips = buildBriefModelActionChips({
      briefType: "evening",
      todayEntries: [{ ticker: "GRNY", direction: "LONG", price: 27.64, reason: "setup" }],
      priceFeedRaw: { GRNY: { p: 27.86, dp: 0.82, p_ts: now, t: now } },
    });
    expect(chips).toHaveLength(1);
    expect(chips[0].dayPct).toBeCloseTo(0.82, 2);
  });
});

describe("formatBriefInvestorActionsBlock", () => {
  it("lists every investor lot fill for Model Actions Today", () => {
    const lots = [
      { ticker: "PLTR", action: "BUY", shares: 120, price: 142.5, reason: "ACCUMULATE" },
      { ticker: "ANET", action: "BUY", shares: 40, price: 118.2, reason: "ACCUMULATE" },
      { ticker: "TJX", action: "DCA_BUY", shares: 25, price: 132.8, reason: "ADD_ON" },
    ];
    const block = formatBriefInvestorActionsBlock(lots);
    expect(block).toContain("PLTR BUY");
    expect(block).toContain("ANET BUY");
    expect(block).toContain("TJX DCA_BUY");
    expect(block).not.toMatch(/no investor lot actions/i);
  });

  it("formatBriefInvestorLotLine includes shares, price, and reason", () => {
    const line = formatBriefInvestorLotLine({
      ticker: "PLTR",
      action: "BUY",
      shares: 120,
      price: 142.5,
      reason: "ACCUMULATE",
    });
    expect(line).toBe("PLTR BUY 120 sh @ $142.50 (ACCUMULATE)");
  });
});

describe("buildBriefUniverseMovers", () => {
  it("prefers timed:all micro cache for RTH movers (Today page parity)", async () => {
    const env = {
      KV_TIMED: {
        async get(key) {
          if (key !== "timed:all:micro:v3:admin:full") return null;
          return JSON.stringify({
            data: {
              IOT: { ticker: "IOT", day_change_pct: 12.4, price: 52.1 },
              QYLS: { ticker: "QYLS", day_change_pct: 11.2, price: 18.3 },
              TENB: { ticker: "TENB", day_change_pct: 10.8, price: 44.6 },
              IREN: { ticker: "IREN", day_change_pct: 10.1, price: 9.7 },
              RBRK: { ticker: "RBRK", day_change_pct: 9.5, price: 62.0 },
              AYI: { ticker: "AYI", day_change_pct: 3.2, price: 312.5 },
              SPY: { ticker: "SPY", day_change_pct: 0.5, price: 600 },
            },
          });
        },
      },
    };
    const movers = await buildBriefUniverseMovers(env, {}, true);
    expect(movers.text).toContain("IOT");
    expect(movers.text).toContain("QYLS");
    expect(movers.text).toContain("TENB");
    expect(movers.text).toContain("IREN");
    expect(movers.text).toContain("RBRK");
    expect(movers.text).toContain("Gainers:");
    expect(movers.text).not.toContain("SPY");
    expect(movers.gainers.map((g) => g.ticker)).toContain("IOT");
  });
});

describe("buildBriefModelActionChips", () => {
  it("builds trader + investor action chips for Model Actions Today", () => {
    const chips = buildBriefModelActionChips({
      todayEntries: [{ ticker: "GS", direction: "LONG", price: 700, reason: "breakout" }],
      todayExits: [{ ticker: "SNDK", direction: "LONG", price: 1745, pnlPct: 18.6 }],
      todayInvestorActions: [
        { ticker: "PLTR", action: "BUY", price: 131.37, shares: 38, reason: "auto_entry_accumulate" },
      ],
    });
    expect(chips.some((c) => c.ticker === "PLTR" && c.lane === "investor")).toBe(true);
    expect(chips.some((c) => c.ticker === "SNDK" && c.action === "EXIT")).toBe(true);
  });
});

describe("parseBriefTopMoversText", () => {
  it("parses gainers/losers lines into chip rows", () => {
    const parsed = parseBriefTopMoversText("Gainers: IOT +15.6%, RBRK +10.0%\nLosers: STRL -14.3%");
    expect(parsed.gainers.map((g) => g.ticker)).toEqual(["IOT", "RBRK"]);
    expect(parsed.losers[0].ticker).toBe("STRL");
  });
});
