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
  sendWeekendDeskEmails,
  uniqueEmailTickers,
  weekendDeskEmailRecipients,
  weekendDeskHasYouYour,
  weekendDeskKey,
  weekendDeskLabel,
  weekendDeskShouldEmail,
  weekendDeskSlot,
  weekendSetupChartUrl,
  computeSetupRR,
  magnetPullDir,
  resolveSetupObjective,
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

  it("does not email on refresh when email is off", () => {
    expect(weekendDeskShouldEmail({
      composeNow: true,
      rescoreDone: true,
      wantEmail: false,
      forceEmail: false,
    })).toBe(false);
    expect(weekendDeskShouldEmail({
      composeNow: true,
      rescoreDone: true,
      wantEmail: true,
      forceEmail: false,
    })).toBe(true);
    expect(weekendDeskShouldEmail({
      composeNow: true,
      rescoreDone: true,
      wantEmail: false,
      forceEmail: true,
    })).toBe(true);
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
    expect(out.story.headline).toMatch(/broken resistance is now being tested as support/i);
    expect(out.story.level_role).toBe("support");
    expect(out.story.level_name).toMatch(/support/i);
    expect(`${out.story.headline} ${out.story.why} ${out.story.watching_for}`).not.toMatch(/\bthe line\b/i);
    expect(out.story.watching_for).toMatch(/support|accepted/i);
    expect(out.story.watching_path).toBe("up");
    expect(out.story.path_up).toMatch(/hold and turn/i);
    expect(out.story.path_down).toMatch(/not accepted/i);
    expect(out.story.path_sideways).toMatch(/no confirm/i);
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
    expect(out.story.headline).toMatch(/falling resistance/i);
    expect(out.story.level_role).toBe("resistance");
    expect(out.story.why).toMatch(/light volume/i);
    expect((out.story.why.match(/light volume/gi) || []).length).toBe(1);
    expect(out.story.watching_for).toMatch(/volume expanding/i);
    expect(`${out.story.headline} ${out.story.why} ${out.story.watching_for}`).not.toMatch(/\bthe line\b/i);
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
    expect(desk.featured.every((c) => c.story.dir !== "SHORT")).toBe(true);
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
    expect(new Set(desk.featured.map((c) => c.story.kind)).size).toBeGreaterThanOrEqual(2);
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
        card({
          ticker: "TSM",
          price: 398.2,
          flags: { st_magnet: true, st_magnet_W: true, st_hold: true },
          st_hold_setup: { magnet: { sideLabel: "LONG", magnet: true, stLine: 421.91 } },
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
    expect(html).toContain("Weekend report");
    expect(html).toContain("Opportunity");
    expect(html).toMatch(/>Up</);
    expect(html).toMatch(/>Down</);
    expect(html).toMatch(/>Sideways</);
    expect(html).toContain("Georgia");
    expect(html).toContain("/timed/logo/CRDO.png");
    expect(html).toContain("$398.20");
    expect(html).toMatch(/TSM[\s\S]{0,400}LONG/);
    expect(html).toContain("style=candles");
    expect(html).toMatch(/Support|Resistance|support|resistance/);
    expect(html).not.toContain("Why it is interesting");
    expect(html).not.toContain("What the model is watching for");
    expect(html).not.toMatch(/\bthe line\b/i);
    expect(html).toContain("light volume");
    expect(html).toContain("ticker=TSM");
    expect(html).toMatch(/Target \$421\.91|magnet target/i);
    const tickers = uniqueEmailTickers(desk);
    expect(new Set(tickers).size).toBe(tickers.length);
    const story = buildSetupStory({
      ticker: "CRDO",
      flags: { breakout_retest: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, line: 88.2, slope: -0.35 },
    }, { ticker: "CRDO", tags: ["retest"], timed_uptick: true });
    const chart = weekendSetupChartUrl(story);
    expect(chart).toContain("ticker=CRDO");
    expect(chart).toContain("tf=D");
    expect(chart).toContain("style=candles");
    expect(chart).toContain("tl0=");
    expect(chart).toContain("tl1=");
    expect(chart).toContain("tl_span=36");
    expect(chart).toContain("tl_label=Support");
    expect(chart).toContain("subtitle=");
    expect(chart).not.toMatch(/the\+line/i);
  });

  it("names personality, earnings, and psych only when the payload has them", () => {
    const out = card({
      ticker: "CRDO",
      price: 149.4,
      day_change_pct: 1.2,
      execution_profile: { personality: "MEAN_REVERT" },
      days_to_earnings: 6,
      fundamentals: {
        earnings: { beat_rate_pct: 80, avg_surprise_pct: 4.2, history: [{ result: "beat" }] },
      },
      flags: { breakout_retest: true, breakout_watch_dir: "LONG" },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 150.2, slope: -0.2 },
    });
    expect(out.story.why).toMatch(/mean-revert|unfinished structure/i);
    expect(out.story.why).toMatch(/earnings/i);
    expect(out.story.why).toMatch(/80%/);
    expect(out.story.why).toMatch(/150 handle/);
    expect(out.story.why).not.toMatch(/\bthe line\b/i);
  });

  it("prefers longs and only adds quality shorts when longs are thin", () => {
    const longRetest = card({
      ticker: "CRDO",
      flags: { breakout_retest: true, st_magnet: true, st_magnet_D: true, momentum_elite: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2 },
    });
    const longApproach = card({
      ticker: "SNOW",
      flags: { breakout_approaching: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true, line: 220 },
    });
    const shortRetest = card({
      ticker: "AVAV",
      flags: { breakout_retest: true, breakout_watch_dir: "SHORT" },
      _breakout_watch: { kind: "trendline", dir: "SHORT", retest: true, promotes_setup: true, line: 41.1 },
    });
    const shortApproach = card({
      ticker: "AAOI",
      flags: { breakout_approaching: true, breakout_watch_dir: "SHORT" },
      _breakout_watch: { kind: "trendline", dir: "SHORT", approaching: true, line: 100.99 },
    });
    const desk = composeWeekendDesk({
      cards: [shortRetest, shortApproach, longRetest, longApproach],
      now: SAT_10_ET,
      scanned: 8,
    });
    expect(desk.featured.map((c) => c.ticker)).toEqual(["CRDO", "SNOW", "AVAV"]);
    expect(desk.also_on_tape.map((c) => c.ticker)).not.toContain("AAOI");
    expect(uniqueEmailTickers(desk)).not.toContain("AAOI");
  });

  it("keeps a quality short when the long list is empty", () => {
    const shortFired = card({
      ticker: "ORCL",
      price: 148.2,
      flags: { breakout_watch: true, breakout_watch_dir: "SHORT" },
      _breakout_watch: { kind: "trendline", dir: "SHORT", promotes_setup: true, line: 151.2, rvol: 1.4 },
    });
    const picked = pickFeaturedSetups([shortFired]);
    expect(picked.map((c) => c.ticker)).toEqual(["ORCL"]);
  });

  it("names the magnet shelf as the target and draws also-on-tape charts", () => {
    const tsm = card({
      ticker: "TSM",
      price: 398.2,
      atr: 16,
      flags: { st_magnet: true, st_magnet_W: true },
      st_hold_setup: { magnet: { sideLabel: "LONG", magnet: true, stLine: 421.91 } },
    });
    expect(tsm.story.kind).toBe("magnet");
    expect(tsm.story.dir).toBe("LONG");
    expect(tsm.story.target).toBe(421.91);
    expect(tsm.story.why).toMatch(/\$421\.91/);
    expect(tsm.story.why).toMatch(/magnet target/i);
    expect(tsm.story.rr).toBeGreaterThan(0);
    expect(tsm.story.chart_tf).toBe("D");
    expect(tsm.story.chart_bars).toBe(60);
    const gold = card({
      ticker: "GOLD",
      price: 41.8,
      atr: 1.2,
      flags: { st_magnet: true, st_magnet_W: true },
      st_hold_setup: { magnet: { sideLabel: "LONG", magnet: true, stLine: 44.13 } },
    });
    expect(gold.story.dir).toBe("LONG");
    expect(gold.story.chart_tf).toBe("D");
    expect(gold.story.chart_bars).toBe(60);
    expect(computeSetupRR({
      entry: 286.4, stop: 283.7, target: 314.55, dir: "LONG",
    })).toBeNull();
    const obj = resolveSetupObjective({
      st_hold_setup: { magnet: { stLine: 421.91 } },
      atr: 16,
    }, { kind: "magnet", dir: "LONG", level: 421.91, px: 398.2 });
    expect(obj.target).toBe(421.91);
    expect(obj.rr).toBe(computeSetupRR({ entry: 398.2, stop: obj.stop, target: 421.91, dir: "LONG" }));
    expect(obj.rr).toBeGreaterThan(0);
    expect(obj.rr).toBeLessThanOrEqual(4);
    const goldFallback = resolveSetupObjective({
      atr: 1.2,
    }, { kind: "magnet", dir: "LONG", level: 44.13, px: 41.8 });
    expect(goldFallback.target).toBe(44.13);
    expect(goldFallback.target_label).toMatch(/shelf/i);
    expect(goldFallback.rr).toBeGreaterThan(0);
    expect(resolveSetupObjective({
      price: 460.28,
    }, { kind: "approaching", dir: "LONG", level: 460.28, px: 460.28 }).target).toBeNull();
    expect(resolveSetupObjective({
      price: 104.02,
    }, { kind: "retest", dir: "LONG", level: 104.02, px: 104.5 }).target).toBeNull();
    const firedNearby = resolveSetupObjective({
      price: 286.4,
      atr: 4.2,
    }, { kind: "fired", dir: "LONG", level: 279.76, px: 286.4 });
    expect(firedNearby.target).toBe(300);
    const firedFar = resolveSetupObjective({
      price: 104.5,
      atr: 2.1,
    }, { kind: "fired", dir: "LONG", level: 104.02, px: 104.5 });
    expect(firedFar.target).toBeNull();
    const amat = card({
      ticker: "AMAT",
      price: 456.5,
      flags: { breakout_approaching: true, st_magnet: true, st_magnet_W: true },
      _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true, line: 460.28, slope: -0.4 },
      st_hold_setup: { magnet: { sideLabel: "SHORT", magnet: true, stLine: 320.82 } },
    });
    expect(amat.story.kind).toBe("approaching");
    expect(amat.story.why).not.toMatch(/\$320\.82/);
    expect(amat.story.why).not.toMatch(/magnet target/i);
    const desk = composeWeekendDesk({
      cards: [
        card({
          ticker: "CRDO",
          flags: { breakout_retest: true, st_magnet: true, st_magnet_D: true, momentum_elite: true },
          _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2 },
        }),
        card({
          ticker: "CDNS",
          flags: { breakout_approaching: true, breakout_watch_dir: "LONG" },
          _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true, reason: "tl_through_low_rvol", line: 312.4, rvol: 0.7 },
        }),
        card({
          ticker: "NVDA",
          flags: { breakout_watch: true, breakout_watch_dir: "LONG" },
          _breakout_watch: { kind: "trendline", dir: "LONG", promotes_setup: true, line: 180, rvol: 1.5 },
        }),
        card({
          ticker: "AMZN",
          flags: { breakout_approaching: true },
          _breakout_watch: { kind: "daily_level", dir: "LONG", approaching: true, line: 230 },
        }),
        tsm,
      ],
      now: SAT_10_ET,
      scanned: 12,
    });
    const html = renderWeekendDeskHtml(desk, { origin: "https://timed-trading.com" });
    expect(html).toContain("Also on the tape");
    expect(html).toContain("ticker=TSM");
    expect(html).toContain("style=candles");
    expect(html).toContain("level_label=Target");
  });

  it("ticker chips show last price and setup direction", () => {
    const desk = composeWeekendDesk({
      cards: [
        card({
          ticker: "EXPE",
          price: 280.8,
          day_change_pct: 1.4,
          flags: { breakout_watch: true, breakout_watch_dir: "LONG" },
          _breakout_watch: {
            kind: "daily_level", dir: "LONG", promotes_setup: true, line: 279.76, rvol: 1.4,
          },
        }),
        card({
          ticker: "ALB",
          price: 92.15,
          day_change_pct: -0.8,
          flags: { breakout_retest: true, breakout_watch_dir: "SHORT" },
          _breakout_watch: {
            kind: "trendline", dir: "SHORT", retest: true, promotes_setup: true, line: 94.2,
          },
        }),
      ],
      now: SAT_10_ET,
      scanned: 6,
    });
    const html = renderWeekendDeskHtml(desk, { origin: "https://timed-trading.com" });
    const text = renderWeekendDeskText(desk);
    expect(html).toContain("$280.80");
    expect(html).toContain("+1.4%");
    expect(html).toMatch(/EXPE[\s\S]{0,500}LONG/);
    expect(html).toContain("$92.15");
    expect(html).toContain("-0.8%");
    expect(html).toMatch(/ALB[\s\S]{0,500}SHORT/);
    expect(text).toMatch(/EXPE \$280\.80 LONG/);
    expect(text).toMatch(/ALB \$92\.15 SHORT/);
  });

  it("magnet dir follows the pull toward the shelf, not SuperTrend sideLabel", () => {
    expect(magnetPullDir(48.23, 44.13)).toBe("SHORT");
    expect(magnetPullDir(398.2, 421.91)).toBe("LONG");
    expect(magnetPullDir(44.13, 44.13)).toBeNull();
    const gold = card({
      ticker: "GOLD",
      price: 48.23,
      atr: 1.2,
      day_change_pct: 5.1,
      flags: { st_magnet: true, st_magnet_W: true },
      st_hold_setup: { magnet: { sideLabel: "LONG", magnet: true, stLine: 44.13 } },
    });
    expect(gold.story.kind).toBe("magnet");
    expect(gold.story.dir).toBe("SHORT");
    expect(gold.story.target).toBe(44.13);
    expect(gold.story.watching_path).toBe("down");
    expect(gold.story.path_down).toMatch(/\$44\.13/);
    expect(gold.story.path_up).toMatch(/chase/i);
    expect(gold.story.watching_for).toMatch(/down path/i);
    expect(gold.story.path_down).toMatch(/completes the magnet/);
    expect(gold.story.path_down).not.toMatch(/holds completes/);
    const desk = composeWeekendDesk({
      cards: [
        card({
          ticker: "CRDO",
          flags: { breakout_retest: true, breakout_watch_dir: "LONG" },
          _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2, rvol: 1.6 },
        }),
        card({
          ticker: "CDNS",
          flags: { breakout_approaching: true, breakout_watch_dir: "LONG" },
          _breakout_watch: { kind: "trendline", dir: "LONG", approaching: true, line: 312.4 },
        }),
        card({
          ticker: "EXPE",
          price: 280.8,
          flags: { breakout_watch: true, breakout_watch_dir: "LONG" },
          _breakout_watch: { kind: "daily_level", dir: "LONG", promotes_setup: true, line: 279.76, rvol: 1.4 },
        }),
        gold,
      ],
      now: SAT_10_ET,
      scanned: 8,
    });
    expect(desk.featured.every((c) => c.ticker !== "GOLD")).toBe(true);
    expect(desk.also_on_tape.map((c) => c.ticker)).toContain("GOLD");
    const html = renderWeekendDeskHtml(desk, { origin: "https://timed-trading.com" });
    expect(html).toContain("$48.23");
    expect(html).toMatch(/GOLD[\s\S]{0,500}SHORT/);
    expect(html).not.toMatch(/GOLD[\s\S]{0,220}>LONG</);
  });
});

