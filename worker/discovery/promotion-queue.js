// worker/discovery/promotion-queue.js
//
// 2026-05-28 — Screener Promotion Queue with thesis-quality scoring.
//
// User concern (paraphrased): "Don't get caught up in pump-and-dumps. Need
// easy-to-decide justification / thesis for WHY we should include each
// candidate — not just because it ran a bunch."
//
// Each candidate is scored across 7 quality components (0-100 total) MINUS
// pump-and-dump red flags. Auto-status:
//   total >= 60 + no critical red flags  → "ready_to_add"  (auto-add if gated)
//   total >= 40 + no critical red flags  → "needs_review" (admin approves)
//   total <  40 OR critical red flags    → "rejected"      (logged only)
//
// Critical red flags: low_liquidity, sub_$5_price, no_news_no_theme_no_insider.
//
// Each row stores:
//   - Numeric total_score (0-100)
//   - Per-component breakdown (transparent scoring math)
//   - Red flags array (the WHY-NOT)
//   - thesis_text: 1-2 sentence human-readable justification
//   - signals_json: raw snapshot for audit
//
// See tasks/2026-05-28-discovery-phases-2-3-4a-5-plan.md for the design rationale.

import { THEMES, getThemesForTicker, computeThemeActivity } from "../sector-mapping.js";
import { loadInsiderSummariesBatch } from "./insider-tracker.js";
import { loadNewsSummariesBatch } from "./news-tracker.js";
import { loadSocialSummariesBatch } from "./social-tracker.js";
import { getStrategyForTicker } from "../strategy-context.js";

// ── Scoring weights ──────────────────────────────────────────────────────
// 2026-05-29 — added W_SOCIAL (10). Note this lifts the theoretical max
// past 100; total_score is clamped to SCORE_MAX. The social weight is
// intentionally smaller than W_NEWS (15) because StockTwits buzz can be
// rumour-driven, but large enough that a 100% bullish high-volume name
// (like SNOW today: 14:0 bull/bear, 57k watchlist) cannot be ignored.
const SCORE_MAX = 100;
const W_SUSTAIN = 20;
const W_QUALITY = 20;
const W_THEME = 15;
const W_NEWS = 15;
const W_INSIDER = 10;
const W_MACRO = 10;
const W_PEER = 10;
const W_SOCIAL = 10;
// 2026-05-30 — Active-playbook alignment. When a candidate sits inside a
// tier-1 theme of the current strategic stance (currently the Fundstrat
// 2026 Year Ahead deck), it gets a small additive boost — strategy
// pulls in the same direction as the screener signal. Editorial weight
// intentionally smaller than W_THEME (theme activity is observed; this
// is a normative tilt) but large enough to break ties between two ~50
// scores in favour of the on-thesis name.
const W_STRATEGY = 8;
const W_TACTICAL = 4; // max ± points from the gated FSD tactical-overlay nudge

// ── Quality floors ───────────────────────────────────────────────────────
const HARD_FLOOR_MARKET_CAP = 2_000_000_000; // $2B
const HARD_FLOOR_AVG_VOLUME = 1_000_000;     // 1M shares
const HARD_FLOOR_PRICE = 5;                  // $5

// ── Red flag thresholds ──────────────────────────────────────────────────
const SINGLE_DAY_EXTREME_MOVE_PCT = 30;
const LOW_LIQUIDITY_AVG_VOLUME = 500_000;
const LOW_LIQUIDITY_MARKET_CAP = 1_000_000_000;
const SUB_THRESHOLD_PRICE = 5;
const VOLUME_SPIKE_MULTIPLE = 5;

// ── Status thresholds ────────────────────────────────────────────────────
// 2026-05-29 — lowered NEEDS_REVIEW from 40 → 25 (with hasMaterialThesis
// gate). The original 40 was unachievable for genuinely strong single-day
// candidates whose THEME / INSIDER / MACRO / PEER signals are 0. E.g. LUNR
// post-Micron-rally scored only 28 (news=15 + quality=13) but represented
// a real, thesis-quality opportunity that operator review would catch. We
// now surface anything ≥25 that has at least one substantive component
// (news cat 7+, insider buy, sustain across 3+ days, or active theme).
const SCORE_READY_TO_ADD = 60;
const SCORE_NEEDS_REVIEW = 25;
const CRITICAL_RED_FLAGS = new Set([
  "low_liquidity",
  "sub_$5_price",
  "no_news_no_theme_no_insider",
]);

// 2026-05-29 — Material thesis gate. Prevents NEEDS_REVIEW spam from
// candidates whose 25+ score is built purely on Quality (mcap + volume)
// with no actual reason to be on the watchlist. A ticker must have at
// least one substantive thesis signal to qualify for operator review.
function hasMaterialThesis(components) {
  if ((components.news?.pts || 0) >= 9) return true;            // news catalyst ≥ 7/10
  if ((components.insider?.hi_buys_count || 0) >= 1) return true;  // any high-signal insider buy
  if ((components.sustain || 0) >= 10) return true;             // 3+ distinct days in screener
  if ((components.theme?.pts || 0) > 0) return true;            // active theme rotation
  if ((components.macro?.pts || 0) > 0) return true;            // macro alignment present
  if ((components.social?.pts || 0) >= 6) return true;          // strong social buzz (≥60% of W_SOCIAL)
  return false;
}

