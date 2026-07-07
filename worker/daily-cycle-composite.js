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
  indexCyclesFromRegimes,
  breadthAwareMarketCycle,
  resolveTickerCycle,
} from "./market-regime-index.js";
import { SECTOR_ETF_MAP, getSector } from "./sector-mapping.js";

export const DAILY_CYCLE_KV_KEY = "timed:daily_cycle_composite";
export const DAILY_CYCLE_KV_TTL_SEC = 300;

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

async function loadIndexRegimes(env) {
  const KV = env?.KV_TIMED;
  const out = {};
  if (!KV) return out;
  await Promise.all(CYCLE_INDEXES.map(async (idx) => {
    try {
      const d = await kvGetJSON(KV, `timed:latest:${idx}`);
      if (d && (d.regime_class || d.ema_regime_daily != null || d.htf_score != null)) {
        out[idx] = {
          ema_regime_daily: d.ema_regime_daily ?? 0,
          htf_score: d.htf_score ?? null,
          regime_class: d.regime_class || null,
          saty_phase_pct: d.saty_phase_pct ?? d.phase_pct ?? null,
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

/**
 * Build the cross-sector Daily Cycle Composite snapshot.
 */
export async function buildDailyCycleComposite(env, opts = {}) {
  const regimesByIndex = await loadIndexRegimes(env);
  const cyclesByIndex = indexCyclesFromRegimes(regimesByIndex);
  const breadthCycle = breadthAwareMarketCycle(cyclesByIndex);

  let tickerIndexMap = null;
  try {
    const im = await kvGetJSON(env?.KV_TIMED, "timed:ticker-index-map");
    tickerIndexMap = im?.map || null;
  } catch (_) {}

  const fsdRefs = await loadFsdCycleRefsFromDb(env, opts);
  const getSector = opts.getSectorForTicker || null;

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
  for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
    const etfReg = regimesByIndex[etf] || {};
    const home = resolveTickerCycle(etf, tickerIndexMap, cyclesByIndex, breadthCycle);
    const sectorFsd = fsdRefs.bySector[sector] || [];
    const fsdPhase = sectorFsd.length ? inferFsdCyclePhase(sectorFsd.flatMap((e) => e.refs)) : null;
    sectors.push({
      sector,
      etf,
      computed_cycle: home.cycle || cyclesByIndex[etf] || null,
      home_index: home.index,
      home_index_cycle: home.cycle,
      saty_phase_pct: etfReg.saty_phase_pct ?? null,
      fsd_refs: sectorFsd,
      fsd_phase: fsdPhase,
      alignment: cycleAlignment(home.cycle || cyclesByIndex[etf], fsdPhase),
    });
  }

  const tickers = {};
  const tickerList = opts.tickers || null;
  const wantTickers = Array.isArray(tickerList) && tickerList.length
    ? tickerList.map((t) => String(t).toUpperCase())
    : Object.keys(fsdRefs.byTicker).slice(0, 30);

  for (const sym of wantTickers) {
    const resolved = resolveTickerCycle(sym, tickerIndexMap, cyclesByIndex, breadthCycle);
    let snap = null;
    try {
      snap = await kvGetJSON(env?.KV_TIMED, `timed:latest:${sym}`);
    } catch (_) {}
    const fsdEntries = fsdRefs.byTicker[sym] || [];
    const fsdPhase = fsdEntries.length ? inferFsdCyclePhase(fsdEntries.flatMap((e) => e.refs)) : null;
    tickers[sym] = {
      computed: resolved,
      saty_phase_pct: snap?.saty_phase_pct ?? snap?.phase_pct ?? null,
      investor_score: snap?.investor_score ?? snap?.investorScore ?? null,
      sector: sectorForTicker(sym, getSector),
      fsd_refs: fsdEntries,
      fsd_phase: fsdPhase,
      alignment: cycleAlignment(resolved.cycle, fsdPhase),
    };
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    breadth_cycle: breadthCycle,
    indices,
    sectors,
    tickers,
    source: "daily-cycle-composite.v1",
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

  const built = await buildDailyCycleComposite(env, {
    ...opts,
    getSectorForTicker: opts.getSectorForTicker || getSector,
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
      await KV.put(DAILY_CYCLE_KV_KEY, JSON.stringify(built), { expirationTtl: DAILY_CYCLE_KV_TTL_SEC * 2 });
    } catch (_) {}
  }
  return built;
}
