import { describe, expect, it } from "vitest";
import {
  analyzeTickerForWeekendDesk,
  buildSetupStory,
  compactPromotionCandidate,
  composeWeekendDesk,
  consensusDir,
  isScreenerPromoteCandidate,
  isWeekendEmailTicker,
  pickFeaturedSetups,
  renderWeekendDeskHtml,
  renderWeekendDeskText,
  uniqueEmailTickers,
  weekendDeskHasYouYour,
  weekendDeskKey,
  weekendDeskLabel,
  weekendDeskSlot,
  weekendSetupChartUrl,
} from "./weekend-desk.js";

const SAT_10_ET = Date.UTC(2026, 8, 12, 14, 0, 0); // Sat Sep 12 2026 10:00 ET
const SUN_10_ET = Date.UTC(2026, 8, 13, 14, 0, 0);
const FRI_17_ET = Date.UTC(2026, 8, 11, 21, 0, 0);
const SAT_13_ET = Date.UTC(2026, 8, 12, 17, 0, 0);

function card(partial) {
  return analyzeTickerForWeekendDesk(partial);
}

describe("weekend desk calendar", () => {
  it("shares one Saturday key across Sat and Sun", () => {
    expect(weekendDeskKey(SAT_10_ET)).toBe("2026-09-12");
    expect(weekendDeskKey(SUN_10_ET)).toBe("2026-09-12");
    expect(weekendDeskKey(FRI_17_ET)).toBe("2026-09-12");
  });

  it("fires Saturday 10 ET full, Sunday 10 ET refresh, Saturday afternoon continue", () => {
    expect(weekendDeskSlot(SAT_10_ET)).toEqual({ fire: true, action: "full" });
    expect(weekendDeskSlot(SUN_10_ET)).toEqual({ fire: true, action: "refresh" });
    expect(weekendDeskSlot(SAT_13_ET)).toEqual({ fire: true, action: "rescore_continue" });
    expect(weekendDeskSlot(FRI_17_ET).fire).toBe(false);
  });

  it("labels the NY calendar day", () => {
    expect(weekendDeskLabel(SAT_10_ET)).toBe("Sat Sep 12");
  });
});

