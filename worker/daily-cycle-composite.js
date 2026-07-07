// worker/daily-cycle-composite.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily Cycle Composite — cross-sector view joining:
//   (1) computed breadth/index cycles (market-regime-index.js)
//   (2) Saty phase + investor score from live snapshots
//   (3) FSD cycle references extracted from publication rewrites + text
// ─────────────────────────────────────────────────────────────────────────────

import { kvGetJSON } from "./storage.js";
import {
  CYCLE_INDEXES,
  cycleFromRegime,
  indexCyclesFromRegimes,
  breadthAwareMarketCycle,
  resolveTickerCycle,
} from "./market-regime-index.js";
import { SECTOR_ETF_MAP, getSector } from "./sector-mapping.js";

export const DAILY_CYCLE_KV_KEY = "timed:daily_cycle_composite";
export const DAILY_CYCLE_PREV_KV_KEY = "timed:daily_cycle_composite:prev";
export const DAILY_CYCLE_KV_TTL_SEC = 300;
/** Legacy pinned names — still surfaced when IT/semi cycle is stressed. */
export const CYCLE_SPOTLIGHT_TICKERS = ["SMH", "NVDA"];

const CARTER_OFFENSE_ETFS = ["XLK", "XLY", "XLI"];
const CARTER_DEFENSE_ETFS = ["XLU", "XLP", "XLV"];

/** Representative industry leaders per GICS sector for dynamic watch rows. */
export const SECTOR_WATCH_CONFIG = {
  "Information Technology": { industryEtf: "SMH", leaders: ["NVDA", "AMD", "AVGO"] },
  "Financials": { leaders: ["JPM", "GS", "BAC"] },
  "Energy": { leaders: ["XOM", "CVX", "SLB"] },
  "Industrials": { leaders: ["CAT", "GE", "RTX"] },
  "Health Care": { leaders: ["LLY", "UNH", "ABBV"] },
  Healthcare: { leaders: ["LLY", "UNH", "ABBV"] },
  "Consumer Discretionary": { leaders: ["AMZN", "TSLA", "HD"] },
  "Communication Services": { leaders: ["META", "GOOGL", "NFLX"] },
  "Consumer Staples": { leaders: ["WMT", "COST", "PG"] },
  "Utilities": { leaders: ["NEE", "DUK"] },
  "Real Estate": { leaders: ["PLD", "AMT"] },
  "Basic Materials": { leaders: ["LIN", "FCX", "NEM"] },
};

