#!/usr/bin/env node
/**
 * TSLA last-week → this-week movie.
 *
 * Reconstructs what was observable on M/W/D/4H/1H from the week of Aug 3
 * through Friday Aug 21 2026: SuperTrend, 21/50/233 EMA, TD Sequential,
 * Saty Phase, range breaks. Does not invent a new detector — it walks
 * the same series the book already has.
 *
 *   node scripts/tsla-week-movie.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectEma233ReclaimFromSeries } from "../worker/supertrend-hold.js";
import { satyPhaseSeries } from "../worker/indicators.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, "data", "st-hold-scan", "cache");
const OUT = join(ROOT, "data", "tsla-week-movie");

const BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const UA = "Mozilla/5.0 (compatible; TimedTradingTslaMovie/1.0)";

const FROM = Date.parse("2026-08-03T00:00:00Z");
const LAST_WEEK = Date.parse("2026-08-10T00:00:00Z");
const THIS_WEEK = Date.parse("2026-08-17T00:00:00Z");
const END = Date.parse("2026-08-22T00:00:00Z");

function iso(t) {
  return t ? new Date(t).toISOString().slice(0, 10) : null;
}
function isoT(t) {
  return t ? new Date(t).toISOString().replace(".000Z", "Z") : null;
}
function r(n, d = 2) {
  return Number.isFinite(n) ? +Number(n).toFixed(d) : null;
}

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (!closes || closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rmaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 1 / period;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (Number.isFinite(values[i]) ? values[i] : 0);
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    out[i] = alpha * v + (1 - alpha) * out[i - 1];
  }
  return out;
}

function atrSeries(bars, period = 14) {
  const tr = new Array(bars.length).fill(NaN);
  if (!bars.length) return tr;
  tr[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
  }
  return rmaSeries(tr, period);
}

function superTrendSeries(bars, factor = 3.0, atrLen = 10) {
  const n = bars.length;
  const line = new Array(n).fill(NaN);
  const dir = new Array(n).fill(0);
  const atr = atrSeries(bars, atrLen);
  const upperBand = new Array(n).fill(NaN);
  const lowerBand = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    upperBand[i] = hl2 + factor * atr[i];
    lowerBand[i] = hl2 - factor * atr[i];
  }
  const firstValid = atrLen;
  if (firstValid >= n) return { line, dir, atr };
  dir[firstValid] = -1;
  line[firstValid] = lowerBand[firstValid];
  for (let i = firstValid + 1; i < n; i++) {
    if (!Number.isFinite(upperBand[i]) || !Number.isFinite(lowerBand[i])) {
      dir[i] = dir[i - 1];
      line[i] = line[i - 1];
      continue;
    }
    if (Number.isFinite(lowerBand[i - 1]) && lowerBand[i] < lowerBand[i - 1] && bars[i - 1].c > lowerBand[i - 1]) {
      lowerBand[i] = lowerBand[i - 1];
    }
    if (Number.isFinite(upperBand[i - 1]) && upperBand[i] > upperBand[i - 1] && bars[i - 1].c < upperBand[i - 1]) {
      upperBand[i] = upperBand[i - 1];
    }
    const prevDir = dir[i - 1];
    if (prevDir === -1) {
      if (bars[i].c < lowerBand[i]) { dir[i] = 1; line[i] = upperBand[i]; }
      else { dir[i] = -1; line[i] = lowerBand[i]; }
    } else if (bars[i].c > upperBand[i]) {
      dir[i] = -1;
      line[i] = lowerBand[i];
    } else {
      dir[i] = 1;
      line[i] = upperBand[i];
    }
  }
  return { line, dir, atr };
}

function walkTdEvents(bars) {
  const PREP_LEN = 9;
  const PREP_COMP = 4;
  const LEADUP_LEN = 13;
  const LEADUP_COMP = 2;
  const events = [];
  if (!bars || bars.length < PREP_COMP + PREP_LEN) return events;
  let bullPrep = 0;
  let bearPrep = 0;
  let bullLead = 0;
  let bearLead = 0;
  for (let i = PREP_COMP; i < bars.length; i++) {
    const c = bars[i].c;
    const cComp = bars[i - PREP_COMP].c;
    bullPrep = c < cComp ? bullPrep + 1 : 0;
    bearPrep = c > cComp ? bearPrep + 1 : 0;
    if (i >= LEADUP_COMP) {
      const lowComp = bars[i - LEADUP_COMP].l;
      const highComp = bars[i - LEADUP_COMP].h;
      if (bearPrep === PREP_LEN) bullLead = 0;
      else if (bullPrep === PREP_LEN) bullLead = 1;
      else if (bullLead > 0 && c < lowComp) bullLead += 1;
      if (bullPrep === PREP_LEN) bearLead = 0;
      else if (bearPrep === PREP_LEN) bearLead = 1;
      else if (bearLead > 0 && c > highComp) bearLead += 1;
    }
    if (bullPrep === PREP_LEN) events.push({ i, t: bars[i].t, side: "bull", kind: 9, close: bars[i].c });
    if (bearPrep === PREP_LEN) events.push({ i, t: bars[i].t, side: "bear", kind: 9, close: bars[i].c });
    if (bullLead === LEADUP_LEN) events.push({ i, t: bars[i].t, side: "bull", kind: 13, close: bars[i].c });
    if (bearLead === LEADUP_LEN) events.push({ i, t: bars[i].t, side: "bear", kind: 13, close: bars[i].c });
  }
  return events;
}

function parseCandles(raw) {
  const rows = Array.isArray(raw) ? raw : (raw?.candles || raw?.result?.candles || []);
  return rows
    .map((c) => ({
      t: Number(c.ts ?? c.time ?? 0),
      o: Number(c.open ?? c.o),
      h: Number(c.high ?? c.h),
      l: Number(c.low ?? c.l),
      c: Number(c.close ?? c.c),
      v: Number(c.volume ?? c.v ?? 0),
    }))
    .filter((c) => c.t > 0 && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);
}

/** Daily store has NY-session + midnight-UTC twins. Keep last bar per UTC date. */
function dedupeDaily(bars) {
  const byDay = new Map();
  for (const b of bars) byDay.set(iso(b.t), b);
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, b]) => b);
}

