/**
 * Analyze which captured signals best predict “winner” outcomes.
 *
 * This script builds a dataset of candidate setup moments from stored trail points,
 * labels outcomes over a forward horizon (e.g. 4h / 1d), and scores signals by lift.
 *
 * Usage:
 *   node scripts/analyze-best-setups.js --days 30 --horizons 4h,1d
 *
 * Optional:
 *   --targetPct 3      (target move %, default depends on horizon)
 *   --stopPct 1.5      (adverse move %, default depends on horizon)
 *   --minGapMin 30     (dedupe candidates per ticker+type)
 *
 * Output:
 *   - docs/BEST_SETUPS_ANALYSIS.md
 *   - docs/BEST_SETUPS_ANALYSIS.json
 */
/* eslint-disable no-console */

const API_BASE =
  process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null) return fallback;
  return v;
}

const DAYS = Number(argValue("--days", "30"));
const HORIZONS_RAW = String(argValue("--horizons", "4h,1d") || "");
const TARGET_PCT_GLOBAL = Number(argValue("--targetPct", ""));
const STOP_PCT_GLOBAL = Number(argValue("--stopPct", ""));
const MIN_GAP_MIN = Number(argValue("--minGapMin", "30"));
const COMBO_MAX_K = Number(argValue("--comboMaxK", "2"));
const COMBO_MIN_N = Number(argValue("--comboMinN", "75"));
const COMBO_TOP = Number(argValue("--comboTop", "15"));

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : NaN;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeFlags(flags) {
  if (flags == null) return {};
  if (typeof flags === "object") return flags;
  if (typeof flags === "string") {
    const s = flags.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function boolish(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) return false;
    return s === "true" || s === "1" || s === "yes" || s === "y";
  }
  return false;
}

function flagOn(flags, key) {
  const f = normalizeFlags(flags);
  return boolish(f?.[key]);
}

