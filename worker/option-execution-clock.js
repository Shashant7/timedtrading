// option-execution-clock.js
//
// Buy / sell timing for 0/1 DTE index options. The contract print tracks
// the underlying: a SPY 765C walks the same 21 EMA and SuperTrend as SPY.
// This module turns that coupling + the option-marks path (when the
// contract actually bottomed / peaked) into a machine-readable clock
// the Today card can spell out under the ticker.
//
// Pure. No I/O. Caller attaches D1 marks + ticker tf_tech.

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

/**
 * Prefer 5m, then 10m/15m. 1-minute SuperTrend/EMA21 is noise on 0/1 DTE;
 * 5m is the tape those contracts actually follow. Daily is context only.
 */
export function extractIndexTimingIndicators(ticker = {}) {
  const tf = ticker?.tf_tech && typeof ticker.tf_tech === "object" ? ticker.tf_tech : {};
  const order = ["5", "10", "15", "30"];
  let tfLabel = null;
  let pick = null;
  for (const k of order) {
    if (tf[k]?.ema?.ema21 != null || num(tf[k]?.stDir) != null) {
      tfLabel = k;
      pick = tf[k];
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
  };
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
  const strikeBit = k != null ? String(Number.isInteger(k) ? k : k.toFixed(0)) : "";
  return {
    occ_short: `${t} ${strikeBit}${right}`,
    dte_bit: dteBit,
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
 *   BUY  — SuperTrend with the lean, price in/near the 21 EMA band, not the open print
 *   WAIT — everything else (chase, against-trend, before 09:45)
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
  const zone = buildDayTradeZoneModel({
    flavor: flav,
    spot: px,
    gamePlan: gp,
    invalidation: mgmt.invalidation,
    ema21,
  });
  const { occ_short, dte_bit } = contractLabel({ ticker: sym, strike, flavor: flav, expiration });
  const ny = nyParts(now);
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
  const requestedStop = String(mgmt.time_stop_et || (dte0 ? "12:00" : "16:15"));
  const [tsH, tsM] = requestedStop.split(":").map((x) => Number(x));
  let timeStopMin = (Number.isFinite(tsH) ? tsH : (dte0 ? 12 : 16)) * 60
    + (Number.isFinite(tsM) ? tsM : (dte0 ? 0 : 15));
  // 1 DTE holds the 15:45-16:15 close-auction run. A 15:30 card stop
  // would flatten the exact window 1 DTE exists to capture.
  if (!dte0 && timeStopMin < CLOSE_AUCTION_END) timeStopMin = CLOSE_AUCTION_END;
  const timeStop = `${String(Math.floor(timeStopMin / 60)).padStart(2, "0")}:${String(timeStopMin % 60).padStart(2, "0")}`;
  const dist = distPct(px, ema21);
  const nearEma = dist != null && Math.abs(dist) <= 0.35;
  const extended = dist != null && (isPut ? dist < -0.40 : dist > 0.40);
  const stWith = isPut ? stIsBear(ind.st_dir) : stIsBull(ind.st_dir);
  const stAgainst = isPut ? stIsBull(ind.st_dir) : stIsBear(ind.st_dir);
  const invPx = isPut
    ? num(mgmt.invalidation?.underlying_above) ?? num(gp.bull_trigger)
    : num(mgmt.invalidation?.underlying_below) ?? num(gp.bear_trigger);
  const invalidated = px != null && invPx != null && (isPut ? px > invPx : px < invPx);
  const tp1 = num(mgmt.take_profit_1?.pct) ?? 40;
  const hardStop = num(mgmt.hard_stop_pct) ?? -50;
  const atTrough = path && prem != null && path.trough_mid > 0 && prem <= path.trough_mid * 1.08;
  const offPeak = path && prem != null && path.peak_mid > 0 && prem <= path.peak_mid * 0.80;
  const openPrint = ny.minutes >= 9 * 60 + 30 && ny.minutes < 9 * 60 + 45;
  const forceLiqWindow = dte0 && ny.minutes >= FORCE_LIQ_MIN;
  const closeAuction = !dte0 && ny.minutes >= CLOSE_AUCTION_START && ny.minutes < CLOSE_AUCTION_END;
  const oneDteFlatten = !dte0 && ny.minutes >= CLOSE_AUCTION_END;
  const premiumRich = value?.band === "over";
  const premiumCheap = value?.band === "under";

  let action = "WAIT";
  let sellKind = null;
  let why = "Stalk the first pullback into the 5-minute 21 EMA. The opening print usually overpays premium.";

  if (invalidated) {
    action = "SELL";
    sellKind = "invalidation";
    why = isPut
      ? `${sym} reclaimed the invalidation at $${round2(invPx)} — the put thesis is done.`
      : `${sym} lost the invalidation at $${round2(invPx)} — the call thesis is done.`;
  } else if (forceLiqWindow) {
    action = "SELL";
    sellKind = "force_liq";
    why = "0 DTE is in the broker force-liquidation window (from 15:15 ET, typically flat by 15:45). Roll to 1 DTE to hold the 15:45-16:15 close run.";
  } else if (oneDteFlatten) {
    action = "SELL";
    sellKind = "close_auction";
    why = "1 DTE close-auction window is done (16:15 ET). Take the premium — 15:45-16:15 is the hold, not after.";
  } else if (dte0 && ny.minutes >= timeStopMin) {
    action = "SELL";
    sellKind = "time_stop";
    why = `0 DTE time stop is ${timeStop} ET. Flat anything that is not working; do not hold into 15:45 force-liq.`;
  } else if (path && prem != null && path.trough_mid > 0 && prem <= path.trough_mid * (1 + hardStop / 100 + 0.02) && path.peak_mid && prem < path.peak_mid * 0.55) {
    action = "WAIT";
    why = `Premium already bled from $${path.peak_mid} (${path.peak_et} ET) to $${round2(prem)}. Do not chase a dead contract.`;
  } else if (premiumRich && stWith) {
    action = "WAIT";
    why = `Tape agrees but premium $${round2(prem)} is rich vs FMV $${value.fmv} (pin $${value.pin} if ${sym} closes $${value.expected_close}). Wait for a print at or under $${value.buy_ceil}.`;
  } else if (stWith && nearEma && !openPrint && !extended && !premiumRich) {
    action = "BUY";
    why = `${sym} is holding the ${ind.tf || "5"}-minute 21 EMA${ema21 ? ` ($${ema21})` : ""} with SuperTrend ${ind.st_label || "aligned"}. Premium is ${value?.band || "unpriced"} vs FMV $${value?.fmv ?? "—"}.`;
  } else if (stWith && atTrough && !openPrint && !premiumRich) {
    action = "BUY";
    why = `This contract is at the session trough ($${path.trough_mid} at ${path.trough_et} ET) while SuperTrend still agrees.`;
  } else if (stWith && premiumCheap && !openPrint && !extended) {
    action = "BUY";
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

  const emaBit = ema21 != null ? ` the ${ind.tf || "5"}-minute 21 EMA ($${ema21})` : " the 5-minute 21 EMA";
  const stBit = `SuperTrend is ${isPut ? "short" : "long"}`;
  const fmvBit = value
    ? ` Pay at or under $${value.buy_ceil} (FMV $${value.fmv} if ${sym} closes $${value.expected_close}; rich ≥ $${value.over}).`
    : "";
  const buyRule = `Buy the ${occ_short}${dte_bit ? ` (${dte_bit})` : ""} when ${sym} holds${emaBit} and ${stBit}.${fmvBit} Typical trough ${tod.buy_window_et} ET — first pullback, not the open print.`;
  const invBit = invPx != null
    ? (isPut ? ` or if ${sym} reclaims $${round2(invPx)}` : ` or if ${sym} loses $${round2(invPx)}`)
    : "";
  const overBit = value ? ` or when premium is rich (≥ $${value.over})` : "";
  const flattenBit = dte0
    ? "0 DTE must be flat by 15:15 ET (broker force-liq ~15:45)."
    : "1 DTE holds 15:45-16:15 ET close-auction, then flatten after 16:15.";
  const sellRule = `Sell half at +${tp1}% premium${overBit}. Close the rest at +${num(mgmt.take_profit_2?.pct) ?? 100}%, at the ${timeStop} ET time stop, on a ${hardStop}% premium stop${invBit}. ${flattenBit}`;
  const pathNote = path
    ? `This contract bottomed at $${path.trough_mid} (${path.trough_et} ET) and peaked at $${path.peak_mid} (${path.peak_et} ET).`
    : (tod.note || null);
  const dteNote = dte0
    ? "0 DTE can be force-liquidated from 15:15 ET. The 15:45-16:15 close run is for 1 DTE (or cash to exercise)."
    : closeAuction
      ? "Close-auction window (15:45-16:15 ET) — 1 DTE still trades; this is the run 0 DTE often misses after a force-liq."
      : "Headline is 1 DTE so the book can hold 15:45-16:15 without a 15:45 force-liq.";

  const headline = action === "BUY"
    ? `BUY ${occ_short} — ${premiumCheap ? "under FMV" : "pullback into"}${premiumCheap ? "" : emaBit}`
    : action === "SELL"
      ? `SELL ${occ_short} — ${why.split("—")[0].trim()}`
      : `WAIT on ${occ_short} — ${premiumRich ? `rich vs FMV $${value?.fmv}` : `stalk ${tod.buy_window_et} ET`}`;

  return {
    action,
    sell_kind: sellKind,
    headline,
    why,
    buy_rule: buyRule,
    sell_rule: sellRule,
    path_note: pathNote,
    dte_note: dteNote,
    premium_band: value,
    tod,
    path,
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
    contract: { ticker: sym, flavor: flav, strike: num(strike), expiration: expiration || null, label: occ_short, dte: dte_bit },
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