function loadCached(tf) {
  const p = join(CACHE, `TSLA_${tf}.json`);
  if (!existsSync(p)) throw new Error(`missing cache ${p}`);
  return parseCandles(JSON.parse(readFileSync(p, "utf8")));
}

function analyze(bars) {
  const closes = bars.map((b) => b.c);
  const e21 = emaSeries(closes, 21);
  const e50 = emaSeries(closes, 50);
  const e233 = emaSeries(closes, 233);
  const atr14 = atrSeries(bars, 14);
  const st = superTrendSeries(bars, 3.0, 10);
  const phase = satyPhaseSeries(bars, closes, e21, atr14, 3);
  const td = walkTdEvents(bars);
  const rows = bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1] : null;
    const rec = detectEma233ReclaimFromSeries({
      closes: closes.slice(0, i + 1),
      ema233: e233.slice(0, i + 1),
      lookback: 24,
    });
    const flipped = prev && st.dir[i] && st.dir[i - 1] && st.dir[i] !== st.dir[i - 1];
    const crossed21 = prev && Number.isFinite(e21[i]) && Number.isFinite(e21[i - 1])
      && ((prev.c < e21[i - 1] && b.c >= e21[i]) || (prev.c > e21[i - 1] && b.c <= e21[i]));
    const crossed233 = prev && Number.isFinite(e233[i]) && Number.isFinite(e233[i - 1])
      && ((prev.c < e233[i - 1] && b.c >= e233[i]) || (prev.c > e233[i - 1] && b.c <= e233[i]));
    return {
      t: b.t,
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
      e21: e21[i], e50: e50[i], e233: e233[i],
      atr: atr14[i],
      st: st.line[i],
      dir: st.dir[i],
      phase: phase.series[i],
      above21: Number.isFinite(e21[i]) ? b.c >= e21[i] : null,
      above50: Number.isFinite(e50[i]) ? b.c >= e50[i] : null,
      above233: Number.isFinite(e233[i]) ? b.c >= e233[i] : null,
      distStAtr: Number.isFinite(atr14[i]) && atr14[i] > 0 && Number.isFinite(st.line[i])
        ? (st.dir[i] === -1 ? (b.l - st.line[i]) / atr14[i] : (st.line[i] - b.h) / atr14[i])
        : null,
      dist21Atr: Number.isFinite(atr14[i]) && atr14[i] > 0 && Number.isFinite(e21[i])
        ? (b.c - e21[i]) / atr14[i]
        : null,
      reclaim233: rec,
      flipped,
      flipTo: flipped ? (st.dir[i] === -1 ? "BULL" : "BEAR") : null,
      crossed21: crossed21 ? (b.c >= e21[i] ? "above" : "below") : null,
      crossed233: crossed233 ? (b.c >= e233[i] ? "above" : "below") : null,
    };
  });
  return { rows, td, last: rows[rows.length - 1] };
}

