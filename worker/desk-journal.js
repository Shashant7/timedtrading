// worker/desk-journal.js
//
// Operator desk journal — TradeZella-style review of the *broker* book
// (Webull sleeves + CSV import). Separate from Trade Review, which grades
// the model's paper/live engine trades.
//
// Fills persist in D1; FIFO round-trips (flat → flat) become journalable
// trips. Sync pulls the newest Webull page (max 100). CSV is the backfill
// path. Journal notes survive a rebuild when the trip fingerprint matches.

import { parseOCCSymbol } from "./alpaca-options.js";
import { buildOccSymbol } from "./options-marks.js";
import { getETDateStr, getETMinutes, getStaticCalendar, previousTradingDay } from "./market-calendar.js";

const ALPACA_DATA_BASE = "https://data.alpaca.markets";
const D1_BATCH = 80;
const OPTION_MULT = 100;

let _ready = false;

const CREATE_FILLS = `CREATE TABLE IF NOT EXISTS desk_journal_fills (
  fill_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  root TEXT,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  px REAL NOT NULL,
  filled_ts INTEGER NOT NULL,
  intent TEXT,
  instrument TEXT,
  raw_json TEXT,
  created_at INTEGER NOT NULL
)`;

const CREATE_TRIPS = `CREATE TABLE IF NOT EXISTS desk_journal_trips (
  trip_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  root TEXT,
  label TEXT,
  qty REAL,
  entry_px REAL,
  exit_px REAL,
  entry_ts INTEGER,
  exit_ts INTEGER,
  hold_s INTEGER,
  pnl REAL,
  overnight INTEGER NOT NULL DEFAULT 0,
  dte_in INTEGER,
  status TEXT NOT NULL DEFAULT 'closed',
  fill_ids TEXT,
  journal_text TEXT,
  journal_grade TEXT,
  journal_tags TEXT,
  journal_updated_at INTEGER,
  created_at INTEGER NOT NULL
)`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_desk_journal_fills_acct_ts ON desk_journal_fills(account_id, filled_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_desk_journal_fills_acct_sym ON desk_journal_fills(account_id, symbol, filled_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_desk_journal_trips_acct_exit ON desk_journal_trips(account_id, exit_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_desk_journal_trips_acct_entry ON desk_journal_trips(account_id, entry_ts DESC)`,
];

export async function ensureDeskJournalSchema(env) {
  if (_ready || !env?.DB) return;
  try {
    await env.DB.batch([
      env.DB.prepare(CREATE_FILLS),
      env.DB.prepare(CREATE_TRIPS),
      ...INDEXES.map((sql) => env.DB.prepare(sql)),
    ]);
    _ready = true;
  } catch (e) {
    console.warn("[DESK_JOURNAL] schema ensure failed:", String(e?.message || e).slice(0, 160));
  }
}

export function _resetDeskJournalSchemaCache() {
  _ready = false;
}

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function normalizeAccountId(id) {
  return String(id || "").trim().toLowerCase();
}

export function parseOcc(symbol) {
  const compact = String(symbol || "").toUpperCase().replace(/\s+/g, "");
  return parseOCCSymbol(compact);
}

export function formatContractLabel(symbol, name) {
  const occ = parseOcc(symbol);
  if (occ) {
    const [, m, d] = String(occ.expiration || "").split("-");
    const strike = Number.isFinite(occ.strike)
      ? (occ.strike % 1 === 0 ? String(occ.strike) : occ.strike.toFixed(2))
      : "";
    const md = m && d ? `${Number(m)}/${Number(d)}` : "";
    return `${occ.underlying} ${strike}${occ.right}${md ? ` ${md}` : ""}`.trim();
  }
  const parsed = parseWebullContractName(name);
  if (parsed?.label) return parsed.label;
  return String(symbol || name || "").toUpperCase();
}

export function parseWebullContractName(name) {
  const m = String(name || "").trim().match(
    /^([A-Z][A-Z0-9.]{0,6})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+([\d.]+)\s+(Call|Put)\b/i,
  );
  if (!m) return null;
  const root = m[1].toUpperCase();
  const mm = String(m[2]).padStart(2, "0");
  const dd = String(m[3]).padStart(2, "0");
  const yyyy = m[4];
  const strike = Number(m[5]);
  const right = /^put$/i.test(m[6]) ? "P" : "C";
  const occ = buildOccSymbol(root, `${yyyy}-${mm}-${dd}`, right, strike);
  const label = `${root} ${strike % 1 === 0 ? String(strike) : strike.toFixed(2)}${right} ${Number(mm)}/${Number(dd)}`;
  return { occ, root, expiration: `${yyyy}-${mm}-${dd}`, strike, right, label };
}

export function nyDateKey(ts) {
  if (!Number.isFinite(Number(ts))) return null;
  return getETDateStr(new Date(Number(ts)));
}

export function nyHour(ts) {
  if (!Number.isFinite(Number(ts))) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  const hour = Number(fmt.format(new Date(Number(ts))));
  return Number.isFinite(hour) ? hour : null;
}

function tzOffsetMs(ts, timeZone) {
  const d = new Date(Number(ts));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const wallAsUtc = Date.parse(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`);
  return wallAsUtc - Number(ts);
}

export function nyWallTimeToUtcMs(dayKey, hh = 0, mm = 0, ss = 0) {
  if (!dayKey) return null;
  const H = String(Math.max(0, Math.min(23, Number(hh) || 0))).padStart(2, "0");
  const M = String(Math.max(0, Math.min(59, Number(mm) || 0))).padStart(2, "0");
  const S = String(Math.max(0, Math.min(59, Number(ss) || 0))).padStart(2, "0");
  const t0 = Date.parse(`${dayKey}T${H}:${M}:${S}Z`);
  if (!Number.isFinite(t0)) return null;
  let ts = t0;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(ts, "America/New_York");
    const next = t0 - off;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - ts) < 1000) {
      ts = next;
      break;
    }
    ts = next;
  }
  return ts;
}

