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

// ── Scoring weights ──────────────────────────────────────────────────────
const SCORE_MAX = 100;
const W_SUSTAIN = 20;
const W_QUALITY = 20;
const W_THEME = 15;
const W_NEWS = 15;
const W_INSIDER = 10;
const W_MACRO = 10;
const W_PEER = 10;

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
const SCORE_READY_TO_ADD = 60;
const SCORE_NEEDS_REVIEW = 40;
const CRITICAL_RED_FLAGS = new Set([
  "low_liquidity",
  "sub_$5_price",
  "no_news_no_theme_no_insider",
]);

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
    flags.push({
      flag: "extreme_single_day_move",
      deduction: 30,
      detail: { change_pct: dailyChangePct, distinct_days: distinctDays },
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

  // Macro.
  if (components.macro?.pts > 0 && components.macro.signal) {
    parts.push(`Macro: ${String(components.macro.signal).replace(/_/g, " ")}.`);
  }

  // Peer validation.
  if (components.peer?.pts > 0 && components.peer.peer_capture_rate != null) {
    parts.push(`Peer validation: ${components.peer.theme} cohort captures ${components.peer.peer_capture_rate}% of historical moves on our system.`);
  }

  // Red flags.
  if (redFlags.length > 0) {
    parts.push(`⚠ Red flags: ${redFlags.map((f) => f.flag).join(", ")}.`);
  }

  // Verdict.
  parts.push(`**Score ${totalScore}/100 → ${statusLabel}.**`);
  return parts.join(" ");
}

// ── Main scorer ──────────────────────────────────────────────────────────
function scoreCandidate(ticker, latest, allAppearances, themeActivityByName, newsSummary, insiderSummary, macroSnapshot, coverageGapsSummary) {
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

  const components = {
    sustain: sustainPts,
    quality: qualityPts,
    theme: themeResult,
    news: newsResult,
    insider: insiderResult,
    macro: macroResult,
    peer: peerResult,
    _raw_appearances: appearances,
  };

  const redFlags = detectRedFlags(latest, appearances, components, dayChangePct);
  const totalRaw =
    sustainPts + qualityPts + themeResult.pts + newsResult.pts +
    insiderResult.pts + macroResult.pts + peerResult.pts;
  const deductions = redFlags.reduce((s, f) => s + f.deduction, 0);
  const totalScore = Math.max(-100, Math.min(SCORE_MAX, totalRaw - deductions));

  const hasCritical = redFlags.some((f) => CRITICAL_RED_FLAGS.has(f.flag));
  let status;
  if (totalScore >= SCORE_READY_TO_ADD && !hasCritical) status = "ready_to_add";
  else if (totalScore >= SCORE_NEEDS_REVIEW && !hasCritical) status = "needs_review";
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

  // 2. Filter to out-of-universe tickers (we don't want to "promote" tickers
  //    we already trade) — uses SECTOR_MAP membership as the universe proxy.
  const SectorMap = await import("../sector-mapping.js");
  const universe = new Set(Object.keys(SectorMap.SECTOR_MAP).map((s) => s.toUpperCase()));
  const outOfUniverse = candidates.filter((c) => {
    const sym = String(c.ticker || "").toUpperCase();
    return sym && !universe.has(sym);
  });
  if (outOfUniverse.length === 0) {
    return { ok: true, scored: 0, message: "no_out_of_universe_candidates" };
  }

  // 3. Build "latest" snapshot per unique ticker (most recent appearance).
  const latestBySym = {};
  for (const c of outOfUniverse) {
    const sym = String(c.ticker || "").toUpperCase();
    if (!latestBySym[sym] || (c.discovered_at || "") > (latestBySym[sym].discovered_at || "")) {
      latestBySym[sym] = c;
    }
  }
  const uniqueTickers = Object.keys(latestBySym);

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

  // News + insider summaries — batched single D1 read each.
  const newsSummaries = await loadNewsSummariesBatch(env, uniqueTickers, { lookbackDays: 5 });
  const insiderSummaries = await loadInsiderSummariesBatch(env, uniqueTickers, { lookbackDays: 14 });

  // Macro snapshot + coverage-gaps summary from KV.
  const macroRaw = await KV.get("timed:macro:cross-asset-summary");
  const macroSnapshot = macroRaw ? JSON.parse(macroRaw) : null;
  const gapsRaw = await KV.get("timed:discovery:coverage-gaps-summary");
  const coverageGapsSummary = gapsRaw ? JSON.parse(gapsRaw) : null;

  // 5. Score every unique ticker.
  const now = Date.now();
  const scoredResults = [];
  for (const sym of uniqueTickers) {
    try {
      const result = scoreCandidate(
        sym, latestBySym[sym], outOfUniverse, themeActivityByName,
        newsSummaries[sym], insiderSummaries[sym], macroSnapshot, coverageGapsSummary,
      );
      scoredResults.push(result);
    } catch (e) {
      console.warn(`[PROMOTION] score failed for ${sym}:`, String(e?.message || e).slice(0, 150));
    }
  }

  // 6. Persist to D1. INSERT OR REPLACE per candidate_id (ticker:YYYY-MM-DD).
  const todayKey = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const r of scoredResults) {
    const candidateId = `${r.ticker}:${todayKey}`;
    try {
      // Preserve operator decisions if they already approved/declined.
      const existing = await db.prepare(
        `SELECT status, decided_by, decided_at FROM discovery_promotion_queue WHERE candidate_id = ?1`,
      ).bind(candidateId).first();
      const finalStatus = (existing?.status === "approved" || existing?.status === "declined")
        ? existing.status : r.status;
      const decidedBy = existing?.decided_by || (r.status === "ready_to_add" ? null : null);
      const decidedAt = existing?.decided_at || null;

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
    universe_size: universe.size,
    screener_candidates: candidates.length,
    out_of_universe: outOfUniverse.length,
    unique_tickers_scored: uniqueTickers.length,
    written,
    by_status: byStatus,
    top_5_ready: scoredResults
      .filter((r) => r.status === "ready_to_add")
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5)
      .map((r) => ({ ticker: r.ticker, score: r.total_score, thesis: r.thesis_text })),
    top_5_review: scoredResults
      .filter((r) => r.status === "needs_review")
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5)
      .map((r) => ({ ticker: r.ticker, score: r.total_score, thesis: r.thesis_text })),
  };
}

// Read rows for admin UI.
export async function loadPromotionQueueRows(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const status = String(opts.status || "").trim();
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

// Operator decision on a queue row. Returns updated row.
export async function decideOnCandidate(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const candidateId = String(opts.candidate_id || "").trim();
  const decision = String(opts.decision || "").toLowerCase();
  const decidedBy = String(opts.decided_by || "operator").slice(0, 200);
  if (!candidateId) return { ok: false, error: "candidate_id_required" };
  if (!["approve", "decline"].includes(decision)) return { ok: false, error: "decision_must_be_approve_or_decline" };
  const finalStatus = decision === "approve" ? "approved" : "declined";
  const now = Date.now();
  try {
    const r = await db.prepare(`
      UPDATE discovery_promotion_queue
         SET status = ?2, decided_by = ?3, decided_at = ?4, updated_at = ?4
       WHERE candidate_id = ?1
    `).bind(candidateId, finalStatus, decidedBy, now).run();
    const changes = r?.meta?.changes ?? 0;
    if (changes === 0) return { ok: false, error: "candidate_not_found" };
    return { ok: true, candidate_id: candidateId, status: finalStatus, decided_by: decidedBy, decided_at: now };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}