function windowRows(rows, from, to) {
  return rows.filter((r) => r.t >= from && r.t < to);
}

function rangeOf(rows) {
  if (!rows.length) return null;
  return {
    n: rows.length,
    first: isoT(rows[0].t),
    last: isoT(rows[rows.length - 1].t),
    o: r(rows[0].o),
    h: r(Math.max(...rows.map((x) => x.h))),
    l: r(Math.min(...rows.map((x) => x.l))),
    c: r(rows[rows.length - 1].c),
    ret: r((rows[rows.length - 1].c / rows[0].o - 1) * 100, 2),
  };
}

function compact(row) {
  return {
    t: isoT(row.t),
    d: iso(row.t),
    o: r(row.o), h: r(row.h), l: r(row.l), c: r(row.c),
    e21: r(row.e21), e50: r(row.e50), e233: r(row.e233),
    st: r(row.st),
    dir: row.dir === -1 ? "BULL" : row.dir === 1 ? "BEAR" : "?",
    atr: r(row.atr),
    phase: r(row.phase, 1),
    above21: row.above21,
    above50: row.above50,
    above233: row.above233,
    distStAtr: r(row.distStAtr),
    dist21Atr: r(row.dist21Atr),
    flipped: row.flipped ? row.flipTo : null,
    crossed21: row.crossed21,
    crossed233: row.crossed233,
  };
}

function eventsIn(rows, td, from, to, tf) {
  const ev = [];
  for (const row of rows) {
    if (row.t < from || row.t >= to) continue;
    if (row.flipped) {
      ev.push({
        t: isoT(row.t), tf, kind: "st_flip",
        detail: `${row.flipTo} ST ${r(row.st)} close ${r(row.c)} dist21=${r(row.dist21Atr)}ATR`,
        close: r(row.c),
      });
    }
    if (row.crossed21) {
      ev.push({
        t: isoT(row.t), tf, kind: `ema21_${row.crossed21}`,
        detail: `21 EMA ${r(row.e21)} close ${r(row.c)}`,
        close: r(row.c),
      });
    }
    if (row.crossed233) {
      ev.push({
        t: isoT(row.t), tf, kind: `ema233_${row.crossed233}`,
        detail: `233 EMA ${r(row.e233)} close ${r(row.c)}`,
        close: r(row.c),
      });
    }
  }
  for (const e of td) {
    if (e.t < from || e.t >= to) continue;
    ev.push({
      t: isoT(e.t), tf, kind: `td${e.kind}_${e.side}`,
      detail: `TD ${e.kind} ${e.side} close ${r(e.close)}`,
      close: r(e.close),
    });
  }
  return ev.sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

function firstCloseAbove(rows, level, from) {
  for (const row of rows) {
    if (row.t < from) continue;
    if (row.c > level) return { t: isoT(row.t), c: r(row.c), level: r(level) };
  }
  return null;
}

function firstHighAbove(rows, level, from) {
  for (const row of rows) {
    if (row.t < from) continue;
    if (row.h > level) return { t: isoT(row.t), h: r(row.h), c: r(row.c), level: r(level) };
  }
  return null;
}

async function fetchJson(path) {
  if (!KEY) return { skipped: true, reason: "no key" };
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: { "X-API-Key": KEY, "User-Agent": UA } });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, text: text.slice(0, 400) }; }
}