export async function ensurePromotionQueueSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS discovery_promotion_queue (
        candidate_id      TEXT PRIMARY KEY,
        ticker            TEXT NOT NULL,
        first_seen_at     INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL,
        appearances_7d    INTEGER NOT NULL,
        total_score       INTEGER NOT NULL,
        status            TEXT NOT NULL,
        thesis_text       TEXT,
        red_flags_json    TEXT,
        components_json   TEXT,
        signals_json      TEXT,
        decided_by        TEXT,
        decided_at        INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_promotion_status ON discovery_promotion_queue (status, total_score DESC)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_promotion_ticker ON discovery_promotion_queue (ticker)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_promotion_created ON discovery_promotion_queue (created_at DESC)`).run();
  } catch (e) {
    console.warn("[PROMOTION] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── SUSTAIN component ────────────────────────────────────────────────────
// Distinct-day appearances in screener candidates. Single-day spike → 0.
function scoreSustain(appearances) {
  if (!Array.isArray(appearances) || appearances.length === 0) return 0;
  const distinctDays = new Set(
    appearances.map((a) => String(a.discovered_at || "").slice(0, 10)).filter(Boolean),
  ).size;
  // 1 day = 0, 2 = 4, 3 = 10, 4 = 15, 5+ = 20
  if (distinctDays <= 1) return 0;
  if (distinctDays === 2) return 4;
  if (distinctDays === 3) return 10;
  if (distinctDays === 4) return 15;
  return 20;
}

// ── QUALITY component + hard floor check ─────────────────────────────────
function scoreQuality(latest) {
  const marketCap = Number(latest?.market_cap) || 0;
  const avgVolume = Number(latest?.avg_volume) || Number(latest?.volume) || 0;
  const price = Number(latest?.price) || 0;

  // Hard floor — fails returns 0 score AND adds a critical red flag elsewhere.
  if (marketCap < HARD_FLOOR_MARKET_CAP || avgVolume < HARD_FLOOR_AVG_VOLUME || price < HARD_FLOOR_PRICE) {
    return 0;
  }

  // Scale: market_cap quartile + liquidity quartile.
  let pts = 0;
  // Market cap: $2B = 4, $10B = 7, $50B = 9, $200B = 10
  if (marketCap >= 200e9) pts += 10;
  else if (marketCap >= 50e9) pts += 9;
  else if (marketCap >= 10e9) pts += 7;
  else if (marketCap >= 2e9) pts += 4;
  // Volume: 1M = 5, 5M = 7, 20M = 9, 50M = 10
  if (avgVolume >= 50e6) pts += 10;
  else if (avgVolume >= 20e6) pts += 9;
  else if (avgVolume >= 5e6) pts += 7;
  else if (avgVolume >= 1e6) pts += 5;
  return Math.min(W_QUALITY, pts);
}

// ── THEME component ──────────────────────────────────────────────────────
function scoreTheme(themes, themeActivityByName, dayChangePct) {
  if (!Array.isArray(themes) || themes.length === 0) return { pts: 0, theme: null, peers_up: null, peers_total: null };
  // Find the best active theme this ticker belongs to.
  let bestTheme = null, bestActive = 0;
  for (const t of themes) {
    const a = themeActivityByName?.[t];
    if (!a) continue;
    const activeCount = Math.max(a.up || 0, a.down || 0);
    if (a.active && activeCount > bestActive) {
      bestTheme = a;
      bestActive = activeCount;
    }
  }
  if (!bestTheme) return { pts: 0, theme: themes[0], peers_up: 0, peers_total: null };
  // Active direction must AGREE with the candidate's daily change direction.
  // Candidate up + theme up = full credit. Candidate up + theme down = 0.
  if (Number.isFinite(dayChangePct) && dayChangePct !== 0) {
    const candidateDir = dayChangePct > 0 ? "up" : "down";
    if (bestTheme.active_direction !== candidateDir) {
      return { pts: 0, theme: bestTheme.theme, peers_up: bestTheme.up, peers_down: bestTheme.down, peers_total: bestTheme.members, divergent: true };
    }
  }
  // Scale points by % of theme members active.
  const pct = bestTheme.has_data > 0 ? bestActive / bestTheme.has_data : 0;
  let pts = 0;
  if (pct >= 0.6) pts = W_THEME;
  else if (pct >= 0.4) pts = Math.round(W_THEME * 0.75);
  else if (pct >= 0.3) pts = Math.round(W_THEME * 0.5);
  else pts = 0;
  return {
    pts,
    theme: bestTheme.theme,
    peers_up: bestTheme.up,
    peers_down: bestTheme.down,
    peers_total: bestTheme.members,
    active_direction: bestTheme.active_direction,
    top_peer_movers: (bestTheme.active_direction === "up" ? bestTheme.top_up : bestTheme.top_down).slice(0, 3),
  };
}

// ── NEWS_CATALYST component ──────────────────────────────────────────────
function scoreNews(newsSummary) {
  if (!newsSummary || newsSummary.count === 0) return { pts: 0, max_catalyst: 0, bullish_catalyst_count: 0 };
  const maxCs = Number(newsSummary.max_catalyst) || 0;
  const bullCount = Number(newsSummary.bullish_catalyst_count) || 0;
  // Strong bullish catalyst (>=7) = full credit.
  let pts = 0;
  if (maxCs >= 8 && bullCount >= 1) pts = W_NEWS;
  else if (maxCs >= 7 && bullCount >= 1) pts = Math.round(W_NEWS * 0.85);
  else if (maxCs >= 5 && bullCount >= 1) pts = Math.round(W_NEWS * 0.55);
  else if (maxCs >= 3) pts = Math.round(W_NEWS * 0.30);
  return {
    pts,
    max_catalyst: maxCs,
    bullish_catalyst_count: bullCount,
    top_headline: newsSummary.top_catalyst_headline || null,
  };
}

// ── SOCIAL_BUZZ component ────────────────────────────────────────────────
// 2026-05-29 — Phase 1+2 social signal. Combines:
//   StockTwits (phase 1): user-tagged Bullish/Bearish + watchlist proxy
//   Reddit/Apewisdom (phase 2): mention count + 24h spike + upvotes
//
// Scoring is additive but capped at W_SOCIAL. Each source can earn up
// to 7 pts. Sources that complement each other (StockTwits bullish ratio
// AND Reddit spike) get the full 10. Either one alone caps at 7.
//
// Sub-scoring bands:
//
//   StockTwits (max 7):
//     100% bullish + ≥20 msgs + watchlist ≥10k    →  7
//     80%+ bullish + ≥15 msgs + watchlist ≥5k     →  5
//     70%+ bullish + ≥10 msgs                     →  3
//     60%+ bullish + ≥10 msgs                     →  2
//
//   Reddit/Apewisdom (max 7):
//     top10 rank OR 5x+ spike + ≥50 mentions      →  7
//     top25 rank OR 3x+ spike + ≥30 mentions      →  5
//     ≥100 mentions OR 2x+ spike + ≥25 mentions   →  3
//     ≥30 mentions in last 24h                    →  1
function scoreSocial(socialSummary) {
  if (!socialSummary || !socialSummary.has_data) {
    return { pts: 0, has_data: false, stocktwits_pts: 0, reddit_pts: 0 };
  }

  // StockTwits subscore (max 7)
  const bullRatio = socialSummary.bull_ratio_pct;
  const msgs = Number(socialSummary.message_count_24h) || 0;
  const watch = Number(socialSummary.watchlist_count) || 0;
  let stPts = 0;
  if (bullRatio == null) {
    stPts = 0;
  } else if (bullRatio >= 100 && msgs >= 20 && watch >= 10_000) {
    stPts = 7;
  } else if (bullRatio >= 80 && msgs >= 15 && watch >= 5_000) {
    stPts = 5;
  } else if (bullRatio >= 70 && msgs >= 10) {
    stPts = 3;
  } else if (bullRatio >= 60 && msgs >= 10) {
    stPts = 2;
  }

  // Reddit subscore (max 7)
  const reddit = socialSummary.reddit || null;
  const rank = reddit?.rank;
  const rMentions = Number(reddit?.mentions_24h) || 0;
  const spike = Number(reddit?.spike_ratio) || 0;
  let rdPts = 0;
  if (reddit && rMentions > 0) {
    if ((rank != null && rank <= 10) || (spike >= 5 && rMentions >= 50)) rdPts = 7;
    else if ((rank != null && rank <= 25) || (spike >= 3 && rMentions >= 30)) rdPts = 5;
    else if (rMentions >= 100 || (spike >= 2 && rMentions >= 25)) rdPts = 3;
    else if (rMentions >= 30) rdPts = 1;
  }

  const pts = Math.min(W_SOCIAL, stPts + rdPts);

  return {
    pts,
    has_data: true,
    stocktwits_pts: stPts,
    reddit_pts: rdPts,
    bull_ratio_pct: bullRatio,
    message_count_24h: msgs,
    watchlist_count: watch || null,
    bullish_count: socialSummary.bullish_count || 0,
    bearish_count: socialSummary.bearish_count || 0,
    top_post_body: socialSummary.top_post_body || null,
    top_post_user: socialSummary.top_post_user || null,
    top_post_url: socialSummary.top_post_url || null,
    reddit: reddit ? {
      rank,
      mentions_24h: rMentions,
      mentions_prev: Number(reddit.mentions_prev) || 0,
      spike_ratio: spike || null,
      upvotes_24h: Number(reddit.upvotes_24h) || 0,
    } : null,
  };
}

// ── INSIDER_BUY component ────────────────────────────────────────────────
function scoreInsider(insiderSummary) {
  if (!insiderSummary || (insiderSummary.buys_count || 0) === 0) {
    return { pts: 0, hi_buys_count: 0, hi_buys_value: 0 };
  }
  const hiBuysValue = Number(insiderSummary.hi_buys_value) || 0;
  const hiBuysCount = Number(insiderSummary.hi_buys_count) || 0;
  // Need at least one high-signal buy. Scale by $ value.
  let pts = 0;
  if (hiBuysValue >= 1_000_000 && hiBuysCount >= 1) pts = W_INSIDER;
  else if (hiBuysValue >= 250_000 && hiBuysCount >= 1) pts = Math.round(W_INSIDER * 0.8);
  else if (hiBuysValue >= 100_000 && hiBuysCount >= 1) pts = Math.round(W_INSIDER * 0.6);
  else if ((insiderSummary.buys_count || 0) >= 2) pts = Math.round(W_INSIDER * 0.4);
  return {
    pts,
    hi_buys_count: hiBuysCount,
    hi_buys_value: hiBuysValue,
    total_buys_value: Number(insiderSummary.buys_value) || 0,
    total_sells_value: Number(insiderSummary.sells_value) || 0,
  };
}

// ── MACRO_ALIGN component ────────────────────────────────────────────────
// Maps the ticker's themes against the cross-asset macro snapshot's
// country_rotation + sector regime tilts.
function scoreMacro(themes, macroSnapshot, sector) {
  if (!macroSnapshot) return { pts: 0, signal: null };
  // Country alignment: if candidate is a country_ ETF, check its row directly.
  for (const t of (themes || [])) {
    if (!t.startsWith("country_")) continue;
    const row = (macroSnapshot.country_rotation?.all || []).find((c) => c.theme === t);
    if (!row || !row.has_data) continue;
    if (row.classification_20d === "outperforming") {
      return { pts: W_MACRO, signal: `country_${t}_outperforming`, rs_20d: row.rs_20d_vs_spy };
    }
    if (row.classification_20d === "underperforming") {
      return { pts: 0, signal: `country_${t}_underperforming`, rs_20d: row.rs_20d_vs_spy };
    }
  }
  // Sector-based proxy: AI infra themes get boost when oil + nat_gas not extreme,
  // since US AI infra benefits from cheap energy (per user's thesis). Energy
  // themes get boost when oil is outperforming.
  const isAiInfra = (themes || []).some((t) => t.startsWith("ai_infra"));
  const isEnergyPlay = (themes || []).some((t) => t === "ai_infra_energy" || t === "oil_gas" || t === "oil_services");
  const oilClass = macroSnapshot.cross_asset_regime?.oil_20d;
  if (isEnergyPlay && oilClass === "outperforming") {
    return { pts: W_MACRO, signal: "energy_play_oil_strong" };
  }
  if (isAiInfra && (oilClass === "outperforming" || oilClass === "inline")) {
    return { pts: Math.round(W_MACRO * 0.5), signal: "ai_infra_oil_supportive" };
  }
  // Fallback: neutral.
  return { pts: 0, signal: null };
}

// ── PEER_VALIDATION component ────────────────────────────────────────────
// Existing in-universe peers (same THEME) have a positive recent capture
// record on our system. Cheap proxy: check how many same-theme tickers
// were big-move + captured in the coverage-gaps summary (computed by
// Phase 1's coverage-gap diagnostic, written to KV).
function scorePeer(themes, coverageGapsSummary) {
  if (!Array.isArray(themes) || themes.length === 0 || !coverageGapsSummary?.by_ticker) {
    return { pts: 0, theme: null, peer_capture_rate: null };
  }
  // For each theme, look at all in-universe peers and compute the average
  // capture_rate_pct from the coverage-gaps summary.
  let bestRate = null, bestTheme = null;
  for (const t of themes) {
    const peers = THEMES[t] || [];
    const peerStats = peers.map((p) => coverageGapsSummary.by_ticker[p]).filter(Boolean);
    if (peerStats.length === 0) continue;
    const rates = peerStats.map((p) => Number(p.capture_rate_pct)).filter((x) => Number.isFinite(x));
    if (rates.length === 0) continue;
    const avg = rates.reduce((s, x) => s + x, 0) / rates.length;
    if (bestRate == null || avg > bestRate) { bestRate = avg; bestTheme = t; }
  }
  if (bestRate == null) return { pts: 0, theme: null, peer_capture_rate: null };
  let pts = 0;
  if (bestRate >= 70) pts = W_PEER;
  else if (bestRate >= 50) pts = Math.round(W_PEER * 0.7);
  else if (bestRate >= 30) pts = Math.round(W_PEER * 0.4);
  return { pts, theme: bestTheme, peer_capture_rate: Math.round(bestRate) };
}

// ── Red-flag detection ───────────────────────────────────────────────────
function detectRedFlags(latest, appearances, components, dailyChangePct) {
  const flags = [];
  const marketCap = Number(latest?.market_cap) || 0;
  const avgVolume = Number(latest?.avg_volume) || Number(latest?.volume) || 0;
  const price = Number(latest?.price) || 0;

  if (avgVolume < LOW_LIQUIDITY_AVG_VOLUME || marketCap < LOW_LIQUIDITY_MARKET_CAP) {
    flags.push({ flag: "low_liquidity", deduction: 20, detail: { avg_volume: avgVolume, market_cap: marketCap } });
  }
  if (price < SUB_THRESHOLD_PRICE) {
    flags.push({ flag: "sub_$5_price", deduction: 15, detail: { price } });
  }
  const distinctDays = new Set(
    (appearances || []).map((a) => String(a.discovered_at || "").slice(0, 10)).filter(Boolean),
  ).size;
  if (Math.abs(Number(dailyChangePct) || 0) >= SINGLE_DAY_EXTREME_MOVE_PCT && distinctDays <= 1) {
    // 2026-05-29 — scale the deduction by market cap and social validation.
    // Original flat −30 was correct for $1B small-caps where 30% daily moves
    // signal pump-and-dump. But a $50B+ large-cap rallying 30%+ on
    // consensus-bullish social (e.g. SNOW today at +36% / 100% bullish /
    // 57k watchlist) is far more likely to be a real fundamental move
    // (earnings beat, M&A, etc.). Scale:
    //   mcap >= $50B  AND social bull_ratio >= 70%        → −10
    //   mcap >= $50B                                       → −15
    //   mcap >= $10B  AND social bull_ratio >= 70%        → −15
    //   mcap >= $10B                                       → −20
    //   else (default — small-cap or no social validation) → −30
    let deduction = 30;
    const bullRatio = components?.social?.bull_ratio_pct;
    const socialConfirms = bullRatio != null && bullRatio >= 70 && (components?.social?.message_count_24h || 0) >= 10;
    if (marketCap >= 50_000_000_000 && socialConfirms) deduction = 10;
    else if (marketCap >= 50_000_000_000) deduction = 15;
    else if (marketCap >= 10_000_000_000 && socialConfirms) deduction = 15;
    else if (marketCap >= 10_000_000_000) deduction = 20;
    flags.push({
      flag: "extreme_single_day_move",
      deduction,
      detail: {
        change_pct: dailyChangePct,
        distinct_days: distinctDays,
        market_cap: marketCap,
        social_confirms: socialConfirms,
        bull_ratio_pct: bullRatio,
      },
    });
  }
  const hasNothing =
    (components.sustain || 0) === 0 &&
    (components.theme?.pts || 0) === 0 &&
    (components.news?.pts || 0) === 0 &&
    (components.insider?.pts || 0) === 0;
  if (hasNothing) {
    flags.push({
      flag: "no_news_no_theme_no_insider",
      deduction: 25,
      detail: { hint: "Pure technical pump signature — no fundamental support" },
    });
  }
  return flags;
}

// ── Thesis text builder ──────────────────────────────────────────────────
function buildThesisText(ticker, latest, components, redFlags, totalScore, statusLabel) {
  const parts = [`**${ticker}**`];
  // Sector + market cap line.
  const sectorLine = [];
  if (latest?.sector) sectorLine.push(latest.sector);
  if (latest?.name && latest.name !== ticker) sectorLine.push(latest.name);
  const marketCapB = Number(latest?.market_cap) ? `${(Number(latest.market_cap) / 1e9).toFixed(1)}B mcap` : null;
  if (marketCapB) sectorLine.push(marketCapB);
  if (sectorLine.length > 0) parts.push(`— ${sectorLine.join(", ")}.`);

  // Sustained appearances.
  if (components.sustain > 0) {
    const distinctDays = new Set(
      (components._raw_appearances || []).map((a) => String(a.discovered_at || "").slice(0, 10)).filter(Boolean),
    ).size;
    const scanTypes = [...new Set((components._raw_appearances || []).map((a) => a.scan_type).filter(Boolean))];
    parts.push(`Sustained: appeared in screener ${distinctDays}× across ${scanTypes.join(", ")}.`);
  } else if ((components._raw_appearances || []).length === 1) {
    const a = components._raw_appearances[0];
    parts.push(`First seen ${String(a.discovered_at || "").slice(0, 10)} as ${a.scan_type || "candidate"} (+${a.change_pct}%).`);
  }

  // Theme.
  if (components.theme?.pts > 0) {
    const peers = (components.theme.top_peer_movers || []).map((p) => `${p.ticker} +${p.dp}%`).join(", ");
    parts.push(`Theme ACTIVE: ${components.theme.theme} (${components.theme.peers_up}/${components.theme.peers_total} peers up >2%${peers ? ` — ${peers}` : ""}).`);
  } else if (components.theme?.theme) {
    parts.push(`Theme: ${components.theme.theme} (not currently active).`);
  }

  // News catalyst.
  if (components.news?.pts > 0 && components.news?.top_headline) {
    parts.push(`Catalyst (strength ${components.news.max_catalyst}/10): "${String(components.news.top_headline).slice(0, 140)}".`);
  } else if (components.news?.bullish_catalyst_count > 0) {
    parts.push(`${components.news.bullish_catalyst_count} bullish catalyst headline(s) in last 5d.`);
  }

  // Insider.
  if (components.insider?.hi_buys_count > 0) {
    const valK = Math.round((components.insider.hi_buys_value || 0) / 1000);
    parts.push(`Insider activity: ${components.insider.hi_buys_count} high-signal buy(s) totaling $${valK}k last 14d.`);
  }

  // Social buzz (StockTwits + Reddit).
  if (components.social?.pts > 0) {
    const lines = [];
    if (components.social.stocktwits_pts > 0) {
      const watchK = components.social.watchlist_count
        ? `${Math.round(components.social.watchlist_count / 1000)}k watching` : null;
      const msgs = `${components.social.message_count_24h || 0} posts`;
      const ratio = components.social.bull_ratio_pct != null
        ? `${components.social.bull_ratio_pct}% bullish` : "untagged";
      lines.push(`StockTwits: ${[msgs, ratio, watchK].filter(Boolean).join(" · ")}`);
    }
    if (components.social.reddit_pts > 0 && components.social.reddit) {
      const r = components.social.reddit;
      const spikeStr = r.spike_ratio && r.spike_ratio < 100
        ? ` (${r.spike_ratio >= 1 ? r.spike_ratio.toFixed(1) + "x" : (r.spike_ratio * 100).toFixed(0) + "%"} vs 24h ago)` : "";
      const rankStr = r.rank ? ` · rank #${r.rank}` : "";
      lines.push(`Reddit: ${r.mentions_24h} mentions${spikeStr}${rankStr}`);
    }
    if (lines.length > 0) parts.push(`Social buzz: ${lines.join(" | ")}.`);
  }

  // Macro.
  if (components.macro?.pts > 0 && components.macro.signal) {
    parts.push(`Macro: ${String(components.macro.signal).replace(/_/g, " ")}.`);
  }

  // Peer validation.
  if (components.peer?.pts > 0 && components.peer.peer_capture_rate != null) {
    parts.push(`Peer validation: ${components.peer.theme} cohort captures ${components.peer.peer_capture_rate}% of historical moves on our system.`);
  }

  // Active playbook alignment.
  if (components.strategy?.pts > 0) {
    parts.push(`Active playbook: ON-THESIS (${components.strategy.stance.toUpperCase()}${components.strategy.tier ? ` · ${components.strategy.tier}` : ""})${components.strategy.reason ? ` — ${components.strategy.reason}` : ""}.`);
  } else if (components.strategy?.pts < 0) {
    parts.push(`Active playbook: OFF-THESIS (${components.strategy.stance.toUpperCase()}) — caution warranted.`);
  }

  // Red flags.
  if (redFlags.length > 0) {
    parts.push(`⚠ Red flags: ${redFlags.map((f) => f.flag).join(", ")}.`);
  }

  // Verdict.
  parts.push(`**Score ${totalScore}/100 → ${statusLabel}.**`);
  return parts.join(" ");
}