function shiftYmd(ymd, days) {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(ms)) return ymd;
  return getETDateStr(new Date(ms + days * 86_400_000));
}

export function previousWeekday(ymd) {
  let cur = ymd;
  for (let i = 0; i < 7; i++) {
    cur = shiftYmd(cur, -1);
    const dow = new Date(`${cur}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return cur;
  }
  return ymd;
}

/** Last completed NY session (after 16:00 ET use today; weekends → Friday). */
export function defaultJournalDay(now = Date.now()) {
  const et = getETDateStr(new Date(now));
  const mins = getETMinutes(new Date(now));
  const dow = new Date(`${et}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return previousWeekday(et);
  if (mins < 16 * 60) return previousWeekday(et);
  return et;
}

/** Webull rejects start_date === end_date; widen by one calendar day. */
export function webullHistoryDateQuery(fromYmd, toYmd) {
  const from = String(fromYmd || "").trim();
  const to = String(toYmd || "").trim();
  if (from && to && from === to) {
    return { start_date: shiftYmd(from, -1), end_date: to };
  }
  const q = {};
  if (from) q.start_date = from;
  if (to) q.end_date = to;
  return q;
}

export function parseFilledTime(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) return Math.round(raw);
    if (raw > 1e9) return Math.round(raw * 1000);
    return null;
  }
  const s0 = String(raw).trim();
  if (/^\d{13}$/.test(s0)) return Number(s0);
  if (/^\d{10}$/.test(s0)) return Number(s0) * 1000;
  const s = s0.replace(/\s+(EDT|EST|ET|UTC|GMT)$/i, "").trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (mdy) {
    const ymd = `${mdy[3]}-${String(mdy[1]).padStart(2, "0")}-${String(mdy[2]).padStart(2, "0")}`;
    return nyWallTimeToUtcMs(ymd, Number(mdy[4] || 0), Number(mdy[5] || 0), Number(mdy[6] || 0));
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function normalizeSide(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (s === "SELL" || s === "SELL_TO_CLOSE" || s === "STC" || s === "SHORT" || s === "SELL_SHORT") return "SELL";
  if (s === "BUY" || s === "BUY_TO_OPEN" || s === "BTO" || s === "COVER" || s === "BUY_TO_COVER") return "BUY";
  if (s.includes("SELL")) return "SELL";
  if (s.includes("BUY")) return "BUY";
  return null;
}

export function isFilledStatus(raw) {
  const s = String(raw || "").toUpperCase().replace(/[\s-]/g, "_");
  if (!s) return true;
  return s.includes("FILL") || s === "COMPLETE" || s === "COMPLETED" || s === "EXECUTED";
}

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      if (row.some((c) => String(c).trim() !== "")) rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  row.push(cur);
  if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  return rows;
}

export function parseCsvObjects(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const keys = rows[0].map((h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  return rows.slice(1).map((cols) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = cols[i] == null ? "" : String(cols[i]).trim(); });
    return o;
  });
}

export function extractOrderRows(payload) {
  if (!payload) return [];
  const flatten = (arr) => arr.flatMap((x) =>
    (x && typeof x === "object" && Array.isArray(x.orders)) ? x.orders : [x]);
  if (Array.isArray(payload)) return flatten(payload);
  if (Array.isArray(payload.orders)) return flatten(payload.orders);
  const r = payload.response ?? payload.data ?? payload;
  if (Array.isArray(r)) return flatten(r);
  if (Array.isArray(r?.orders)) return flatten(r.orders);
  if (Array.isArray(r?.data)) return flatten(r.data);
  if (r?.data && Array.isArray(r.data.data)) return flatten(r.data.data);
  return [];
}

