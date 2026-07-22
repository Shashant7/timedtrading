/* shared-rail-helpers.js
 *
 * Helpers required by `TickerDetailRightRailFactory` (shared-right-rail.js)
 * that are NOT already exposed via:
 *   - window.TimedPriceUtils      (shared-price-utils.js)
 *   - window.TimedBubbleChart     (shared-bubble-chart.js)
 *
 * These are ported verbatim from /react-app/index-react.source.html so the
 * journey pages (today / active-trader / investor / portfolio) get the
 * SAME logic and SAME labels the Active Trader dashboard uses. No stubs.
 *
 * Exposes on window.TimedRailHelpers:
 *   - getTickerSector(ticker)            (line 2699 of source)
 *   - normalizeSectorKey(sectorName)     (line 2904)
 *   - sectorKeyToCanonicalName(key)      (line 2942)
 *   - GROUPS / GROUP_LABELS / GROUP_ORDER
 *   - groupsForTicker(t)                 (line 3034)
 *   - getQuadrantFromState(state)        (line 16779)
 *   - detectPatterns(trail, flags)       (line 16792)
 *   - normalizeTrailPoints(trail)        (line 1261)
 *   - downsampleByInterval(points, ms)   (line 4301)
 *   - computeHorizonBucket(src)          (line 3899)
 *   - computeTpMaxPrice(ticker)          (line 3507)
 *   - computeTpTargetPrice(ticker)       (line 3544)
 *   - getDirection(ticker)               (line 7840)
 *   - getProtectionStageInfo(...)        (line 8011)
 *   - getTradeLifecycleState(...)        (line 8036)
 *   - getActionDescription(ticker, tr)   (line 8093)
 *   - TRADE_SIZE / FUTURES_SPECS
 *   - loadETFGroups()                    (line 2983)
 *
 * This module is self-contained — it depends only on window.TimedPriceUtils
 * and window.TimedBubbleChart, which must be loaded BEFORE this file.
 */
