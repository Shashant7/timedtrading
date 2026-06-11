// worker/chart-candle-calendar.js
// ET-calendar proactive chart candle refresh + forming D/W bar synthesis.
// Chart UI surfaces 1H / 4H / D / W only; scoring still ingests finer TFs.

import { kvGetJSON } from "./storage.js";
import { normalizeTfKey } from "./ingest.js";
import * as DataProvider from "./data-provider.js";

export const CHART_SYMBOL_BLOCKLIST = new Set([
  "ES1!", "NQ1!", "YM1!", "RTY1!", "CL1!", "GC1!", "SI1!", "HG1!", "NG1!",
  "BTCUSD", "ETHUSD", "US500", "VX1!",
]);

const TICKER_RE = /^[A-Z]{1,5}(-[A-Z]{1,2})?$/;

/** NY wall-clock parts for ET scheduling. */
export function getNyEtParts(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const wd = String(map.weekday || "").toLowerCase();
  return {
    weekday: wd,
    hour: Number(map.hour) || 0,
    minute: Number(map.minute) || 0,
    dateStr: new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
  };
}

function isNyWeekday(weekday) {
  return weekday.startsWith("mon") || weekday.startsWith("tue") || weekday.startsWith("wed")
    || weekday.startsWith("thu") || weekday.startsWith("fri");
}

/**
 * Which chart TFs to backfill at this ET moment.
 * Runs on */5 cron when minute is 5 (hourly 1H) or 10 (Friday W).
 */
export function getChartCalendarTasks(nowMs = Date.now()) {
  const et = getNyEtParts(nowMs);
  const tasks = [];

  if (et.minute === 5) {
    tasks.push({ tf: "60", sinceDays: 3, label: "hourly_1h" });
    if ([10, 14, 18, 22].includes(et.hour)) {
      tasks.push({ tf: "240", sinceDays: 7, label: "scheduled_4h" });
    }
    if (et.hour === 16 && isNyWeekday(et.weekday)) {
      tasks.push({ tf: "D", sinceDays: 7, label: "rth_close_daily" });
    }
  }
  if (et.minute === 10 && et.hour === 16 && et.weekday.startsWith("fri")) {
    tasks.push({ tf: "W", sinceDays: 90, label: "week_close_weekly" });
  }

  return tasks;
}

/** Full chart universe: SECTOR_MAP + timed:tickers + user-added. */
export async function getChartUniverse(env, deps = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  const sectorMap = deps.SECTOR_MAP || {};
  let kvTickers = [];
  try {
    kvTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
  } catch (_) {}
  let userAdded = [];
  if (typeof deps.d1GetActiveUserTickersCached === "function") {
    try {
      userAdded = await deps.d1GetActiveUserTickersCached(env);
    } catch (_) {}
  }
  const blocklist = deps.blocklist || CHART_SYMBOL_BLOCKLIST;
  return [...new Set([
    ...Object.keys(sectorMap),
    ...kvTickers.map((t) => String(t || "").toUpperCase()),
    ...userAdded.map((t) => String(t || "").toUpperCase()),
  ])]
    .filter((t) => t && !blocklist.has(t) && TICKER_RE.test(t))
    .sort();
}

const CHUNK_SIZE = 40;
const CHUNK_PAUSE_MS = 2500;

async function backfillChunk(env, tickers, tf, sinceDays) {
  if (!tickers.length) return { upserted: 0, errors: 0 };
  try {
    const r = await DataProvider.backfill(env, tickers, tf, { sinceDays });
    return { upserted: Number(r?.upserted) || 0, errors: Number(r?.errors) || 0 };
  } catch (e) {
    console.warn(`[CHART_CALENDAR] backfill tf=${tf} failed:`, String(e?.message || e).slice(0, 160));
    return { upserted: 0, errors: tickers.length };
  }
}

/**
 * ET-gated full-universe chart candle refresh. Non-blocking via ctx.waitUntil.
 */
export async function runChartCandleCalendar(env, ctx, deps = {}) {
  const tasks = getChartCalendarTasks();
  if (!tasks.length || !env?.DB) return { ran: false };

  const tickers = await getChartUniverse(env, deps);
  if (!tickers.length) return { ran: false, tickers: 0 };

  const et = getNyEtParts();
  const run = async () => {
    let totalUpserted = 0;
    let totalErrors = 0;
    for (const task of tasks) {
      for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
        const chunk = tickers.slice(i, i + CHUNK_SIZE);
        const r = await backfillChunk(env, chunk, task.tf, task.sinceDays);
        totalUpserted += r.upserted;
        totalErrors += r.errors;
        if (i + CHUNK_SIZE < tickers.length) {
          await new Promise((res) => setTimeout(res, CHUNK_PAUSE_MS));
        }
      }
      console.log(
        `[CHART_CALENDAR] ${task.label} tf=${task.tf} et=${et.hour}:${String(et.minute).padStart(2, "0")} `
        + `tickers=${tickers.length} upserted=${totalUpserted} errors=${totalErrors}`,
      );
    }
    return { ran: true, tasks: tasks.map((t) => t.tf), tickers: tickers.length, upserted: totalUpserted, errors: totalErrors };
  };

  if (ctx?.waitUntil) {
    ctx.waitUntil(run().catch((e) => {
      console.warn("[CHART_CALENDAR] failed:", String(e?.message || e).slice(0, 200));
    }));
    return { scheduled: true, tasks: tasks.map((t) => t.tf), tickers: tickers.length };
  }
  return run();
}