export function parseBridgeBody(bodyText) {
  if (bodyText && typeof bodyText === "object") return bodyText;
  try {
    return JSON.parse(String(bodyText || "{}"));
  } catch {
    return { raw: String(bodyText || "").slice(0, 200) };
  }
}

function resolveSymbol(raw) {
  const named = parseWebullContractName(raw.name || raw.Name || raw.ticker_name);
  const direct = String(
    raw.symbol || raw.ticker || raw.Symbol || raw.option_symbol || raw.optionSymbol || "",
  ).toUpperCase().replace(/\s+/g, "");
  if (parseOcc(direct)) return direct;
  if (named?.occ) return named.occ;
  return direct || named?.root || "";
}

export function normalizeFill(raw, accountId) {
  if (!raw || typeof raw !== "object") return null;
  const account_id = normalizeAccountId(accountId);
  const side = normalizeSide(raw.side || raw.Side);
  const qty = num(raw.qty ?? raw.filled ?? raw.Filled ?? raw.filled_quantity ?? raw.filledQuantity
    ?? raw.filled_qty ?? raw.FilledQty ?? raw.quantity);
  const px = num(raw.px ?? raw.avg_price ?? raw.avgPrice ?? raw["Avg Price"] ?? raw.avg_price
    ?? raw.filled_price ?? raw.filledPrice ?? raw.Price ?? raw.price ?? raw.average_price);
  const filled_ts = parseFilledTime(
    raw.filled_ts ?? raw.filled_time ?? raw.filledTime ?? raw["Filled Time"]
    ?? raw.update_time ?? raw.updated_at ?? raw.create_time ?? raw.placed_time ?? raw["Placed Time"],
  );
  const status = raw.status ?? raw.Status ?? raw.order_status;
  if (!isFilledStatus(status)) return null;
  if (!side || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0 || !filled_ts) return null;
  const symbol = resolveSymbol(raw);
  if (!symbol) return null;
  const occ = parseOcc(symbol);
  const named = parseWebullContractName(raw.name || raw.Name);
  const root = occ?.underlying || named?.root || symbol;
  const instrument = occ || named ? "OPTION" : "EQUITY";
  const brokerId = raw.order_id || raw.orderId || raw.broker_order_id || raw.id || "";
  const fill_id = brokerId
    ? `wb_${account_id}_${brokerId}`
    : `djf_${fnv1a32([account_id, symbol, side, filled_ts, qty, px].join("|"))}`;
  const intent = String(raw.intent || raw.order_type || raw.orderType || raw["Time-in-Force"] || raw.time_in_force || "").slice(0, 40);
  return {
    fill_id,
    account_id,
    symbol,
    root,
    side,
    qty,
    px,
    filled_ts,
    intent: intent || null,
    instrument,
    raw_json: null,
  };
}

export function fillsFromCsv(text, accountId) {
  return parseCsvObjects(text)
    .map((row) => normalizeFill({
      name: row.name,
      symbol: row.symbol,
      side: row.side,
      status: row.status,
      filled: row.filled || row.filled_qty || row.total_qty,
      qty: row.filled || row.total_qty,
      price: row.avg_price || row.price,
      avg_price: row.avg_price || row.price,
      time_in_force: row.time_in_force,
      filled_time: row.filled_time,
      placed_time: row.placed_time,
    }, accountId))
    .filter(Boolean);
}

export function fillsFromOrders(payload, accountId) {
  return extractOrderRows(payload)
    .map((row) => normalizeFill(row, accountId))
    .filter(Boolean);
}

function vwap(legs) {
  let q = 0;
  let notional = 0;
  for (const l of legs) {
    const qty = Math.abs(Number(l.qty) || 0);
    const px = Number(l.px);
    if (qty <= 0 || !Number.isFinite(px)) continue;
    q += qty;
    notional += qty * px;
  }
  return q > 0 ? notional / q : null;
}