// ── STRATEGY_ALIGNMENT component ─────────────────────────────────────────
// 2026-05-30 — Editorial tilt boost. When the candidate sits in an OVERWEIGHT
// theme or sector of the active playbook (currently FSD 2026), award up to
// W_STRATEGY points. Penalise UNDERWEIGHT names by the same magnitude so
// the queue actively de-prioritises off-thesis candidates without rejecting
// them outright (the score gates already handle that). Pure data join —
// no I/O.
function scoreStrategyAlignment(sym, latest, tacticalCtx) {
  try {
    const aligned = getStrategyForTicker(sym, {
      sector: latest?.sector,
      market_cap: Number(latest?.market_cap) || null,
    }, getThemesForTicker);
    const base = (!aligned || aligned.stance === "neutral" || aligned.multiplier === 1.0)
      ? { pts: 0, stance: "neutral", multiplier: 1.0, tier: null, reason: null, sector: aligned?.sector || latest?.sector || null, themes: (aligned?.themes_matched || []).map(t => t.theme) }
      : (() => {
          // multiplier semantics: 1.25 = OW strongest, 0.90 = UW strongest.
          const delta = aligned.multiplier - 1.0;
          const scale = Math.min(1.0, Math.abs(delta) / 0.25);
          const sign = delta >= 0 ? 1 : -1;
          return {
            pts: Math.round(sign * scale * W_STRATEGY),
            stance: aligned.stance,
            multiplier: aligned.multiplier,
            tier: aligned.tier,
            reason: aligned.reason,
            sector: aligned.sector,
            themes: (aligned.themes_matched || []).map(t => t.theme),
          };
        })();

    // 2026-06-04 — Optional, gated FSD tactical-overlay nudge. When the live
    // CRO tactical overlay favors (or cautions on) a theme/sector this name
    // belongs to, add a small bounded ±W_TACTICAL. Default OFF
    // (cro_tactical_rank_nudge_enabled). Never flips the structural stance.
    if (tacticalCtx && tacticalCtx.enabled) {
      let nudge = 0;
      const reasons = [];
      for (const th of (base.themes || [])) {
        const s = tacticalCtx.themeDir.get(th);
        if (s) { nudge += s; reasons.push(`${th}${s > 0 ? "+" : "-"}`); }
      }
      const secSign = base.sector ? tacticalCtx.sectorDir.get(base.sector) : null;
      if (secSign) { nudge += secSign; reasons.push(`${base.sector}${secSign > 0 ? "+" : "-"}`); }
      if (nudge !== 0) {
        const capped = Math.max(-1, Math.min(1, nudge)) * W_TACTICAL;
        base.pts += Math.round(capped);
        base.tactical_nudge = Math.round(capped);
        base.tactical_reason = reasons.slice(0, 4).join(", ");
      }
    }
    return base;
  } catch (_) {
    return { pts: 0, stance: "neutral", multiplier: 1.0, tier: null, reason: null };
  }
}

