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
  source: "playbook",
  note: "0/1 DTE premium usually bottoms on the first pullback into the 21 EMA, not the opening print. Peaks once SuperTrend holds into midday.",
};

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
 * Prefer 15m/10m/30m 21 EMA + SuperTrend for day-trade timing; fall
 * back to daily. Matches the "contract follows SPY LTF" premise.
 */
export function extractIndexTimingIndicators(ticker = {}) {
  const tf = ticker?.tf_tech && typeof ticker.tf_tech === "object" ? ticker.tf_tech : {};
  const ltf = tf["15"] || tf["10"] || tf["30"] || null;
  const daily = tf.D || null;
  const pick = ltf || daily || {};
  const ema21 = num(pick?.ema?.ema21) ?? num(daily?.ema?.ema21) ?? num(ticker?.ema21);
  const stDir = num(pick?.stDir) ?? num(daily?.stDir);
  const priceAbove = pick?.ema?.priceAboveEma21;
  const tfLabel = ltf ? (tf["15"] ? "15" : tf["10"] ? "10" : "30") : (daily ? "D" : null);
  return {
    ema21: round2(ema21),
    st_dir: stDir,
    st_label: stIsBull(stDir) ? "long" : stIsBear(stDir) ? "short" : "flat",
    price_above_ema21: priceAbove == null ? null : !!priceAbove,
    tf: tfLabel,
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
  const timeStop = String(mgmt.time_stop_et || (dte0 ? "12:00" : "15:30"));
  const [tsH, tsM] = timeStop.split(":").map((x) => Number(x));
  const timeStopMin = (Number.isFinite(tsH) ? tsH : 15) * 60 + (Number.isFinite(tsM) ? tsM : 30);
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

  let action = "WAIT";
  let why = "Stalk the first pullback into the 21 EMA. The opening print usually overpays premium.";

  if (invalidated) {
    action = "SELL";
    why = isPut
      ? `${sym} reclaimed the invalidation at $${round2(invPx)} — the put thesis is done.`
      : `${sym} lost the invalidation at $${round2(invPx)} — the call thesis is done.`;
  } else if (ny.minutes >= timeStopMin && ny.minutes < 16 * 60) {
    action = "SELL";
    why = `${dte0 ? "0 DTE" : "Session"} time stop is ${timeStop} ET. Flat anything that is not working.`;
  } else if (path && prem != null && path.trough_mid > 0 && prem <= path.trough_mid * (1 + hardStop / 100 + 0.02) && path.peak_mid && prem < path.peak_mid * 0.55) {
    // already crushed vs the session peak — do not average down into theta
    action = "WAIT";
    why = `Premium already bled from $${path.peak_mid} (${path.peak_et} ET) to $${round2(prem)}. Do not chase a dead contract.`;
  } else if (stWith && nearEma && !openPrint && !extended) {
    action = "BUY";
    why = `${sym} is holding the ${ind.tf || ""} 21 EMA${ema21 ? ` ($${ema21})` : ""} with SuperTrend ${ind.st_label || "aligned"}. That is the same print the ${occ_short} will follow.`;
  } else if (stWith && atTrough && !openPrint) {
    action = "BUY";
    why = `This contract is at the session trough ($${path.trough_mid} at ${path.trough_et} ET) while SuperTrend still agrees.`;
  } else if (stAgainst) {
    action = "WAIT";
    why = `SuperTrend is ${ind.st_label || "against"} this ${flav}. Wait for the ${ind.tf || "LTF"} flip — the contract will not lead the underlying.`;
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

  const emaBit = ema21 != null ? ` the 21 EMA ($${ema21})` : " the 21 EMA";
  const stBit = `SuperTrend is ${isPut ? "short" : "long"}`;
  const buyRule = `Buy the ${occ_short}${dte_bit ? ` (${dte_bit})` : ""} when ${sym} holds${emaBit} and ${stBit}. Typical premium trough ${tod.buy_window_et} ET — first pullback, not the open print.`;
  const invBit = invPx != null
    ? (isPut ? ` or if ${sym} reclaims $${round2(invPx)}` : ` or if ${sym} loses $${round2(invPx)}`)
    : "";
  const sellRule = `Sell half at +${tp1}% premium. Close the rest at +${num(mgmt.take_profit_2?.pct) ?? 100}%, at the ${timeStop} ET time stop, on a ${hardStop}% premium stop${invBit}.`;
  const pathNote = path
    ? `This contract bottomed at $${path.trough_mid} (${path.trough_et} ET) and peaked at $${path.peak_mid} (${path.peak_et} ET).`
    : (tod.note || null);

  const headline = action === "BUY"
    ? `BUY ${occ_short} — pullback into${emaBit}`
    : action === "SELL"
      ? `SELL ${occ_short} — ${why.split("—")[0].trim()}`
      : `WAIT on ${occ_short} — stalk ${tod.buy_window_et} ET`;

  return {
    action,
    headline,
    why,
    buy_rule: buyRule,
    sell_rule: sellRule,
    path_note: pathNote,
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