function dteIn(symbol, entryTs) {
  const occ = parseOcc(symbol);
  if (!occ?.expiration || !entryTs) return null;
  const entry = nyDateKey(entryTs);
  if (!entry) return null;
  const a = Date.parse(`${entry}T12:00:00Z`);
  const b = Date.parse(`${occ.expiration}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function tripFingerprint(accountId, symbol, entryTs, qty) {
  return `${normalizeAccountId(accountId)}|${String(symbol || "").toUpperCase()}|${entryTs}|${Number(qty)}`;
}

export function makeTripId(accountId, symbol, entryTs, firstFillId) {
  return `djt_${fnv1a32(`${normalizeAccountId(accountId)}|${symbol}|${entryTs}|${firstFillId || ""}`)}`;
}

function finalizeTrip(accountId, symbol, fills, status) {
  if (!fills.length) return null;
  const buys = fills.filter((f) => f.side === "BUY");
  const sells = fills.filter((f) => f.side === "SELL");
  const startSide = fills[0].side;
  const opening = startSide === "BUY" ? buys : sells;
  const closing = startSide === "BUY" ? sells : buys;
  const openedQty = opening.reduce((s, f) => s + f.qty, 0);
  const closedQty = closing.reduce((s, f) => s + f.qty, 0);
  const remaining = Math.max(0, openedQty - closedQty);
  const matched = Math.min(openedQty, closedQty);
  const entry_px = vwap(opening);
  const exit_px = closing.length ? vwap(closing) : null;
  const occ = parseOcc(symbol);
  const instrument = fills[0].instrument || (occ ? "OPTION" : "EQUITY");
  const mult = instrument === "OPTION" ? OPTION_MULT : 1;
  let pnl = null;
  if (matched > 0 && Number.isFinite(entry_px) && Number.isFinite(exit_px)) {
    const dir = startSide === "BUY" ? 1 : -1;
    pnl = (exit_px - entry_px) * matched * mult * dir;
  }
  const entry_ts = fills[0].filled_ts;
  const exit_ts = status === "closed" ? fills[fills.length - 1].filled_ts : null;
  const overnight = Number(nyDateKey(entry_ts) !== nyDateKey(exit_ts || entry_ts));
  const qty = status === "closed" ? matched : remaining;
  return {
    trip_id: makeTripId(accountId, symbol, entry_ts, fills[0].fill_id),
    account_id: normalizeAccountId(accountId),
    symbol,
    root: fills[0].root || occ?.underlying || symbol,
    label: formatContractLabel(symbol),
    qty,
    entry_px,
    exit_px,
    entry_ts,
    exit_ts,
    hold_s: exit_ts ? Math.max(0, Math.round((exit_ts - entry_ts) / 1000)) : null,
    pnl,
    overnight,
    dte_in: dteIn(symbol, entry_ts),
    status,
    fill_ids: fills.map((f) => f.fill_id),
    fingerprint: tripFingerprint(accountId, symbol, entry_ts, qty),
    instrument,
    opened_qty: openedQty,
    closed_qty: closedQty,
    remaining_qty: remaining,
    start_side: startSide,
  };
}

/** FIFO round-trips: one trip per flat→flat run on a symbol. */
export function pairFillsIntoTrips(fills, accountId) {
  const bySymbol = new Map();
  for (const f of fills || []) {
    if (!f?.symbol) continue;
    const key = String(f.symbol).toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(f);
  }
  const trips = [];
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => (a.filled_ts - b.filled_ts) || String(a.fill_id).localeCompare(String(b.fill_id)));
    let pos = 0;
    let bucket = [];
    const flush = (status) => {
      const trip = finalizeTrip(accountId, symbol, bucket, status);
      if (trip) trips.push(trip);
      bucket = [];
    };
    for (const f of rows) {
      const signed = f.side === "SELL" ? -Math.abs(f.qty) : Math.abs(f.qty);
      if (pos === 0) bucket = [];
      const next = pos + signed;
      if (pos !== 0 && next * pos < 0) {
        const closeQty = Math.abs(pos);
        const openQty = Math.abs(next);
        bucket.push({ ...f, qty: closeQty, fill_id: `${f.fill_id}:close` });
        flush("closed");
        bucket = [{ ...f, qty: openQty, fill_id: `${f.fill_id}:open` }];
      } else {
        bucket.push(f);
        if (pos !== 0 && next === 0) flush("closed");
      }
      pos = next;
    }
    if (bucket.length) flush(pos === 0 ? "closed" : "open");
  }
  trips.sort((a, b) => (b.exit_ts || b.entry_ts || 0) - (a.exit_ts || a.entry_ts || 0));
  return trips;
}

export function mergeJournalOntoTrips(trips, existingRows) {
  const byId = new Map();
  const byFp = new Map();
  for (const row of existingRows || []) {
    if (row.trip_id) byId.set(row.trip_id, row);
    const fp = tripFingerprint(row.account_id, row.symbol, row.entry_ts, row.qty);
    byFp.set(fp, row);
  }
  return (trips || []).map((t) => {
    const old = byId.get(t.trip_id) || byFp.get(t.fingerprint);
    if (!old) return t;
    return {
      ...t,
      journal_text: old.journal_text || null,
      journal_grade: old.journal_grade || null,
      journal_tags: old.journal_tags || null,
      journal_updated_at: old.journal_updated_at || null,
    };
  });
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function computeTripMetrics(trips) {
  const list = trips || [];
  const closed = list.filter((t) => t.status === "closed" && Number.isFinite(Number(t.pnl)));
  const wins = closed.filter((t) => Number(t.pnl) > 0);
  const losses = closed.filter((t) => Number(t.pnl) < 0);
  const flats = closed.filter((t) => Number(t.pnl) === 0);
  const overnight = closed.filter((t) => Number(t.overnight) === 1);
  const intra = closed.filter((t) => Number(t.overnight) !== 1);
  const after13 = closed.filter((t) => {
    const h = nyHour(t.exit_ts);
    return h != null && h >= 13;
  });
  const before13 = closed.filter((t) => {
    const h = nyHour(t.exit_ts);
    return h != null && h < 13;
  });
  const sum = (arr) => arr.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);
  const journaled = list.filter((t) => String(t.journal_text || "").trim() || t.journal_grade).length;
  return {
    n: list.length,
    n_closed: closed.length,
    n_open: list.filter((t) => t.status === "open").length,
    n_wins: wins.length,
    n_losses: losses.length,
    n_flats: flats.length,
    win_rate: closed.length ? wins.length / closed.length : null,
    pnl: sum(closed),
    avg_win: avg(wins),
    avg_loss: avg(losses),
    expectancy: closed.length ? sum(closed) / closed.length : null,
    median_hold_s: median(closed.map((t) => Number(t.hold_s))),
    overnight_n: overnight.length,
    overnight_pnl: sum(overnight),
    intra_n: intra.length,
    intra_pnl: sum(intra),
    after_13_n: after13.length,
    after_13_pnl: sum(after13),
    before_13_n: before13.length,
    before_13_pnl: sum(before13),
    journaled,
    unjournaled: list.length - journaled,
  };
}

export function accountsFromBridgeStatus(payload, storedIds = []) {
  const users = payload?.users || [];
  const out = [];
  const seen = new Set();
  for (const u of users) {
    const broker = String(u?.broker || "").toLowerCase();
    if (broker && broker !== "webull") continue;
    if (String(u?.status || "").toLowerCase() !== "connected") continue;
    const account_id = normalizeAccountId(u.user_id);
    if (!account_id || seen.has(account_id)) continue;
    seen.add(account_id);
    const sleeve = String(u.user_id || "").split("#").slice(2).join("#") || u.webull_account_class || "";
    out.push({
      account_id,
      label: u.webull_account_label || (sleeve ? `Webull ${sleeve}` : account_id),
      broker: "webull",
      webull_account_id: u.webull_account_id || null,
      sleeve: sleeve || null,
      connected: true,
      syncable: true,
    });
  }
  for (const id of storedIds) {
    const account_id = normalizeAccountId(id);
    if (!account_id || seen.has(account_id)) continue;
    seen.add(account_id);
    const broker = account_id.includes("#webull#") ? "webull" : (account_id.includes("#ibkr#") ? "ibkr" : "import");
    out.push({
      account_id,
      label: account_id,
      broker,
      connected: false,
      syncable: broker === "webull",
      imported: true,
    });
  }
  return out;
}

export function tripInDateRange(trip, fromYmd, toYmd) {
  const key = nyDateKey(trip.exit_ts || trip.entry_ts);
  if (!key) return false;
  if (fromYmd && key < fromYmd) return false;
  if (toYmd && key > toYmd) return false;
  return true;
}

export function filterTrips(trips, { from, to, unjournaled, side } = {}) {
  return (trips || []).filter((t) => {
    if ((from || to) && !tripInDateRange(t, from, to)) return false;
    if (unjournaled && (String(t.journal_text || "").trim() || t.journal_grade)) return false;
    if (side === "winners" && !(Number(t.pnl) > 0)) return false;
    if (side === "losers" && !(Number(t.pnl) < 0)) return false;
    if (side === "overnight" && Number(t.overnight) !== 1) return false;
    if (side === "after13") {
      const h = nyHour(t.exit_ts);
      if (h == null || h < 13) return false;
    }
    return true;
  });
}

function serializeTrip(t) {
  let tags = t.journal_tags;
  if (typeof tags === "string") {
    try { tags = JSON.parse(tags); } catch { tags = []; }
  }
  return {
    ...t,
    fill_ids: Array.isArray(t.fill_ids)
      ? t.fill_ids
      : (typeof t.fill_ids === "string" ? (() => { try { return JSON.parse(t.fill_ids); } catch { return []; } })() : []),
    journal_tags: Array.isArray(tags) ? tags : [],
    fingerprint: undefined,
  };
}

async function dbAll(env, sql, binds = []) {
  const res = await env.DB.prepare(sql).bind(...binds).all();
  return res?.results || [];
}

async function distinctAccountIds(env) {
  try {
    const rows = await dbAll(env, `SELECT DISTINCT account_id FROM desk_journal_fills`);
    return rows.map((r) => r.account_id).filter(Boolean);
  } catch {
    return [];
  }
}

async function runBatches(env, stmts) {
  for (let i = 0; i < stmts.length; i += D1_BATCH) {
    await env.DB.batch(stmts.slice(i, i + D1_BATCH));
  }
}

export async function persistFills(env, fills) {
  if (!env?.DB || !fills?.length) return { upserted: 0 };
  const now = Date.now();
  const stmts = fills.map((f) => env.DB.prepare(
    `INSERT OR REPLACE INTO desk_journal_fills
      (fill_id, account_id, symbol, root, side, qty, px, filled_ts, intent, instrument, raw_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).bind(
    f.fill_id, f.account_id, f.symbol, f.root || null, f.side, f.qty, f.px,
    f.filled_ts, f.intent || null, f.instrument || null, f.raw_json || null, now,
  ));
  await runBatches(env, stmts);
  return { upserted: fills.length };
}