// Build the (gated) FSD tactical-overlay nudge context once per scoring run.
// Reads the operator flag + the live tactical override, mapping affected
// themes/sectors to a favor (+1) / caution (-1) direction.
async function buildTacticalNudgeContext(env) {
  const ctx = { enabled: false, themeDir: new Map(), sectorDir: new Map() };
  try {
    if (!env?.DB) return ctx;
    // 2026-06-05 — operator flipped this ON by default. Disabled only when the
    // model_config row is explicitly false.
    const cfg = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_tactical_rank_nudge_enabled'`,
    ).first().catch(() => null);
    const v = cfg ? String(cfg.config_value).toLowerCase() : "true";
    if (v === "false" || v === "0") return ctx;
    const raw = await env?.KV?.get("cro:tactical_overrides");
    const blob = raw ? JSON.parse(raw) : null;
    const signals = Array.isArray(blob?.tactical_signals) ? blob.tactical_signals : [];
    if (signals.length === 0) return ctx;
    const cautionRe = /(caution|bearish|under|reduce|fade|trim|down|stretch)/i;
    for (const sig of signals) {
      const dir = String(sig.direction || "");
      const sign = cautionRe.test(dir) ? -1 : 1;
      for (const th of (sig.affected_tier1_themes || [])) {
        ctx.themeDir.set(th, sign);
      }
      // affected_sectors_overweight are explicit overweight calls → favorable.
      for (const sec of (sig.affected_sectors_overweight || [])) {
        ctx.sectorDir.set(sec, 1);
      }
    }
    ctx.enabled = ctx.themeDir.size > 0 || ctx.sectorDir.size > 0;
  } catch (_) { /* gate stays off on any error */ }
  return ctx;
}