function parseDurationMs(s) {
  const str = String(s || "").trim().toLowerCase();
  if (!str) return null;
  const m = str.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "m") return Math.round(n * 60 * 1000);
  if (unit === "h") return Math.round(n * 60 * 60 * 1000);
  if (unit === "d") return Math.round(n * 24 * 60 * 60 * 1000);
  if (unit === "w") return Math.round(n * 7 * 24 * 60 * 60 * 1000);
  return null;
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(2)}%`;
}

function fmtRate(p) {
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function fmtNum(n, d = 2) {
  if (!Number.isFinite(n)) return "—";
  return Number(n).toFixed(d);
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function fmtHorizon(ms) {
  const m = ms / 60000;
  if (m < 120) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  const d = h / 24;
  return `${Math.round(d * 10) / 10}d`;
}

function lowerBoundTs(points, tsTarget, idxHiExclusive) {
  // First index i where points[i].__ts >= tsTarget, within [0, idxHiExclusive).
  let lo = 0;
  let hi = Math.max(0, Number.isFinite(idxHiExclusive) ? idxHiExclusive : points.length);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = Number(points[mid]?.__ts);
    if (!Number.isFinite(ts) || ts < tsTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lookbackDeltas(points, idx0, lookbackMs) {
  const p0 = points[idx0];
  const t0 = Number(p0?.__ts);
  if (!Number.isFinite(t0) || !Number.isFinite(lookbackMs) || lookbackMs <= 0) return null;
  const idxHi = Math.max(0, idx0);
  if (idxHi <= 0) return null;
  const tsTarget = t0 - lookbackMs;
  const idx = lowerBoundTs(points, tsTarget, idxHi);
  // Use the earliest sample within the lookback window (but before idx0).
  const p1 = points[Math.min(idx, idxHi - 1)];
  if (!p1) return null;

  const htf0 = Number(p0?.htf_score);
  const ltf0 = Number(p0?.ltf_score);
  const px0 = Number(p0?.__price);
  const t1 = Number(p1?.__ts);
  const htf1 = Number(p1?.htf_score);
  const ltf1 = Number(p1?.ltf_score);
  const px1 = Number(p1?.__price);

  const dtMs = Number.isFinite(t1) ? t0 - t1 : null;
  const dHtf = Number.isFinite(htf0) && Number.isFinite(htf1) ? htf0 - htf1 : null;
  const dLtf = Number.isFinite(ltf0) && Number.isFinite(ltf1) ? ltf0 - ltf1 : null;
  const dPxPct = Number.isFinite(px0) && Number.isFinite(px1) && px1 > 0 ? (px0 - px1) / px1 : null;

  return {
    lookbackMs,
    t1: Number.isFinite(t1) ? t1 : null,
    dtMs,
    deltaHtf: dHtf,
    deltaLtf: dLtf,
    deltaPricePct: dPxPct,
  };
}

function withinMs(a, b, maxMs) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(maxMs)) return false;
  return Math.abs(a - b) <= maxMs;
}

function orderedWithin(a, b, maxMs) {
  // a -> b, with b after a, and within maxMs
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(maxMs)) return false;
  return b >= a && b - a <= maxMs;
}

function buildSignalDefs() {
  return [
    // Events
    { key: "corridor_entry", name: "Corridor entry (event)", pred: (r) => r.type === "corridor_entry" },
    { key: "squeeze_on", name: "Squeeze on (event)", pred: (r) => r.type === "squeeze_on" },
    { key: "squeeze_release", name: "Squeeze release (event)", pred: (r) => r.type === "squeeze_release" },
    { key: "setup_to_momentum", name: "Setup → Momentum (event)", pred: (r) => r.type === "setup_to_momentum" },
    { key: "ema_cross", name: "Trigger: EMA_CROSS (event)", pred: (r) => r.type === "trigger_EMA_CROSS" },
    { key: "tdseq", name: "Trigger: TDSEQ (event)", pred: (r) => r.type === "trigger_TDSEQ" },
    { key: "td9_bullish", name: "TD9 bullish (event)", pred: (r) => r.type === "td9_bullish" },
    { key: "td9_bearish", name: "TD9 bearish (event)", pred: (r) => r.type === "td9_bearish" },

    // Snapshot rules
    { key: "winner_sig", name: "Winner Signature (snapshot)", pred: (r) => r.features?.winnerSignature === true },
    { key: "prime_like", name: "Prime-like (snapshot)", pred: (r) => r.features?.primeLike === true },
    { key: "in_corridor", name: "In Corridor (snapshot)", pred: (r) => r.features?.inCorridor === true },
    { key: "q1", name: "Q1 (setup bull)", pred: (r) => r.features?.quadrant === "Q1" },
    { key: "q4", name: "Q4 (setup bear)", pred: (r) => r.features?.quadrant === "Q4" },

    // Sequence-based features (time since events)
    {
      key: "recent_corridor_60m",
      name: "Recent corridor entry (≤60m)",
      pred: (r) => r.features?.seq?.recentCorridorEntry_60m === true,
    },
    {
      key: "recent_squeeze_on_6h",
      name: "Recent squeeze on (≤6h)",
      pred: (r) => r.features?.seq?.recentSqueezeOn_6h === true,
    },
    {
      key: "recent_squeeze_rel_6h",
      name: "Recent squeeze release (≤6h)",
      pred: (r) => r.features?.seq?.recentSqueezeRelease_6h === true,
    },

    // Sequence patterns (ordered chains within windows)
    {
      key: "pat_corr_to_sqon_6h",
      name: "Pattern: corridor → squeeze on (≤6h)",
      pred: (r) => r.features?.seq?.patterns?.corridorToSqueezeOn_6h === true,
    },
    {
      key: "pat_sqon_to_rel_24h",
      name: "Pattern: squeeze on → release (≤24h)",
      pred: (r) => r.features?.seq?.patterns?.squeezeOnToRelease_24h === true,
    },
    {
      key: "pat_corr_to_rel_24h",
      name: "Pattern: corridor → squeeze release (≤24h)",
      pred: (r) => r.features?.seq?.patterns?.corridorToSqueezeRelease_24h === true,
    },
    {
      key: "pat_rel_to_momo_6h",
      name: "Pattern: squeeze release → momentum (≤6h)",
      pred: (r) => r.features?.seq?.patterns?.squeezeReleaseToMomentum_6h === true,
    },

    // Deltas (sequence dynamics)
    { key: "htf_improving_4h", name: "HTF improving (dir-aware, 4h)", pred: (r) => r.features?.deltas?.htfImproving4h === true },
    { key: "ltf_improving_4h", name: "LTF improving (dir-aware, 4h)", pred: (r) => r.features?.deltas?.ltfImproving4h === true },
    {
      key: "htf_ltf_improving_4h",
      name: "HTF + LTF improving (dir-aware, 4h)",
      pred: (r) => r.features?.deltas?.htfAndLtfImproving4h === true,
    },
    { key: "htf_move_4h_big", name: "|ΔHTF| ≥ 5 (4h)", pred: (r) => r.features?.deltas?.htfMove4h_big === true },
    { key: "ltf_move_4h_big", name: "|ΔLTF| ≥ 5 (4h)", pred: (r) => r.features?.deltas?.ltfMove4h_big === true },
    { key: "htf_improving_1d", name: "HTF improving (dir-aware, 1d)", pred: (r) => r.features?.deltas?.htfImproving1d === true },
  ];
}

function computeStatsForPredicate(rows, pred, baselineWinRate, winnersTotal) {
  let n = 0;
  let w = 0;
  for (const r of rows) {
    if (!pred(r)) continue;
    n++;
    if (r.label?.firstHit === "WIN") w++;
  }
  const winRate = n > 0 ? w / n : 0;
  const lift = baselineWinRate > 0 ? winRate / baselineWinRate : null;
  const coverage = rows.length > 0 ? n / rows.length : 0;
  const recall = winnersTotal > 0 ? w / winnersTotal : 0;
  const deltaWinRate = winRate - (baselineWinRate || 0);
  const deltaWins = w - n * (baselineWinRate || 0); // “incremental winners” vs baseline
  return { n, winners: w, winRate, lift, coverage, recall, deltaWinRate, deltaWins };
}

function mineCombos(rows, defs, k, { minN, topN, baselineWinRate, winnersTotal }) {
  const out = [];
  if (!Array.isArray(defs) || defs.length === 0) return out;
  const K = Math.max(2, Math.min(3, Math.floor(k)));
  const minCount = Math.max(1, Math.floor(minN || 1));
  const take = Math.max(1, Math.floor(topN || 10));

  const indices = defs.map((_, i) => i);

  if (K === 2) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const da = defs[indices[a]];
        const db = defs[indices[b]];
        const pred = (r) => da.pred(r) && db.pred(r);
        const s = computeStatsForPredicate(rows, pred, baselineWinRate, winnersTotal);
        if (s.n < minCount) continue;
        out.push({
          keys: [da.key, db.key],
          name: `${da.name} + ${db.name}`,
          ...s,
        });
      }
    }
  } else if (K === 3) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        for (let c = b + 1; c < indices.length; c++) {
          const d1 = defs[indices[a]];
          const d2 = defs[indices[b]];
          const d3 = defs[indices[c]];
          const pred = (r) => d1.pred(r) && d2.pred(r) && d3.pred(r);
          const s = computeStatsForPredicate(rows, pred, baselineWinRate, winnersTotal);
          if (s.n < minCount) continue;
          out.push({
            keys: [d1.key, d2.key, d3.key],
            name: `${d1.name} + ${d2.name} + ${d3.name}`,
            ...s,
          });
        }
      }
    }
  }

  out.sort((x, y) => {
    const lx = x.lift || 0;
    const ly = y.lift || 0;
    if (ly !== lx) return ly - lx;
    if (y.winRate !== x.winRate) return y.winRate - x.winRate;
    return (y.n || 0) - (x.n || 0);
  });

  return out.slice(0, take);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function getTickers() {
  const json = await fetchJson(`${API_BASE}/timed/tickers?_t=${Date.now()}`);
  const list = Array.isArray(json?.tickers) ? json.tickers : Array.isArray(json) ? json : [];
  return list.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean);
}

async function getTrail(ticker, sinceMs) {
  const qs = new URLSearchParams();
  qs.set("ticker", ticker);
  qs.set("limit", "5000");
  if (Number.isFinite(sinceMs)) qs.set("since", String(sinceMs));
  const json = await fetchJson(`${API_BASE}/timed/trail?${qs.toString()}`);
  const trail = Array.isArray(json?.trail) ? json.trail : Array.isArray(json?.data) ? json.data : [];
  const pts = trail
    .map((p) => {
      const ts = toMs(p?.ts ?? p?.timestamp ?? p?.ingest_ts ?? p?.ingest_time);
      const price = Number(p?.price);
      if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return null;
      return {
        ...p,
        __ts: ts,
        __price: price,
        __flags: normalizeFlags(p?.flags),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.__ts - b.__ts);
  return pts;
}

// Corridor ranges match the dashboard/worker conventions
const LONG_CORRIDOR = { ltfMin: -8, ltfMax: 12 };
const SHORT_CORRIDOR = { ltfMin: -12, ltfMax: 8 };

function entryTypeFromScores(htf, ltf) {
  const h = Number(htf);
  const l = Number(ltf);
  if (!Number.isFinite(h) || !Number.isFinite(l)) return { corridor: false, side: null };
  if (h > 0 && l >= LONG_CORRIDOR.ltfMin && l <= LONG_CORRIDOR.ltfMax) return { corridor: true, side: "LONG" };
  if (h < 0 && l >= SHORT_CORRIDOR.ltfMin && l <= SHORT_CORRIDOR.ltfMax) return { corridor: true, side: "SHORT" };
  return { corridor: false, side: null };
}

function directionForPoint(p) {
  const st = String(p?.state || "");
  if (st.includes("BEAR")) return "SHORT";
  if (st.includes("BULL")) return "LONG";
  const htf = Number(p?.htf_score);
  if (Number.isFinite(htf) && htf < 0) return "SHORT";
  if (Number.isFinite(htf) && htf > 0) return "LONG";
  return null;
}

function quadrantForState(state) {
  const s = String(state || "");
  if (s === "HTF_BULL_LTF_PULLBACK") return "Q1";
  if (s === "HTF_BULL_LTF_BULL") return "Q2";
  if (s === "HTF_BEAR_LTF_BEAR") return "Q3";
  if (s === "HTF_BEAR_LTF_PULLBACK") return "Q4";
  return "OTHER";
}

function isWinnerSignatureSnapshot(p) {
  const flags = normalizeFlags(p?.flags ?? p?.__flags);
  const state = String(p?.state || "");
  const isSetup = state.includes("PULLBACK");
  const ent = entryTypeFromScores(p?.htf_score, p?.ltf_score);
  const inCorridor = !!ent?.corridor;
  const comp = Number(p?.completion);
  const completion = Number.isFinite(comp) ? clamp(comp, 0, 1) : 0;
  const phase = Number(p?.phase_pct);
  const phasePct = Number.isFinite(phase) ? clamp(phase, 0, 1) : 0;
  const inSqueeze = flagOn(flags, "sq30_on") && !flagOn(flags, "sq30_release");
  return isSetup && inCorridor && completion < 0.15 && (phasePct < 0.6 || inSqueeze);
}

function isPrimeLikeSnapshot(p) {
  // “Prime-like” from trail snapshot fields (rank + phase/completion + corridor + aligned/flags).
  const flags = normalizeFlags(p?.flags ?? p?.__flags);
  const state = String(p?.state || "");
  const ent = entryTypeFromScores(p?.htf_score, p?.ltf_score);
  const inCorridor = !!ent?.corridor;
  const rank = Number(p?.rank);
  const completion = clamp(Number(p?.completion) || 0, 0, 1);
  const phase = clamp(Number(p?.phase_pct) || 0, 0, 1);
  const aligned = state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const sqRel = flagOn(flags, "sq30_release");
  const phaseZoneChange = flagOn(flags, "phase_zone_change");
  return (
    inCorridor &&
    (Number.isFinite(rank) ? rank >= 75 : false) &&
    completion < 0.4 &&
    phase < 0.6 &&
    (aligned || sqRel || phaseZoneChange)
  );
}

function defaultThresholdsForHorizonMs(hMs) {
  // Conservative defaults; can override with --targetPct/--stopPct.
  if (Number.isFinite(TARGET_PCT_GLOBAL) && Number.isFinite(STOP_PCT_GLOBAL)) {
    return { targetPct: TARGET_PCT_GLOBAL, stopPct: STOP_PCT_GLOBAL };
  }
  const hours = hMs / (60 * 60 * 1000);
  if (hours <= 6) return { targetPct: 3.0, stopPct: 1.5 };
  if (hours <= 30) return { targetPct: 5.0, stopPct: 2.5 };
  return { targetPct: 8.0, stopPct: 3.5 };
}

function labelOutcome(points, idx0, horizonMs, targetPct, stopPct) {
  const p0 = points[idx0];
  const entryPrice = Number(p0?.__price);
  const t0 = Number(p0?.__ts);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(t0)) return null;

  const dir = directionForPoint(p0);
  if (!dir) return null;
  const target = targetPct / 100;
  const stop = stopPct / 100;

  let firstHit = null; // "WIN" | "LOSS"
  let firstHitTs = null;
  let maxFav = 0;
  let maxAdv = 0;

  for (let i = idx0 + 1; i < points.length; i++) {
    const p = points[i];
    const ts = Number(p?.__ts);
    if (!Number.isFinite(ts)) continue;
    if (ts > t0 + horizonMs) break;
    const price = Number(p?.__price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const up = (price - entryPrice) / entryPrice;
    const down = (entryPrice - price) / entryPrice;
    const fav = dir === "LONG" ? up : down;
    const adv = dir === "LONG" ? down : up;
    if (Number.isFinite(fav)) maxFav = Math.max(maxFav, fav);
    if (Number.isFinite(adv)) maxAdv = Math.max(maxAdv, adv);

    if (!firstHit) {
      if (fav >= target) {
        firstHit = "WIN";
        firstHitTs = ts;
      } else if (adv >= stop) {
        firstHit = "LOSS";
        firstHitTs = ts;
      }
    }
  }

  return {
    dir,
    entryPrice,
    t0,
    horizonMs,
    targetPct,
    stopPct,
    firstHit,
    firstHitTs,
    maxFav,
    maxAdv,
  };
}

function candidateTypesFromPoint(p, prev) {
  const flags = normalizeFlags(p?.__flags ?? p?.flags);
  const flagsPrev = normalizeFlags(prev?.__flags ?? prev?.flags);
  const htf = Number(p?.htf_score);
  const ltf = Number(p?.ltf_score);
  const ent = entryTypeFromScores(htf, ltf);
  const entPrev = entryTypeFromScores(prev?.htf_score, prev?.ltf_score);

  const st = String(p?.state || "");
  const stPrev = String(prev?.state || "");
  const isPullback = st.includes("PULLBACK");
  const wasPullback = stPrev.includes("PULLBACK");
  const isMomentum = (st.includes("LTF_BULL") || st.includes("LTF_BEAR")) && !isPullback;

  const types = [];
  if (!entPrev.corridor && ent.corridor) types.push("corridor_entry");
  if (flagOn(flags, "sq30_on") && !flagOn(flagsPrev, "sq30_on")) types.push("squeeze_on");
  if (flagOn(flags, "sq30_release") && !flagOn(flagsPrev, "sq30_release")) types.push("squeeze_release");
  if (wasPullback && isMomentum) types.push("setup_to_momentum");

  // Trigger reason changes (captures EMA_CROSS/TDSEQ/etc. when present)
  const trig = String(p?.trigger_reason || "").trim().toUpperCase();
  const trigPrev = String(prev?.trigger_reason || "").trim().toUpperCase();
  if (trig && trig !== trigPrev) types.push(`trigger_${trig}`);

  // TD9 events if present
  const td = p?.td_sequential || {};
  const tdPrev = prev?.td_sequential || {};
  const td9Bull = boolish(td?.td9_bullish);
  const td9Bear = boolish(td?.td9_bearish);
  const td9BullPrev = boolish(tdPrev?.td9_bullish);
  const td9BearPrev = boolish(tdPrev?.td9_bearish);
  if (td9Bull && !td9BullPrev) types.push("td9_bullish");
  if (td9Bear && !td9BearPrev) types.push("td9_bearish");

  return types;
}

function buildCandidatesForTicker(ticker, points, minGapMs) {
  const out = [];
  const lastByTypeTs = new Map(); // type -> ts
  const lastEventTs = new Map(); // base event type -> ts (not deduped)
  const BASE_EVENTS = ["corridor_entry", "squeeze_on", "squeeze_release", "setup_to_momentum"];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const ts = Number(p?.__ts);
    if (!Number.isFinite(ts)) continue;
    const types = candidateTypesFromPoint(p, prev);
    if (types.length === 0) continue;

    // Always update base-event “last seen” timestamps (even if the candidate is deduped).
    for (const be of BASE_EVENTS) {
      if (types.includes(be)) lastEventTs.set(be, ts);
    }

    const seq = {
      lastCorridorEntryTs: lastEventTs.get("corridor_entry") ?? null,
      lastSqueezeOnTs: lastEventTs.get("squeeze_on") ?? null,
      lastSqueezeReleaseTs: lastEventTs.get("squeeze_release") ?? null,
      lastSetupToMomentumTs: lastEventTs.get("setup_to_momentum") ?? null,
    };

    for (const type of types) {
      const lastTs = lastByTypeTs.get(type);
      if (Number.isFinite(lastTs) && ts - lastTs < minGapMs) continue;
      lastByTypeTs.set(type, ts);
      out.push({ ticker, idx: i, ts, type, seq });
    }
  }
  return out;
}

function scoreSignals(rows, horizonLabel) {
  const total = rows.length || 1;
  const winners = rows.filter((r) => r.label?.firstHit === "WIN").length;
  const baseline = winners / total;

  const defs = buildSignalDefs();
  const scored = defs
    .map((d) => {
      const s = computeStatsForPredicate(rows, d.pred, baseline, winners);
      return { key: d.key, name: d.name, ...s };
    })
    .sort((a, b) => (b.lift || 0) - (a.lift || 0));

  // Only include defs with some evidence for combo mining
  const minN = Math.max(5, Math.floor(COMBO_MIN_N));
  const eligible = defs.filter((d) => {
    const s = scored.find((x) => x.key === d.key);
    return (s?.n || 0) >= minN;
  });

  const combos = {};
  const maxK = Math.max(1, Math.min(3, Math.floor(COMBO_MAX_K)));
  const topN = Math.max(1, Math.floor(COMBO_TOP));
  if (maxK >= 2) combos.k2 = mineCombos(rows, eligible, 2, { minN, topN, baselineWinRate: baseline, winnersTotal: winners });
  if (maxK >= 3) combos.k3 = mineCombos(rows, eligible, 3, { minN, topN, baselineWinRate: baseline, winnersTotal: winners });

  // Shortlist-ready: rank by incremental winners (balances lift + coverage/recall).
  const shortlistSingles = scored
    .filter((s) => (s?.n || 0) >= minN && (s?.deltaWins || 0) > 0)
    .slice()
    .sort((a, b) => (b.deltaWins || 0) - (a.deltaWins || 0))
    .slice(0, 12);

  function shortlistFromCombos(list) {
    return (Array.isArray(list) ? list : [])
      .filter((c) => (c?.n || 0) >= minN && (c?.deltaWins || 0) > 0)
      .slice()
      .sort((a, b) => (b.deltaWins || 0) - (a.deltaWins || 0))
      .slice(0, 12);
  }

  const shortlistCombos = {
    k2: shortlistFromCombos(combos.k2),
    k3: shortlistFromCombos(combos.k3),
  };

  return {
    horizon: horizonLabel,
    total,
    winners,
    baselineWinRate: baseline,
    signals: scored,
    combos,
    comboParams: { maxK, minN, topN },
    shortlist: { singles: shortlistSingles, combos: shortlistCombos },
  };
}

function toMarkdown(summary, meta) {
  const lines = [];
  lines.push(`# Best Setups Analysis`);
  lines.push(``);
  lines.push(`Source: \`${API_BASE}\``);
  lines.push(`Window: last **${meta.days}** days`);
  lines.push(`Candidates: **event moments** (corridor entry, squeeze, TD9, setup→momentum) deduped by ${meta.minGapMin}m`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## What this is`);
  lines.push(`This report scores which **signals** (events + snapshot rules) best predict a “winner” outcome over forward horizons.`);
  lines.push(`A “winner” means **target% move happens before stop% adverse move** within the horizon window.`);
  lines.push(`Sequence context is included via **time-since-event** and **HTF/LTF delta** features (4h + 1d lookbacks).`);
  lines.push(``);

  for (const s of summary) {
    lines.push(`## Horizon: ${s.horizon}`);
    lines.push(`- Baseline win rate: **${fmtRate(s.baselineWinRate)}** (${s.winners}/${s.total})`);
    lines.push(``);
    lines.push(`| Signal | N | Coverage | Win rate | Lift | Recall |`);
    lines.push(`|:--|--:|--:|--:|--:|--:|`);
    for (const row of s.signals.slice(0, 12)) {
      lines.push(
        `| ${row.name} | ${row.n} | ${fmtRate(row.coverage)} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} |`
      );
    }
    lines.push(``);

    const cp = s.comboParams || {};
    const k2 = Array.isArray(s?.combos?.k2) ? s.combos.k2 : [];
    const k3 = Array.isArray(s?.combos?.k3) ? s.combos.k3 : [];

    if (k2.length > 0) {
      lines.push(`### Top combos (k=2, minN=${cp.minN}, top=${cp.topN})`);
      lines.push(`| Combo | N | Coverage | Win rate | Lift | Recall |`);
      lines.push(`|:--|--:|--:|--:|--:|--:|`);
      for (const row of k2) {
        lines.push(
          `| ${row.name} | ${row.n} | ${fmtRate(row.coverage)} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} |`
        );
      }
      lines.push(``);
    }

    if (k3.length > 0) {
      lines.push(`### Top combos (k=3, minN=${cp.minN}, top=${cp.topN})`);
      lines.push(`| Combo | N | Coverage | Win rate | Lift | Recall |`);
      lines.push(`|:--|--:|--:|--:|--:|--:|`);
      for (const row of k3) {
        lines.push(
          `| ${row.name} | ${row.n} | ${fmtRate(row.coverage)} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} |`
        );
      }
      lines.push(``);
    }

    const ss = s.shortlist || {};
    const ssSingles = Array.isArray(ss?.singles) ? ss.singles : [];
    const ssK2 = Array.isArray(ss?.combos?.k2) ? ss.combos.k2 : [];
    const ssK3 = Array.isArray(ss?.combos?.k3) ? ss.combos.k3 : [];

    lines.push(`### Shortlist-ready (balances lift + recall)`);
    lines.push(
      `Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).`
    );
    lines.push(``);

    if (ssSingles.length > 0) {
      lines.push(`#### Singles (top by ΔWins)`);
      lines.push(`| Signal | N | Win rate | Lift | Recall | ΔWins |`);
      lines.push(`|:--|--:|--:|--:|--:|--:|`);
      for (const row of ssSingles) {
        lines.push(
          `| ${row.name} | ${row.n} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} | ${fmtNum(row.deltaWins, 1)} |`
        );
      }
      lines.push(``);
    } else {
      lines.push(`#### Singles (top by ΔWins)`);
      lines.push(`(No singles exceeded baseline with minN=${cp.minN})`);
      lines.push(``);
    }

    if (ssK2.length > 0) {
      lines.push(`#### Combos k=2 (top by ΔWins)`);
      lines.push(`| Combo | N | Win rate | Lift | Recall | ΔWins |`);
      lines.push(`|:--|--:|--:|--:|--:|--:|`);
      for (const row of ssK2) {
        lines.push(
          `| ${row.name} | ${row.n} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} | ${fmtNum(row.deltaWins, 1)} |`
        );
      }
      lines.push(``);
    }

    if (ssK3.length > 0) {
      lines.push(`#### Combos k=3 (top by ΔWins)`);
      lines.push(`| Combo | N | Win rate | Lift | Recall | ΔWins |`);
      lines.push(`|:--|--:|--:|--:|--:|--:|`);
      for (const row of ssK3) {
        lines.push(
          `| ${row.name} | ${row.n} | ${fmtRate(row.winRate)} | ${row.lift == null ? "—" : fmtNum(row.lift, 2)} | ${fmtRate(row.recall)} | ${fmtNum(row.deltaWins, 1)} |`
        );
      }
      lines.push(``);
    }
  }

  lines.push(`## Notes / Next upgrades`);
  lines.push(`- Add richer **sequence mining** (multi-event combos, e.g. corridor entry → squeeze on → release within \(X\) hours).`);
  lines.push(`- Add **trade-relative labels** (+1R/+2R before -1R) once SL/entry reference fields are consistently available in trail points.`);
  lines.push(`- Once we have more history, train a lightweight model to output a **win probability** and drive a “Best Setups” tag in the UI.`);
  lines.push(``);
  return lines.join("\n");
}