describe("analyzeTickerForWeekendDesk", () => {
  it("promotes a retest + ST magnet + elite into a TT Setup", () => {
    const out = card({
      ticker: "CRDO",
      rank: 78,
      __focus_conviction_score: 118,
      __focus_tier: "A",
      flags: {
        breakout_retest: true,
        breakout_watch_dir: "LONG",
        st_magnet: true,
        st_magnet_D: true,
        momentum_elite: true,
        momentum_elite_dir: "LONG",
        ema_regime_D: 2,
        ema13above21_D: true,
        ema5above48_D: true,
      },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true },
      fvg_imbalance_D: { imbalance_direction: "BULLISH_LEAN", upside_magnets: 5, downside_magnets: 1, unfilled_below: 2 },
      _news_summary: {
        has_data: true,
        dominant_sentiment: "bullish",
        bull: 3, bear: 0, neutral: 1,
        bullish_catalyst_count: 1,
        top_catalyst: { headline: "CRDO raised at Street", sentiment: "bullish" },
      },
    });
    expect(out.ticker).toBe("CRDO");
    expect(out.timed_uptick).toBe(true);
    expect(out.dir).toBe("LONG");
    expect(out.tags).toContain("retest");
    expect(out.tags).toContain("st_magnet");
    expect(out.tags).toContain("momentum_elite");
    expect(out.families.length).toBeGreaterThanOrEqual(2);
    expect(out.score).toBeGreaterThanOrEqual(36);
    expect(out.story.kind).toBe("retest");
    expect(out.story.headline).toMatch(/came back and held/i);
    expect(out.story.watching_for).toMatch(/good-entry window/i);
    expect(out.story.why).toMatch(/volume|held|line/i);
    expect(out.story.why).not.toMatch(/st_magnet|ema_short|RVOL/i);
  });

  it("keeps a lone approaching trendline as watch, not a TT Setup", () => {
    const out = card({
      ticker: "XYZ",
      flags: { breakout_approaching: true, breakout_watch_dir: "SHORT" },
      _breakout_watch: { kind: "trendline", dir: "SHORT", approaching: true },
    });
    expect(out.timed_uptick).toBe(false);
    expect(out.tags).toContain("tl_watch");
    expect(out.notes[0]).toMatch(/watching for a break/i);
    expect(out.story.kind).toBe("approaching");
  });

  it("treats a quiet volume poke as a probe, not a confirmed break", () => {
    const out = card({
      ticker: "CDNS",
      flags: { breakout_approaching: true, breakout_watch_dir: "LONG" },
      _breakout_watch: {
        kind: "trendline",
        dir: "LONG",
        approaching: true,
        reason: "tl_through_low_rvol",
        line: 312.4,
        rvol: 0.7,
      },
    });
    expect(out.story.kind).toBe("quiet_pierce");
    expect(out.story.why).toMatch(/light volume/i);
    expect(out.story.watching_for).toMatch(/volume expanding/i);
    expect(out.families).toContain("volume");
  });

  it("flags a flat SuperTrend magnet without inventing a buy path", () => {
    const out = card({
      ticker: "NVDA",
      flags: { st_magnet: true, st_magnet_W: true, st_hold: true, st_hold_W: true },
      st_hold_setup: { magnet: { sideLabel: "LONG", magnet: true } },
    });
    expect(out.tags).toContain("st_magnet");
    expect(out.notes.join(" ")).toMatch(/magnet/i);
    expect(out.notes.join(" ")).not.toMatch(/\bbuy\b/i);
  });

  it("requires two family votes before stamping a side", () => {
    expect(consensusDir(["LONG"])).toBe(null);
    expect(consensusDir(["LONG", "SHORT"])).toBe(null);
    expect(consensusDir(["LONG", "LONG", "SHORT"])).toBe("LONG");
    const mixed = card({
      ticker: "WMT",
      flags: { st_magnet: true, st_magnet_M: true, ema_regime_D: -2, momentum_elite: true },
      fvg_imbalance_D: { imbalance_direction: "LONG_OPPORTUNITY", upside_magnets: 8, downside_magnets: 1 },
    });
    expect(mixed.dir).toBe(null);
  });

  it("treats missing news as no news family", () => {
    const out = card({ ticker: "AAPL", flags: { st_hold: true, st_hold_D: true } });
    expect(out.families).not.toContain("news");
  });

  it("notes Newton's list as overlap, not the TT Setup definition", () => {
    const out = analyzeTickerForWeekendDesk(
      { ticker: "GOOGL", flags: { st_hold_D: true, st_hold: true } },
      { newtonUpticks: new Set(["GOOGL"]) },
    );
    expect(out.tags).toContain("newton_upticks");
    expect(out.timed_uptick).toBe(false);
  });
});

