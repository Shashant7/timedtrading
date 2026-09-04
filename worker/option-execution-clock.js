// option-execution-clock.js
//
// Buy / sell timing for 0/1 DTE index options. The contract print tracks
// the underlying: a SPY 765C walks the same 21 EMA and SuperTrend as SPY.
// This module turns that coupling + the option-marks path (when the
// contract actually bottomed / peaked) into a machine-readable clock
// the Today card can spell out under the ticker.
//
// Pure. No I/O. Caller attaches D1 marks + ticker tf_tech.

import {
  computePremiumRr,
  shouldHoldOvernight,
  isOvernightCarry,
  formatExpirationShort,
  isOptionsSellWindowEt,
  SESSION_FLAT_ET,
  HARD_STOP_PCT,
} from "./option-day-trade-plan.js";
import { computeTfBundle } from "./indicators.js";

const NY_TZ = "America/New_York";

export const DEFAULT_TOD_PLAYBOOK = {
  buy_window_et: "09:45-10:30",
  sell_window_et: "11:00-14:30",
  open_avoid_et: "09:30-09:45",
  close_auction_et: "15:45-16:15",
  force_liq_et: "15:45",
  source: "playbook",
  note: "Premium usually bottoms on the first pullback into the 5-minute 21 EMA, not the opening print. 0 DTE is often force-liquidated around 15:45 ET; 1 DTE can hold the 15:45-16:15 close run.",
};

/** Brokers flatten 0 DTE around 15:45 ET. New 0 DTE after 15:15 is not a trade. */
export const FORCE_LIQ_MIN = 15 * 60 + 15;
export const CLOSE_AUCTION_START = 15 * 60 + 45;
export const CLOSE_AUCTION_END = 16 * 60 + 15;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