export async function rebuildTripsForAccount(env, accountId) {
  const account_id = normalizeAccountId(accountId);
  const fills = await dbAll(env,
    `SELECT fill_id, account_id, symbol, root, side, qty, px, filled_ts, intent, instrument
       FROM desk_journal_fills WHERE account_id = ?1 ORDER BY filled_ts ASC`,
    [account_id],
  );
  const existing = await dbAll(env, `SELECT * FROM desk_journal_trips WHERE account_id = ?1`, [account_id]);
  const trips = mergeJournalOntoTrips(pairFillsIntoTrips(fills, account_id), existing);
  const now = Date.now();
  const del = env.DB.prepare(`DELETE FROM desk_journal_trips WHERE account_id = ?1`).bind(account_id);
  const inserts = trips.map((t) => env.DB.prepare(
    `INSERT INTO desk_journal_trips
      (trip_id, account_id, symbol, root, label, qty, entry_px, exit_px, entry_ts, exit_ts, hold_s, pnl,
       overnight, dte_in, status, fill_ids, journal_text, journal_grade, journal_tags, journal_updated_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
  ).bind(
    t.trip_id, t.account_id, t.symbol, t.root || null, t.label || null, t.qty ?? null,
    t.entry_px ?? null, t.exit_px ?? null, t.entry_ts ?? null, t.exit_ts ?? null,
    t.hold_s ?? null, t.pnl ?? null, t.overnight ? 1 : 0, t.dte_in ?? null, t.status,
    JSON.stringify(t.fill_ids || []), t.journal_text || null, t.journal_grade || null,
    t.journal_tags || null, t.journal_updated_at || null, now,
  ));
  await runBatches(env, [del, ...inserts]);
  return { trips: trips.length, fills: fills.length };
}

export async function listDeskJournalAccounts(env, { callBridge } = {}) {
  await ensureDeskJournalSchema(env);
  const stored = env?.DB ? await distinctAccountIds(env) : [];
  let payload = {};
  if (typeof callBridge === "function") {
    const result = await callBridge("/bridge/status");
    if (result?.kind === "ok") payload = parseBridgeBody(result.body);
  }
  return {
    ok: true,
    accounts: accountsFromBridgeStatus(payload, stored),
    default_from: defaultJournalDay(),
    default_to: defaultJournalDay(),
    note: "Sync reads the newest Webull page (max 100). Import a CSV to backfill older fills.",
  };
}

export async function syncDeskJournalFromWebull(env, { userId, from, to, postBridge }) {
  const account_id = normalizeAccountId(userId);
  if (!account_id) return { ok: false, error: "user_id_required" };
  if (typeof postBridge !== "function") return { ok: false, error: "bridge_unavailable" };
  await ensureDeskJournalSchema(env);
  const query = webullHistoryDateQuery(from, to);
  const result = await postBridge("/bridge/test/webull-call", {
    user_id: account_id,
    action: "list_orders",
    args: { limit: 100, query },
  });
  if (result?.kind && result.kind !== "ok") {
    return { ok: false, error: `bridge_${result.kind}`, detail: String(result.body || "").slice(0, 240) };
  }
  const payload = parseBridgeBody(result?.body);
  if (payload?.ok === false) {
    return { ok: false, error: payload.error || "webull_list_failed", detail: payload };
  }
  const fills = fillsFromOrders(payload, account_id);
  await persistFills(env, fills);
  const rebuild = env?.DB ? await rebuildTripsForAccount(env, account_id) : { trips: 0, fills: fills.length };
  return {
    ok: true,
    account_id,
    query,
    orders_seen: extractOrderRows(payload).length,
    fills_upserted: fills.length,
    ...rebuild,
  };
}

export async function importDeskJournalCsv(env, { accountId, csv }) {
  const account_id = normalizeAccountId(accountId);
  if (!account_id) return { ok: false, error: "account_id_required" };
  if (!csv) return { ok: false, error: "csv_required" };
  await ensureDeskJournalSchema(env);
  const fills = fillsFromCsv(csv, account_id);
  await persistFills(env, fills);
  const rebuild = env?.DB ? await rebuildTripsForAccount(env, account_id) : { trips: 0, fills: fills.length };
  return { ok: true, account_id, fills_upserted: fills.length, ...rebuild };
}

function rowToTrip(row) {
  return serializeTrip({
    ...row,
    overnight: Number(row.overnight) === 1 ? 1 : 0,
  });
}

export async function listDeskJournalTrips(env, {
  accountId, from, to, unjournaled, side, limit = 400,
} = {}) {
  const account_id = normalizeAccountId(accountId);
  if (!account_id) return { ok: false, error: "account_id_required" };
  await ensureDeskJournalSchema(env);
  const rows = await dbAll(env,
    `SELECT * FROM desk_journal_trips WHERE account_id = ?1
      ORDER BY COALESCE(exit_ts, entry_ts) DESC LIMIT ?2`,
    [account_id, Math.max(1, Math.min(800, Number(limit) || 400))],
  );
  const trips = filterTrips(rows.map(rowToTrip), {
    from, to,
    unjournaled: unjournaled === true || unjournaled === "1" || unjournaled === "true",
    side,
  });
  return {
    ok: true,
    account_id,
    from: from || null,
    to: to || null,
    count: trips.length,
    metrics: computeTripMetrics(trips),
    trips,
  };
}

function mapAlpacaBars(rawList) {
  return (rawList || []).map((b) => ({
    ts: Date.parse(b?.t),
    o: num(b?.o),
    h: num(b?.h),
    l: num(b?.l),
    c: num(b?.c),
    v: num(b?.v),
  })).filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.c));
}

export async function fetchJournalBars(env, { symbol, start, end, timeframe = "1Min" } = {}) {
  const keyId = env?.ALPACA_API_KEY_ID || env?.ALPACA_API_KEY;
  const secret = env?.ALPACA_API_SECRET_KEY || env?.ALPACA_API_SECRET;
  if (!keyId || !secret || !symbol) return { ok: false, error: "bars_unconfigured", bars: [], source: null };
  const occ = parseOcc(symbol);
  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
    "Accept": "application/json",
  };
  const params = new URLSearchParams({
    timeframe,
    limit: "10000",
    sort: "asc",
  });
  if (start) params.set("start", new Date(start).toISOString());
  if (end) params.set("end", new Date(end).toISOString());
  try {
    if (occ) {
      params.set("symbols", occ.occ || symbol);
      const url = `${ALPACA_DATA_BASE}/v1beta1/options/bars?${params.toString()}`;
      const r = await fetch(url, { headers });
      if (r.ok) {
        const j = await r.json();
        const list = Array.isArray(j?.bars)
          ? j.bars
          : (j?.bars?.[symbol] || j?.bars?.[occ.occ] || j?.bars?.[Object.keys(j?.bars || {})[0]] || []);
        const bars = mapAlpacaBars(list);
        if (bars.length) return { ok: true, bars, source: "alpaca_options", timeframe, symbol };
      }
    }
    const root = occ?.underlying || symbol;
    const stockParams = new URLSearchParams({
      timeframe: timeframe === "1Min" ? "1Min" : "5Min",
      limit: "10000",
      adjustment: "raw",
      feed: "iex",
    });
    if (start) stockParams.set("start", new Date(start).toISOString());
    if (end) stockParams.set("end", new Date(end).toISOString());
    const url = `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(root)}/bars?${stockParams.toString()}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return { ok: false, error: `http_${r.status}`, bars: [], source: null };
    const j = await r.json();
    const bars = mapAlpacaBars(j?.bars || []);
    return { ok: true, bars, source: "alpaca_equity", timeframe: stockParams.get("timeframe"), symbol: root };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160), bars: [], source: null };
  }
}