function pctFromSnapshot(d = {}) {
  for (const key of ["day_change_pct", "change_pct", "dp", "percent_change"]) {
    const n = Number(d[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Human label for a sector watch row — IT keeps the Semis / AI desk name. */
export function sectorWatchLabel(sector, config = {}) {
  if (sector === "Information Technology" && config.industryEtf) return "Semis / AI leaders";
  const name = String(sector || "")
    .replace(/^Basic /, "")
    .replace(/ Sector$/i, "");
  return `${name} leaders`;
}

/** Coarse cyclical phase from Saty phase % + phase zone (quarter/year style). */
export function inferCyclicalPhaseLabel(satyPhasePct, phaseZone) {
  const zone = String(phaseZone || "").toLowerCase();
  if (zone === "accumulation") return "early cycle";
  if (zone === "markup") return "mid cycle";
  if (zone === "distribution") return "late cycle / peak";
  if (zone === "markdown") return "down cycle";
  if (zone === "recovery") return "recovery";
  const raw = Number(satyPhasePct);
  if (!Number.isFinite(raw)) return null;
  const pct = raw <= 1 ? raw * 100 : raw;
  if (pct < 25) return "early cycle";
  if (pct < 50) return "mid cycle";
  if (pct < 75) return "late cycle";
  return "peak zone";
}

/** Score how much a sector deserves a dedicated leaders row. */
export function scoreSectorForWatch(sectorRow, breadthCycle) {
  let score = 0;
  const reasons = [];
  const c = sectorRow?.computed_cycle;
  const b = breadthCycle;
  if (c && b && c !== b) {
    score += 3;
    reasons.push("vs_market");
  }
  if (sectorRow?.alignment === "divergent") {
    score += 2;
    reasons.push("desk_divergence");
  }
  if ((c === "downtrend" && b === "uptrend") || (c === "uptrend" && b === "downtrend")) {
    score += 2;
    if (!reasons.includes("vs_market")) reasons.push("vs_market");
  }
  if (sectorRow?.own_cycle && sectorRow?.home_index_cycle && sectorRow.own_cycle !== sectorRow.home_index_cycle) {
    score += 1;
    reasons.push("own_regime");
  }
  return { score, reason: reasons[0] || "rotation" };
}

/** Pick up to N sector watch groups — shifts, vs-market divergence, desk mismatch. */
export function selectSectorWatchGroups(sectors, breadthCycle, transitionEtfs = new Set(), opts = {}) {
  const maxGroups = opts.maxGroups || 3;
  const minScore = opts.minScore || 2;
  const scored = (sectors || []).map((s) => {
    const { score, reason } = scoreSectorForWatch(s, breadthCycle);
    let finalScore = score;
    let finalReason = reason;
    if (transitionEtfs.has(s.etf)) {
      finalScore += 4;
      finalReason = "cycle_shift";
    }
    if (s.sector === "Information Technology" && s.computed_cycle === "downtrend") {
      finalScore += 2;
      if (finalReason === "rotation") finalReason = "pinned";
    }
    return { sectorRow: s, score: finalScore, reason: finalReason };
  }).filter((x) => x.score >= minScore || x.reason === "cycle_shift");

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, maxGroups);

  if (picked.length === 0) {
    const it = (sectors || []).find((s) => s.sector === "Information Technology" || s.etf === "XLK");
    if (it) picked.push({ sectorRow: it, score: 1, reason: "pinned" });
  }
  return picked;
}

/** Intraday sector rotation snapshot from the 11 GICS sector ETFs. */
export function buildSectorRotationSnapshot(sectors = []) {
  const rows = (sectors || [])
    .map((s) => ({
      etf: s.etf,
      sector: s.sector,
      day_pct: s.day_change_pct,
      computed_cycle: s.computed_cycle,
    }))
    .filter((s) => s.etf && Number.isFinite(s.day_pct));
  rows.sort((a, b) => b.day_pct - a.day_pct);
  const gainers = rows.slice(0, 2);
  const losers = rows.slice(-2).reverse();

  const byEtf = Object.fromEntries(rows.map((r) => [r.etf, r]));
  const offenseVals = CARTER_OFFENSE_ETFS.map((e) => byEtf[e]?.day_pct).filter((n) => Number.isFinite(n));
  const defenseVals = CARTER_DEFENSE_ETFS.map((e) => byEtf[e]?.day_pct).filter((n) => Number.isFinite(n));
  const avg = (arr) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null);
  const offenseAvg = avg(offenseVals);
  const defenseAvg = avg(defenseVals);

  let state = "unknown";
  if (Number.isFinite(offenseAvg) && Number.isFinite(defenseAvg)) {
    const spread = offenseAvg - defenseAvg;
    if (spread >= 0.25) state = "risk_on";
    else if (spread <= -0.25) state = "risk_off";
    else state = "balanced";
  }

  return {
    state,
    offense_avg_pct: offenseAvg,
    defense_avg_pct: defenseAvg,
    offense_etfs: CARTER_OFFENSE_ETFS,
    defense_etfs: CARTER_DEFENSE_ETFS,
    gainers,
    losers,
  };
}

const CYCLE_TEXT_PATTERNS = [
  { re: /daily\s+cycle\s+composite/gi, kind: "daily_cycle_composite" },
  { re: /\b(early|mid|late|transitional)\s+cycle\b/gi, kind: "cycle_phase" },
  { re: /cycle\s+(?:is\s+)?(?:at\s+)?(?:a\s+)?(low|high|bottom|top|turn(?:ing)?)/gi, kind: "cycle_inflection" },
  { re: /(?:in|at|near|approaching)\s+(?:a\s+)?cycle\s+(low|high|bottom|top)/gi, kind: "cycle_position" },
];

const PHASE_WORDS = new Set(["early", "mid", "late", "transitional"]);

/** Extract cycle phrases from FSD publication prose. */
export function extractCycleReferencesFromText(text, opts = {}) {
  const src = String(text || "");
  if (!src.trim()) return [];
  const tickerHint = opts.ticker ? String(opts.ticker).toUpperCase() : null;
  const out = [];
  const seen = new Set();
  for (const pat of CYCLE_TEXT_PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(src)) !== null) {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(src.length, m.index + m[0].length + 60);
      const phrase = src.slice(start, end).replace(/\s+/g, " ").trim();
      const key = `${pat.kind}:${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: pat.kind,
        phrase,
        ticker: tickerHint,
        match: m[0].trim(),
      });
    }
  }
  return out.slice(0, 8);
}

/** Pull cycle-ish notes from FSD rewriter key points (macro/thesis). */
export function extractCycleReferencesFromKeyPoints(keyPoints = [], ticker = null) {
  if (!Array.isArray(keyPoints)) return [];
  const sym = ticker ? String(ticker).toUpperCase() : null;
  const out = [];
  for (const kp of keyPoints) {
    if (!kp || typeof kp !== "object") continue;
    const note = String(kp.note || "");
    const kind = String(kp.kind || "").toLowerCase();
    if (!note && kind !== "macro" && kind !== "thesis") continue;
    const blob = `${note} ${kp.level || ""}`;
    if (!/cycle/i.test(blob) && kind !== "macro") continue;
    if (sym && kp.ticker && String(kp.ticker).toUpperCase() !== sym) continue;
    out.push({
      kind: "key_point",
      phrase: note.slice(0, 160) || kind,
      ticker: kp.ticker ? String(kp.ticker).toUpperCase() : sym,
      direction: kp.direction || null,
      horizon: kp.horizon || null,
    });
  }
  return out.slice(0, 6);
}

/** Infer a coarse FSD cycle phase label from extracted references. */
export function inferFsdCyclePhase(refs = []) {
  const blob = refs.map((r) => `${r.phrase || ""} ${r.match || ""}`).join(" ").toLowerCase();
  if (/\bearly\s+cycle\b/.test(blob) || /\bcycle\s+(low|bottom)\b/.test(blob)) return "early";
  if (/\blate\s+cycle\b/.test(blob) || /\bcycle\s+(high|top)\b/.test(blob)) return "late";
  if (/\bmid\s+cycle\b/.test(blob)) return "mid";
  if (/\btransitional\s+cycle\b/.test(blob) || /\bcycle\s+turn/.test(blob)) return "transitional";
  for (const w of PHASE_WORDS) {
    if (blob.includes(`${w} cycle`)) return w;
  }
  return null;
}

/** Map computed cycle + FSD phase into a simple alignment label. */
export function cycleAlignment(computedCycle, fsdPhase) {
  if (!computedCycle && !fsdPhase) return "none";
  if (!fsdPhase) return "computed_only";
  if (!computedCycle) return "fsd_only";
  const bullishComputed = computedCycle === "uptrend";
  const bearishComputed = computedCycle === "downtrend";
  const bullishFsd = fsdPhase === "early" || fsdPhase === "mid";
  const bearishFsd = fsdPhase === "late";
  const neutralFsd = fsdPhase === "transitional";
  if (neutralFsd && computedCycle === "transitional") return "aligned";
  if (bullishFsd && bullishComputed) return "aligned";
  if (bearishFsd && bearishComputed) return "aligned";
  if (bullishFsd && bearishComputed) return "divergent";
  if (bearishFsd && bullishComputed) return "divergent";
  return "mixed";
}

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

async function loadIndexRegimes(env, extraSymbols = []) {
  const KV = env?.KV_TIMED;
  const out = {};
  if (!KV) return out;
  const symbols = [...new Set([...CYCLE_INDEXES, ...extraSymbols])];
  await Promise.all(symbols.map(async (idx) => {
    try {
      const d = await kvGetJSON(KV, `timed:latest:${idx}`);
      if (d && (d.regime_class || d.ema_regime_daily != null || d.htf_score != null)) {
        out[idx] = {
          ema_regime_daily: d.ema_regime_daily ?? 0,
          htf_score: d.htf_score ?? null,
          regime_class: d.regime_class || null,
          saty_phase_pct: d.saty_phase_pct ?? d.phase_pct ?? null,
          phase_zone: d.phase_zone ?? null,
          day_change_pct: pctFromSnapshot(d),
        };
      }
    } catch (_) {}
  }));
  return out;
}

async function loadFsdCycleRefsFromDb(env, { lookbackDays = 14, limit = 40 } = {}) {
  const db = env?.DB;
  if (!db) return { byTicker: {}, bySector: {} };
  const since = Date.now() - lookbackDays * 86400000;
  try {
    const rows = (await db.prepare(`
      SELECT r.pub_id, r.tt_key_points_json, p.title, p.published_at, p.fetched_at,
             pt.ticker AS tagged_ticker
        FROM cro_publication_rewrites r
        JOIN cro_publications p ON p.pub_id = r.pub_id
        LEFT JOIN cro_publication_tickers pt ON pt.pub_id = r.pub_id
       WHERE COALESCE(p.published_at, p.fetched_at) >= ?1
       ORDER BY COALESCE(p.published_at, p.fetched_at) DESC
       LIMIT ?2
    `).bind(since, limit * 3).all())?.results || [];

    const byTicker = {};
    const bySector = {};
    const seenPub = new Set();

    for (const row of rows) {
      const pubId = row.pub_id;
      const tagged = row.tagged_ticker ? String(row.tagged_ticker).toUpperCase() : null;
      const title = String(row.title || "");
      const keyPoints = safeJson(row.tt_key_points_json) || [];
      const publishedAt = Number(row.published_at) || Number(row.fetched_at) || null;

      const textRefs = extractCycleReferencesFromText(title, { ticker: tagged });
      const kpRefs = extractCycleReferencesFromKeyPoints(keyPoints, tagged);
      const refs = [...textRefs, ...kpRefs];
      if (refs.length === 0) continue;

      const entry = {
        pub_id: pubId,
        published_at: publishedAt,
        refs,
        fsd_phase: inferFsdCyclePhase(refs),
      };

      if (tagged) {
        if (!byTicker[tagged]) byTicker[tagged] = [];
        if (byTicker[tagged].length < 4) byTicker[tagged].push(entry);
      }

      const pubKey = `${pubId}:${tagged || "macro"}`;
      if (seenPub.has(pubKey)) continue;
      seenPub.add(pubKey);

      // Sector tagging via sector ETF map inverse lookup happens at merge time.
      if (refs.some((r) => /semi|technology|xlk|smh|nvda|memory/i.test(r.phrase || ""))) {
        const sec = "Information Technology";
        if (!bySector[sec]) bySector[sec] = [];
        if (bySector[sec].length < 4) bySector[sec].push(entry);
      }
    }
    return { byTicker, bySector };
  } catch (_) {
    return { byTicker: {}, bySector: {} };
  }
}

function sectorForTicker(ticker, sectorMapFn) {
  try {
    if (typeof sectorMapFn === "function") return sectorMapFn(ticker) || null;
  } catch (_) {}
  return null;
}

/** Resolve computed cycle for a symbol — prefer its own EMA/HTF regime, else home index. */
export function resolveComputedCycle(sym, regimesBySymbol, tickerIndexMap, cyclesByIndex, breadthCycle) {
  const reg = regimesBySymbol[sym] || {};
  const ownCycle = cycleFromRegime(reg.ema_regime_daily, reg.htf_score);
  const home = resolveTickerCycle(sym, tickerIndexMap, cyclesByIndex, breadthCycle);
  const computed = ownCycle || home.cycle || cyclesByIndex[sym] || null;
  return {
    computed_cycle: computed,
    own_cycle: ownCycle,
    home_index: home.index,
    home_index_cycle: home.cycle,
    cycle_source: ownCycle ? "own_regime" : (home.source === "home_index" ? "home_index" : "breadth"),
    saty_phase_pct: reg.saty_phase_pct ?? null,
    ema_regime_daily: reg.ema_regime_daily ?? null,
    htf_score: reg.htf_score ?? null,
  };
}

/** Breadth mix across benchmark indices for the banner row. */
export function summarizeIndexMix(cyclesByIndex = {}) {
  const mix = { uptrend: 0, downtrend: 0, transitional: 0 };
  for (const idx of CYCLE_INDEXES) {
    const c = cyclesByIndex[idx];
    if (c && mix[c] != null) mix[c] += 1;
  }
  return mix;
}

/** Detect cycle label changes vs the prior composite snapshot. */
export function detectCycleTransitions(prev, built) {
  if (!prev || !built) return [];
  const out = [];
  const push = (scope, symbol, from, to) => {
    if (!from || !to || from === to) return;
    out.push({ scope, symbol, from, to, at: built.generated_at });
  };
  push("market", "MARKET", prev.breadth_cycle, built.breadth_cycle);
  const prevSectors = {};
  (prev.sectors || []).forEach((s) => { if (s.etf) prevSectors[s.etf] = s; });
  (built.sectors || []).forEach((s) => {
    const p = prevSectors[s.etf];
    if (p) push("sector", s.etf, p.computed_cycle, s.computed_cycle);
  });
  const prevSpot = {};
  (prev.spotlights || []).forEach((s) => { if (s.symbol) prevSpot[s.symbol] = s; });
  (built.spotlights || []).forEach((s) => {
    const p = prevSpot[s.symbol];
    if (p) push("spotlight", s.symbol, p.computed_cycle, s.computed_cycle);
  });
  for (const grp of built.sector_watch || []) {
    for (const t of grp.tickers || []) {
      const p = prevSpot[t.symbol];
      if (p) push("leader", t.symbol, p.computed_cycle, t.computed_cycle);
    }
  }
  return out;
}

async function maybeAlertCycleTransitions(env, transitions = []) {
  if (!transitions.length) return;
  try {
    const { notifyDiscord } = await import("./alerts.js");
    const lines = transitions.slice(0, 8).map((t) =>
      `**${t.symbol}** (${t.scope}): ${t.from} → **${t.to}**`,
    );
    await notifyDiscord(env, {
      title: "Daily Cycle Composite — cycle transition",
      description: lines.join("\n"),
      color: transitions.some((t) => t.to === "downtrend") ? 0xef4444 : 0x22c55e,
      footer: { text: "Computed from EMA regime + HTF score · refreshes each scoring cycle" },
    }, "system");
  } catch (_) { /* best-effort */ }
}

/**
 * Build the cross-sector Daily Cycle Composite snapshot.
 */
export async function buildDailyCycleComposite(env, opts = {}) {
  const sectorEtfs = [...new Set(Object.values(SECTOR_ETF_MAP))];
  const regimeSymbols = [...new Set([...sectorEtfs, ...CYCLE_SPOTLIGHT_TICKERS])];
  const regimesByIndex = await loadIndexRegimes(env, regimeSymbols);
  const cyclesByIndex = indexCyclesFromRegimes(regimesByIndex);
  const breadthCycle = breadthAwareMarketCycle(cyclesByIndex);
  const indexMix = summarizeIndexMix(cyclesByIndex);

  let tickerIndexMap = null;
  try {
    const im = await kvGetJSON(env?.KV_TIMED, "timed:ticker-index-map");
    tickerIndexMap = im?.map || null;
  } catch (_) {}

  const fsdRefs = await loadFsdCycleRefsFromDb(env, opts);
  const getSectorFn = opts.getSectorForTicker || null;

  const indices = {};
  for (const idx of CYCLE_INDEXES) {
    const reg = regimesByIndex[idx];
    if (!reg && !cyclesByIndex[idx]) continue;
    indices[idx] = {
      cycle: cyclesByIndex[idx] || null,
      ema_regime_daily: reg?.ema_regime_daily ?? null,
      htf_score: reg?.htf_score ?? null,
      regime_class: reg?.regime_class || null,
      saty_phase_pct: reg?.saty_phase_pct ?? null,
    };
  }

  const sectors = [];
  const seenEtf = new Set();
  for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
    if (seenEtf.has(etf)) continue;
    seenEtf.add(etf);
    const resolved = resolveComputedCycle(etf, regimesByIndex, tickerIndexMap, cyclesByIndex, breadthCycle);
    const sectorFsd = fsdRefs.bySector[sector] || [];
    const fsdPhase = sectorFsd.length ? inferFsdCyclePhase(sectorFsd.flatMap((e) => e.refs)) : null;
    const etfReg = regimesByIndex[etf] || {};
    sectors.push({
      sector,
      etf,
      computed_cycle: resolved.computed_cycle,
      own_cycle: resolved.own_cycle,
      cycle_source: resolved.cycle_source,
      home_index: resolved.home_index,
      home_index_cycle: resolved.home_index_cycle,
      saty_phase_pct: resolved.saty_phase_pct,
      cyclical_phase: inferCyclicalPhaseLabel(resolved.saty_phase_pct, etfReg.phase_zone),
      day_change_pct: etfReg.day_change_pct ?? null,
      ema_regime_daily: resolved.ema_regime_daily,
      htf_score: resolved.htf_score,
      fsd_refs: sectorFsd,
      fsd_phase: fsdPhase,
      alignment: cycleAlignment(resolved.computed_cycle, fsdPhase),
    });
  }

  const sectorRotation = buildSectorRotationSnapshot(sectors);
  const transitionEtfs = new Set(
    (opts.transitionEtfs || []).map((e) => String(e).toUpperCase()),
  );
  if (Array.isArray(opts.prevSectors)) {
    const prevMap = Object.fromEntries(
      opts.prevSectors.filter((s) => s?.etf).map((s) => [String(s.etf).toUpperCase(), s.computed_cycle]),
    );
    for (const s of sectors) {
      const etf = String(s.etf || "").toUpperCase();
      const prevCycle = prevMap[etf];
      if (prevCycle && prevCycle !== s.computed_cycle) transitionEtfs.add(etf);
    }
  }
  const watchPicks = selectSectorWatchGroups(sectors, breadthCycle, transitionEtfs, opts);
  const sectorWatch = [];
  const spotlights = [];

  async function pushWatchTicker(sym, role, groupTickers) {
    const resolved = resolveComputedCycle(sym, regimesByIndex, tickerIndexMap, cyclesByIndex, breadthCycle);
    const fsdEntries = fsdRefs.byTicker[sym] || [];
    const fsdPhase = fsdEntries.length ? inferFsdCyclePhase(fsdEntries.flatMap((e) => e.refs)) : null;
    let snap = null;
    try {
      snap = await kvGetJSON(env?.KV_TIMED, `timed:latest:${sym}`);
    } catch (_) {}
    const saty = resolved.saty_phase_pct ?? snap?.saty_phase_pct ?? snap?.phase_pct ?? null;
    const entry = {
      symbol: sym,
      role,
      computed_cycle: resolved.computed_cycle,
      own_cycle: resolved.own_cycle,
      cycle_source: resolved.cycle_source,
      home_index: resolved.home_index,
      saty_phase_pct: saty,
      phase_zone: snap?.phase_zone ?? null,
      cyclical_phase: inferCyclicalPhaseLabel(saty, snap?.phase_zone),
      fsd_phase: fsdPhase,
      fsd_refs: fsdEntries.slice(0, 2),
      alignment: cycleAlignment(resolved.computed_cycle, fsdPhase),
    };
    groupTickers.push(entry);
    spotlights.push({ ...entry, label: sym });
  }

  for (const pick of watchPicks) {
    const row = pick.sectorRow;
    const cfg = SECTOR_WATCH_CONFIG[row.sector] || SECTOR_WATCH_CONFIG[row.sector?.replace(/healthcare/i, "Health Care")] || {};
    const tickers = [];
    const symbols = [];
    if (cfg.industryEtf) symbols.push(cfg.industryEtf);
    symbols.push(row.etf);
    for (const leader of (cfg.leaders || []).slice(0, 2)) symbols.push(leader);
    const seen = new Set();
    for (const sym of symbols) {
      const s = String(sym || "").toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      const role = s === cfg.industryEtf ? "industry_etf" : (s === row.etf ? "sector_etf" : "leader");
      await pushWatchTicker(s, role, tickers);
    }
    sectorWatch.push({
      sector: row.sector,
      etf: row.etf,
      label: sectorWatchLabel(row.sector, cfg),
      reason: pick.reason,
      sector_cycle: row.computed_cycle,
      cyclical_phase: row.cyclical_phase,
      alignment: row.alignment,
      tickers,
    });
  }

  const tickers = {};
  const tickerList = opts.tickers || null;
  const wantTickers = Array.isArray(tickerList) && tickerList.length
    ? tickerList.map((t) => String(t).toUpperCase())
    : Object.keys(fsdRefs.byTicker).slice(0, 30);

  for (const sym of wantTickers) {
    const resolved = resolveComputedCycle(sym, regimesByIndex, tickerIndexMap, cyclesByIndex, breadthCycle);
    let snap = null;
    try {
      snap = await kvGetJSON(env?.KV_TIMED, `timed:latest:${sym}`);
    } catch (_) {}
    const fsdEntries = fsdRefs.byTicker[sym] || [];
    const fsdPhase = fsdEntries.length ? inferFsdCyclePhase(fsdEntries.flatMap((e) => e.refs)) : null;
    tickers[sym] = {
      computed: {
        cycle: resolved.computed_cycle,
        index: resolved.home_index,
        source: resolved.cycle_source,
        own_cycle: resolved.own_cycle,
      },
      saty_phase_pct: snap?.saty_phase_pct ?? snap?.phase_pct ?? null,
      investor_score: snap?.investor_score ?? snap?.investorScore ?? null,
      sector: sectorForTicker(sym, getSectorFn),
      fsd_refs: fsdEntries,
      fsd_phase: fsdPhase,
      alignment: cycleAlignment(resolved.computed_cycle, fsdPhase),
    };
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    breadth_cycle: breadthCycle,
    index_mix: indexMix,
    indices,
    sectors,
    sector_watch: sectorWatch,
    sector_rotation: sectorRotation,
    spotlights,
    tickers,
    source: "daily-cycle-composite.v3",
  };
}

/** Read cached composite or rebuild when stale/missing. */
export async function getDailyCycleComposite(env, opts = {}) {
  const KV = env?.KV_TIMED;
  const force = opts.force === true;
  if (KV && !force) {
    try {
      const cached = await kvGetJSON(KV, DAILY_CYCLE_KV_KEY);
      if (cached?.ok && cached.generated_at) {
        const ageMs = Date.now() - Date.parse(cached.generated_at);
        if (Number.isFinite(ageMs) && ageMs < DAILY_CYCLE_KV_TTL_SEC * 1000) {
          if (opts.ticker) {
            const sym = String(opts.ticker).toUpperCase();
            return {
              ...cached,
              ticker: sym,
              ticker_view: cached.tickers?.[sym] || null,
            };
          }
          return cached;
        }
      }
    } catch (_) {}
  }

  let prevForTransitions = null;
  if (KV) {
    try { prevForTransitions = await kvGetJSON(KV, DAILY_CYCLE_PREV_KV_KEY); } catch (_) {}
  }

  const built = await buildDailyCycleComposite(env, {
    ...opts,
    getSectorForTicker: opts.getSectorForTicker || getSector,
    prevSectors: prevForTransitions?.sectors || null,
  });

  if (opts.ticker) {
    const sym = String(opts.ticker).toUpperCase();
    if (!built.tickers[sym]) {
      built.tickers[sym] = (await buildDailyCycleComposite(env, {
        ...opts,
        tickers: [sym],
        getSectorForTicker: opts.getSectorForTicker || getSector,
      })).tickers[sym] || null;
    }
    built.ticker = sym;
    built.ticker_view = built.tickers[sym] || null;
  }

  if (KV) {
    try {
      const prev = prevForTransitions || await kvGetJSON(KV, DAILY_CYCLE_PREV_KV_KEY);
      built.transitions = detectCycleTransitions(prev, built);
      if (built.transitions.length > 0 && !opts.skipAlerts) {
        await maybeAlertCycleTransitions(env, built.transitions);
      }
      await KV.put(DAILY_CYCLE_PREV_KV_KEY, JSON.stringify({
        generated_at: built.generated_at,
        breadth_cycle: built.breadth_cycle,
        sectors: (built.sectors || []).map((s) => ({ etf: s.etf, computed_cycle: s.computed_cycle })),
        spotlights: (built.spotlights || []).map((s) => ({ symbol: s.symbol, computed_cycle: s.computed_cycle })),
        sector_watch: (built.sector_watch || []).map((g) => ({ etf: g.etf, sector_cycle: g.sector_cycle })),
      }), { expirationTtl: 86400 * 7 });
      await KV.put(DAILY_CYCLE_KV_KEY, JSON.stringify(built), { expirationTtl: DAILY_CYCLE_KV_TTL_SEC * 2 });
    } catch (_) {}
  }
  return built;
}