function nyDateStrFromTs(tsMs) {
  return new Date(tsMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Monday 00:00 ET of the week containing tsMs, as YYYY-MM-DD. */
function nyWeekMondayKey(tsMs = Date.now()) {
  const et = getNyEtParts(tsMs);
  const d = new Date(tsMs);
  const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dow = dayMap[et.weekday.slice(0, 3)] ?? 0;
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const mondayMs = tsMs + mondayOffset * 86400000;
  return new Date(mondayMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function nyWeekKeyFromTs(tsMs) {
  const mon = nyWeekMondayKey(tsMs);
  return mon;
}

/**
 * Append or replace a forming D/W bar using live timed:prices (p, dh, dl, pc).
 * TD-native completed bars are untouched; only the current session bar is synthesized.
 */
export async function appendFormingChartCandle(env, ticker, tfKey, candles, opts = {}) {
  const sym = String(ticker || "").toUpperCase();
  const tf = normalizeTfKey(tfKey);
  if (!sym || !tf || !Array.isArray(candles)) return { candles, forming: false };

  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { candles, forming: false };

  let snap = opts.priceSnap || null;
  if (!snap) {
    try {
      const prices = await kvGetJSON(KV, "timed:prices");
      snap = prices?.[sym] || null;
    } catch (_) {}
  }
  const px = Number(snap?.p);
  if (!Number.isFinite(px) || px <= 0) return { candles, forming: false };

  const dh = Number(snap?.dh) || px;
  const dl = Number(snap?.dl) || px;
  const pc = Number(snap?.pc) || 0;
  const nowMs = Date.now();
  const out = candles.slice();
  const last = out[out.length - 1];
  const lastTs = Number(last?.ts) || 0;

  if (tf === "D") {
    const todayKey = getNyEtParts(nowMs).dateStr;
    const lastDayKey = lastTs > 0 ? nyDateStrFromTs(lastTs) : "";
    const high = Math.max(dh, px);
    const low = Math.min(dl > 0 ? dl : px, px);
    const open = lastDayKey === todayKey && Number(last?.o) > 0
      ? Number(last.o)
      : (pc > 0 ? pc : px);

    if (lastDayKey === todayKey) {
      out[out.length - 1] = {
        ...last,
        o: open,
        h: high,
        l: low,
        c: px,
        forming: true,
      };
      return { candles: out, forming: true };
    }
    const barTs = lastTs > 0 ? Math.min(nowMs, lastTs + 20 * 3600000) : nowMs;
    out.push({ ts: barTs, o: open, h: high, l: low, c: px, v: null, forming: true });
    return { candles: out, forming: true };
  }

  if (tf === "W") {
    const weekKey = nyWeekKeyFromTs(nowMs);
    const lastWeekKey = lastTs > 0 ? nyWeekKeyFromTs(lastTs) : "";
    const high = Math.max(dh, px);
    const low = Math.min(dl > 0 ? dl : px, px);
    let weekOpen = px;
    if (lastWeekKey === weekKey && Number(last?.o) > 0) {
      weekOpen = Number(last.o);
    } else if (out.length >= 2) {
      const prev = out[out.length - 1];
      if (Number(prev?.c) > 0) weekOpen = Number(prev.c);
    } else if (pc > 0) {
      weekOpen = pc;
    }

    if (lastWeekKey === weekKey) {
      out[out.length - 1] = {
        ...last,
        o: weekOpen,
        h: Math.max(Number(last?.h) || high, high),
        l: Math.min(Number(last?.l) || low, low),
        c: px,
        forming: true,
      };
      return { candles: out, forming: true };
    }
    const barTs = lastTs > 0 ? Math.min(nowMs, lastTs + 5 * 86400000) : nowMs;
    out.push({
      ts: barTs,
      o: weekOpen,
      h: high,
      l: low,
      c: px,
      v: null,
      forming: true,
    });
    return { candles: out, forming: true };
  }

  return { candles: out, forming: false };
}