describe("weekend desk recipients", () => {
  it("stays admin-only until WEEKEND_DESK_BROADCAST is on", () => {
    const opted = [{ email: "member@example.com" }, { email: "shashant@gmail.com" }];
    expect(weekendDeskEmailRecipients({ ADMIN_EMAIL: "shashant@gmail.com" }, opted).map((u) => u.email))
      .toEqual(["shashant@gmail.com"]);
    expect(weekendDeskEmailRecipients({ ADMIN_EMAIL: "shashant@gmail.com", WEEKEND_DESK_BROADCAST: "1" }, opted)
      .map((u) => u.email)).toEqual(["shashant@gmail.com", "member@example.com"]);
    expect(weekendDeskEmailRecipients({}, opted)).toEqual([]);
  });

  it("sends the preview only to the admin address", async () => {
    const desk = composeWeekendDesk({
      cards: [
        card({
          ticker: "CRDO",
          flags: { breakout_retest: true, st_magnet: true, st_magnet_D: true, momentum_elite: true },
          _breakout_watch: { kind: "trendline", dir: "LONG", retest: true, promotes_setup: true, line: 88.2, slope: -0.4 },
        }),
      ],
      now: SAT_10_ET,
      scanned: 4,
    });
    const sent = [];
    const result = await sendWeekendDeskEmails(
      { ADMIN_EMAIL: "shashant@gmail.com", WORKER_URL: "https://timed-trading.com" },
      desk,
      { sendFn: async (_env, msg) => { sent.push(msg); return { ok: true }; } },
    );
    expect(result.preview).toBe(true);
    expect(result.recipients).toBe(1);
    expect(result.to).toEqual(["shashant@gmail.com"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("shashant@gmail.com");
    expect(sent[0].subject).toMatch(/preview/i);
    expect(sent[0].html).toContain("admin only");
    expect(sent[0].html).toContain("style=candles");
    expect(weekendDeskHasYouYour(sent[0].html)).toBe(false);
  });
});