(function () {
  if (typeof window === "undefined") return;

  const TT = () => window.TimedBubbleChart || {};
  const numFromAny = (TT().numFromAny) || function (v) {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const s = v.trim(); if (!s) return null;
      const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]); return Number.isFinite(n) ? n : null;
    }
    if (typeof v === "object" && v.price != null) return numFromAny(v.price);
    return null;
  };
  const computeEntryRef = (TT().computeEntryRef) || function (ticker) {
    const er = numFromAny(ticker?.entry_ref);
    if (Number.isFinite(er) && er > 0) return er;
    const tr = numFromAny(ticker?.trigger_price);
    if (Number.isFinite(tr) && tr > 0) return tr;
    const px = numFromAny(ticker?.price ?? ticker?.close ?? ticker?.c ?? ticker?.last);
    return Number.isFinite(px) && px > 0 ? px : null;
  };
  const getDirectionFromState = (TT().getDirectionFromState) || function (ticker) {
    const s = String(ticker?.state || "");
    if (s.startsWith("HTF_BULL")) return "LONG";
    if (s.startsWith("HTF_BEAR")) return "SHORT";
    if (s.includes("BULL")) return "LONG";
    if (s.includes("BEAR")) return "SHORT";
    return null;
  };
  const completionForSize = (TT().completionForSize) || function (ticker) {
    const c = Number(ticker?.completion);
    return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
  };
  const computeEtaDays = (TT().computeEtaDays) || function () { return null; };
  const isPrimeBubble = (TT().isPrimeBubble) || function () { return false; };
  const entryType = (TT().entryType) || function () { return { corridor: false, side: null }; };

  // ── TRADE_SIZE + FUTURES_SPECS (verbatim from index-react.source.html:1241) ──
  const TRADE_SIZE = 1000;
  const FUTURES_SPECS = {
    "ES1!": { pointValue: 50,        name: "E-mini S&P 500" },
    "NQ1!": { pointValue: 20,        name: "E-mini Nasdaq-100" },
    "YM1!": { pointValue: 5,         name: "E-mini Dow" },
    "RTY1!":{ pointValue: 50,        name: "E-mini Russell 2000" },
    "CL1!": { pointValue: 1000,      name: "Crude Oil" },
    "GC1!": { pointValue: 100,       name: "Gold" },
    "SI1!": { pointValue: 5000,      name: "Silver" },
    "ZB1!": { pointValue: 1000,      name: "30-Year Treasury Bond" },
    "ZN1!": { pointValue: 1000,      name: "10-Year Treasury Note" },
    "6E1!": { pointValue: 125000,    name: "Euro FX" },
    "6J1!": { pointValue: 12500000,  name: "Japanese Yen" },
  };

  // ── normalizeTrailPoints (verbatim from line 1261) ──
  function normalizeTrailPoints(trail) {
    if (!Array.isArray(trail)) return [];
    return trail
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const ltf = p.ltf_score ?? p.ltfScore ?? p.ltf ?? p.x ?? p.ltf_value ?? p.ltfValue ?? p.ltf_score_value;
        const htf = p.htf_score ?? p.htfScore ?? p.htf ?? p.y ?? p.htf_value ?? p.htfValue ?? p.htf_score_value;
        const phase = p.saty_phase_pct ?? p.phase_pct ?? p.phasePct ?? p.phase ?? p.phase_completion ?? p.phaseCompletion;
        const completion = p.completion ?? p.comp ?? p.completion_pct ?? p.completionPct;
        return {
          ...p,
          ltf_score: Number.isFinite(Number(ltf)) ? Number(ltf) : 0,
          htf_score: Number.isFinite(Number(htf)) ? Number(htf) : 0,
          phase_pct: Number.isFinite(Number(phase))
            ? Math.max(0, Math.min(1, Number(phase)))
            : Number.isFinite(Number(p.phase_pct)) ? Number(p.phase_pct) : 0,
          completion: Number.isFinite(Number(completion))
            ? Math.max(0, Math.min(1, Number(completion)))
            : Number.isFinite(Number(p.completion)) ? Number(p.completion) : 0,
        };
      })
      .filter(Boolean);
  }

  // ── downsampleByInterval (verbatim from line 4301) ──
  function downsampleByInterval(points, intervalMs) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const buckets = new Map();
    points.forEach((p) => {
      const tsRaw = p.__ts_ms ?? p.ts ?? p.ingest_ts ?? p.ingest_time;
      const ts = typeof tsRaw === "string" ? new Date(tsRaw).getTime() : Number(tsRaw);
      if (!Number.isFinite(ts)) return;
      const bucket = Math.floor(ts / intervalMs) * intervalMs;
      const prev = buckets.get(bucket);
      if (!prev || ts > prev.__ts_ms) {
        buckets.set(bucket, { ...p, __ts_ms: ts, __bucket: bucket });
      }
    });
    return Array.from(buckets.values()).sort((a, b) => a.__ts_ms - b.__ts_ms);
  }

  // ── getQuadrantFromState (verbatim from line 16779) ──
  function getQuadrantFromState(state) {
    if (state === "HTF_BULL_LTF_PULLBACK") return { q: 1, name: "Q1", label: "Bull Setup", color: "blue" };
    if (state === "HTF_BULL_LTF_BULL")     return { q: 2, name: "Q2", label: "Bull Momentum", color: "green" };
    if (state === "HTF_BEAR_LTF_BEAR")     return { q: 3, name: "Q3", label: "Bear Momentum", color: "red" };
    if (state === "HTF_BEAR_LTF_PULLBACK") return { q: 4, name: "Q4", label: "Bear Setup", color: "orange" };
    return null;
  }

  // ── detectPatterns (verbatim from line 16792) ──
  function detectPatterns(trail, flags) {
    if (!trail || trail.length < 2) return [];
    const patterns = [];
    const states = trail.map((p) => p.state).filter(Boolean);
    const safeFlags = flags || {};
    for (let i = 1; i < states.length; i++) {
      if (states[i - 1] === "HTF_BULL_LTF_PULLBACK" && states[i] === "HTF_BULL_LTF_BULL") {
        patterns.push({ type: "IDEAL_ENTRY", description: "Clean Q1→Q2 transition (Bull Entry)", quadrant: "Q1→Q2", timestamp: trail[i].ts, confidence: "HIGH" });
      }
      if (states[i - 1] === "HTF_BEAR_LTF_PULLBACK" && states[i] === "HTF_BEAR_LTF_BEAR") {
        patterns.push({ type: "IDEAL_ENTRY", description: "Clean Q4→Q3 transition (Bear Entry)", quadrant: "Q4→Q3", timestamp: trail[i].ts, confidence: "HIGH" });
      }
    }
    const currentState = states[states.length - 1];
    if ((currentState === "HTF_BULL_LTF_PULLBACK" || currentState === "HTF_BEAR_LTF_PULLBACK") && safeFlags.momentum_elite) {
      patterns.push({ type: "ELITE_SETUP", description: "Momentum Elite in Setup Quadrant", quadrant: getQuadrantFromState(currentState)?.name, confidence: "HIGH" });
    }
    const lastPoint = trail[trail.length - 1];
    if (lastPoint && lastPoint.flags && lastPoint.flags.sq30_release) {
      const q = getQuadrantFromState(lastPoint.state);
      if (q && (q.q === 1 || q.q === 4)) {
        patterns.push({ type: "SQUEEZE_SETUP", description: "Squeeze Release in Setup Quadrant", quadrant: q.name, confidence: "HIGH" });
      }
    }
    const uniqueQuads = new Set(states.map((s) => getQuadrantFromState(s)?.q).filter(Boolean));
    if (uniqueQuads.size > 2 && states.length > 5) {
      patterns.push({ type: "CHOPPY", description: "Multiple quadrant visits (choppy action)", confidence: "MEDIUM" });
    } else if (uniqueQuads.size === 1 && states.length >= 3) {
      patterns.push({ type: "STABLE", description: "Stable quadrant (consistent state)", quadrant: getQuadrantFromState(states[0])?.name, confidence: "MEDIUM" });
    }
    if (lastPoint && lastPoint.flags && lastPoint.flags.phase_zone_change) {
      const q = getQuadrantFromState(lastPoint.state);
      if (q && (q.q === 1 || q.q === 4)) {
        patterns.push({ type: "PHASE_SHIFT", description: "Phase zone change in Setup", quadrant: q.name, confidence: "MEDIUM" });
      }
    }
    return patterns;
  }

  // ── computeHorizonBucket (verbatim from line 3899) ──
  function computeHorizonBucket(src) {
    const bucket = String(src?.horizon_bucket || "").trim().toUpperCase();
    if (bucket) return bucket.replace("_", " ");
    const eta = computeEtaDays(src);
    if (!Number.isFinite(eta)) return "—";
    if (eta <= 7) return "SHORT TERM";
    if (eta <= 30) return "SWING";
    return "POSITIONAL";
  }

  // ── computeTpMaxPrice (verbatim from line 3507) ──
  function computeTpMaxPrice(ticker) {
    const entry = computeEntryRef(ticker);
    if (!Number.isFinite(entry)) return null;
    const directMax = numFromAny(ticker?.tp_max_price ?? ticker?.tp_max);
    if (Number.isFinite(directMax) && directMax > 0) return directMax;
    const dir = getDirectionFromState(ticker);
    const tpLevels = Array.isArray(ticker?.tp_levels) ? ticker.tp_levels : [];
    const candidates = tpLevels
      .map((tp) => {
        const px = tp && typeof tp === "object" && tp.price != null ? tp.price : tp;
        const price = numFromAny(px);
        return Number.isFinite(price) ? price : null;
      })
      .filter((p) => Number.isFinite(p));
    if (ticker?.tp != null) {
      const tp = numFromAny(ticker.tp);
      if (Number.isFinite(tp)) candidates.push(tp);
    }
    if (candidates.length === 0) return null;
    if (dir === "LONG") {
      const valid = candidates.filter((p) => p > entry);
      return valid.length > 0 ? Math.max(...valid) : null;
    }
    if (dir === "SHORT") {
      const valid = candidates.filter((p) => p < entry);
      return valid.length > 0 ? Math.min(...valid) : null;
    }
    return null;
  }

  // ── computeTpTargetPrice (verbatim from line 3544) ──
  function computeTpTargetPrice(ticker) {
    const directTarget = numFromAny(ticker?.tp_target_price ?? ticker?.tp_target);
    if (Number.isFinite(directTarget) && directTarget > 0) return directTarget;
    const primary = numFromAny(ticker?.tp);
    if (Number.isFinite(primary) && primary > 0) return primary;
    return null;
  }

  // ── getTickerSector (verbatim from line 2699; SECTOR_MAP inlined) ──
  const SECTOR_MAP = {
    XLK: "Information Technology", XLF: "Financials", XLY: "Consumer Discretionary",
    XLP: "Consumer Staples", XLC: "Communication Services", XLI: "Industrials",
    XLB: "Basic Materials", XLE: "Energy", XLRE: "Real Estate", XLU: "Utilities",
    XLV: "Healthcare", IBB: "Healthcare", INFL: "Thematic ETF", LIT: "Thematic ETF",
    RPG: "Thematic ETF", SPHB: "Thematic ETF", GRNJ: "Thematic ETF", GRNI: "Thematic ETF", SPCX: "Thematic ETF",
    AMZN: "Consumer Discretionary", TSLA: "Consumer Discretionary", NKE: "Consumer Discretionary",
    TJX: "Consumer Discretionary", HD: "Consumer Discretionary", MCD: "Consumer Discretionary",
    SBUX: "Consumer Discretionary", LOW: "Consumer Discretionary", NFLX: "Consumer Discretionary",
    BKNG: "Consumer Discretionary", CMG: "Consumer Discretionary", ABNB: "Consumer Discretionary",
    EXPE: "Consumer Discretionary", RBLX: "Consumer Discretionary", ULTA: "Consumer Discretionary",
    SHOP: "Consumer Discretionary",
    CAT: "Industrials", GE: "Industrials", BA: "Industrials", HON: "Industrials",
    RTX: "Industrials", EMR: "Industrials", ETN: "Industrials", DE: "Industrials",
    PH: "Industrials", CSX: "Industrials", UNP: "Industrials", UPS: "Industrials",
    FDX: "Industrials", LMT: "Industrials", NOC: "Industrials", GD: "Industrials",
    TT: "Industrials", PWR: "Industrials", AWI: "Industrials", WTS: "Industrials",
    DY: "Industrials", FIX: "Industrials", ITT: "Industrials", STRL: "Industrials",
    AAPL: "Information Technology", MSFT: "Information Technology", NVDA: "Information Technology",
    AVGO: "Information Technology", AMD: "Information Technology", ORCL: "Information Technology",
    CRM: "Information Technology", ADBE: "Information Technology", INTC: "Information Technology",
    CSCO: "Information Technology", TXN: "Information Technology", AMAT: "Information Technology",
    LRCX: "Information Technology", KLAC: "Information Technology", ANET: "Information Technology",
    CDNS: "Information Technology", CRWD: "Information Technology", PANW: "Information Technology",
    PLTR: "Information Technology", MDB: "Information Technology", PATH: "Information Technology",
    QLYS: "Information Technology", PEGA: "Information Technology", IOT: "Information Technology",
    PSTG: "Information Technology", MU: "Information Technology", APLD: "Information Technology",
    META: "Communication Services", GOOGL: "Communication Services",
    DIS: "Communication Services", CMCSA: "Communication Services", VZ: "Communication Services",
    T: "Communication Services", TWLO: "Communication Services", RDDT: "Communication Services",
    LIN: "Basic Materials", APD: "Basic Materials", ECL: "Basic Materials", SHW: "Basic Materials",
    PPG: "Basic Materials", FCX: "Basic Materials", NEM: "Basic Materials", ALB: "Basic Materials",
    MP: "Basic Materials", NEU: "Basic Materials", AU: "Basic Materials", CCJ: "Basic Materials",
    RGLD: "Basic Materials", SN: "Basic Materials",
    XOM: "Energy", CVX: "Energy", SLB: "Energy", EOG: "Energy", COP: "Energy",
    MPC: "Energy", PSX: "Energy", VST: "Energy", FSLR: "Energy",
    JPM: "Financials", BAC: "Financials", WFC: "Financials", GS: "Financials",
    MS: "Financials", C: "Financials", AXP: "Financials", COF: "Financials",
    SPGI: "Financials", MCO: "Financials", BLK: "Financials", SCHW: "Financials",
    PNC: "Financials", TFC: "Financials", USB: "Financials",
    ALLY: "Financials", EWBC: "Financials", WAL: "Financials", SOFI: "Financials",
    HOOD: "Financials",
    AMT: "Real Estate", PLD: "Real Estate", EQIX: "Real Estate", PSA: "Real Estate",
    WELL: "Real Estate", SPG: "Real Estate", O: "Real Estate", DLR: "Real Estate",
    VICI: "Real Estate", EXPI: "Real Estate",
    UNH: "Healthcare", JNJ: "Healthcare", LLY: "Healthcare", ABBV: "Healthcare",
    MRK: "Healthcare", TMO: "Healthcare", ABT: "Healthcare", DHR: "Healthcare",
    BMY: "Healthcare", AMGN: "Healthcare", GILD: "Healthcare", REGN: "Healthcare",
    VRTX: "Healthcare", BIIB: "Healthcare", UTHR: "Healthcare", HIMS: "Healthcare",
    NBIS: "Healthcare",
    NEE: "Utilities", DUK: "Utilities", SO: "Utilities", D: "Utilities",
    AEP: "Utilities", SRE: "Utilities", EXC: "Utilities", XEL: "Utilities",
    WEC: "Utilities", ES: "Utilities", PEG: "Utilities", ETR: "Utilities",
    FE: "Utilities", AEE: "Utilities",
  };
  function normTicker(t) {
    let s = String(t || "").trim().toUpperCase();
    if (s === "BRK.B" || s === "BRK-B") s = "BRK-B";
    return s;
  }
  function getTickerSector(ticker) {
    const T = normTicker(ticker?.ticker || ticker?.symbol || ticker);
    return SECTOR_MAP[T] || "";
  }

  // ── normalizeSectorKey (verbatim from line 2904) ──
  function normalizeSectorKey(sectorName) {
    const raw = String(sectorName || "")
      .trim().toLowerCase()
      .replace(/[-_/]+/g, " ")
      .replace(/&/g, "and")
      .replace(/\s+/g, " ");
    if (!raw) return "";
    const ALIASES = {
      "health care": "healthcare", healthcare: "healthcare",
      materials: "basic materials", "basic materials": "basic materials",
      "non energy minerals": "basic materials",
      "consumer durables": "consumer discretionary",
      "consumer non durables": "consumer staples",
      "consumer cyclical": "consumer discretionary",
      "consumer discretionary": "consumer discretionary",
      "consumer defensive": "consumer staples",
      "consumer staples": "consumer staples",
      "financial services": "financials", finance: "financials",
      financials: "financials",
      technology: "information technology",
      "technology services": "information technology",
      "electronic technology": "information technology",
      "information technology": "information technology",
      communications: "communication services",
      "communication services": "communication services",
      "energy minerals": "energy", energy: "energy",
      industrials: "industrials", utilities: "utilities",
      "real estate": "real estate",
    };
    return ALIASES[raw] || raw;
  }

  // ── sectorKeyToCanonicalName (verbatim from line 2942) ──
  function sectorKeyToCanonicalName(key) {
    const K = String(key || "").trim().toLowerCase();
    const CANON = {
      "consumer discretionary": "Consumer Discretionary", industrials: "Industrials",
      "information technology": "Information Technology",
      "communication services": "Communication Services",
      "basic materials": "Basic Materials", energy: "Energy",
      financials: "Financials", "real estate": "Real Estate",
      "consumer staples": "Consumer Staples", healthcare: "Healthcare",
      utilities: "Utilities",
    };
    return CANON[K] || key;
  }

  // ── GROUPS / GROUP_LABELS / GROUP_ORDER (verbatim from line 2965 / 3003 / 3013) ──
  const GROUPS = {
    UPTICKS: new Set([
      "RDDT","AMZN","BABA","TSLA","KO","WMT","ETHA","BRK-B","MTB",
      "AMGN","GILD","CSX","GEV","HII","JCI","PH","PWR","TT",
      "CLS","FSLR","PANW","CRS","VST","BG","MRK","QXO","AXP",
    ]),
    GRNI: new Set(), GRNJ: new Set(), GRNY: new Set(),
    SP_Sectors: new Set([
      "XLK","XLF","XLY","XLP","XLC","XLI","XLB","XLE","XLRE","XLU","XLV",
    ]),
    Futures: new Set(["ES1!","NQ1!","RTY1!","YM1!","GC1!","SI1!","CL1!","BTCUSD","ETHUSD"]),
  };
  const GROUP_LABELS = {
    SP_Sectors: "S&P Sectors", Futures: "Futures", Other: "Other",
    UPTICKS: "TT Selected", GRNI: "TT Selected", GRNJ: "TT Selected", GRNY: "TT Selected",
  };
  const GROUP_ORDER = ["SP_Sectors","Futures","UPTICKS","GRNI","GRNJ","GRNY","Other"];

  function groupsForTicker(t) {
    const T = normTicker(typeof t === "string" ? t : (t?.ticker || t?.symbol));
    const out = [];
    for (const [g, set] of Object.entries(GROUPS)) {
      if (set.has(T)) out.push(g);
    }
    if (out.length === 0) out.push("Other");
    return out;
  }

  // Expose isTickerTTSelected on window for the right rail (which reads
  // it as a global on /index-react.html). Keep idempotent so pages that
  // already wire it (active-trader.html / today.html) win.
  if (typeof window.isTickerTTSelected !== "function") {
    window.isTickerTTSelected = function (sym) {
      const T = normTicker(sym);
      return (
        GROUPS.UPTICKS.has(T) ||
        GROUPS.GRNI.has(T) ||
        GROUPS.GRNJ.has(T) ||
        GROUPS.GRNY.has(T)
      );
    };
  }

  // ── loadETFGroups — populates GRNI/GRNJ/GRNY from server (line 2983 of source) ──
  let _etfGroupsLoaded = false;
  async function loadETFGroups() {
    if (_etfGroupsLoaded) return;
    try {
      const resp = await fetch("/timed/etf/groups");
      const data = await resp.json();
      if (data && data.ok && data.groups) {
        for (const [etf, tickers] of Object.entries(data.groups)) {
          if (GROUPS[etf] !== undefined) {
            GROUPS[etf] = new Set(tickers.map((t) => normTicker(t)));
          }
        }
        _etfGroupsLoaded = true;
      }
    } catch (_) { /* swallow */ }
  }
  loadETFGroups();

  // ── getDirection (verbatim from line 7840) ──
  function getDirection(ticker) {
    const state = String(ticker?.state || "");
    if (state.startsWith("HTF_BULL")) return { text: "LONG",  color: "text-teal-400", bg: "bg-teal-500/20" };
    if (state.startsWith("HTF_BEAR")) return { text: "SHORT", color: "text-rose-400", bg: "bg-rose-500/20" };
    if (state.includes("BULL"))       return { text: "LONG",  color: "text-teal-400", bg: "bg-teal-500/20" };
    if (state.includes("BEAR"))       return { text: "SHORT", color: "text-rose-400", bg: "bg-rose-500/20" };
    return { text: "—", color: "text-[#6E867D]", bg: "bg-white/[0.04]" };
  }

  // ── getProtectionStageInfo (verbatim from line 8011) ──
  function getProtectionStageInfo(ticker, trade) {
    const stage = String(
      trade?.protectionStage ||
      trade?.protection_stage ||
      ticker?.kanban_meta?.protection_stage ||
      ticker?.__protection_stage || ""
    ).trim().toLowerCase();
    const labelMap = {
      original_invalidation: "Original Invalidation",
      breakeven_eligible: "Breakeven Eligible",
      breakeven_locked: "Breakeven Locked",
      profit_lock: "Profit Lock",
      runner_protect: "Runner Protect",
    };
    const reasons = Array.isArray(ticker?.kanban_meta?.protection_reasons)
      ? ticker.kanban_meta.protection_reasons : [];
    return { stage, label: labelMap[stage] || "", reasons };
  }

  // ── getTradeLifecycleState (verbatim from line 8036) ──
  function getTradeLifecycleState(ticker, trade) {
    const resolvedTrade = trade || ticker?._openTrade || null;
    const rawStage = String(ticker?.kanban_stage || "").trim().toLowerCase();
    const protection = getProtectionStageInfo(ticker, resolvedTrade);
    if (!resolvedTrade) {
      return { trade: null, rawStage, effectiveStage: rawStage, tradeStatus: "", trimmedPct: 0, tradeIsOpen: false, tradeIsClosed: false, protection };
    }
    const tradeStatus = String(resolvedTrade.status || "").toUpperCase();
    const trimmedPct = Number(resolvedTrade?.trimmed_pct ?? resolvedTrade?.trimmedPct ?? 0);
    const tradeIsClosed =
      tradeStatus === "WIN" || tradeStatus === "LOSS" ||
      !!(resolvedTrade?.exit_ts ?? resolvedTrade?.exitTs) ||
      trimmedPct >= 0.9999;
    const tradeIsOpen =
      !tradeIsClosed && (tradeStatus === "OPEN" || tradeStatus === "TP_HIT_TRIM" || !tradeStatus);
    let effectiveStage = rawStage;
    if (tradeIsOpen) {
      if (rawStage === "exit") effectiveStage = "defend";
      else if (rawStage === "defend") effectiveStage = "defend";
      else if (tradeStatus === "TP_HIT_TRIM" || trimmedPct > 0) effectiveStage = "trim";
      else if (!["trim", "hold", "active", "just_entered"].includes(rawStage)) effectiveStage = "hold";
    }
    return { trade: resolvedTrade, rawStage, effectiveStage, tradeStatus, trimmedPct, tradeIsOpen, tradeIsClosed, protection };
  }

  // ── getActionDescription (verbatim from line 8093 — full 567-line body) ──
  function getActionDescription(ticker, trade) {
    const lifecycle = getTradeLifecycleState(ticker, trade);
    const activeTrade = lifecycle.trade;
    const stage = lifecycle.effectiveStage;
    const state = String(ticker.state || "");
    const phase = Number(ticker.phase_pct) || 0;
    const comp = completionForSize(ticker);
    const flags = ticker.flags || {};
    const ent = entryType(ticker);
    const rank = Number(ticker.rank || 0);
    const rr = Number(ticker.rr || 0);
    const momentumElite = !!flags.momentum_elite;
    const momentumPct = ticker.momentum_pct || {};
    const isAligned = state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
    const isPullback = state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK";
    const isPrime = isPrimeBubble(ticker);
    const inCorridor = ent.corridor;
    const sqRelease = !!flags.sq30_release;
    const sqOn = !!flags.sq30_on;
    const tradeStatus = lifecycle.tradeStatus;
    const tradeIsClosed = lifecycle.tradeIsClosed;
    const tradeIsOpen = lifecycle.tradeIsOpen;

    if (tradeIsOpen) {
      const ep = Number(activeTrade?.entryPrice ?? activeTrade?.entry_price) || 0;
      const cp = Number(ticker?.price ?? ticker?.close) || 0;
      const tradeDir = String(activeTrade?.direction || "").toUpperCase();
      const isLong = tradeDir === "LONG";
      const trimmedPct = lifecycle.trimmedPct;
      const sl = Number(ticker?.sl ?? ticker?.sl_price ?? activeTrade?.sl ?? 0);
      const tp = numFromAny(ticker?.tp ?? ticker?.tp_trim ?? activeTrade?.tp);
      const dirSign = isLong ? 1 : -1;
      const unrealizedPct = ep > 0 && cp > 0 ? ((cp - ep) / ep) * 100 * dirSign : 0;
      const isProfit = unrealizedPct > 0;
      const slBreached = sl > 0 && cp > 0 && ((isLong && cp <= sl) || (!isLong && cp >= sl));
      const tpReached = tp > 0 && cp > 0 && ((isLong && cp >= tp) || (!isLong && cp <= tp));
      const nearSl = sl > 0 && cp > 0 && !slBreached && (Math.abs(cp - sl) / cp) < 0.015;
      const nearTp = tp > 0 && cp > 0 && !tpReached && (Math.abs(cp - tp) / cp) < 0.015;
      const meta = ticker?.kanban_meta || {};
      const metaReason = meta?.reason || "";
      const protectionStage = lifecycle.protection?.stage || "";
      const protectionLabel = lifecycle.protection?.label || "";
      const protectionSummary = protectionLabel ? `Protection stage: ${protectionLabel}. ` : "";
      const trimmedProtectionText = (() => {
        if (protectionStage === "runner_protect") return "The runner has graduated into full runner protection, so the system can trail structure and peak reactions more aggressively.";
        if (protectionStage === "profit_lock")    return "The trade has reached profit lock, so the system can tighten stops to preserve gains without treating every pullback like failure.";
        if (protectionStage === "breakeven_locked")   return "The trade has earned breakeven protection, so the system can defend entry while still giving the move room to mature.";
        if (protectionStage === "breakeven_eligible") return "The trade is eligible for breakeven protection, but the system is still waiting for stronger confirmation before ratcheting the stop.";
        return "The original invalidation stays in force until the system confirms a stronger protection stage.";
      })();
      const priceSummary = `${isLong ? "Long" : "Short"} from $${ep.toFixed(2)}, current $${cp.toFixed(2)} (${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(1)}%).`;
      if (tradeStatus === "TP_HIT_TRIM" || trimmedPct > 0) {
        return { action: "✂️ Position Trimmed — Let Runner Work",
          description: `${(trimmedPct * 100).toFixed(0)}% of position trimmed. ${priceSummary} ${protectionSummary}${trimmedProtectionText} ${!isAligned ? "Timeframes are weakening, so watch for a defend or exit signal instead of tightening on noise." : "Trend alignment is still intact, so let the runner work until a true defend signal appears."}`,
          color: "text-yellow-300", bg: "bg-yellow-500/15" };
      }
      if (stage === "exit") {
        const exitReason = metaReason || (slBreached ? "TSL breached" : "Exit indicator triggered");
        return { action: "🚨 EXIT — Close Position",
          description: `System says EXIT. Reason: ${exitReason}. ${priceSummary} Close the position now to ${isProfit ? "lock in remaining gains" : "limit losses"}. Do not average down or widen your stop.`,
          color: "text-rose-400", bg: "bg-rose-500/20" };
      }
      if (stage === "defend" || (stage === "hold" && meta?.bucket === "defend")) {
        const defendReason = metaReason || "Warning indicators detected";
        return { action: "🛡 DEFEND — Tighten Stop",
          description: `System says DEFEND. Reason: ${defendReason}. ${priceSummary} ${protectionSummary}The system is tightening TSL to ${isProfit ? "protect gains" : "limit further downside"}. Do NOT trim yet — just defending. Monitor for recovery (back to HOLD) or further deterioration (to EXIT).`,
          color: "text-amber-400", bg: "bg-amber-500/15" };
      }
      if (stage === "trim") {
        const trimReason = metaReason || (nearTp ? "Near TP target" : `${(comp * 100).toFixed(0)}% complete`);
        return { action: "✂️ TRIM — Take Partial Profits",
          description: `System says TRIM. Reason: ${trimReason}. ${priceSummary} Consider trimming 50–75% of the position to lock in gains. ${isAligned ? "Trend still aligned — trail the stop on the remaining runner." : "Alignment weakening — consider a larger trim."}`,
          color: "text-yellow-400", bg: "bg-yellow-500/20" };
      }
      if (stage === "just_entered") {
        return { action: "🆕 JUST ENTERED — Monitor",
          description: `Position recently opened. ${priceSummary} Watch for confirmation and initial move in your favor. The system will promote to HOLD once the position stabilizes, or to DEFEND/EXIT if adverse indicators appear.`,
          color: "text-sky-300", bg: "bg-sky-500/15" };
      }
      if (stage === "hold") {
        const holdExtra = isPullback
          ? `HTF still supports the ${isLong ? "bullish" : "bearish"} case but LTF pulling back — hold above TSL.`
          : isAligned ? "All timeframes aligned — conditions favor holding." : "Monitor alignment.";
        return { action: isProfit ? "🔒 HOLD — Trend Intact" : "🔄 HOLD — Position Building",
          description: `System says HOLD. Position is healthy and working as expected. ${priceSummary} ${protectionSummary}${holdExtra} TSL at $${sl > 0 ? sl.toFixed(2) : "N/A"}, TP at $${tp > 0 ? tp.toFixed(2) : "N/A"}. ${comp > 0.5 ? `Completion at ${(comp * 100).toFixed(0)}% — watch for trim indicators.` : "Let the trade develop."}`,
          color: isProfit ? "text-teal-300" : "text-sky-300", bg: isProfit ? "bg-teal-500/15" : "bg-sky-500/15" };
      }
      if (slBreached) {
        return { action: "🚨 TSL Breached — Exit Now",
          description: `Current price ($${cp.toFixed(2)}) has breached your TSL at $${sl.toFixed(2)}. ${priceSummary} Close the position to limit losses. Do not average down.`,
          color: "text-rose-400", bg: "bg-rose-500/20" };
      }
      if (tpReached) {
        return { action: "🎯 Target Reached — Take Profit",
          description: `Price has reached the first take-profit target ($${tp.toFixed(2)}). ${priceSummary} Consider trimming 50–75% to lock in gains. ${isAligned ? "Trend still aligned — trail the stop on the remaining runner." : "Alignment weakening — consider full exit."}`,
          color: "text-[#00e676]", bg: "bg-[#00c853]/20" };
      }
      if (nearSl) {
        return { action: "🛡 Near TSL — Defend",
          description: `Price ($${cp.toFixed(2)}) is approaching your TSL at $${sl.toFixed(2)}. ${!isAligned ? "Timeframes have lost alignment, increasing risk." : "Trend still aligned — TSL may hold."} Prepare to exit if TSL is breached. Do not widen your stop.`,
          color: "text-orange-400", bg: "bg-orange-500/15" };
      }
      if (nearTp) {
        return { action: "📈 Approaching Target — Prepare to Trim",
          description: `Price ($${cp.toFixed(2)}) is nearing your take-profit at $${tp.toFixed(2)}. ${priceSummary} Set a limit order at TP or prepare a manual trim when target is touched.`,
          color: "text-teal-300", bg: "bg-teal-500/15" };
      }
      if (!isAligned && !isPullback) {
        return { action: "⚠️ Alignment Lost — Monitor Closely",
          description: `Timeframes no longer aligned (${state.replace(/_/g, " ")}). ${priceSummary} Consider tightening TSL or trimming to reduce exposure until alignment returns.`,
          color: "text-amber-300", bg: "bg-amber-500/15" };
      }
      if (isPullback) {
        return { action: "↩️ Pullback in Progress — Hold",
          description: `Higher timeframe still supports the ${isLong ? "bullish" : "bearish"} case, but lower timeframe is pulling back. ${priceSummary} Hold as long as price stays above TSL ($${sl > 0 ? sl.toFixed(2) : "N/A"}). Pullbacks in aligned trends can offer add-on opportunities.`,
          color: "text-cyan-300", bg: "bg-cyan-500/15" };
      }
      return { action: "Manage Open Position",
        description: `${priceSummary} Position is open — let it work toward TP, manage with TSL discipline.`,
        color: "text-sky-300", bg: "bg-sky-500/15" };
    }

    if (trade && tradeIsClosed) {
      const pnl = Number(trade?.pnl ?? trade?.realizedPnl) || 0;
      const pnlPct = Number(trade?.pnl_pct ?? trade?.pnlPct) || 0;
      const exitPx = Number(trade?.exit_price ?? trade?.exitPrice) || 0;
      const entPx = Number(trade?.entryPrice ?? trade?.entry_price) || 0;
      const exitReason = String(trade?.exit_reason ?? trade?.exitReason ?? "").replace(/_/g, " ");
      const trDir = String(trade?.direction || "").toUpperCase();
      const pnlStr = pnlPct !== 0 ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : pnl !== 0 ? `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}` : "";
      const exitPxStr = exitPx > 0 ? ` at $${exitPx.toFixed(2)}` : "";
      const entPxStr = entPx > 0 ? `${trDir === "LONG" ? "Long" : trDir === "SHORT" ? "Short" : "Entry"} from $${entPx.toFixed(2)}, exited${exitPxStr}` : `Exited${exitPxStr}`;
      const reasonStr = exitReason ? ` Reason: ${exitReason.replace(/\b\w/g, c => c.toUpperCase())}.` : "";
      const isWin = tradeStatus === "WIN" || pnl > 0;
      return { action: isWin ? "✅ Trade Closed — Win" : "❌ Trade Closed — Loss",
        description: `${entPxStr}${pnlStr ? ` (${pnlStr})` : ""}.${reasonStr} ${isWin ? "Well managed." : "Review the setup and indicators for lessons."} The ticker is now back in the scoring pipeline and will re-enter stages if a new setup forms.`,
        color: isWin ? "text-[#69f0ae]" : "text-rose-300",
        bg: isWin ? "bg-[#00c853]/15" : "bg-rose-500/15" };
    }

    if (stage === "watch" || stage === "setup_watch" || stage === "flip_watch" || stage === "just_flipped" || stage === "in_review" || stage === "enter_now" || stage === "enter") {
      const late = (Number.isFinite(phase) && phase > 0.7) || (Number.isFinite(comp) && comp > 0.8);
      const cautionParts = [];
      if (Number.isFinite(phase) && phase > 0.7) cautionParts.push(`Phase ${(phase * 100).toFixed(0)}% (late-cycle)`);
      if (Number.isFinite(comp)  && comp  > 0.8) cautionParts.push(`Completion ${(comp * 100).toFixed(0)}% (near target)`);
      const caution = cautionParts.length > 0 ? `Caution: ${cautionParts.join(" • ")}.` : "";
      if (stage === "watch")        return { action: "Watching",       description: `Ticker has started to form a setup or pattern we like but not yet confirmed. Waiting for corridor entry or momentum flip. ${caution}`.trim(), color: "text-violet-300", bg: "bg-violet-500/15" };
      if (stage === "setup_watch")  return { action: "Setup Watch",    description: `Ticker is in corridor but still in setup (pullback) state. Waiting for flip to momentum (HTF_BULL_LTF_BULL or HTF_BEAR_LTF_BEAR) before entry. ${caution}`.trim(), color: "text-violet-300", bg: "bg-violet-500/15" };
      if (stage === "flip_watch")   return { action: late ? "Flip Watch (Late-cycle)" : "Flip Watch", description: `Ticker is in the Flip Watch lane: momentum alignment is near and the system is watching for a flip into momentum. Wait for the flip / corridor confirmation before entering. ${caution}`.trim(), color: "text-amber-300", bg: "bg-amber-500/15" };
      if (stage === "just_flipped") return { action: late ? "Just Flipped (Late-cycle)" : "Just Flipped", description: `Ticker just flipped into momentum (recent corridor entry). Prefer waiting for the first pullback / corridor stabilization, then enter on confirmation. ${caution}`.trim(), color: "text-cyan-300", bg: "bg-cyan-500/15" };
      return { action: "In Review",
        description: `Ticker meets the system's technical entry criteria and is under CIO review. The AI CIO will evaluate risk, market context, and trade quality before approving or rejecting. ${isPullback ? "Currently in pullback — may offer better entry if price holds above SL. " : ""}${caution}`.trim(),
        color: "text-amber-300", bg: "bg-amber-500/15" };
    }

    if (stage === "exit") {
      const exitMeta = ticker?.kanban_meta || {};
      const exitReason = exitMeta?.reason || "Exit indicator triggered";
      return { action: "🚨 EXIT — Close Position",
        description: `System says EXIT. Reason: ${exitReason}. If you have an open position, close it now. The setup has deteriorated beyond recovery thresholds.`,
        color: "text-rose-400", bg: "bg-rose-500/20" };
    }
    if (stage === "defend" || (stage === "hold" && ticker?.kanban_meta?.bucket === "defend")) {
      const defendReason = ticker?.kanban_meta?.reason || "Warning indicators detected";
      return { action: "🛡 DEFEND — Tighten Stop",
        description: `System says DEFEND. Reason: ${defendReason}. The system is tightening TSL to protect gains or limit losses. Do NOT trim yet — just defending. Monitor for recovery (back to HOLD) or further deterioration (to EXIT).`,
        color: "text-amber-400", bg: "bg-amber-500/15" };
    }
    if (stage === "trim") {
      const trimMeta = ticker?.kanban_meta || {};
      const trimReason = trimMeta?.reason || `${(comp * 100).toFixed(0)}% complete`;
      return { action: "✂️ TRIM — Take Partial Profits",
        description: `System says TRIM. Reason: ${trimReason}. ${momentumElite ? "Despite Momentum Elite status, " : ""}Consider trimming 50–75% of position to lock in gains while allowing runners to continue. Monitor for signs of reversal or continuation beyond TP levels.`,
        color: "text-yellow-400", bg: "bg-yellow-500/20" };
    }
    if (stage === "hold") {
      return { action: "🔒 HOLD — Position Healthy",
        description: `System says HOLD. Position is working as expected. ${isAligned ? "All timeframes aligned — conditions favor holding." : isPullback ? "HTF trend intact, LTF pulling back — normal behavior." : "Monitor alignment."} ${comp > 0.5 ? `Completion at ${(comp * 100).toFixed(0)}% — watch for trim indicators.` : "Let the trade develop."}`,
        color: "text-teal-300", bg: "bg-teal-500/15" };
    }
    if (stage === "just_entered") {
      return { action: "🆕 JUST ENTERED — Monitor",
        description: "Position recently opened. Watch for confirmation and initial move in your favor. The system will promote to HOLD once the position stabilizes, or to DEFEND/EXIT if adverse indicators appear.",
        color: "text-sky-300", bg: "bg-sky-500/15" };
    }

    if (comp > 0.8) {
      return { action: "Prepare for Exit / Trim Position",
        description: `Position has reached ${(comp * 100).toFixed(0)}% completion, indicating the move is near its target. ${momentumElite ? "Despite Momentum Elite status, " : ""}Consider taking profits or trimming 50-75% of position to lock in gains while allowing runners to continue. Monitor for signs of reversal or continuation beyond TP levels.`,
        color: "text-yellow-400", bg: "bg-yellow-500/20" };
    }
    if (phase > 0.7) {
      return { action: "Wait / Trim Existing Position",
        description: `Phase oscillator at ${(phase * 100).toFixed(0)}% indicates late-cycle conditions. ${momentumElite ? "While Momentum Elite suggests continued strength, " : ""}Market is approaching exhaustion zone. Wait for pullback to better entry or trim existing positions by 30-50% to reduce risk. Look for phase reset or continuation patterns before adding size.`,
        color: "text-orange-400", bg: "bg-orange-500/20" };
    }
    if (momentumElite && isPrime && inCorridor && rank >= 75 && rr >= 1.5) {
      const momentumStr = momentumPct.month != null ? ` with ${Number(momentumPct.month).toFixed(0)}% monthly momentum` : "";
      return { action: "Initiate Position - High Conviction",
        description: `Momentum Elite stock${momentumStr} showing Prime setup with exceptional alignment. Both HTF and LTF are aligned, price is in entry corridor, rank is strong (${rank}), and risk/reward is favorable (${rr.toFixed(2)}:1). This represents a high-probability setup with strong fundamentals backing the technical pattern. Review TP levels as potential profit targets and size according to your risk tolerance.`,
        color: "text-teal-400", bg: "bg-teal-500/20" };
    }
    if (momentumElite && sqRelease && inCorridor && isAligned) {
      const momentumStr = momentumPct.week != null ? ` (${Number(momentumPct.week).toFixed(0)}% weekly)` : "";
      return { action: "Initiate Position - Momentum Breakout",
        description: `Momentum Elite stock${momentumStr} experiencing squeeze release with timeframe alignment. This indicates pent-up energy being released in the direction of the trend. The combination of Momentum Elite fundamentals and technical squeeze release creates a high-probability momentum continuation setup. Enter on pullback to corridor or on break of squeeze high/low, targeting TP levels.`,
        color: "text-teal-400", bg: "bg-teal-500/20" };
    }
    if (isPrime && inCorridor && rank >= 75 && rr >= 1.5) {
      return { action: "Initiate Position - Prime Setup",
        description: `Prime setup detected with strong technical alignment. Both timeframes are aligned, price is in entry corridor, rank is strong (${rank}), and risk/reward is favorable (${rr.toFixed(2)}:1). ${momentumElite ? "Momentum Elite status adds fundamental strength to this technical setup. " : ""}Early phase (${(phase * 100).toFixed(0)}%) with low completion (${(comp * 100).toFixed(0)}%) suggests room to run. Consider entering position, using SL for risk management and TP levels as profit targets.`,
        color: "text-teal-400", bg: "bg-teal-500/20" };
    }
    if (momentumElite && inCorridor && isAligned && comp < 0.5 && phase < 0.6) {
      return { action: "Consider Entry - Momentum Elite Setup",
        description: `Momentum Elite stock in favorable technical setup. Price is in entry corridor with both timeframes aligned, early phase (${(phase * 100).toFixed(0)}%), and low completion (${(comp * 100).toFixed(0)}%) indicating room for continuation. ${sqRelease ? "Squeeze release adds momentum confirmation. " : sqOn ? "Squeeze building suggests potential breakout. " : ""}The combination of strong fundamentals (Momentum Elite) and favorable technicals creates a quality setup. Enter on confirmation or pullback, targeting TP levels.`,
        color: "text-blue-400", bg: "bg-blue-500/20" };
    }
    if (sqRelease && inCorridor && isAligned) {
      return { action: "Initiate Position - Squeeze Release",
        description: `Squeeze release detected with timeframe alignment in entry corridor. This indicates pent-up energy being released in the direction of the trend. ${momentumElite ? "Momentum Elite status adds fundamental backing to this technical pattern. " : ""}Early phase (${(phase * 100).toFixed(0)}%) and low completion (${(comp * 100).toFixed(0)}%) suggest continuation potential. Enter on pullback or break, using SL for protection and TP levels as targets.`,
        color: "text-teal-400", bg: "bg-teal-500/20" };
    }
    if (inCorridor && isAligned && comp < 0.5 && phase < 0.6) {
      return { action: "Consider Entry - Favorable Setup",
        description: `Setup is in entry corridor with both timeframes aligned. Early phase (${(phase * 100).toFixed(0)}%) and low completion (${(comp * 100).toFixed(0)}%) suggest room to run. ${momentumElite ? "Momentum Elite status adds quality to this setup. " : ""}${sqOn ? "Squeeze building suggests potential momentum. " : ""}Rank is ${rank >= 70 ? "strong" : "moderate"} (${rank}) with RR of ${rr.toFixed(2)}:1. Monitor for entry confirmation or wait for squeeze release pattern before initiating position.`,
        color: "text-blue-400", bg: "bg-blue-500/20" };
    }
    if (isPullback && !inCorridor) {
      return { action: "Wait for Entry - Pullback Setup",
        description: `Pullback detected (${state}) but price not yet in entry corridor. ${momentumElite ? "Momentum Elite status suggests this pullback may be shallow and could present a quality entry. " : ""}Wait for price to enter corridor (Q1→Q2 for LONG, Q4→Q3 for SHORT) before considering entry. ${sqOn ? "Squeeze building suggests potential momentum when released. " : ""}Monitor for corridor entry and confirmation patterns before initiating position.`,
        color: "text-cyan-400", bg: "bg-cyan-500/20" };
    }
    if (sqOn && !sqRelease) {
      return { action: "Monitor Closely - Squeeze Building",
        description: `Squeeze building but not yet released, indicating pressure is accumulating. ${momentumElite ? "Momentum Elite status suggests when released, the move could be significant. " : ""}${inCorridor ? "Price is in entry corridor, making this a high-probability setup when squeeze releases. " : "Wait for price to enter corridor and squeeze to release before entering. "}Monitor closely for squeeze release pattern, which typically provides strong directional momentum.`,
        color: "text-yellow-400", bg: "bg-yellow-500/20" };
    }
    if (isPrime) {
      return { action: "Wait for Entry - Prime Setup",
        description: `This is a Prime (high-quality) setup, but entry conditions are not yet aligned. ${momentumElite ? "Momentum Elite status is positive. " : ""}${!inCorridor ? "Price needs to enter entry corridor. " : ""}${!isAligned ? "Timeframes need better alignment. " : ""}${comp > 0.5 ? `Completion is high (${(comp * 100).toFixed(0)}%), reducing upside potential. ` : ""}Wait for corridor alignment, confirmation patterns, or better timing before entering.`,
        color: "text-[#6E867D]", bg: "bg-white/[0.04]" };
    }
    return { action: "Wait - Setup Not Optimal",
      description: `Setup not yet optimal for entry. ${momentumElite ? "Momentum Elite status is positive, but " : ""}Technical conditions need improvement. ${!inCorridor ? "Price needs to enter entry corridor. " : ""}${!isAligned ? "Timeframes need better alignment. " : ""}${comp > 0.5 ? `Completion is high (${(comp * 100).toFixed(0)}%), reducing upside potential. ` : ""}Wait for better conditions, confirmation patterns, or entry corridor alignment before considering position.`,
      color: "text-[#6E867D]", bg: "bg-white/[0.04]" };
  }

  window.TimedRailHelpers = {
    TRADE_SIZE,
    FUTURES_SPECS,
    GROUPS, GROUP_LABELS, GROUP_ORDER,
    SECTOR_MAP,
    normTicker,
    normalizeTrailPoints,
    downsampleByInterval,
    getQuadrantFromState,
    detectPatterns,
    computeHorizonBucket,
    computeTpMaxPrice,
    computeTpTargetPrice,
    getTickerSector,
    normalizeSectorKey,
    sectorKeyToCanonicalName,
    groupsForTicker,
    loadETFGroups,
    getDirection,
    getProtectionStageInfo,
    getTradeLifecycleState,
    getActionDescription,
  };

  /** Client mirror of worker/cto/cto-service.js interpretCTORead — tags stale cache rows. */
  function interpretCTORead(topUpside, topDownside, leanThreshold = 0.12) {
    const upP = Number(topUpside?.regime_adjusted_prob ?? topUpside?.adj_prob);
    const dnP = Number(topDownside?.regime_adjusted_prob ?? topDownside?.adj_prob);
    const upPx = Number(topUpside?.price);
    const dnPx = Number(topDownside?.price);
    if (!Number.isFinite(upP) && !Number.isFinite(dnP)) return null;
    const spread = Math.abs((Number.isFinite(upP) ? upP : 0) - (Number.isFinite(dnP) ? dnP : 0));
    const bothStrong = upP >= 0.55 && dnP >= 0.55;
    let rangePct = null;
    if (Number.isFinite(upPx) && Number.isFinite(dnPx) && upPx > dnPx) {
      const mid = (upPx + dnPx) / 2;
      if (mid > 0) rangePct = Number((((upPx - dnPx) / mid) * 100).toFixed(1));
    }
    if (bothStrong && spread < leanThreshold) {
      return {
        kind: "range",
        label: "Range map",
        blurb: rangePct != null
          ? `Both magnets sit in a ${rangePct.toFixed(1)}% band and each hit often historically — read as chop between levels, not a directional pick.`
          : "Both nearby levels hit often — read as a range between upside and downside magnets, not a directional pick.",
      };
    }
    if (Number.isFinite(upP) && Number.isFinite(dnP) && upP - dnP >= leanThreshold) {
      return {
        kind: "upside",
        label: "Upside lean",
        blurb: `Upside ${topUpside?.label || "level"} (${(upP * 100).toFixed(0)}%) leads downside (${(dnP * 100).toFixed(0)}%) — prioritize the upper magnet when they conflict.`,
      };
    }
    if (Number.isFinite(dnP) && Number.isFinite(upP) && dnP - upP >= leanThreshold) {
      return {
        kind: "downside",
        label: "Downside lean",
        blurb: `Downside ${topDownside?.label || "level"} (${(dnP * 100).toFixed(0)}%) leads upside (${(upP * 100).toFixed(0)}%) — prioritize the lower magnet when they conflict.`,
      };
    }
    const lean = upP > dnP ? "up" : dnP > upP ? "down" : null;
    return {
      kind: lean === "up" ? "upside" : lean === "down" ? "downside" : "mixed",
      label: lean === "up" ? "Upside edge" : lean === "down" ? "Downside edge" : "Compare sides",
      blurb: "Use the higher hit-rate side as the primary magnet; these are historical tags, not entries.",
    };
  }

  function ctoReadTone(kind) {
    if (kind === "range") return "var(--tt-accent, #f5c25c)";
    if (kind === "upside") return "var(--tt-up-soft, #34d399)";
    if (kind === "downside") return "var(--tt-dn-soft, #f87171)";
    return "var(--tt-text-muted, #8AA39A)";
  }

  function formatLevelDistance(lvl) {
    const live = Number(lvl?.live_distance_pct);
    const snap = Number(lvl?.distance_pct);
    const d = Number.isFinite(live) ? live : snap;
    if (!Number.isFinite(d)) return null;
    return `${d > 0 ? "+" : ""}${d.toFixed(1)}%`;
  }

  function levelStatusMeta(status) {
    if (status === "hit") return { label: "Hit", tone: "var(--tt-up-soft, #34d399)" };
    if (status === "faded") return { label: "Faded", tone: "var(--tt-dn-soft, #f87171)" };
    if (status === "open") return { label: "Open", tone: "var(--tt-text-faint, #5a7268)" };
    return null;
  }

  function readStatusMeta(status) {
    if (status === "confirmed" || status === "hit") return { label: "Playing out", tone: "var(--tt-up-soft, #34d399)" };
    if (status === "against") return { label: "Against read", tone: "var(--tt-dn-soft, #f87171)" };
    if (status === "partial") return { label: "Partial", tone: "var(--tt-accent, #f5c25c)" };
    return null;
  }

  function pickLeadingMagnet(item) {
    const lean = item?.lean;
    const kind = item?.read_kind;
    if (lean === "up" || kind === "upside") return item?.top_upside || null;
    if (lean === "down" || kind === "downside") return item?.top_downside || null;
    const upP = Number(item?.top_upside?.adj_prob) || 0;
    const dnP = Number(item?.top_downside?.adj_prob) || 0;
    return upP >= dnP ? (item?.top_upside || null) : (item?.top_downside || null);
  }

  /** Human label for move phase: early / confirming / exhausted / extended. */
  function setupMoveMeta(item) {
    const leading = pickLeadingMagnet(item);
    if (!leading) return null;
    const distRaw = Number(leading.live_distance_pct ?? leading.distance_pct);
    const dist = Number.isFinite(distRaw) ? Math.abs(distRaw) : null;
    const st = leading.level_status;
    const rs = item?.read_status?.status;

    if (st === "hit") {
      return {
        label: "At magnet",
        tone: "var(--tt-up-soft, #34d399)",
        blurb: "Live price reached the leading magnet — little runway left on this tag.",
      };
    }
    if (st === "faded") {
      return {
        label: "Faded",
        tone: "var(--tt-dn-soft, #f87171)",
        blurb: "Price moved away from the lean — the setup lost its edge since the daily anchor.",
      };
    }
    if (rs === "confirmed" || rs === "partial") {
      const room = dist != null ? `${dist.toFixed(1)}% to target` : "move confirming";
      return {
        label: "Confirming",
        tone: "var(--tt-up-soft, #34d399)",
        blurb: `The lean is playing out — ${room}.`,
      };
    }
    if (dist != null && dist <= 1.5) {
      return {
        label: "Early",
        tone: "var(--tt-accent, #f5c25c)",
        blurb: `Only ${dist.toFixed(1)}% to the leading magnet — early in the move with room if confirmation follows.`,
      };
    }
    if (dist != null && dist <= 6) {
      return {
        label: "In play",
        tone: "var(--tt-text-muted, #8AA39A)",
        blurb: `${dist.toFixed(1)}% to the magnet — actionable distance with historical hit rate backing.`,
      };
    }
    if (dist != null) {
      return {
        label: "Extended",
        tone: "var(--tt-text-faint, #5a7268)",
        blurb: `${dist.toFixed(1)}% away — higher hit rate but less confirmation that the move has started.`,
      };
    }
    return null;
  }

  window.TimedCTORead = {
    interpret: interpretCTORead,
    tone: ctoReadTone,
    formatDistance: formatLevelDistance,
    levelStatus: levelStatusMeta,
    readStatus: readStatusMeta,
    setupMove: setupMoveMeta,
    formatBarAsOf(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return null;
      try {
        return new Date(n).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + " ET";
      } catch (_) {
        return new Date(n).toISOString().slice(0, 16).replace("T", " ");
      }
    },
    formatAsOfDate(dateStr) {
      const raw = String(dateStr || "").trim();
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      try {
        const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
        return d.toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
        }) + " ET (daily close)";
      } catch (_) {
        return raw.slice(0, 10) + " (daily close)";
      }
    },
    resolveFeedAsOfLabel(feed) {
      const formatBar = window.TimedCTORead?.formatBarAsOf || (() => null);
      const formatDate = window.TimedCTORead?.formatAsOfDate || (() => null);
      // A "daily close" anchor is a TRADING DAY, not a wall-clock instant.
      // Daily bars are stamped at 00:00 UTC of the trading day, so rendering
      // that instant in Eastern time shifts it to ~8 PM the PREVIOUS calendar
      // day (e.g. a Jun-15 close shows as "Jun 14, 8:00 PM ET"). Resolve the
      // trading-day DATE in UTC (the canonical convention) and render via the
      // date formatter so the anchor reads as the correct session.
      const msToUtcDate = (ms) => {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return null;
        try { return new Date(n).toISOString().slice(0, 10); } catch (_) { return null; }
      };
      // 1) explicit feed-level date, else derive from prediction_as_of_ms (UTC).
      let date = (typeof feed?.prediction_as_of_date === "string" && feed.prediction_as_of_date.slice(0, 10))
        || msToUtcDate(feed?.prediction_as_of_ms);
      // 2) else the freshest item as_of_date / bar_as_of_ms.
      if (!date) {
        const items = Array.isArray(feed?.items) ? feed.items : [];
        let bestBar = 0;
        let bestDate = null;
        for (const it of items) {
          const bar = Number(it?.bar_as_of_ms);
          if (Number.isFinite(bar) && bar > bestBar) bestBar = bar;
          if (it?.as_of_date && (!bestDate || String(it.as_of_date) > bestDate)) {
            bestDate = String(it.as_of_date).slice(0, 10);
          }
        }
        date = bestDate || msToUtcDate(bestBar);
      }
      if (date) {
        const fromDate = formatDate(date);
        if (fromDate) return fromDate;
      }
      // 3) last resort: the rollup refresh time is a real instant → ET is fine.
      const gen = Number(feed?.generated_at || feed?.updated_at);
      if (Number.isFinite(gen) && gen > 0) {
        const fromGen = formatBar(gen);
        if (fromGen) return fromGen + " (rollup refresh)";
      }
      return null;
    },
    formatAgeShort(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return "—";
      const mins = Math.floor(n / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 48) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    },
    buildRegimeTimelineColumns(fc, direction) {
      if (!fc) return [];
      const PRETTY = {
        HTF_BULL_LTF_BULL: { short: "Bull", color: "#4ade80" },
        HTF_BULL_LTF_PULLBACK: { short: "Bull · Pull", color: "#fbbf24" },
        HTF_BEAR_LTF_BEAR: { short: "Bear", color: "#f87171" },
        HTF_BEAR_LTF_PULLBACK: { short: "Bear · Rally", color: "#fbbf24" },
      };
      const dir = String(direction || "").toUpperCase();
      const probInDir = (vec) => {
        if (!vec || !dir) return null;
        if (dir === "LONG") {
          return (Number(vec.HTF_BULL_LTF_BULL) || 0) + (Number(vec.HTF_BULL_LTF_PULLBACK) || 0);
        }
        if (dir === "SHORT") {
          return (Number(vec.HTF_BEAR_LTF_BEAR) || 0) + (Number(vec.HTF_BEAR_LTF_PULLBACK) || 0);
        }
        return null;
      };
      const horizons = [
        { key: "p_1h", label: "1 hour", bars: 12 },
        { key: "p_4h", label: "4 hours", bars: 48 },
        { key: "p_1d", label: "1 day", bars: 78 },
        { key: "p_1w", label: "1 week", bars: 390 },
      ];
      return horizons.map((h) => {
        const vec = fc[h.key];
        if (!vec) return null;
        const entries = Object.entries(vec).sort((a, b) => b[1] - a[1]);
        const top = entries[0] || ["", 0];
        const holdPct = Number(top[1]) || 0;
        const holdState = top[0];
        const meta = PRETTY[holdState] || { short: holdState, color: "var(--ds-text-muted)" };
        const dirPct = probInDir(vec);
        return {
          ...h,
          holdState,
          holdPct,
          holdLabel: meta.short,
          holdColor: meta.color,
          dirPct,
        };
      }).filter(Boolean);
    },
    buildFundamentalsHeroNarrative(F) {
      const prof = F?.profile || {};
      const val = F?.valuation || {};
      const grw = F?.growth || {};
      const earn = F?.earnings || {};
      const beat = Number(earn.beat_rate_pct);
      const fvPrem = Number(val.fair_value_premium_pct);
      let tone = "neutral";
      if (grw.eps_growth_class === "declining" || grw.rev_growth_class === "declining") tone = "cautious";
      else if (["explosive", "exploding", "strong"].includes(grw.eps_growth_class)) tone = "bullish";
      if (Number.isFinite(fvPrem) && fvPrem > 25) tone = tone === "bullish" ? "neutral" : "cautious";
      const bullets = [];
      if (Number.isFinite(beat)) bullets.push(`Beat rate near ${Math.round(beat)}% across recent quarters.`);
      if (Number.isFinite(fvPrem)) bullets.push(`Fair-value screen shows ${Math.abs(fvPrem).toFixed(0)}% ${fvPrem > 0 ? "premium" : "discount"} vs modeled value.`);
      if (Number.isFinite(grw.eps_growth_pct)) bullets.push(`EPS growth ${grw.eps_growth_pct >= 0 ? "+" : ""}${Number(grw.eps_growth_pct).toFixed(0)}% YoY.`);
      while (bullets.length < 3) bullets.push(`Read metrics against ${prof.industry || prof.sector || "sector"} peers.`);
      return {
        headline: `${prof.name || "This name"} — ${tone === "bullish" ? "constructive" : tone === "cautious" ? "cautious" : "balanced"} ${prof.industry || "fundamental"} profile.`,
        bullets: bullets.slice(0, 3),
        quality_chip: earn.beat_rate_pct >= 70 ? "Consistent reporter" : "Standard profile",
        tone,
        source: "rule_based",
      };
    },
    buildCatalystsStreetBuzz(C) {
      const news = C?.news || {};
      const count = Number(news.count) || 0;
      const dom = String(news.dominant_sentiment || "neutral");
      const top = news.top_catalyst?.headline || news.latest_3?.[0]?.headline;
      let vibe = count === 0 ? "quiet" : dom === "bullish" ? "bullish" : dom === "bearish" ? "bearish" : "mixed";
      return {
        vibe,
        headline: vibe === "quiet" ? "Street is quiet on this ticker." : vibe === "bullish" ? "Headlines lean constructive." : vibe === "bearish" ? "Headlines lean cautious." : "Mixed street buzz.",
        summary: top ? String(top).slice(0, 220) : (count > 0 ? `${count} filtered headlines in the last few days.` : "No ticker-specific headlines after relevance filtering."),
        top_drivers: top ? [String(top).slice(0, 100)] : [],
        freshness_note: "Headlines filtered to mention this symbol.",
        source: "rule_based",
      };
    },
    stageDisplayLabel(stage, context) {
      const s = String(stage || "").toLowerCase();
      const ctx = String(context || "trader").toLowerCase();
      const map = {
        setup: ctx === "investor" ? "On Watch" : "Setup",
        setup_watch: "Entry Watch",
        watch: ctx === "investor" ? "Watching" : "Watch for Entry",
        enter: "Enter",
        enter_now: "Enter Now",
        just_flipped: "Just Flipped",
        hold: "Holding",
        trim: "Trim",
        defend: "Defend",
        exit: "Exit",
        accumulate: "Accumulate",
        core_hold: "Core Hold",
        reduce: "Reduce",
        research_on_watch: "On Radar",
        research_low: "Low Conviction",
        research_avoid: "Avoid",
      };
      return map[s] || String(stage || "").replace(/_/g, " ") || "—";
    },
    /** Matches investor-panel.js — keep in sync with TTInvestorLane. */
    deriveInvestorActionTier(row) {
      if (window.TTInvestorLane?.deriveActionTier) return window.TTInvestorLane.deriveActionTier(row);
      const stage = String(row?.stage || "");
      if (stage !== "accumulate" && stage !== "reduce") return null;
      const owned = !!(row?.position?.owned);
      const simEligible = row?.simEligible === true;
      const inZone = !!(row?.accumZone?.inZone);
      const score = Number(row?.score) || 0;
      const lastTs = Number(row?.position?.last_action_ts) || 0;
      const lastType = String(row?.position?.last_action_type || "");
      const agoMs = lastTs > 0 ? Date.now() - lastTs : 0;
      const stale = owned && lastTs > 0 && agoMs > 7 * 86400000 && (
        (stage === "reduce" && lastType !== "SELL") ||
        (stage === "accumulate" && !["BUY", "DCA_BUY"].includes(lastType))
      );
      if (stale) return "stale";
      if (stage === "accumulate") {
        if (inZone && simEligible) return "act_now";
        if (simEligible || (inZone && score >= 65)) return "ready";
        return "monitor";
      }
      if (simEligible) return "act_now";
      if (owned) return "ready";
      return "monitor";
    },
    isInvestorExecuteReady(row) {
      if (window.TTInvestorLane?.isExecuteReady) return window.TTInvestorLane.isExecuteReady(row);
      const tier = window.TimedRailHelpers?.deriveInvestorActionTier?.(row);
      return tier === "act_now" || tier === "ready";
    },
    /** Normalize investor fields from /timed/investor/scores or /timed/all rows. */
    normalizeInvestorScoreRow(raw, sym) {
      const ticker = String(sym || raw?.ticker || "").toUpperCase();
      const stage = String(raw?.stage || raw?.investor_stage || raw?.investorStage || "").toLowerCase();
      return {
        ticker,
        stage,
        investor_stage: raw?.investor_stage || raw?.investorStage || raw?.stage || stage,
        score: raw?.score ?? raw?.investor_score,
        simEligible: raw?.simEligible ?? raw?.investor_sim_eligible,
        accumZone: raw?.accumZone || raw?.investor_accum_zone,
        position: raw?.position || raw?.investor_position,
        actionTier: raw?.actionTier || raw?.investor_action_tier,
        recentlyExited: raw?.recentlyExited,
      };
    },
    /** Cross-page Investor Buy Zone thesis — matches Today Ready Setups investor lane. */
    isInvestorBuyZoneThesis(raw, sym) {
      const row = window.TimedRailHelpers.normalizeInvestorScoreRow(raw, sym);
      const stage = String(row?.stage || "").toLowerCase();
      if (stage !== "accumulate") return false;
      if (stage === "exited" || (row?.recentlyExited && typeof row.recentlyExited === "object")) return false;
      const kanban = window.TimedRailHelpers.resolveInvestorKanbanStage(row);
      return kanban !== "research_avoid" && kanban !== "exited";
    },
    resolveInvestorKanbanStage(row) {
      if (window.TTInvestorLane?.resolveKanbanStage) return window.TTInvestorLane.resolveKanbanStage(row);
      let stage = String(row?.stage || "research_avoid");
      if (stage === "research") stage = "research_avoid";
      if (stage === "exited" || (row?.recentlyExited && typeof row.recentlyExited === "object")) {
        return "exited";
      }
      const owned = !!(row?.position?.owned);
      if (!owned) {
        if (stage === "core_hold" || stage === "watch") stage = "research_on_watch";
        else if (stage === "reduce") stage = "research_low";
      }
      if (stage === "accumulate" && !window.TimedRailHelpers.isInvestorExecuteReady(row)) {
        stage = owned ? "watch" : "research_on_watch";
      } else if (stage === "accumulate" && window.TimedRailHelpers.isInvestorExecuteReady(row)) {
        const lastType = String(row?.position?.last_action_type || "").toUpperCase();
        const entered = owned && (
          ["BUY", "DCA_BUY", "ADD"].includes(lastType)
          || (Number(row?.position?.first_entry_ts) || 0) > 0
        );
        stage = entered ? "accumulate_entered" : "accumulate_queued";
      }
      return stage;
    },
    INVESTOR_LANE_CHIP_META: {
      accumulate:        { label: "Accumulate",     chip: "ds-chip--up",     title: "Investor lane: execution-ready — buy zone + trend alignment." },
      core_hold:         { label: "Core Hold",      chip: "ds-chip--solid", title: "Investor lane: hold the core; add on meaningful pullbacks.", style: { color: "#60a5fa", borderColor: "rgba(96,165,250,0.30)", background: "rgba(96,165,250,0.10)" } },
      watch:             { label: "Hold & Watch",   chip: "ds-chip--solid", title: "Investor lane: owned — hold flat until the next signal.", style: { color: "#38F2A1", borderColor: "rgba(56,242,161,0.30)", background: "rgba(56,242,161,0.10)" } },
      reduce:            { label: "Reduce",         chip: "ds-chip--dn",    title: "Investor lane: trim on rebalance or invalidation." },
      research_on_watch: { label: "On Radar",       chip: "ds-chip--solid", title: "Investor lane: tracking — not execution-ready yet.", style: { color: "#a78bfa", borderColor: "rgba(167,139,250,0.30)", background: "rgba(167,139,250,0.10)" } },
      research_low:      { label: "Low Conviction", chip: "ds-chip--solid", title: "Investor lane: low conviction — pass for now.", style: { color: "#8AA39A", borderColor: "rgba(156,163,175,0.30)", background: "rgba(156,163,175,0.10)" } },
      research_avoid:    { label: "Avoid",          chip: "ds-chip--dn",    title: "Investor lane: multiple red flags — skip." },
      research:          { label: "Research",       chip: "ds-chip--solid", title: "Investor lane: under evaluation.", style: { color: "#8AA39A", borderColor: "rgba(156,163,175,0.30)", background: "rgba(156,163,175,0.10)" } },
      exited:            { label: "Exited",         chip: "ds-chip--solid", title: "Investor lane: position closed; monitor for re-entry.", style: { color: "#8AA39A", borderColor: "rgba(156,163,175,0.20)", background: "rgba(156,163,175,0.08)" } },
    },
    INVESTOR_TIER_CHIP_META: {
      act_now: { label: "ACT NOW", color: "#22c55e", title: "Execution-ready — model would open or add on the next rebalance." },
      ready:   { label: "READY",   color: "#4ade80", title: "Structural alignment — rebalance candidate." },
      monitor: { label: "MONITOR", color: "#6E867D", title: "Thesis signal only — not buying until the buy zone / trigger fires." },
      stale:   { label: "STALE",   color: "#f59e0b", title: "Signal active >7 days without a matching lot action." },
    },
    /** Strip third-party source branding from user-facing rail copy. */
    sanitizeUserFacingCopy(text) {
      if (text == null || text === "") return text;
      return String(text)
        .replace(/\bfsd_macro_risk_off\b/gi, "macro_risk_off")
        .replace(/\bfsd_macro_risk_on\b/gi, "macro_risk_on")
        .replace(/\bFSD\s*\/\s*/gi, "")
        .replace(/\bFSD\b/gi, "")
        .replace(/Fundstrat Direct/gi, "")
        .replace(/Fundstrat/gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/^\s*[·,\-–—]\s*/g, "")
        .trim();
    },
    /**
     * Single source for rail header + Snapshot investor POV.
     * displayStage = kanban lane (execution-aware); rawStage = classifier output.
     */
    buildInvestorDisplayContext(opts) {
      opts = opts || {};
      const sym = String(opts.tickerSymbol || opts.ticker?.ticker || opts.latestTicker?.ticker || "").trim().toUpperCase();
      const investorData = opts.investorData && String(opts.investorData.ticker || "").toUpperCase() === sym
        ? opts.investorData : null;
      const rawStage = String(
        investorData?.stage
        || opts.ticker?.investor_stage
        || opts.latestTicker?.investor_stage
        || ""
      ).toLowerCase();
      if (!rawStage || rawStage === "—") return null;

      const owned = !!(opts.effectiveInvestorTrade || investorData?.position?.owned);
      const row = {
        stage: rawStage,
        score: Number(investorData?.score ?? opts.ticker?.investor_score ?? opts.latestTicker?.investor_score) || 0,
        actionTier: investorData?.actionTier || null,
        simEligible: investorData?.simEligible === true,
        accumZone: investorData?.accumZone || null,
        position: {
          ...(investorData?.position || {}),
          owned,
          last_action_ts: investorData?.position?.last_action_ts,
          last_action_type: investorData?.position?.last_action_type,
        },
      };

      const H = window.TimedRailHelpers;
      const displayStage = H.resolveInvestorKanbanStage(row);
      const actionTier = row.actionTier || H.deriveInvestorActionTier(row);
      const executeReady = H.isInvestorExecuteReady(row);
      const laneMeta = H.INVESTOR_LANE_CHIP_META[displayStage] || H.INVESTOR_LANE_CHIP_META.watch;
      const tierMeta = actionTier ? H.INVESTOR_TIER_CHIP_META[actionTier] : null;
      const inBuyZone = !!(investorData?.accumZone?.inZone);

      const LANE_GUIDANCE = {
        accumulate: { laneLabel: "Accumulate", doNow: "The model scales in over 2–3 tranches inside the buy zone; no chasing extended moves." },
        core_hold: { laneLabel: "Core Hold", doNow: "The model holds the core; adds only on meaningful pullbacks if the buy zone triggers again." },
        watch: { laneLabel: "Hold & Watch", doNow: "The model holds flat and monitors signals; invalidation floor stays visible on the chart." },
        reduce: { laneLabel: "Reduce", doNow: "The model trims ~30% per reduce cycle (or exits fully on invalidation breach)." },
        research_on_watch: { laneLabel: "On Radar", doNow: "The model tracks the name; no capital deployment until execution-ready." },
        research_low: { laneLabel: "Low Conviction", doNow: "The model passes — better setups elsewhere in the universe." },
        research_avoid: { laneLabel: "Avoid", doNow: "The model skips — multiple red flags; no initiate or add." },
        exited: { laneLabel: "Exited", doNow: "The model monitors for a fresh Accumulate signal before re-entry." },
      };
      const displayGuide = LANE_GUIDANCE[displayStage] || LANE_GUIDANCE.watch;

      let signalNote = null;
      if (rawStage === "accumulate" && displayStage !== "accumulate") {
        signalNote = owned
          ? "Accumulate thesis — owned but not execution-ready; shown in Hold & Watch until the buy zone triggers."
          : "Accumulate thesis — tracking on On Radar until price enters the buy zone with trend alignment.";
      } else if (rawStage === "reduce" && displayStage !== "reduce") {
        signalNote = "Reduce thesis — not execution-ready on the Reduce lane yet.";
      }

      const statusLine = (() => {
        if (!owned && rawStage === "accumulate" && !executeReady) {
          if (inBuyZone) return "In buy zone but not fully aligned — model is monitoring, not buying yet.";
          return "Waiting for buy zone entry — no model position opened yet.";
        }
        if (owned && rawStage === "accumulate" && !executeReady) {
          return "Owned — accumulate signal active but model is not adding until the next trigger.";
        }
        return displayGuide.doNow;
      })();

      const laneLabel = displayGuide.laneLabel;
      return {
        sym,
        rawStage,
        displayStage,
        displayGuide,
        actionTier,
        executeReady,
        laneMeta,
        tierMeta,
        signalNote,
        statusLine,
        inBuyZone,
        owned,
        laneLabel,
        displayLabel: laneLabel,
        headerChipText: `Investor – ${laneLabel}`,
      };
    },
    buildTraderLaneCardProps(ticker, opts) {
      opts = opts || {};
      const t = ticker || {};
      const sym = String(t.ticker || "").toUpperCase();
      const stage = String(t.kanban_stage || t.stage || "").toLowerCase();
      const laneHead = opts.laneHead || null;
      const hideStageChip = !!laneHead;
      const hideRank = opts.hideRank || /hold|defend|trim|exit/.test(stage);
      const getDir = window.TimedRailHelpers?.getDirection || window.TimedBubbleChart?.getDirectionFromState;
      const dir = typeof getDir === "function" ? getDir(t) : null;
      const posture = String(t.posture_label || t.trader_posture_label || "").trim();
      const biasLabel = posture || (dir === "LONG" ? "Leaning bullish" : dir === "SHORT" ? "Leaning bearish" : "Neutral");
      return {
        sym,
        stageLabel: window.TimedRailHelpers?.stageDisplayLabel?.(stage, opts.context || "trader"),
        biasLabel,
        hideStageChip,
        hideRank,
        showSq: opts.showSq !== false,
      };
    },
  };

  /** Pre-entry kanban stages where posture lean may override HTF contract direction. */
  function isPreEntryTraderStage(stage) {
    const s = String(stage || "").toLowerCase();
    return ["watch", "setup", "setup_watch", "flip_watch", "monitor"].includes(s)
      || s.includes("setup");
  }

  function resolveTraderPlanDir(raw) {
    const d = String(raw || "").toUpperCase();
    return d === "LONG" || d === "SHORT" ? d : "";
  }

  function inferDirFromPlanLevels(px, pcSL, pcTargets) {
    const price = Number(px);
    const sl = Number(pcSL);
    if (!(price > 0) || !(sl > 0)) return "";
    const targets = Array.isArray(pcTargets) ? pcTargets : [];
    const tpBelow = targets.some((t) => Number(t?.price) > 0 && Number(t.price) < price);
    const tpAbove = targets.some((t) => Number(t?.price) > 0 && Number(t.price) > price);
    if (sl > price && tpBelow) return "SHORT";
    if (sl < price && tpAbove) return "LONG";
    return sl > price ? "SHORT" : "LONG";
  }

  function timingFavorsPostureOverContract(timing, postureDir, contractDir) {
    if (!timing || !postureDir || !contractDir || postureDir === contractDir) return false;
    const bias = String(timing.bias || "").toUpperCase();
    const posture = String(timing.posture || "").toUpperCase();
    const flash = String(timing.flash_headline || "").toLowerCase();
    if (postureDir === "LONG" && contractDir === "SHORT") {
      if (timing.add_on_dips || timing.long_opportunity || timing.call_opportunity) return true;
      if (bias === "COMPRESSION") return true;
      if (posture.includes("ACCUMULATE") || posture.includes("RALLY")) return true;
      if (flash.includes("avoid new shorts")) return true;
    }
    if (postureDir === "SHORT" && contractDir === "LONG") {
      if (timing.trim_winners || timing.short_opportunity || timing.put_opportunity) return true;
      if (bias === "EXTENSION") return true;
      if (flash.includes("avoid new longs")) return true;
    }
    return false;
  }

  /**
   * When posture lean conflicts with HTF contract on watch/setup, align the
   * displayed plan + Now tab to posture (LTF lean), keeping HTF as alternate.
   */
  function resolvePosturePlanConflict(opts) {
    opts = opts || {};
    const postureDir = resolveTraderPlanDir(opts.postureDir);
    const contractDir = resolveTraderPlanDir(opts.contractDir);
    const levelDir = resolveTraderPlanDir(opts.levelDir);
    const structuralDir = resolveTraderPlanDir(opts.structuralDir);
    const htfAltDir = contractDir || levelDir || structuralDir || "";
    const postureStrength = String(opts.postureStrength || "").toLowerCase();
    const isLean = postureStrength === "lean" || postureStrength === "";

    if (opts.tradeIsOpen) {
      return {
        alignToPosture: false,
        displayDir: htfAltDir || postureDir,
        htfAltDir: "",
        conflict: false,
      };
    }

    if (!isPreEntryTraderStage(opts.stage) || !postureDir || !htfAltDir || postureDir === htfAltDir) {
      return {
        alignToPosture: false,
        displayDir: htfAltDir || postureDir,
        htfAltDir: "",
        conflict: false,
      };
    }

    const timingOk = timingFavorsPostureOverContract(opts.timing, postureDir, htfAltDir);
    const alignToPosture = isLean && (timingOk || postureDir !== htfAltDir);
    return {
      alignToPosture,
      displayDir: alignToPosture ? postureDir : htfAltDir,
      htfAltDir: alignToPosture ? htfAltDir : "",
      conflict: alignToPosture,
    };
  }

  function roundPlanPx(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
  }

  /** Build LONG/SHORT-shaped SL + targets from structural levels when posture wins. */
  function buildPostureAlignedPlanLevels(opts) {
    opts = opts || {};
    const px = Number(opts.px);
    const displayDir = resolveTraderPlanDir(opts.displayDir);
    const pcSL = Number(opts.pcSL);
    const pcTargets = Array.isArray(opts.pcTargets) ? opts.pcTargets : [];
    const levels = Array.isArray(opts.levels) ? opts.levels : [];
    const ticker = opts.ticker || {};
    const atrRaw = Number(ticker.atr_d)
      || Number(ticker.atr_levels?.day?.atr)
      || Number(ticker.atr_levels?.D?.atr)
      || 0;
    const atr = Number.isFinite(atrRaw) && atrRaw > 0 ? atrRaw : 0;
    const htfAltDir = resolveTraderPlanDir(opts.htfAltDir);

    const supports = levels
      .filter((l) => l?.role === "support" && Number(l.price) > 0 && Number(l.price) < px)
      .sort((a, b) => Number(b.price) - Number(a.price));
    const resistances = levels
      .filter((l) => l?.role === "resistance" && Number(l.price) > px)
      .sort((a, b) => Number(a.price) - Number(b.price));

    if (displayDir === "LONG") {
      let sl = supports[0] ? Number(supports[0].price) : 0;
      if (!(sl > 0 && sl < px)) sl = atr > 0 ? roundPlanPx(px - atr) : roundPlanPx(px * 0.97);
      if (!(sl > 0 && sl < px)) sl = roundPlanPx(px * 0.97);

      const targets = [];
      const resistAbove = resistances.filter((r) => Number(r.price) > px);
      if (resistAbove.length >= 1) {
        targets.push({ label: "Trim", desc: resistAbove[0].label || "Resistance", price: roundPlanPx(resistAbove[0].price) });
      } else if (atr > 0) {
        targets.push({ label: "Trim", desc: "ATR +0.618", price: roundPlanPx(px + 0.618 * atr) });
      }
      if (resistAbove.length >= 2) {
        targets.push({ label: "Exit", desc: resistAbove[1].label || "Resistance", price: roundPlanPx(resistAbove[1].price) });
      } else if (atr > 0) {
        targets.push({ label: "Exit", desc: "ATR +1.0", price: roundPlanPx(px + 1.0 * atr) });
      }
      if (resistAbove.length >= 3) {
        targets.push({ label: "Runner", desc: resistAbove[2].label || "Resistance", price: roundPlanPx(resistAbove[2].price) });
      } else if (atr > 0 && targets.length < 3) {
        targets.push({ label: "Runner", desc: "ATR +1.618", price: roundPlanPx(px + 1.618 * atr) });
      }

      const invalidationLines = [
        `Close below $${sl.toFixed(2)} — bullish lean invalidates (support lost)`,
      ];
      let htfNote = null;
      if (pcSL > px && htfAltDir === "SHORT") {
        invalidationLines.push(
          `Sustained reclaim above $${roundPlanPx(pcSL).toFixed(2)} would shift bias toward the HTF short template`,
        );
        htfNote = `HTF alternate (not active): SHORT stop $${roundPlanPx(pcSL).toFixed(2)} above — fade zone if lean fails`;
      }
      return { sl, targets, invalidationLines, htfNote };
    }

    if (displayDir === "SHORT") {
      let sl = resistances[0] ? Number(resistances[0].price) : 0;
      if (!(sl > px)) sl = atr > 0 ? roundPlanPx(px + atr) : roundPlanPx(px * 1.03);
      if (!(sl > px)) sl = roundPlanPx(px * 1.03);

      const targets = [];
      const supportBelow = supports.filter((s) => Number(s.price) < px);
      if (supportBelow.length >= 1) {
        targets.push({ label: "Trim", desc: supportBelow[0].label || "Support", price: roundPlanPx(supportBelow[0].price) });
      } else if (atr > 0) {
        targets.push({ label: "Trim", desc: "ATR -0.618", price: roundPlanPx(px - 0.618 * atr) });
      }
      if (supportBelow.length >= 2) {
        targets.push({ label: "Exit", desc: supportBelow[1].label || "Support", price: roundPlanPx(supportBelow[1].price) });
      } else if (atr > 0) {
        targets.push({ label: "Exit", desc: "ATR -1.0", price: roundPlanPx(px - 1.0 * atr) });
      }
      if (supportBelow.length >= 3) {
        targets.push({ label: "Runner", desc: supportBelow[2].label || "Support", price: roundPlanPx(supportBelow[2].price) });
      } else if (atr > 0 && targets.length < 3) {
        targets.push({ label: "Runner", desc: "ATR -1.618", price: roundPlanPx(px - 1.618 * atr) });
      }

      const invalidationLines = [
        `Close above $${sl.toFixed(2)} — bearish lean invalidates (resistance reclaimed)`,
      ];
      let htfNote = null;
      if (pcSL > 0 && pcSL < px && htfAltDir === "LONG") {
        invalidationLines.push(
          `Close below $${roundPlanPx(pcSL).toFixed(2)} would shift bias toward the HTF long template`,
        );
        htfNote = `HTF alternate (not active): LONG stop $${roundPlanPx(pcSL).toFixed(2)} below`;
      }
      return { sl, targets, invalidationLines, htfNote };
    }

    return {
      sl: pcSL > 0 ? pcSL : 0,
      targets: pcTargets,
      invalidationLines: [],
      htfNote: null,
    };
  }

  function resolveTraderPlanDisplayContext(opts) {
    opts = opts || {};
    const px = Number(opts.px);
    if (!(px > 0)) return null;
    const pc = opts.predictionContract || {};
    const contractDir = resolveTraderPlanDir(pc.direction);
    const levelDir = inferDirFromPlanLevels(px, pc?.risk?.stop_loss, pc.targets);
    const postureDir = resolveTraderPlanDir(opts.postureDir || pc.posture_direction);
    const conflict = resolvePosturePlanConflict({
      stage: opts.stage,
      tradeIsOpen: !!opts.tradeIsOpen,
      postureDir,
      postureStrength: opts.postureStrength || pc.posture_strength,
      contractDir,
      levelDir,
      structuralDir: opts.structuralDir,
      timing: opts.timing,
    });

    let sl = Number(pc?.risk?.stop_loss) || 0;
    let targets = Array.isArray(pc.targets) ? pc.targets : [];
    let invalidationLines = Array.isArray(pc.invalidation) ? pc.invalidation.slice() : [];
    let htfNote = null;

    if (conflict.alignToPosture) {
      const aligned = buildPostureAlignedPlanLevels({
        px,
        displayDir: conflict.displayDir,
        pcSL: sl,
        pcTargets: targets,
        levels: pc.levels,
        ticker: opts.ticker,
        htfAltDir: conflict.htfAltDir,
      });
      sl = aligned.sl;
      targets = aligned.targets;
      invalidationLines = aligned.invalidationLines;
      htfNote = aligned.htfNote;
    }

    return {
      ...conflict,
      px,
      sl,
      targets,
      invalidationLines,
      htfNote,
      contractDir: contractDir || levelDir,
    };
  }

  // Investor + rail display helpers were appended inside TimedCTORead by mistake —
  // callers expect them on TimedRailHelpers (Today Ready Setups, Investor Brief).
  Object.assign(window.TimedRailHelpers, {
    isPreEntryTraderStage,
    resolveTraderPlanDir,
    inferDirFromPlanLevels,
    resolvePosturePlanConflict,
    buildPostureAlignedPlanLevels,
    resolveTraderPlanDisplayContext,
    stageDisplayLabel: window.TimedCTORead.stageDisplayLabel,
    deriveInvestorActionTier: window.TimedCTORead.deriveInvestorActionTier,
    isInvestorExecuteReady: window.TimedCTORead.isInvestorExecuteReady,
    normalizeInvestorScoreRow: window.TimedCTORead.normalizeInvestorScoreRow,
    isInvestorBuyZoneThesis: window.TimedCTORead.isInvestorBuyZoneThesis,
    resolveInvestorKanbanStage: window.TimedCTORead.resolveInvestorKanbanStage,
    INVESTOR_LANE_CHIP_META: window.TimedCTORead.INVESTOR_LANE_CHIP_META,
    INVESTOR_TIER_CHIP_META: window.TimedCTORead.INVESTOR_TIER_CHIP_META,
    sanitizeUserFacingCopy: window.TimedCTORead.sanitizeUserFacingCopy,
    buildInvestorDisplayContext: window.TimedCTORead.buildInvestorDisplayContext,
    buildTraderLaneCardProps: window.TimedCTORead.buildTraderLaneCardProps,
  });
})();

// cache-bust:1784753136177:241306926