function slimLatest(data) {
  if (!data || typeof data !== "object") return data;
  const t = data.result || data.ticker || data;
  const keys = [
    "ticker", "symbol", "price", "close", "kanban_stage", "investor_stage",
    "investor_score", "confluence", "confluence_score", "confluence_action",
    "st_hold_setup", "flags", "state", "htf_score", "ltf_score",
    "completion", "rank", "trigger_reason", "setup_name",
  ];
  const out = {};
  for (const k of keys) if (t[k] != null) out[k] = t[k];
  if (t.tf_tech) {
    out.tf_tech = {};
    for (const tf of ["M", "W", "D", "4H", "240", "1H", "60", "30"]) {
      const row = t.tf_tech[tf];
      if (!row) continue;
      out.tf_tech[tf] = {
        st: row.st || row.supertrend || row.stLine,
        stDir: row.stDir ?? row.st_dir ?? row.dir,
        ema21: row.ema21 || row.ema?.e21 || row.ema?.ema21,
        ema233: row.ema233 || row.ema?.e233 || row.ema?.ema233,
        ema233Reclaim: row.ema233Reclaim || row.ema?.ema233Reclaim,
        stHold: row.stHold,
      };
    }
  }
  if (t.td_sequential || t.tdSeq) out.td = t.td_sequential || t.tdSeq;
  if (t.magnets || t.cto || t.cto_magnets) out.magnets = t.magnets || t.cto || t.cto_magnets;
  if (t.levels) out.levels = t.levels;
  return out;
}