function captureFromBars(trip, bars) {
  if (!bars?.length || !Number.isFinite(Number(trip.entry_px))) return null;
  const entry = Number(trip.entry_px);
  const start = trip.entry_ts;
  const end = trip.exit_ts || Date.now();
  const window = bars.filter((b) => b.ts >= start && b.ts <= end);
  if (!window.length) return null;
  const highs = window.map((b) => b.h).filter(Number.isFinite);
  const lows = window.map((b) => b.l).filter(Number.isFinite);
  if (!highs.length || !lows.length) return null;
  const mfePx = Math.max(...highs);
  const maePx = Math.min(...lows);
  const dir = trip.start_side === "SELL" ? -1 : 1;
  const mfe = dir * (mfePx - entry);
  const mae = dir * (maePx - entry);
  return {
    mfe_px: mfe,
    mae_px: mae,
    mfe_pct: entry ? (mfe / entry) * 100 : null,
    mae_pct: entry ? (mae / entry) * 100 : null,
  };
}

export async function getDeskJournalTrip(env, { tripId } = {}) {
  const trip_id = String(tripId || "").trim();
  if (!trip_id) return { ok: false, error: "trip_id_required" };
  await ensureDeskJournalSchema(env);
  const row = await env.DB.prepare(`SELECT * FROM desk_journal_trips WHERE trip_id = ?1`).bind(trip_id).first();
  if (!row) return { ok: false, error: "trip_not_found" };
  const trip = rowToTrip(row);
  let fills = [];
  if (trip.fill_ids?.length) {
    const placeholders = trip.fill_ids.map((_, i) => `?${i + 1}`).join(",");
    fills = await dbAll(env,
      `SELECT fill_id, account_id, symbol, root, side, qty, px, filled_ts, intent, instrument
         FROM desk_journal_fills WHERE fill_id IN (${placeholders}) ORDER BY filled_ts ASC`,
      trip.fill_ids,
    );
  }
  if (!fills.length) {
    fills = await dbAll(env,
      `SELECT fill_id, account_id, symbol, root, side, qty, px, filled_ts, intent, instrument
         FROM desk_journal_fills
        WHERE account_id = ?1 AND symbol = ?2 AND filled_ts >= ?3 AND filled_ts <= ?4
        ORDER BY filled_ts ASC`,
      [trip.account_id, trip.symbol, trip.entry_ts, trip.exit_ts || Date.now()],
    );
  }
  const span = (trip.exit_ts || Date.now()) - (trip.entry_ts || Date.now());
  const timeframe = span > 4 * 3600_000 ? "5Min" : "1Min";
  const pad = timeframe === "1Min" ? 15 * 60_000 : 30 * 60_000;
  const barsRes = await fetchJournalBars(env, {
    symbol: trip.symbol,
    start: (trip.entry_ts || Date.now()) - pad,
    end: (trip.exit_ts || Date.now()) + pad,
    timeframe,
  });
  return {
    ok: true,
    trip,
    fills,
    bars: barsRes.bars || [],
    bars_source: barsRes.source || null,
    bars_timeframe: barsRes.timeframe || timeframe,
    capture: captureFromBars({ ...trip, start_side: fills[0]?.side }, barsRes.bars),
  };
}