async function main() {
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error("bad --days");
  const horizons = HORIZONS_RAW.split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => ({ raw: x, ms: parseDurationMs(x) }))
    .filter((x) => Number.isFinite(x.ms));
  if (horizons.length === 0) throw new Error("bad --horizons (use like 4h,1d)");

  const minGapMs = Math.max(0, (Number.isFinite(MIN_GAP_MIN) ? MIN_GAP_MIN : 30) * 60 * 1000);
  const sinceMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const LOOKBACK_4H = 4 * 60 * 60 * 1000;
  const LOOKBACK_1D = 24 * 60 * 60 * 1000;
  const H1 = 60 * 60 * 1000;

  const tickers = await getTickers();
  console.log(`[best-setups] tickers=${tickers.length} days=${DAYS} horizons=${horizons.map((h) => h.raw).join(",")}`);

  const allRowsByHorizon = new Map(); // raw -> rows[]
  horizons.forEach((h) => allRowsByHorizon.set(h.raw, []));

  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    try {
      const pts = await getTrail(sym, sinceMs);
      if (!pts || pts.length < 5) continue;

      const candidates = buildCandidatesForTicker(sym, pts, minGapMs);
      for (const c of candidates) {
        const p = pts[c.idx];
        const ent = entryTypeFromScores(p?.htf_score, p?.ltf_score);
        const dir = directionForPoint(p);
        const seq = c.seq || {};
        const since = {
          corridorEntryMs:
            Number.isFinite(seq?.lastCorridorEntryTs) ? Math.max(0, c.ts - seq.lastCorridorEntryTs) : null,
          squeezeOnMs: Number.isFinite(seq?.lastSqueezeOnTs) ? Math.max(0, c.ts - seq.lastSqueezeOnTs) : null,
          squeezeReleaseMs:
            Number.isFinite(seq?.lastSqueezeReleaseTs) ? Math.max(0, c.ts - seq.lastSqueezeReleaseTs) : null,
          setupToMomentumMs:
            Number.isFinite(seq?.lastSetupToMomentumTs) ? Math.max(0, c.ts - seq.lastSetupToMomentumTs) : null,
        };

        const deltas4h = lookbackDeltas(pts, c.idx, LOOKBACK_4H);
        const deltas1d = lookbackDeltas(pts, c.idx, LOOKBACK_1D);

        const features = {
          dir,
          quadrant: quadrantForState(p?.state),
          inCorridor: !!ent?.corridor,
          squeezeOn: flagOn(p?.__flags, "sq30_on"),
          squeezeRelease: flagOn(p?.__flags, "sq30_release"),
          momentumElite: flagOn(p?.__flags, "momentum_elite"),
          winnerSignature: isWinnerSignatureSnapshot(p),
          primeLike: isPrimeLikeSnapshot(p),
          rank: Number(p?.rank),
          trigger_reason: String(p?.trigger_reason || "").trim().toUpperCase() || null,
          trigger_dir: String(p?.trigger_dir || "").trim().toUpperCase() || null,
          completion: Number(p?.completion),
          phase_pct: Number(p?.phase_pct),
          seq: {
            lastCorridorEntryTs: seq?.lastCorridorEntryTs ?? null,
            lastSqueezeOnTs: seq?.lastSqueezeOnTs ?? null,
            lastSqueezeReleaseTs: seq?.lastSqueezeReleaseTs ?? null,
            lastSetupToMomentumTs: seq?.lastSetupToMomentumTs ?? null,
            since,
            // Handy derived buckets for the report
            recentCorridorEntry_60m: since.corridorEntryMs != null && since.corridorEntryMs <= 60 * 60 * 1000,
            recentCorridorEntry_3h: since.corridorEntryMs != null && since.corridorEntryMs <= 3 * 60 * 60 * 1000,
            recentSqueezeOn_6h: since.squeezeOnMs != null && since.squeezeOnMs <= 6 * 60 * 60 * 1000,
            recentSqueezeOn_24h: since.squeezeOnMs != null && since.squeezeOnMs <= 24 * 60 * 60 * 1000,
            recentSqueezeRelease_6h: since.squeezeReleaseMs != null && since.squeezeReleaseMs <= 6 * 60 * 60 * 1000,
            recentSqueezeRelease_24h: since.squeezeReleaseMs != null && since.squeezeReleaseMs <= 24 * 60 * 60 * 1000,
            patterns: {
              corridorToSqueezeOn_6h: orderedWithin(seq?.lastCorridorEntryTs, seq?.lastSqueezeOnTs, 6 * H1),
              corridorToSqueezeOn_24h: orderedWithin(seq?.lastCorridorEntryTs, seq?.lastSqueezeOnTs, 24 * H1),
              squeezeOnToRelease_6h: orderedWithin(seq?.lastSqueezeOnTs, seq?.lastSqueezeReleaseTs, 6 * H1),
              squeezeOnToRelease_24h: orderedWithin(seq?.lastSqueezeOnTs, seq?.lastSqueezeReleaseTs, 24 * H1),
              corridorToSqueezeRelease_24h: orderedWithin(seq?.lastCorridorEntryTs, seq?.lastSqueezeReleaseTs, 24 * H1),
              squeezeReleaseToMomentum_6h: orderedWithin(seq?.lastSqueezeReleaseTs, seq?.lastSetupToMomentumTs, 6 * H1),
              squeezeReleaseToMomentum_24h: orderedWithin(seq?.lastSqueezeReleaseTs, seq?.lastSetupToMomentumTs, 24 * H1),
              squeezeReleaseNearCorridor_60m: withinMs(seq?.lastSqueezeReleaseTs, seq?.lastCorridorEntryTs, 60 * 60 * 1000),
            },
          },
          deltas: {
            "4h": deltas4h,
            "1d": deltas1d,
            // Direction-aware “improving” flags
            htfImproving4h:
              !!dir &&
              Number.isFinite(deltas4h?.deltaHtf) &&
              ((dir === "LONG" && deltas4h.deltaHtf > 0) || (dir === "SHORT" && deltas4h.deltaHtf < 0)),
            ltfImproving4h:
              !!dir &&
              Number.isFinite(deltas4h?.deltaLtf) &&
              ((dir === "LONG" && deltas4h.deltaLtf > 0) || (dir === "SHORT" && deltas4h.deltaLtf < 0)),
            htfImproving1d:
              !!dir &&
              Number.isFinite(deltas1d?.deltaHtf) &&
              ((dir === "LONG" && deltas1d.deltaHtf > 0) || (dir === "SHORT" && deltas1d.deltaHtf < 0)),
            ltfImproving1d:
              !!dir &&
              Number.isFinite(deltas1d?.deltaLtf) &&
              ((dir === "LONG" && deltas1d.deltaLtf > 0) || (dir === "SHORT" && deltas1d.deltaLtf < 0)),
            // Magnitude-ish versions
            htfMove4h_big: Number.isFinite(deltas4h?.deltaHtf) && Math.abs(deltas4h.deltaHtf) >= 5,
            ltfMove4h_big: Number.isFinite(deltas4h?.deltaLtf) && Math.abs(deltas4h.deltaLtf) >= 5,
            htfMove1d_big: Number.isFinite(deltas1d?.deltaHtf) && Math.abs(deltas1d.deltaHtf) >= 8,
            ltfMove1d_big: Number.isFinite(deltas1d?.deltaLtf) && Math.abs(deltas1d.deltaLtf) >= 8,
            // Helpful combined flag
            htfAndLtfImproving4h:
              !!dir &&
              Number.isFinite(deltas4h?.deltaHtf) &&
              Number.isFinite(deltas4h?.deltaLtf) &&
              ((dir === "LONG" && deltas4h.deltaHtf > 0 && deltas4h.deltaLtf > 0) ||
                (dir === "SHORT" && deltas4h.deltaHtf < 0 && deltas4h.deltaLtf < 0)),
          },
        };

        for (const h of horizons) {
          const { targetPct, stopPct } = defaultThresholdsForHorizonMs(h.ms);
          const label = labelOutcome(pts, c.idx, h.ms, targetPct, stopPct);
          if (!label) continue;
          allRowsByHorizon.get(h.raw).push({
            ticker: sym,
            ts: c.ts,
            type: c.type,
            state: String(p?.state || ""),
            price: Number(p?.__price),
            features,
            label,
          });
        }
      }
    } catch (e) {
      console.warn(`[best-setups] ${sym} failed: ${String(e?.message || e)}`);
    }
    if ((i + 1) % 20 === 0) console.log(`[best-setups] progress ${i + 1}/${tickers.length}`);
  }

  const summary = [];
  for (const h of horizons) {
    const rows = allRowsByHorizon.get(h.raw) || [];
    summary.push(scoreSignals(rows, h.raw));
  }

  const meta = {
    apiBase: API_BASE,
    days: DAYS,
    horizons: horizons.map((h) => h.raw),
    minGapMin: MIN_GAP_MIN,
    targetPctGlobal: Number.isFinite(TARGET_PCT_GLOBAL) ? TARGET_PCT_GLOBAL : null,
    stopPctGlobal: Number.isFinite(STOP_PCT_GLOBAL) ? STOP_PCT_GLOBAL : null,
    comboParams: {
      maxK: Math.max(1, Math.min(3, Math.floor(COMBO_MAX_K))),
      minN: Math.max(5, Math.floor(COMBO_MIN_N)),
      topN: Math.max(1, Math.floor(COMBO_TOP)),
    },
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  const md = toMarkdown(summary, meta);
  await fs.writeFile("docs/BEST_SETUPS_ANALYSIS.md", md, "utf-8");
  await fs.writeFile(
    "docs/BEST_SETUPS_ANALYSIS.json",
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        meta,
        summary,
        // Keep raw rows in JSON for deeper analysis downstream (but avoid huge size by omitting per-point arrays)
        rowsByHorizon: Object.fromEntries(Array.from(allRowsByHorizon.entries())),
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`[best-setups] wrote docs/BEST_SETUPS_ANALYSIS.md and .json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