// ── Main scorer ──────────────────────────────────────────────────────────
function scoreCandidate(ticker, latest, allAppearances, themeActivityByName, newsSummary, insiderSummary, macroSnapshot, coverageGapsSummary, socialSummary, tacticalCtx) {
  const sym = String(ticker || "").toUpperCase();
  const appearances = (allAppearances || []).filter((a) => String(a.ticker || "").toUpperCase() === sym);
  const themes = getThemesForTicker(sym);
  const dayChangePct = Number(latest?.change_pct) || 0;

  const sustainPts = scoreSustain(appearances);
  const qualityPts = scoreQuality(latest);
  const themeResult = scoreTheme(themes, themeActivityByName, dayChangePct);
  const newsResult = scoreNews(newsSummary);
  const insiderResult = scoreInsider(insiderSummary);
  const macroResult = scoreMacro(themes, macroSnapshot, latest?.sector);
  const peerResult = scorePeer(themes, coverageGapsSummary);
  const socialResult = scoreSocial(socialSummary);
  const strategyResult = scoreStrategyAlignment(sym, latest, tacticalCtx);

  const components = {
    sustain: sustainPts,
    quality: qualityPts,
    theme: themeResult,
    news: newsResult,
    insider: insiderResult,
    macro: macroResult,
    peer: peerResult,
    social: socialResult,
    strategy: strategyResult,
    _raw_appearances: appearances,
  };

  const redFlags = detectRedFlags(latest, appearances, components, dayChangePct);
  const totalRaw =
    sustainPts + qualityPts + themeResult.pts + newsResult.pts +
    insiderResult.pts + macroResult.pts + peerResult.pts + socialResult.pts +
    strategyResult.pts;
  const deductions = redFlags.reduce((s, f) => s + f.deduction, 0);
  const totalScore = Math.max(-100, Math.min(SCORE_MAX, totalRaw - deductions));

  const hasCritical = redFlags.some((f) => CRITICAL_RED_FLAGS.has(f.flag));
  const material = hasMaterialThesis(components);
  let status;
  if (totalScore >= SCORE_READY_TO_ADD && !hasCritical && material) status = "ready_to_add";
  else if (totalScore >= SCORE_NEEDS_REVIEW && !hasCritical && material) status = "needs_review";
  else status = "rejected";

  const statusLabel = status === "ready_to_add" ? "READY_TO_ADD"
    : status === "needs_review" ? "NEEDS_REVIEW"
    : "REJECTED";

  const thesisText = buildThesisText(sym, latest, components, redFlags, totalScore, statusLabel);

  // Strip internal _raw_appearances from persisted components.
  const cleanComponents = { ...components };
  delete cleanComponents._raw_appearances;

  return {
    ticker: sym,
    total_score: totalScore,
    status,
    thesis_text: thesisText,
    red_flags: redFlags,
    components: cleanComponents,
    appearances_count: appearances.length,
    first_seen_at: appearances.length > 0
      ? new Date(appearances[appearances.length - 1].discovered_at || Date.now()).getTime()
      : Date.now(),
    last_seen_at: appearances.length > 0
      ? new Date(appearances[0].discovered_at || Date.now()).getTime()
      : Date.now(),
    signals: {
      latest_price: latest?.price,
      latest_change_pct: dayChangePct,
      latest_volume: latest?.volume,
      market_cap: latest?.market_cap,
      sector: latest?.sector,
      name: latest?.name,
      themes,
      scan_types: [...new Set(appearances.map((a) => a.scan_type).filter(Boolean))],
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────────────
// Pulls the latest screener candidates + auxiliary data, scores every
// out-of-universe candidate, writes results to the D1 promotion queue.
// Returns a summary suitable for the admin response.
export async function rebuildPromotionQueue(env, opts = {}) {
  const db = env?.DB;
  const KV = env?.KV_TIMED || env?.KV;
  if (!db || !KV) return { ok: false, error: "no_db_or_kv" };
  await ensurePromotionQueueSchema(env);

  // 1. Load screener candidates from KV.
  const candidatesRaw = await KV.get("timed:screener:candidates");
  if (!candidatesRaw) return { ok: false, error: "no_screener_candidates" };
  const candidatesData = JSON.parse(candidatesRaw);
  const candidates = Array.isArray(candidatesData?.candidates) ? candidatesData.candidates : [];
  if (candidates.length === 0) return { ok: true, scored: 0, message: "no_candidates" };

  // 2. Build the in-universe ticker set.
  //
  // SECTOR_MAP is keyed by TICKER → SECTOR_NAME (e.g. AAPL → "Information
  // Technology"). So Object.keys() correctly returns the in-universe
  // ticker symbols.
  //
  // 2026-05-29 — we no longer skip in-universe candidates. Tag them with
  // `in_universe: true` so the UI can either filter them out or surface
  // them as "strong screener signal on a ticker we already track". The
  // user explicitly wants to see in-universe names like SNOW/LUNR when
  // they ARE valid candidates, not have them silently dropped.
  const SectorMap = await import("../sector-mapping.js");
  const inUniverseSet = new Set(Object.keys(SectorMap.SECTOR_MAP).map((s) => s.toUpperCase()));

  // 3. Build "latest" snapshot per unique ticker (most recent appearance).
  //    Score ALL candidates, regardless of universe membership.
  const latestBySym = {};
  for (const c of candidates) {
    const sym = String(c.ticker || "").toUpperCase();
    if (!sym) continue;
    if (!latestBySym[sym] || (c.discovered_at || "") > (latestBySym[sym].discovered_at || "")) {
      latestBySym[sym] = c;
    }
  }
  const uniqueTickers = Object.keys(latestBySym);
  const outOfUniverse = candidates.filter((c) => {
    const sym = String(c.ticker || "").toUpperCase();
    return sym && !inUniverseSet.has(sym);
  });

  // 4. Load auxiliary data for scoring.
  const livePricesRaw = await KV.get("timed:prices");
  const livePrices = livePricesRaw ? JSON.parse(livePricesRaw) : null;

  // Compute theme activity once for all themes referenced by candidates.
  const allThemes = new Set();
  for (const sym of uniqueTickers) {
    for (const t of getThemesForTicker(sym)) allThemes.add(t);
  }
  const themeActivityByName = {};
  for (const t of allThemes) {
    themeActivityByName[t] = computeThemeActivity(t, livePrices);
  }

  // News + insider + social summaries — batched single D1 read each.
  const newsSummaries = await loadNewsSummariesBatch(env, uniqueTickers, { lookbackDays: 5 });
  const insiderSummaries = await loadInsiderSummariesBatch(env, uniqueTickers, { lookbackDays: 14 });
  const socialSummaries = await loadSocialSummariesBatch(env, uniqueTickers, { lookbackDays: 3 });

  // Macro snapshot + coverage-gaps summary from KV.
  const macroRaw = await KV.get("timed:macro:cross-asset-summary");
  const macroSnapshot = macroRaw ? JSON.parse(macroRaw) : null;
  const gapsRaw = await KV.get("timed:discovery:coverage-gaps-summary");
  const coverageGapsSummary = gapsRaw ? JSON.parse(gapsRaw) : null;

  // Gated FSD tactical-overlay nudge context (default OFF).
  const tacticalCtx = await buildTacticalNudgeContext(env);

  // 5. Score every unique ticker.
  const now = Date.now();
  const scoredResults = [];
  for (const sym of uniqueTickers) {
    try {
      const result = scoreCandidate(
        sym, latestBySym[sym], candidates, themeActivityByName,
        newsSummaries[sym], insiderSummaries[sym], macroSnapshot, coverageGapsSummary,
        socialSummaries[sym], tacticalCtx,
      );
      result.in_universe = inUniverseSet.has(sym);
      // Annotate signals payload so the UI can render the badge without
      // re-checking SECTOR_MAP.
      if (result.signals) result.signals.in_universe = result.in_universe;
      scoredResults.push(result);
    } catch (e) {
      console.warn(`[PROMOTION] score failed for ${sym}:`, String(e?.message || e).slice(0, 150));
    }
  }

  /* 6. Persist to D1. INSERT OR REPLACE per candidate_id (ticker:YYYY-MM-DD).

     2026-06-01 — Per-ticker decision inheritance.

     Operator reported: "SMCI, SNOW showed up again, but I thought we
     already added those last time we used screener." Root cause: the
     candidate_id was `${ticker}:${YYYY-MM-DD}`, so EACH day creates a
     new row keyed by date. The existing "preserve decision" logic only
     matched the same-day candidate_id — SMCI approved 2026-05-29 had no
     row at SMCI:2026-06-01, so today's rebuild created a fresh
     needs_review/ready_to_add row.

     Fix: before inserting today's row, look up the MOST RECENT row for
     this ticker (any candidate_id) where status is `approved` or
     `declined`. If found, inherit that decision (preserve `decided_by`
     + `decided_at`, override status with the prior decision). Result:
     a ticker the operator already decided on stays decided forever
     (unless the operator explicitly re-decides on today's row, which
     they can do from the Approved/Declined tabs).

     Also: previously-approved tickers that ARE in the universe now stay
     in the "approved" bucket so the needs_review / ready_to_add tabs
     don't keep showing them. */
  const todayKey = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const r of scoredResults) {
    const candidateId = `${r.ticker}:${todayKey}`;
    try {
      // Preserve operator decisions for THIS candidate_id (same-day re-run).
      const existing = await db.prepare(
        `SELECT status, decided_by, decided_at FROM discovery_promotion_queue WHERE candidate_id = ?1`,
      ).bind(candidateId).first();

      // Also look up the most recent prior decision for this ticker across
      // ALL candidate_ids — that's the source-of-truth for cross-day
      // dedup. Single-row LIMIT 1 ordered by decided_at DESC; both indexes
      // (idx_promotion_ticker, idx_promotion_created) are already present.
      const priorDecision = await db.prepare(
        `SELECT status, decided_by, decided_at
           FROM discovery_promotion_queue
          WHERE ticker = ?1
            AND status IN ('approved', 'declined')
            AND decided_at IS NOT NULL
          ORDER BY decided_at DESC
          LIMIT 1`,
      ).bind(r.ticker).first().catch(() => null);

      let finalStatus = r.status;
      let decidedBy = null;
      let decidedAt = null;

      if (existing?.status === "approved" || existing?.status === "declined") {
        finalStatus = existing.status;
        decidedBy = existing.decided_by;
        decidedAt = existing.decided_at;
      } else if (priorDecision?.status === "approved" || priorDecision?.status === "declined") {
        finalStatus = priorDecision.status;
        decidedBy = priorDecision.decided_by;
        decidedAt = priorDecision.decided_at;
      }

      await db.prepare(`
        INSERT OR REPLACE INTO discovery_promotion_queue
          (candidate_id, ticker, first_seen_at, last_seen_at, appearances_7d,
           total_score, status, thesis_text, red_flags_json, components_json,
           signals_json, decided_by, decided_at, created_at, updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,
                COALESCE((SELECT created_at FROM discovery_promotion_queue WHERE candidate_id = ?1), ?14),
                ?15)
      `).bind(
        candidateId, r.ticker, r.first_seen_at, r.last_seen_at, r.appearances_count,
        r.total_score, finalStatus, r.thesis_text,
        JSON.stringify(r.red_flags || []),
        JSON.stringify(r.components || {}),
        JSON.stringify(r.signals || {}),
        decidedBy, decidedAt, now, now,
      ).run();
      written++;
    } catch (e) {
      console.warn(`[PROMOTION] D1 write failed for ${candidateId}:`, String(e?.message || e).slice(0, 200));
    }
  }

  // 7. Summary by status.
  const byStatus = scoredResults.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    computed_at: now,
    universe_size: inUniverseSet.size,
    screener_candidates: candidates.length,
    out_of_universe: outOfUniverse.length,
    unique_tickers_scored: uniqueTickers.length,
    written,
    by_status: byStatus,
    top_5_ready: scoredResults
      .filter((r) => r.status === "ready_to_add")
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5)
      .map((r) => ({ ticker: r.ticker, score: r.total_score, in_universe: r.in_universe, thesis: r.thesis_text })),
    top_5_review: scoredResults
      .filter((r) => r.status === "needs_review")
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5)
      .map((r) => ({ ticker: r.ticker, score: r.total_score, in_universe: r.in_universe, thesis: r.thesis_text })),
  };
}