const GRADES = new Set(["A", "B", "C", "D", "F", "REPEAT", "AVOID"]);

export async function saveDeskJournalEntry(env, body = {}) {
  const trip_id = String(body.trip_id || "").trim();
  if (!trip_id) return { ok: false, error: "trip_id_required" };
  await ensureDeskJournalSchema(env);
  const row = await env.DB.prepare(`SELECT trip_id FROM desk_journal_trips WHERE trip_id = ?1`).bind(trip_id).first();
  if (!row) return { ok: false, error: "trip_not_found" };
  const gradeRaw = String(body.journal_grade || body.grade || "").trim().toUpperCase();
  const journal_grade = GRADES.has(gradeRaw) ? gradeRaw : (gradeRaw || null);
  let tags = body.journal_tags || body.tags || [];
  if (typeof tags === "string") {
    try { tags = JSON.parse(tags); } catch { tags = tags.split(",").map((s) => s.trim()).filter(Boolean); }
  }
  if (!Array.isArray(tags)) tags = [];
  const journal_tags = JSON.stringify(tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12));
  const journal_text = body.journal_text != null ? String(body.journal_text).slice(0, 8000) : null;
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE desk_journal_trips
        SET journal_text = ?1, journal_grade = ?2, journal_tags = ?3, journal_updated_at = ?4
      WHERE trip_id = ?5`,
  ).bind(journal_text, journal_grade, journal_tags, now, trip_id).run();
  return { ok: true, trip_id, journal_updated_at: now };
}

export function lastSessionHint(now = Date.now()) {
  const day = defaultJournalDay(now);
  const cal = getStaticCalendar();
  const prev = previousTradingDay(cal, day);
  return { day, prev_session: prev };
}