/** NY clock parts. hour is 0-23. */
export function nyParts(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

export function fmtEt(ts) {
  const p = nyParts(ts);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function isRthEt(ts) {
  const m = nyParts(ts).minutes;
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

/** Pine SuperTrend: -1 = bull, +1 = bear. */
export function stIsBull(stDir) {
  return num(stDir) != null && Number(stDir) < 0;
}

export function stIsBear(stDir) {
  return num(stDir) != null && Number(stDir) > 0;
}

/** Scoring tf_tech never emits 5m. A 10m/15m 21 that is this far from
 *  live spot is leftover from a different session — do not use it. */
const FALLBACK_EMA_MAX_DIST = 0.015;

function emaUsableForSpot(ema21, spot, tfLabel) {
  if (ema21 == null) return false;
  if (tfLabel === "5") return true;
  const px = num(spot);
  if (!(px > 0)) return true;
  return Math.abs(px - ema21) / ema21 <= FALLBACK_EMA_MAX_DIST;
}

/**
 * Prefer 5m, then 10m/15m. 1-minute SuperTrend/EMA21 is noise on 0/1 DTE;
 * 5m is the tape those contracts actually follow. Daily is context only.
 *
 * Scoring snapshots do not include tf_tech.5 (assembleTickerData stops
 * at 10m). Callers should prefer `timingFromM5Candles` and pass `spot`
 * so a stale 10m 21 (SPY 778 vs 765) is rejected.
 */
export function extractIndexTimingIndicators(ticker = {}, { spot } = {}) {
  const tf = ticker?.tf_tech && typeof ticker.tf_tech === "object" ? ticker.tf_tech : {};
  const order = ["5", "10", "15", "30"];
  let tfLabel = null;
  let pick = null;
  for (const k of order) {
    const slot = tf[k];
    const ema21 = num(slot?.ema?.ema21);
    if (ema21 != null && num(slot?.stDir) != null && emaUsableForSpot(ema21, spot, k)) {
      tfLabel = k;
      pick = slot;
      break;
    }
  }
  const daily = tf.D || null;
  if (!pick) pick = daily || {};
  if (!tfLabel && daily) tfLabel = "D";
  const ema21 = num(pick?.ema?.ema21) ?? num(daily?.ema?.ema21) ?? num(ticker?.ema21);
  const stDir = num(pick?.stDir) ?? num(daily?.stDir);
  const priceAbove = pick?.ema?.priceAboveEma21;
  return {
    ema21: round2(ema21),
    st_dir: stDir,
    st_label: stIsBull(stDir) ? "long" : stIsBear(stDir) ? "short" : "flat",
    price_above_ema21: priceAbove == null ? null : !!priceAbove,
    tf: tfLabel,
    source: pick ? "tf_tech" : null,
  };
}

/**
 * Live 5m EMA21 + SuperTrend from D1 5m bars. Same computeTfBundle as
 * scoring — the clock asked for 5m; the snapshot never had it.
 */
export function timingFromM5Candles(candles) {
  if (!Array.isArray(candles) || candles.length < 15) return null;
  try {
    const b = computeTfBundle(candles);
    if (!b || num(b.e21) == null || num(b.stDir) == null) return null;
    return {
      ema21: round2(b.e21),
      st_dir: num(b.stDir),
      st_label: stIsBull(b.stDir) ? "long" : stIsBear(b.stDir) ? "short" : "flat",
      price_above_ema21: num(b.px) != null && num(b.e21) != null ? b.px >= b.e21 : null,
      tf: "5",
      source: "live_m5",
    };
  } catch {
    return null;
  }
}

/**
 * Fair-market premium from the expected close (game-plan target) plus
 * a shrinking time cushion. A 763P with an expected pin at 762.50 is
 * worth ~$0.50 at the close — that pin is the buy ceiling. Live
 * premium below it is under FMV; well above it is rich.
 */
export function computePremiumValueBand({
  strike,
  flavor,
  spot,
  expectedClose,
  premium,
  dte,
  now = Date.now(),
  atrPct,
} = {}) {
  const K = num(strike);
  const S = num(spot);
  const exp = num(expectedClose) ?? S;
  if (!(K > 0) || !(exp > 0)) return null;
  const isPut = String(flavor || "").toLowerCase() === "put";
  const pin = Math.max(0, isPut ? K - exp : exp - K);
  const ny = nyParts(now);
  const dte0 = num(dte) === 0;
  const hoursToday = Math.max(0, (16 * 60 - ny.minutes) / 60);
  const hoursLeft = dte0 ? hoursToday : hoursToday + 6.5;
  const move = (num(atrPct) > 0 && S > 0)
    ? S * Number(atrPct)
    : Math.max(Math.abs(exp - (S || exp)), (S || exp) * 0.006);
  // Cushion is remaining *today* only. 1 DTE is chosen to hold the
  // 15:45-16:15 close run, not to pay a second full session of ATR.
  const todayFrac = Math.sqrt(Math.max(0, hoursToday) / 6.5);
  const timeCushion = dte0
    ? Math.min(Math.max(pin, 0.20) * 0.25, move * 0.04 * todayFrac)
    : Math.min(Math.max(pin, 0.15) * 0.35, move * 0.05 * todayFrac);
  const fmv = pin + (hoursToday <= 0 && dte0 ? 0 : timeCushion);
  const buyCeil = pin > 0.05 ? pin : Math.max(0.15, round2(fmv) || 0.15);
  const over = Math.max(buyCeil * 1.25, fmv, buyCeil + 0.08);
  const under = Math.max(0.05, buyCeil * 0.80);
  const mid = num(premium);
  let band = "unknown";
  if (mid != null) {
    if (mid <= under) band = "under";
    else if (mid >= over) band = "over";
    else band = "fair";
  }
  return {
    expected_close: round2(exp),
    pin: round2(pin),
    fmv: round2(fmv),
    buy_ceil: round2(buyCeil),
    under: round2(under),
    over: round2(over),
    premium: mid != null ? round2(mid) : null,
    band,
    hours_left: round2(hoursLeft),
  };
}

/**
 * INV / PB / TGT for the shared zone bar. Puts invert the path
 * (target below spot, invalidation above).
 */
export function buildDayTradeZoneModel({
  flavor,
  spot,
  gamePlan,
  invalidation,
  ema21,
} = {}) {
  const px = num(spot);
  if (!(px > 0)) return null;
  const gp = gamePlan || {};
  const isPut = String(flavor || "").toLowerCase() === "put";
  const invRaw = isPut
    ? (num(invalidation?.underlying_above) ?? num(gp.bull_trigger))
    : (num(invalidation?.underlying_below) ?? num(gp.bear_trigger));
  const tgtRaw = isPut ? num(gp.bear_target) : num(gp.bull_target);
  const trigger = isPut ? num(gp.bear_trigger) : num(gp.bull_trigger);
  const ema = num(ema21);
  const padPct = 0.006;
  const inv = invRaw != null ? invRaw : (isPut ? px * (1 + padPct) : px * (1 - padPct));
  const tgt = tgtRaw != null ? tgtRaw : (isPut ? px * (1 - padPct * 2) : px * (1 + padPct * 2));
  if (!(inv > 0) || !(tgt > 0) || inv === tgt) return null;

  const anchor = ema != null ? ema : (trigger != null ? trigger : px);
  const band = Math.max(px * 0.0025, 0.15);
  let pbLo = anchor - band;
  let pbHi = anchor + band;
  const lo = Math.min(inv, tgt);
  const hi = Math.max(inv, tgt);
  if (pbLo < lo) pbLo = lo + (hi - lo) * 0.28;
  if (pbHi > hi) pbHi = hi - (hi - lo) * 0.08;
  if (pbHi <= pbLo) {
    pbLo = px - band;
    pbHi = px + band;
  }

  const span = hi - lo;
  if (!(span > 0)) return null;
  const pad = span * 0.04;
  const minPx = lo - pad;
  const maxPx = hi + pad;
  return {
    inv: round2(inv),
    pb: [round2(pbLo), round2(pbHi)],
    tgt: round2(tgt),
    price: round2(px),
    minPx: round2(minPx),
    maxPx: round2(maxPx),
    lane: "trader",
    flavor: isPut ? "put" : "call",
  };
}

/** Revive a JSON zone (no functions) so TTLaneCard.zoneBarTrack can plot it. */
export function reviveZoneModel(zone, livePrice) {
  if (!zone || !(num(zone.minPx) < num(zone.maxPx))) return null;
  const minPx = Number(zone.minPx);
  const maxPx = Number(zone.maxPx);
  const span = maxPx - minPx;
  const price = num(livePrice) > 0 ? Number(livePrice) : Number(zone.price);
  const pct = (px) => Math.max(0, Math.min(100, ((Number(px) - minPx) / span) * 100));
  return { ...zone, price, pct, lane: zone.lane || "trader" };
}

/**
 * Highest RTH mid on or after `afterTs` today. Used to arm profit-lock
 * off the contract path, not only the last minute-lane poll mid — a spike that
 * printed between ticks still counts as "was green".
 */
export function peakMidSinceEntry(marks = [], afterTs, now = Date.now()) {
  if (afterTs == null || afterTs === "") return null;
  const start = num(afterTs);
  if (start == null) return null;
  const today = nyParts(now).ymd;
  let peak = null;
  for (const m of marks || []) {
    const ts = num(m.ts);
    const mid = num(m.mid ?? m.c);
    if (ts == null || !(mid > 0)) continue;
    if (!isRthEt(ts) || nyParts(ts).ymd !== today) continue;
    if (ts + 1e-9 < start) continue;
    if (peak == null || mid > peak) peak = mid;
  }
  return peak != null ? round2(peak) : null;
}

/**
 * Session path for one OCC symbol: RTH-only trough / peak.
 */
export function summarizeOptionPath(marks = [], now = Date.now()) {
  const today = nyParts(now).ymd;
  const rows = (Array.isArray(marks) ? marks : [])
    .map((m) => ({ ts: num(m.ts), mid: num(m.mid ?? m.c) }))
    .filter((m) => m.ts != null && m.mid != null && m.mid > 0 && isRthEt(m.ts) && nyParts(m.ts).ymd === today)
    .sort((a, b) => a.ts - b.ts);
  if (rows.length < 2) return null;
  let min = rows[0];
  let max = rows[0];
  for (const r of rows) {
    if (r.mid < min.mid) min = r;
    if (r.mid > max.mid) max = r;
  }
  const last = rows[rows.length - 1];
  return {
    n: rows.length,
    first_ts: rows[0].ts,
    last_ts: last.ts,
    last_mid: round2(last.mid),
    trough_ts: min.ts,
    trough_et: fmtEt(min.ts),
    trough_mid: round2(min.mid),
    peak_ts: max.ts,
    peak_et: fmtEt(max.ts),
    peak_mid: round2(max.mid),
  };
}

/**
 * Historical time-of-day study: per (symbol, NY date) find a *tradable*
 * RTH trough / peak, then take the interquartile window.
 *
 * Dying 0DTE premium prints its low at 15:50 as it goes to zero. That
 * is not a buy. A buy-quality trough has to land before 13:00 ET AND
 * be followed by at least a 15% bounce. A sell-quality peak has to
 * land after 09:45 (the open print is excluded — that is the chase).
 */
export function summarizeTodStudy(marks = []) {
  const byKey = new Map();
  for (const m of marks || []) {
    const ts = num(m.ts);
    const mid = num(m.mid ?? m.c);
    if (ts == null || mid == null || mid <= 0 || !isRthEt(ts)) continue;
    const key = `${String(m.option_symbol || m.ticker || "")}|${nyParts(ts).ymd}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ts, mid });
  }
  const troughHours = [];
  const peakHours = [];
  for (const rows of byKey.values()) {
    if (rows.length < 6) continue;
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    let buyTrough = null;
    let sellPeak = null;
    for (const r of sorted) {
      const hm = nyParts(r.ts).minutes;
      if (hm >= 9 * 60 + 45 && hm < 13 * 60) {
        if (!buyTrough || r.mid < buyTrough.mid) buyTrough = r;
      }
      if (hm >= 9 * 60 + 45 && hm < 15 * 60 + 30) {
        if (!sellPeak || r.mid > sellPeak.mid) sellPeak = r;
      }
    }
    if (buyTrough) {
      const bounce = sorted.some((r) => r.ts > buyTrough.ts && r.mid >= buyTrough.mid * 1.15);
      if (bounce) troughHours.push(nyParts(buyTrough.ts).hour + nyParts(buyTrough.ts).minute / 60);
    }
    if (sellPeak) {
      peakHours.push(nyParts(sellPeak.ts).hour + nyParts(sellPeak.ts).minute / 60);
    }
  }
  if (troughHours.length < 3) {
    return { ...DEFAULT_TOD_PLAYBOOK, n_days: troughHours.length };
  }
  const q = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.max(0, Math.min(s.length - 1, Math.round((s.length - 1) * p)));
    return s[i];
  };
  const fmtHr = (h) => {
    const hr = Math.floor(h);
    const min = Math.round((h - hr) * 60);
    const carry = min === 60;
    const hh = String(carry ? hr + 1 : hr).padStart(2, "0");
    const mm = String(carry ? 0 : min).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  const tLo = q(troughHours, 0.25);
  const tHi = q(troughHours, 0.75);
  const pLo = q(peakHours, 0.25);
  const pHi = q(peakHours, 0.75);
  return {
    buy_window_et: `${fmtHr(tLo)}-${fmtHr(tHi)}`,
    sell_window_et: `${fmtHr(pLo)}-${fmtHr(pHi)}`,
    open_avoid_et: DEFAULT_TOD_PLAYBOOK.open_avoid_et,
    source: "option_marks",
    n_days: troughHours.length,
    note: `Across ${troughHours.length} contract days, premium troughed ${fmtHr(tLo)}-${fmtHr(tHi)} ET and peaked ${fmtHr(pLo)}-${fmtHr(pHi)} ET.`,
  };
}

function contractLabel({ ticker, strike, flavor, expiration } = {}) {
  const t = String(ticker || "").toUpperCase();
  const k = num(strike);
  const right = String(flavor || "").toLowerCase() === "put" ? "P" : "C";
  const dte = num(expiration?.dte);
  const dteBit = dte === 0 ? "0 DTE" : dte === 1 ? "1 DTE" : (expiration?.label || "");
  const expBit = formatExpirationShort(expiration);
  const strikeBit = k != null ? String(Number.isInteger(k) ? k : k.toFixed(0)) : "";
  return {
    occ_short: `${t} ${strikeBit}${right}`,
    dte_bit: dteBit,
    exp_bit: expBit,
    right,
  };
}

function distPct(price, ema) {
  const p = num(price);
  const e = num(ema);
  if (!(p > 0) || !(e > 0)) return null;
  return ((p - e) / e) * 100;
}

/**
 * Build the clock the card prints.
 *
 * action:
 *   SELL — invalidation, hard stop, time stop, or TP1 already printed
 *          (09:30–16:15 ET only — invalidation waits for the cash open)
 *   BUY  — (a) game-plan trigger pierce while still fresh to the target, or
 *          (b) SuperTrend with the lean + price in/near the 21 EMA band;
 *          cash RTH after 09:45. Never newly enter after the lean target tags.
 *   WAIT — everything else (premarket, chase-after-target, against-trend, 09:30-09:45 open print)
 */
export function buildExecutionClock({
  ticker,
  flavor,
  strike,
  expiration,
  spot,
  premium,
  indicators,
  gamePlan,
  management,
  now = Date.now(),
  marks = [],
  todStudy = null,
  openBook = null,
} = {}) {
  const sym = String(ticker || "").toUpperCase();
  const flav = String(flavor || "").toLowerCase() === "put" ? "put" : "call";
  const isPut = flav === "put";
  const px = num(spot);
  const prem = num(premium);
  const ind = indicators || {};
  const ema21 = num(ind.ema21);
  const gp = gamePlan || {};
  const mgmt = management || {};
  const tod = todStudy && todStudy.buy_window_et ? todStudy : DEFAULT_TOD_PLAYBOOK;
  const path = summarizeOptionPath(marks, now);
  const pathPeakSinceEntry = peakMidSinceEntry(marks, num(openBook?.entry_ts), now);
  const zone = buildDayTradeZoneModel({
    flavor: flav,
    spot: px,
    gamePlan: gp,
    invalidation: mgmt.invalidation,
    ema21,
  });
  const { occ_short, dte_bit, exp_bit } = contractLabel({ ticker: sym, strike, flavor: flav, expiration });
  const ny = nyParts(now);
  const rth = isRthEt(now);
  const beforeCashOpen = ny.minutes < 9 * 60 + 30;
  const sellWindow = isOptionsSellWindowEt(now);
  const dte0 = num(expiration?.dte) === 0;
  const expectedClose = isPut
    ? (num(gp.bear_target) ?? px)
    : (num(gp.bull_target) ?? px);
  const value = computePremiumValueBand({
    strike,
    flavor: flav,
    spot: px,
    expectedClose,
    premium: prem,
    dte: num(expiration?.dte),
    now,
    atrPct: num(gp.atr_pct) ?? num(ind.atr_pct),
  });
  const targetPx = isPut ? num(gp.bear_target) : num(gp.bull_target);
  const rr = computePremiumRr({
    entry: prem,
    stopPct: num(mgmt.hard_stop_pct) ?? HARD_STOP_PCT,
    strike,
    flavor: flav,
    targetPx,
    pin: value?.pin,
  });
  const displayBuyCeil = prem != null && prem > 0
    ? (value?.fmv != null ? round2(Math.min(value.fmv, prem * 1.15)) : round2(prem * 1.08))
    : value?.buy_ceil;
  let holdOvernight = shouldHoldOvernight({
    dte: num(expiration?.dte),
    stWith: isPut ? stIsBear(ind.st_dir) : stIsBull(ind.st_dir),
    invalidated: false,
    premium: prem,
    entry: prem,
    targetPrem: rr?.target_prem,
    minutes: ny.minutes,
  });
  const requestedStop = String(mgmt.time_stop_et || (dte0 ? "12:00" : SESSION_FLAT_ET));
  const [tsH, tsM] = requestedStop.split(":").map((x) => Number(x));
  let timeStopMin = (Number.isFinite(tsH) ? tsH : (dte0 ? 12 : 15)) * 60
    + (Number.isFinite(tsM) ? tsM : (dte0 ? 0 : 45));
  // Same-day flatten is 15:45 ET — before the cash close. 16:15 is only
  // reachable if the overnight hold is on.
  if (!dte0 && !holdOvernight && timeStopMin > CLOSE_AUCTION_START) {
    timeStopMin = CLOSE_AUCTION_START;
  }
  const timeStop = `${String(Math.floor(timeStopMin / 60)).padStart(2, "0")}:${String(timeStopMin % 60).padStart(2, "0")}`;
  const dist = distPct(px, ema21);
  const nearEma = dist != null && Math.abs(dist) <= 0.35;
  const extended = dist != null && (isPut ? dist < -0.40 : dist > 0.40);
  const stWith = isPut ? stIsBear(ind.st_dir) : stIsBull(ind.st_dir);
  const stAgainst = isPut ? stIsBull(ind.st_dir) : stIsBear(ind.st_dir);
  const invPx = isPut
    ? num(mgmt.invalidation?.underlying_above) ?? num(gp.inv_put) ?? num(gp.bull_trigger)
    : num(mgmt.invalidation?.underlying_below) ?? num(gp.inv_call) ?? num(gp.bear_trigger);
  const invalidated = px != null && invPx != null && (isPut ? px > invPx : px < invPx);
  if (invalidated) holdOvernight = false;
  const tp1 = rr?.trim != null ? rr.trim : (num(mgmt.take_profit_1?.pct) ?? 50);
  const hardStop = num(mgmt.hard_stop_pct) ?? HARD_STOP_PCT;
  const atTrough = path && prem != null && path.trough_mid > 0 && prem <= path.trough_mid * 1.08;
  const offPeak = path && prem != null && path.peak_mid > 0 && prem <= path.peak_mid * 0.80;
  const openPrint = ny.minutes >= 9 * 60 + 30 && ny.minutes < 9 * 60 + 45;
  const carryOvernight = isOvernightCarry(openBook, now);
  const bookStatus = String(openBook?.status || "").toLowerCase();
  const hasLiveBook = carryOvernight || bookStatus === "open" || bookStatus === "trimmed";
  const bookEntry = num(openBook?.entry_premium) ?? prem;
  const bookRr = carryOvernight && bookEntry > 0
    ? computePremiumRr({
      entry: bookEntry,
      stopPct: num(mgmt.hard_stop_pct) ?? HARD_STOP_PCT,
      strike,
      flavor: flav,
      targetPx,
      pin: value?.pin,
    })
    : null;
  const manageTrim = num(openBook?.trim_premium) ?? bookRr?.trim;
  const manageExit = num(openBook?.exit_premium) ?? bookRr?.exit;
  const forceLiqWindow = dte0 && ny.minutes >= FORCE_LIQ_MIN;
  const closeAuction = !dte0 && ny.minutes >= CLOSE_AUCTION_START && ny.minutes < CLOSE_AUCTION_END;
  const sessionFlatten = !dte0 && ny.minutes >= CLOSE_AUCTION_START && !holdOvernight;
  const lateEntry = ny.minutes >= 15 * 60 + 30;
  const rrBlocked = rr != null && !rr.positive;
  const premiumRich = value?.band === "over";
  const premiumCheap = value?.band === "under";
  // Day-trade game-plan trigger/target (same levels the Daily Brief grades).
  // Trigger-pierce lets the 1-min lane fire when cash breaks the level —
  // without waiting for a late EMA mean-revert that often arrives after
  // the target is already tagged (SPY/QQQ 2026-09-03 bought at 15:06).
  const leanTrigger = isPut ? num(gp.bear_trigger) : num(gp.bull_trigger);
  const leanTarget = isPut ? num(gp.bear_target) : num(gp.bull_target);
  const triggerPierced = px != null && leanTrigger != null
    && (isPut ? px <= leanTrigger : px >= leanTrigger);
  const targetTagged = px != null && leanTarget != null
    && (isPut ? px <= leanTarget : px >= leanTarget);
  let triggerProgress = null;
  if (px != null && leanTrigger != null && leanTarget != null) {
    const span = leanTarget - leanTrigger;
    if (span !== 0) triggerProgress = (px - leanTrigger) / span;
  }
  // Fresh = through the trigger but not yet most of the way to the target.
  const triggerFresh = triggerProgress != null && triggerProgress >= 0 && triggerProgress < 0.55;

  let action = "WAIT";
  let sellKind = null;
  let entryMode = null;
  let why = "Stalk the first pullback into the 5-minute 21 EMA. The opening print usually overpays premium.";

  if (beforeCashOpen) {
    action = "WAIT";
    why = invalidated
      ? `${sym} is through invalidation at $${round2(invPx)} — flatten at the 09:30 ET cash open, not in premarket.`
      : carryOvernight
        ? "Overnight book is still open. Index options are not tradeable until the 09:30 ET cash open. Trim and exit stay live at the open."
        : "Index options are not tradeable until the 09:30 ET cash open. Stalk the first pullback after 09:45.";
  } else if (!sellWindow) {
    action = "WAIT";
    why = "Index options session is closed. Sells are live 09:30-16:15 ET.";
  } else if (invalidated && hasLiveBook) {
    action = "SELL";
    sellKind = "invalidation";
    why = isPut
      ? `${sym} reclaimed the invalidation at $${round2(invPx)} — the put thesis is done.`
      : `${sym} lost the invalidation at $${round2(invPx)} — the call thesis is done.`;
  } else if (invalidated) {
    action = "WAIT";
    why = isPut
      ? `${sym} reclaimed $${round2(invPx)} — put thesis is done. Do not open a new ${flav}.`
      : `${sym} lost $${round2(invPx)} — call thesis is done. Do not open a new ${flav}.`;
  } else if (forceLiqWindow && hasLiveBook) {
    action = "SELL";
    sellKind = "force_liq";
    why = "0 DTE is in the broker force-liquidation window (from 15:15 ET, typically flat by 15:45). Roll to 1 DTE to hold the 15:45-16:15 close run.";
  } else if (forceLiqWindow) {
    action = "WAIT";
    why = "0 DTE force-liq window — flatten any open 0 DTE before 15:45 ET. Roll to 1 DTE to hold the close run.";
  } else if (sessionFlatten && hasLiveBook) {
    action = "SELL";
    sellKind = "session_close";
    why = `Flatten by ${SESSION_FLAT_ET} ET — before the cash close. Overnight risk can erase the gain; 16:15 is not the planned exit.`;
  } else if (sessionFlatten) {
    action = "WAIT";
    why = `If this ${flav} is still open, flatten by ${SESSION_FLAT_ET} ET before the cash close.`;
  } else if (dte0 && ny.minutes >= timeStopMin && hasLiveBook) {
    action = "SELL";
    sellKind = "time_stop";
    why = `0 DTE time stop is ${timeStop} ET. Flat anything that is not working; do not hold into 15:45 force-liq.`;
  } else if (dte0 && ny.minutes >= timeStopMin) {
    action = "WAIT";
    why = `0 DTE time stop is ${timeStop} ET — flatten any open 0 DTE that is not working.`;
  } else if (carryOvernight && openPrint && manageExit != null && prem != null && prem + 1e-9 >= manageExit) {
    action = "SELL";
    sellKind = "open_exit";
    why = "Overnight book — take the open exit. Do not wait for 09:45; the first print is often the profit-taking run.";
  } else if (carryOvernight && openPrint && String(openBook?.status) === "open" && manageTrim != null && prem != null && prem + 1e-9 >= manageTrim) {
    action = "TRIM";
    sellKind = "open_trim";
    why = "Overnight book — trim at the open. Do not wait for 09:45; a profit-taking dump can erase the gain.";
  } else if (carryOvernight && openPrint) {
    action = "WAIT";
    why = "Overnight book — trim and exit are live from 09:30. Do not wait for 09:45; the open is often the profit-taking print.";
  } else if (path && prem != null && path.trough_mid > 0 && prem <= path.trough_mid * (1 + hardStop / 100 + 0.02) && path.peak_mid && prem < path.peak_mid * 0.55) {
    action = "WAIT";
    why = `Premium already bled from $${path.peak_mid} (${path.peak_et} ET) to $${round2(prem)}. Do not chase a dead contract.`;
  } else if (targetTagged && stWith && !hasLiveBook) {
    // Anti-chase must beat premium-rich / EMA-pullback — Sep 3 SPY bought
    // at 15:06 on a late EMA tag after bull target was already done.
    action = "WAIT";
    why = `${sym} already tagged the day-trade ${isPut ? "bear" : "bull"} target at $${round2(leanTarget)}. Do not chase a late entry — the brief move is done.`;
  } else if (premiumRich && stWith) {
    action = "WAIT";
    why = `Tape agrees but premium $${round2(prem)} is rich vs FMV $${value.fmv} (pin $${value.pin} if ${sym} closes $${value.expected_close}). Wait for a print at or under $${value.buy_ceil}.`;
  } else if (rrBlocked && stWith) {
    action = "WAIT";
    why = `R:R to the target is ${rr.rr}:1 — below 1:1 at this print. Wait for a cheaper mid so the stop is covered.`;
  } else if (lateEntry && stWith) {
    action = "WAIT";
    why = holdOvernight
      ? "Too late for a new ticket. Existing book may hold overnight — leftover R:R is still ≥ 1."
      : "Too late for a new ticket. Flatten any open book by 15:45 ET; do not wait until 16:15.";
  } else if (!hasLiveBook && isPut && gp.or_resolved === false && px != null && (
    (num(gp.overnight_mid) != null && px > num(gp.overnight_mid))
    || (num(gp.prev_close) != null && px > num(gp.prev_close))
  )) {
    action = "WAIT";
    why = `${sym} is above the premarket pivot while the opening range is still forming. Do not buy the put into the bounce — wait for the 10:00 ET OR vote.`;
  } else if (rth && stWith && triggerPierced && triggerFresh && !openPrint && !premiumRich && !hasLiveBook) {
    action = "BUY";
    entryMode = "trigger_pierce";
    why = `${sym} pierced the ${isPut ? "bear" : "bull"} trigger at $${round2(leanTrigger)} with SuperTrend ${ind.st_label || "aligned"} — enter on the break, not a late EMA tag. Target $${round2(leanTarget)}.`;
  } else if (rth && stWith && nearEma && !openPrint && !extended && !premiumRich && !targetTagged) {
    action = "BUY";
    entryMode = "ema_pullback";
    why = `${sym} is holding the ${ind.tf || "5"}-minute 21 EMA${ema21 ? ` ($${ema21})` : ""} with SuperTrend ${ind.st_label || "aligned"}. Premium is ${value?.band || "unpriced"} vs FMV $${value?.fmv ?? "—"}.`;
  } else if (rth && stWith && atTrough && !openPrint && !premiumRich && !targetTagged) {
    action = "BUY";
    entryMode = "premium_trough";
    why = `This contract is at the session trough ($${path.trough_mid} at ${path.trough_et} ET) while SuperTrend still agrees.`;
  } else if (rth && stWith && premiumCheap && !openPrint && !extended && !targetTagged) {
    action = "BUY";
    entryMode = "premium_cheap";
    why = `Premium $${round2(prem)} is under FMV $${value.fmv} (expected close $${value.expected_close}) and SuperTrend agrees.`;
  } else if (stAgainst) {
    action = "WAIT";
    why = `SuperTrend is ${ind.st_label || "against"} this ${flav}. Wait for the ${ind.tf || "5"}-minute flip — the contract will not lead the underlying.`;
  } else if (openPrint) {
    action = "WAIT";
    why = `09:30-09:45 ET is the open auction. Premium is usually widest here — wait for the first pullback (${tod.buy_window_et} ET).`;
  } else if (extended) {
    action = "WAIT";
    why = `${sym} is ${dist >= 0 ? "extended above" : "extended below"} the 21 EMA${ema21 ? ` ($${ema21})` : ""}. Let the underlying mean-revert into the band before paying the contract.`;
  } else if (offPeak && !stWith) {
    action = "WAIT";
    why = `Contract has rolled over from the ${path.peak_et} ET peak ($${path.peak_mid}). No SuperTrend confirmation to re-enter.`;
  }

  if (carryOvernight && action === "BUY") {
    action = "WAIT";
    why = "Overnight book is still open. Trim and exit stay live — do not add a new ticket until this book is flat.";
  }

  const contractBit = `${occ_short}${exp_bit ? ` ${exp_bit}` : ""}${dte_bit ? ` (${dte_bit})` : ""}`;
  const emaBit = ema21 != null ? ` the ${ind.tf || "5"}-minute 21 EMA ($${ema21})` : " the 5-minute 21 EMA";
  const stBit = `SuperTrend is ${isPut ? "short" : "long"}`;
  const fmvBit = value
    ? ` Pay at or under $${value.buy_ceil} (FMV $${value.fmv} if ${sym} closes $${value.expected_close}; rich ≥ $${value.over}).`
    : "";
  const buyRule = `Buy the ${contractBit} when ${sym} holds${emaBit} and ${stBit}.${fmvBit} Prefer the game-plan trigger pierce while the target is still open; otherwise the first pullback into the 21 EMA (${tod.buy_window_et} ET) — not the open print, and not after the target tags.`;
  const invBit = invPx != null
    ? (isPut ? ` or if ${sym} reclaims $${round2(invPx)}` : ` or if ${sym} loses $${round2(invPx)}`)
    : "";
  const overBit = value ? ` or when premium is rich (≥ $${value.over})` : "";
  const flattenBit = dte0
    ? "0 DTE must be flat by 15:15 ET (broker force-liq ~15:45)."
    : (holdOvernight || carryOvernight
      ? "Overnight hold is on — leftover R:R ≥ 1. Trim and exit stay live at the next open; do not wait for 09:45. Flatten next session if the open does not pay."
      : `Flatten by ${SESSION_FLAT_ET} ET, before the cash close. Overnight only if leftover R:R stays ≥ 1.`);
  const trimBit = rr?.trim != null ? ` $${Number(rr.trim).toFixed(2)} (1R)` : ` +${tp1}%`;
  const exitBit = rr?.exit != null ? ` $${Number(rr.exit).toFixed(2)} (2R)` : ` +${num(mgmt.take_profit_2?.pct) ?? 100}%`;
  const sellRule = `Collect half at${trimBit} premium${overBit}. Close the rest at${exitBit}, at the ${timeStop === "overnight" ? "next-session" : `${timeStop} ET`} time stop, on a ${hardStop}% premium stop${invBit}. ${flattenBit}`;
  const pathNote = path
    ? `This contract bottomed at $${path.trough_mid} (${path.trough_et} ET) and peaked at $${path.peak_mid} (${path.peak_et} ET).`
    : (tod.note || null);
  const dteNote = dte0
    ? "0 DTE can be force-liquidated from 15:15 ET. Flatten 0 DTE well before the cash close."
    : (holdOvernight || carryOvernight)
      ? "Overnight hold — thesis intact and leftover R:R ≥ 1. Trim and exit are live from 09:30 the next session; do not wait for 09:45. 16:15 is not the planned exit."
      : "Flatten by 15:45 ET unless leftover R:R still justifies holding overnight. Do not wait until 16:15 to take an intended exit.";

  const headline = action === "BUY"
    ? `BUY ${contractBit} — ${entryMode === "trigger_pierce"
      ? `trigger $${round2(leanTrigger)}`
      : (premiumCheap ? "under FMV" : "pullback into")}${entryMode === "trigger_pierce" || premiumCheap ? "" : emaBit}`
    : action === "TRIM"
      ? `TRIM ${contractBit} — take the open, do not wait for 09:45`
      : action === "SELL"
        ? `FLAT ${contractBit} — ${why.split("—")[0].trim()}`
        : `WAIT on ${contractBit} — ${beforeCashOpen
          ? (invalidated ? "flatten at 09:30 ET" : "index options open 09:30 ET")
          : (!sellWindow
            ? "session closed"
            : (carryOvernight && openPrint
              ? "trim/exit live at the open"
              : (premiumRich ? `rich vs FMV $${value?.fmv}` : `stalk ${tod.buy_window_et} ET`)))}`;

  const scanParts = [
    displayBuyCeil != null ? `Debit ≤ $${Number(displayBuyCeil).toFixed(2)}` : null,
    rr?.trim != null ? `collect trim $${Number(rr.trim).toFixed(2)}` : null,
    rr?.exit != null ? `collect exit $${Number(rr.exit).toFixed(2)}` : null,
    holdOvernight || carryOvernight ? "hold overnight" : `flat ${SESSION_FLAT_ET} ET`,
    exp_bit || null,
    dte_bit || null,
  ].filter(Boolean);

  const displayAction = action === "SELL" ? "FLAT" : action;

  return {
    action,
    display_action: displayAction,
    leg_side: "debit",
    sell_kind: sellKind,
    headline,
    scan_line: scanParts.join(" · "),
    why,
    buy_rule: buyRule,
    sell_rule: sellRule,
    path_note: pathNote,
    path_peak_since_entry: pathPeakSinceEntry,
    dte_note: dteNote,
    premium_band: value ? { ...value, display_buy_ceil: displayBuyCeil } : value,
    tod,
    path,
    entry_mode: entryMode,
    trigger: {
      level: leanTrigger,
      target: leanTarget,
      pierced: triggerPierced,
      target_tagged: targetTagged,
      progress: triggerProgress != null ? round2(triggerProgress) : null,
      fresh: triggerFresh,
    },
    indicators: {
      ema21,
      st_dir: ind.st_dir ?? null,
      st_label: ind.st_label || null,
      dist_pct: dist != null ? round2(dist) : null,
      tf: ind.tf || null,
      near_ema: nearEma,
      extended,
    },
    zone,
    rr,
    hold_overnight: holdOvernight,
    carry_overnight: carryOvernight,
    contract: {
      ticker: sym,
      flavor: flav,
      strike: num(strike),
      expiration: expiration || null,
      label: occ_short,
      dte: dte_bit,
      exp_bit: exp_bit || "",
    },
  };
}

export function groupMarksByOcc(rows = []) {
  const out = {};
  for (const r of rows || []) {
    const occ = String(r.option_symbol || "").toUpperCase();
    if (!occ) continue;
    if (!out[occ]) out[occ] = [];
    out[occ].push(r);
  }
  return out;
}