// Read rows for admin UI.
export async function loadPromotionQueueRows(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  // 2026-05-29 — accept "any" / "all" / "*" / empty as "no filter".
  // Previously a literal WHERE status='any' matched zero rows when the
  // admin UI's "Show all" tab requested the unfiltered view.
  const rawStatus = String(opts.status || "").trim().toLowerCase();
  const wildcards = new Set(["", "any", "all", "*"]);
  const status = wildcards.has(rawStatus) ? null : rawStatus;
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const where = [];
  const params = [];
  if (status) { where.push(`status = ?${params.length + 1}`); params.push(status); }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const rows = (await db.prepare(`
    SELECT candidate_id, ticker, first_seen_at, last_seen_at, appearances_7d,
           total_score, status, thesis_text, red_flags_json, components_json,
           signals_json, decided_by, decided_at, created_at, updated_at
      FROM discovery_promotion_queue
      ${whereClause}
      ORDER BY (status='needs_review') DESC, (status='ready_to_add') DESC, total_score DESC, updated_at DESC
      LIMIT ?${params.length}
  `).bind(...params).all().catch(() => ({ results: [] })))?.results || [];
  // Parse JSON columns for clean response.
  const parsed = rows.map((r) => ({
    ...r,
    red_flags: tryParseJSON(r.red_flags_json) || [],
    components: tryParseJSON(r.components_json) || {},
    signals: tryParseJSON(r.signals_json) || {},
    red_flags_json: undefined, components_json: undefined, signals_json: undefined,
  }));
  return { ok: true, count: parsed.length, rows: parsed };
}

function tryParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

/* 2026-06-01 — Per-ticker thesis lookup for the right-rail Snapshot tab.

   Operator request: "the justification text is money, can we incorporate
   that into our Snapshot Right Rail tab when, where and how appropriate?"

   Returns the most recent promotion-queue row for a ticker (regardless of
   decision status — even APPROVED/DECLINED rows carry the same scoring
   payload + thesis). One D1 read; no KV cache needed at this layer
   because the route handler in worker/index.js layers a short cache. */
export async function loadThesisForTicker(env, ticker) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const sym = String(ticker || "").trim().toUpperCase();
  if (!sym) return { ok: false, error: "ticker_required" };
  try {
    const row = await db.prepare(
      `SELECT candidate_id, ticker, first_seen_at, last_seen_at, appearances_7d,
              total_score, status, thesis_text, red_flags_json, components_json,
              signals_json, decided_by, decided_at, created_at, updated_at
         FROM discovery_promotion_queue
        WHERE ticker = ?1
        ORDER BY updated_at DESC
        LIMIT 1`,
    ).bind(sym).first();
    if (!row) return { ok: true, ticker: sym, found: false };
    return {
      ok: true,
      ticker: sym,
      found: true,
      candidate_id: row.candidate_id,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      appearances_7d: row.appearances_7d,
      total_score: row.total_score,
      status: row.status,
      thesis_text: row.thesis_text || null,
      red_flags: tryParseJSON(row.red_flags_json) || [],
      components: tryParseJSON(row.components_json) || {},
      signals: tryParseJSON(row.signals_json) || {},
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// Operator decision on a queue row. Returns updated row.
//
// 2026-05-29 — When status === "approve", ALSO add the ticker to
// the global universe (timed:tickers KV) and remove it from the
// timed:removed blocklist if present. The user reported approving
// SMCI in the queue but not seeing it added to "My Tickers" — root
// cause was that this function only flipped a D1 status column and
// never actually mutated the universe. Now it's a real one-tap
// "promote into universe" action.
export async function decideOnCandidate(env, opts = {}) {
  const db = env?.DB;
  const KV = env?.KV_TIMED || env?.KV;
  if (!db) return { ok: false, error: "no_db" };
  const candidateId = String(opts.candidate_id || "").trim();
  const decision = String(opts.decision || "").toLowerCase();
  const decidedBy = String(opts.decided_by || "operator").slice(0, 200);
  if (!candidateId) return { ok: false, error: "candidate_id_required" };
  if (!["approve", "decline"].includes(decision)) return { ok: false, error: "decision_must_be_approve_or_decline" };
  const finalStatus = decision === "approve" ? "approved" : "declined";
  const now = Date.now();
  try {
    // 1. Look up the candidate's ticker (needed for the universe add).
    const existing = await db.prepare(
      `SELECT ticker FROM discovery_promotion_queue WHERE candidate_id = ?1`,
    ).bind(candidateId).first();
    if (!existing) return { ok: false, error: "candidate_not_found" };
    const ticker = String(existing.ticker || "").toUpperCase();

    // 2. Persist the decision.
    await db.prepare(`
      UPDATE discovery_promotion_queue
         SET status = ?2, decided_by = ?3, decided_at = ?4, updated_at = ?4
       WHERE candidate_id = ?1
    `).bind(candidateId, finalStatus, decidedBy, now).run();

    // 3. On approve, actually add to universe.
    let universeAdded = false;
    let removedFromBlocklist = false;
    if (decision === "approve" && KV && ticker) {
      try {
        // Clear from blocklist first so the next ensureTickerIndex
        // call (or this one) can succeed.
        const blocklist = (await KV.get("timed:removed", "json")) || [];
        if (Array.isArray(blocklist) && blocklist.includes(ticker)) {
          const next = blocklist.filter((t) => t !== ticker);
          await KV.put("timed:removed", JSON.stringify(next));
          removedFromBlocklist = true;
        }
        // Add to the universe set with retry-on-race.
        let retries = 3;
        while (retries-- > 0) {
          const cur = (await KV.get("timed:tickers", "json")) || [];
          if (!Array.isArray(cur)) break;
          if (cur.includes(ticker)) { universeAdded = true; break; }
          cur.push(ticker);
          cur.sort();
          await KV.put("timed:tickers", JSON.stringify(cur));
          // Verify with a tiny KV-consistency wait.
          await new Promise((res) => setTimeout(res, 50));
          const verify = (await KV.get("timed:tickers", "json")) || [];
          if (Array.isArray(verify) && verify.includes(ticker)) {
            universeAdded = true;
            break;
          }
        }
        // Best-effort: also write an attribution breadcrumb so the
        // operator can later see "SMCI was promoted via queue by X".
        try {
          await KV.put(
            `timed:promotion:approved:${ticker}`,
            JSON.stringify({
              candidate_id: candidateId,
              decided_by: decidedBy,
              decided_at: now,
              removed_from_blocklist: removedFromBlocklist,
            }),
            { expirationTtl: 90 * 86400 },
          );
        } catch (_) { /* best-effort */ }
        // 2026-05-29 — Fast-onboard hook. The user reported that
        // newly approved tickers had thin technicals data for a
        // while because the next scoring cron tick (every 5 min)
        // hadn't run yet, especially when approval happens during
        // extended-hours sessions when the data feed is slower.
        //
        // We set a "needs_fast_onboard" flag in KV that the
        // freshness monitor / scoring cron can read to prioritise
        // this ticker on its very next pass. We also kick off a
        // best-effort backfill request so candle data exists when
        // scoring runs. Both are fire-and-forget — never block
        // the operator's approve action.
        try {
          await KV.put(
            `timed:fast_onboard:${ticker}`,
            JSON.stringify({ added_at: now, decided_by: decidedBy }),
            { expirationTtl: 24 * 60 * 60 }, // 24h flag; expires after one full session cycle
          );
        } catch (_) { /* best-effort */ }
        // Trigger candle backfill. 2026-05-29 — bumped from 30d to
        // 365d for the all-tf pass and added a separate W backfill at
        // 730d, because the prior 30-day window only produced ~21
        // daily candles per ticker — not enough for HTF scoring
        // (which needs 50+ D bars) OR the investor weekly/monthly
        // classification (which needs the W ladder). Live verified:
        // after extending to 365d the recent 8 tickers all got 251 D
        // bars and 104 W bars, enough to fully onboard.
        try {
          const _workerUrl = env?.WORKER_URL || "https://timed-trading.com";
          const _apiKey = env?.TIMED_API_KEY;
          if (_apiKey) {
            const _enc = encodeURIComponent(ticker);
            const _k = encodeURIComponent(_apiKey);
            // 1. Intraday + daily, 1 year (~250 D bars).
            fetch(
              `${_workerUrl}/timed/admin/alpaca-backfill?ticker=${_enc}&tf=all&sinceDays=365&key=${_k}`,
              { method: "POST" },
            ).catch(() => {});
            // 2. Weekly, 2 years (~100 W bars). Separate call so the
            // W backfill doesn't get cut off by the all-tf time budget.
            fetch(
              `${_workerUrl}/timed/admin/alpaca-backfill?ticker=${_enc}&tf=W&sinceDays=730&key=${_k}`,
              { method: "POST" },
            ).catch(() => {});
          }
        } catch (_) { /* best-effort */ }
      } catch (e) {
        console.warn(`[PROMOTION] universe add failed for ${ticker}:`, String(e?.message || e).slice(0, 200));
      }
    }

    return {
      ok: true,
      candidate_id: candidateId,
      ticker,
      status: finalStatus,
      decided_by: decidedBy,
      decided_at: now,
      universe_added: universeAdded,
      removed_from_blocklist: removedFromBlocklist,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}