function mdTable(rows, cols) {
  const lines = [];
  lines.push("| " + cols.map((c) => c.h).join(" | ") + " |");
  lines.push("|" + cols.map(() => "---").join("|") + "|");
  for (const row of rows) {
    lines.push("| " + cols.map((c) => {
      const v = c.v(row);
      return v == null || v === "" ? "—" : String(v);
    }).join(" | ") + " |");
  }
  return lines.join("\n");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const rawD = loadCached("D");
  const d = analyze(dedupeDaily(rawD));
  const w = analyze(loadCached("W"));
  const m = analyze(loadCached("M"));
  const h4 = analyze(loadCached("240"));
  const h1 = analyze(loadCached("60"));

  const dailyCtx = windowRows(d.rows, FROM, END);
  const dailyLast = windowRows(d.rows, LAST_WEEK, THIS_WEEK);
  const dailyThis = windowRows(d.rows, THIS_WEEK, END);
  const h4Last = windowRows(h4.rows, LAST_WEEK, THIS_WEEK);
  const h4This = windowRows(h4.rows, THIS_WEEK, END);
  const h1Last = windowRows(h1.rows, LAST_WEEK, THIS_WEEK);
  const h1This = windowRows(h1.rows, THIS_WEEK, END);

  const lastWeekRange = rangeOf(dailyLast);
  const thisWeekRange = rangeOf(dailyThis);
  const lastWeekHigh = lastWeekRange?.h;
  const lastWeekLow = lastWeekRange?.l;
  const breakLastHigh = lastWeekHigh != null
    ? firstHighAbove(dailyThis, lastWeekHigh, THIS_WEEK)
    : null;
  const closeAboveLastHigh = lastWeekHigh != null
    ? firstCloseAbove(dailyThis, lastWeekHigh, THIS_WEEK)
    : null;

  const movie = {
    generatedAt: new Date().toISOString(),
    ranges: {
      lastWeek: lastWeekRange,
      thisWeek: thisWeekRange,
      fromLastWeekOpenToFri: dailyLast.length && dailyThis.length
        ? {
          from: iso(dailyLast[0].t),
          to: iso(dailyThis[dailyThis.length - 1].t),
          open: r(dailyLast[0].o),
          close: r(dailyThis[dailyThis.length - 1].c),
          ret: r((dailyThis[dailyThis.length - 1].c / dailyLast[0].o - 1) * 100),
        }
        : null,
    },
    breakout: { lastWeekHigh, lastWeekLow, firstTag: breakLastHigh, firstClose: closeAboveLastHigh },
    daily: dailyCtx.map(compact),
    weekly: windowRows(w.rows, Date.parse("2026-06-01T00:00:00Z"), END).map(compact),
    monthly: windowRows(m.rows, Date.parse("2025-12-01T00:00:00Z"), END).map(compact),
    h4Last: h4Last.map(compact),
    h4This: h4This.map(compact),
    events: {
      D: eventsIn(d.rows, d.td, FROM, END, "D"),
      W: eventsIn(w.rows, w.td, Date.parse("2026-06-01T00:00:00Z"), END, "W"),
      M: eventsIn(m.rows, m.td, Date.parse("2025-12-01T00:00:00Z"), END, "M"),
      "4H": eventsIn(h4.rows, h4.td, FROM, END, "4H"),
      "1H": eventsIn(h1.rows, h1.td, FROM, END, "1H"),
    },
  };

  const latest = await fetchJson("/timed/latest?ticker=TSLA");
  const trail = await fetchJson(`/timed/trail?ticker=TSLA&since=${FROM}&limit=500&include_kanban=1`);
  movie.live = {
    latestStatus: latest.status,
    latest: slimLatest(latest.json),
    trailStatus: trail.status,
    trailN: Array.isArray(trail.json?.result) ? trail.json.result.length
      : Array.isArray(trail.json?.trail) ? trail.json.trail.length
      : null,
  };

  writeFileSync(join(OUT, "movie.json"), JSON.stringify(movie, null, 2));

  const lines = [];
  lines.push("# TSLA last week into this week");
  lines.push("");
  lines.push(`Generated ${movie.generatedAt}. Cash Friday close **${thisWeekRange?.c}**.`);
  lines.push("");
  lines.push("## The ride");
  lines.push("");
  if (movie.ranges.fromLastWeekOpenToFri) {
    const x = movie.ranges.fromLastWeekOpenToFri;
    lines.push(`Last Monday open **$${x.open}** → this Friday close **$${x.close}** (**+${x.ret}%**).`);
  }
  lines.push("");
  lines.push(`Last week range: **$${lastWeekLow}–$${lastWeekHigh}** (close ${lastWeekRange?.c}).`);
  lines.push(`This week range: **$${thisWeekRange?.l}–$${thisWeekRange?.h}** (close ${thisWeekRange?.c}, ${thisWeekRange?.ret}% from Monday open).`);
  if (breakLastHigh) {
    lines.push(`First tag of last week's high ($${lastWeekHigh}): **${breakLastHigh.t}** high ${breakLastHigh.h}.`);
  }
  if (closeAboveLastHigh) {
    lines.push(`First daily close above last week's high: **${closeAboveLastHigh.t}** close ${closeAboveLastHigh.c}.`);
  }
  lines.push("");
  lines.push("## Daily bars (Aug 3–21)");
  lines.push("");
  lines.push(mdTable(movie.daily, [
    { h: "Date", v: (b) => b.d },
    { h: "O", v: (b) => b.o },
    { h: "H", v: (b) => b.h },
    { h: "L", v: (b) => b.l },
    { h: "C", v: (b) => b.c },
    { h: "21", v: (b) => b.e21 },
    { h: "233", v: (b) => b.e233 },
    { h: "ST", v: (b) => b.st },
    { h: "Dir", v: (b) => b.dir },
    { h: "Ph", v: (b) => b.phase },
    { h: "vs21", v: (b) => b.dist21Atr },
    { h: "Flip / cross", v: (b) => [b.flipped, b.crossed21 && `21 ${b.crossed21}`, b.crossed233 && `233 ${b.crossed233}`].filter(Boolean).join(", ") },
  ]));
  lines.push("");
  lines.push("## Observable events Aug 3–21");
  lines.push("");
  for (const tf of ["D", "4H", "1H", "W", "M"]) {
    const ev = movie.events[tf] || [];
    lines.push(`### ${tf}`);
    lines.push("");
    if (!ev.length) { lines.push("None."); lines.push(""); continue; }
    for (const e of ev) lines.push(`- **${e.t}** ${e.kind}: ${e.detail}`);
    lines.push("");
  }
  lines.push("## 4H this week");
  lines.push("");
  lines.push(mdTable(movie.h4This, [
    { h: "Time", v: (b) => b.t },
    { h: "C", v: (b) => b.c },
    { h: "21", v: (b) => b.e21 },
    { h: "233", v: (b) => b.e233 },
    { h: "ST", v: (b) => b.st },
    { h: "Dir", v: (b) => b.dir },
    { h: "vs ST ATR", v: (b) => b.distStAtr },
    { h: "vs 21 ATR", v: (b) => b.dist21Atr },
    { h: "Event", v: (b) => [b.flipped, b.crossed21 && `21 ${b.crossed21}`, b.crossed233 && `233 ${b.crossed233}`].filter(Boolean).join(", ") },
  ]));
  lines.push("");
  writeFileSync(join(OUT, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  console.log("\n--- events ---");
  console.log(JSON.stringify(movie.events, null, 2));
  console.log("\n--- ranges ---");
  console.log(JSON.stringify({ ranges: movie.ranges, breakout: movie.breakout }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