describe("composeWeekendDesk", () => {
  it("splits confluence TT Setups from single-tag watches and outside-book promotions", () => {
    const crdo = card({
      ticker: "CRDO",
      flags: {
        breakout_retest: true,
        st_magnet: true,
        st_magnet_D: true,
        momentum_elite: true,
        momentum_elite_dir: "LONG",
      },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true },
    });
    const watch = card({
      ticker: "SNOW",
      flags: { breakout_approaching: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true },
    });
    const desk = composeWeekendDesk({
      cards: [crdo, watch],
      promotions: [
        compactPromotionCandidate({
          ticker: "APP",
          status: "needs_review",
          total_score: 62,
          thesis_text: "Screener hit — not in the book",
          already_tracked: false,
          in_universe: false,
        }),
        compactPromotionCandidate({
          ticker: "AAPL",
          status: "needs_review",
          total_score: 80,
          already_tracked: true,
          in_universe: true,
        }),
      ],
      now: SAT_10_ET,
      scanned: 250,
    });
    expect(desk.timed_upticks.map((c) => c.ticker)).toEqual(["CRDO"]);
    expect(desk.trendlines.map((c) => c.ticker)).toEqual(["CRDO", "SNOW"]);
    expect(desk.promotion_candidates.map((c) => c.ticker)).toEqual(["APP"]);
    expect(isScreenerPromoteCandidate("DECXF")).toBe(false);
    expect(isScreenerPromoteCandidate("ONCO", { price: 1.2 })).toBe(false);
    expect(isScreenerPromoteCandidate("APP", { price: 420, market_cap: 2e9 })).toBe(true);
    expect(desk.disclaimer).toMatch(/not a buy list/i);
    expect(desk.disclaimer).toMatch(/not Newton's/i);
    expect(desk.disclaimer).toMatch(/TT Setups/);
    expect(desk.featured[0].ticker).toBe("CRDO");
    expect(desk.featured.map((c) => c.ticker)).toContain("SNOW");
    const emailTickers = uniqueEmailTickers(desk);
    expect(new Set(emailTickers).size).toBe(emailTickers.length);
    expect(emailTickers).toContain("CRDO");
  });

  it("keeps featured tickers unique and drops futures from the email list", () => {
    const crdo = card({
      ticker: "CRDO",
      flags: { breakout_retest: true, st_magnet: true, st_magnet_D: true, momentum_elite: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2, rvol: 1.6 },
    });
    const avav = card({
      ticker: "AVAV",
      flags: { breakout_retest: true, breakout_watch_dir: "SHORT" },
      _breakout_watch: { kind: "trendline", dir: "SHORT", retest: true, promotes_setup: true, line: 41.1 },
    });
    const snow = card({
      ticker: "SNOW",
      flags: { breakout_approaching: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true, line: 220 },
    });
    const cl = card({
      ticker: "CL1!",
      flags: { breakout_watch: true, breakout_watch_kind: "daily_level" },
      _breakout_watch: { kind: "daily_level", dir: "LONG", promotes_setup: true, line: 72, rvol: 1.4 },
    });
    const desk = composeWeekendDesk({
      cards: [crdo, avav, snow, cl, crdo],
      now: SAT_10_ET,
      scanned: 40,
    });
    const tickers = uniqueEmailTickers(desk);
    expect(new Set(tickers).size).toBe(tickers.length);
    expect(tickers).not.toContain("CL1!");
    expect(isWeekendEmailTicker("CL1!")).toBe(false);
    expect(isWeekendEmailTicker("BTCUSD")).toBe(false);
    expect(isWeekendEmailTicker("AMZN")).toBe(true);
    expect(desk.featured.length).toBeLessThanOrEqual(4);
    expect(pickFeaturedSetups([crdo, crdo, cl]).map((c) => c.ticker)).toEqual(["CRDO"]);
  });

  it("email is TT Setups with a chart and no indicator dump", () => {
    const desk = composeWeekendDesk({
      cards: [
        card({
          ticker: "CRDO",
          flags: { breakout_retest: true, st_magnet: true, st_magnet_D: true, momentum_elite: true },
          _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2, rvol: 1.6 },
        }),
        card({
          ticker: "CDNS",
          flags: { breakout_approaching: true, breakout_watch_dir: "LONG" },
          _breakout_watch: {
            kind: "trendline", dir: "LONG", approaching: true,
            reason: "tl_through_low_rvol", line: 312.4, rvol: 0.7,
          },
        }),
      ],
      now: SAT_10_ET,
      scanned: 10,
    });
    const html = renderWeekendDeskHtml(desk, { origin: "https://timed-trading.com" });
    const text = renderWeekendDeskText(desk);
    expect(weekendDeskHasYouYour(html)).toBe(false);
    expect(weekendDeskHasYouYour(text)).toBe(false);
    expect(html).toContain("Market data powered by Twelve Data");
    expect(html).toContain("TT Setups");
    expect(text).toContain("TT Setups");
    expect(text).not.toContain("TIMED UPTICKS");
    expect(html).not.toMatch(/TIMED UPTICKS|Timed Upticks/);
    expect(html).not.toMatch(/st_magnet|ema_short|ema_long|momentum_elite/);
    expect(html).toContain("/timed/chart-image?");
    expect(html).toContain("ticker=CRDO");
    expect(html).toMatch(/tf=D|tf=W|tf=240|tf=60/);
    expect(html).toContain("Why it is interesting");
    expect(html).toContain("What the model is watching for");
    expect(html).toContain("light volume");
    const tickers = uniqueEmailTickers(desk);
    expect(new Set(tickers).size).toBe(tickers.length);
    const story = buildSetupStory({
      ticker: "CRDO",
      flags: { breakout_retest: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, line: 88.2 },
    }, { ticker: "CRDO", tags: ["retest"], timed_uptick: true });
    expect(weekendSetupChartUrl(story)).toContain("ticker=CRDO");
    expect(weekendSetupChartUrl(story)).toContain("tf=D");
  });
});
