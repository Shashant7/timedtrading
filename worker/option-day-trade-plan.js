// option-day-trade-plan.js
//
// Saty-style day-trade plan + paper-execution events for index 0/1 DTE.
// Five boxes: Setup/Thesis, Trigger, Entry, Exits, Stop. Size is
// light / medium / heavy so a Discord #trade-signals embed can carry
// the same plan a bracket order would use.
//
// Pure. No I/O.

import {
  getStaticCalendar,
  getETDateStr,
  getEasternParts,
  isEquityHoliday,
  isNyRegularMarketOpenStatic,
} from "./market-calendar.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

function money(v) {
  const n = round2(v);
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

export const SIZE_CONTRACTS = { light: 1, medium: 2, heavy: 3 };
export const HARD_STOP_PCT = -50;
export const MIN_RR = 1;
export const TRIM_R = 1;
export const EXIT_R = 2;
/** Absolute floor so a $0.45 entry does not trim at $0.53. */
export const MIN_TRIM_DOLLARS = 0.15;
/** Partial trim needs ≥2 contracts — one-lot books PROTECT at 1R instead. */
export const MIN_CONTRACTS_FOR_TRIM = 2;
/** After 1R / trim, exit runner if premium gives back this fraction from peak. */
export const TRAIL_GIVEBACK_PCT = 0.40;
/** Sell qty for a 50% trim (whole contracts). */
export function trimSellQty(contracts) {
  const c = Math.max(1, Math.round(Number(contracts) || 1));
  return Math.max(1, Math.round(c * 0.5));
}
export const SESSION_FLAT_ET = "15:45";
/** Overnight is decided from 15:30 ET, not at the morning entry. */
export const OVERNIGHT_DECIDE_MIN = 15 * 60 + 30;
export const OPEN_PRINT_START_MIN = 9 * 60 + 30;
export const OPEN_PRINT_END_MIN = 9 * 60 + 45;
export const CASH_CLOSE_MIN = 16 * 60;
/** Last sell is before 16:15 ET — the index options close. */
export const SELL_WINDOW_END_MIN = 16 * 60 + 15;
const SLEEVE_USD = 25000;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar expiration for chips / Discord — "Aug 22", not just "1 DTE". */
export function formatExpirationShort(expiration) {
  const iso = String(expiration?.iso || expiration?.date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [, m, d] = iso.split("-").map(Number);
    if (m >= 1 && m <= 12 && d >= 1) return `${MONTHS_SHORT[m - 1]} ${d}`;
  }
  const label = String(expiration?.label || "").trim();
  if (label && !/^\d+\s*DTE$/i.test(label)) return label;
  return "";
}

/** New index-option buys: cash session after the 09:45 open-print wait. */
export function isOptionsBuyWindowEt(ts) {
  if (!isNyRegularMarketOpenStatic(new Date(Number(ts)))) return false;
  const m = nyMinutes(ts);
  return m != null && m >= OPEN_PRINT_END_MIN && m < CASH_CLOSE_MIN;
}

/** US equity session day (weekday, non-holiday) — not necessarily RTH-open at `ts`. */
function isNyEquityTradingDayStatic(ts) {
  const now = new Date(Number(ts));
  const { weekday } = getEasternParts(now);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const cal = getStaticCalendar();
  const dateStr = getETDateStr(now);
  return !isEquityHoliday(cal, dateStr);
}

/** Flatten / trim / exit: 09:30 ET until before 16:15 ET. Not premarket. */
export function isOptionsSellWindowEt(ts) {
  if (!isNyEquityTradingDayStatic(ts)) return false;
  const m = nyMinutes(ts);
  return m != null && m >= OPEN_PRINT_START_MIN && m < SELL_WINDOW_END_MIN;
}

function nyMinutes(ts) {
  if (ts == null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(Number(ts)));
  let hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (hour === 24) hour = 0;
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/**
 * Premium R:R from a proposed entry. Reward is the game-plan target
 * intrinsic (not the pin). The pin is the buy ceiling; the target is
 * the move. Trim = 1R, exit = 2R, both floored so the first take is
 * meaningful vs a 50% stop.
 *
 * Entry $0.45 / stop $0.225 → trim $0.68 (1R), not $0.53.
 */
export function computePremiumRr({
  entry,
  stopPct = HARD_STOP_PCT,
  strike,
  flavor,
  targetPx,
  pin,
} = {}) {
  const e = num(entry);
  if (!(e > 0)) return null;
  const stopRaw = e * (1 + Number(stopPct) / 100);
  const riskRaw = e - stopRaw;
  if (!(riskRaw > 0)) return null;
  const stop = round2(stopRaw);
  const risk = round2(riskRaw);
  const K = num(strike);
  const tgt = num(targetPx);
  const isPut = String(flavor || "").toLowerCase() === "put";
  let targetPrem = num(pin);
  if (K > 0 && tgt > 0) {
    const intrinsic = Math.max(0, isPut ? K - tgt : tgt - K);
    targetPrem = Math.max(targetPrem || 0, intrinsic);
  }
  const reward = targetPrem != null ? round2(targetPrem - e) : null;
  const rr = reward != null ? round2(reward / riskRaw) : null;
  const trimRaw = Math.max(e + TRIM_R * riskRaw, e + MIN_TRIM_DOLLARS);
  const exitRaw = Math.max(e + EXIT_R * riskRaw, trimRaw + riskRaw);
  const trim = round2(trimRaw);
  const exit = round2(exitRaw);
  return {
    entry: round2(e),
    stop,
    risk,
    target_prem: targetPrem != null ? round2(targetPrem) : null,
    reward,
    rr,
    positive: rr != null && rr >= MIN_RR,
    trim,
    exit,
    trim_r: riskRaw > 0 ? round2((trim - e) / riskRaw) : null,
    exit_r: riskRaw > 0 ? round2((exit - e) / riskRaw) : null,
  };
}

/**
 * Overnight hold is only for 1 DTE when the thesis is still intact and
 * leftover R:R to the target is still ≥ 1. Otherwise flatten before the
 * 16:00 ET cash close — 16:15 is not the planned exit.
 */
export function shouldHoldOvernight({
  dte,
  stWith,
  invalidated,
  premium,
  entry,
  targetPrem,
  minutes,
} = {}) {
  if (num(dte) === 0) return false;
  if (invalidated || !stWith) return false;
  const min = num(minutes);
  // Missing minutes = morning plan. Overnight is only granted after 15:30 ET.
  if (min == null || min < OVERNIGHT_DECIDE_MIN) return false;
  const mid = num(premium);
  const fill = num(entry) ?? mid;
  if (mid != null && fill != null && mid + 1e-9 < fill) return false;
  const tgt = num(targetPrem);
  if (mid != null && tgt != null) {
    const risk = (fill != null) ? fill * Math.abs(HARD_STOP_PCT) / 100 : mid * 0.5;
    if (risk > 0 && (tgt - mid) / risk < MIN_RR) return false;
  }
  return true;
}

export function nyDateIso(ts = Date.now()) {
  return new Date(Number(ts) || Date.now()).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

export function isOpenPrintMinutes(minutes) {
  const m = num(minutes);
  return m != null && m >= OPEN_PRINT_START_MIN && m < OPEN_PRINT_END_MIN;
}

/**
 * An overnight carry is an open/trimmed book from a prior NY session,
 * or a book the clock already stamped held_overnight. Trim and exit
 * stay live at the next open — the 09:30-09:45 wait is for new buys.
 */
export function isOvernightCarry(book, now = Date.now()) {
  const status = String(book?.status || "");
  if (status !== "open" && status !== "trimmed") return false;
  if (book?.held_overnight) return true;
  const entryTs = num(book?.entry_ts);
  if (entryTs == null) return false;
  return nyDateIso(entryTs) !== nyDateIso(now);
}

/**
 * Model size for the index day-trade sleeve.
 * Heavy = high-conviction lean, SuperTrend with the play, premium not rich.
 * Light = veto, low conviction, rich premium, or SuperTrend against.
 */
export function sizeDayTradePlay({
  leanConviction,
  premiumBand,
  stWith,
  honestyVeto,
  premium,
} = {}) {
  const conv = String(leanConviction || "").toLowerCase();
  const band = String(premiumBand || "").toLowerCase();
  let label = "medium";
  if (honestyVeto || conv === "low" || band === "over") label = "light";
  else if (conv === "high" && stWith && (band === "under" || band === "fair")) label = "heavy";
  else if (conv === "medium" && stWith && band !== "over") label = "medium";
  else if (!stWith) label = "light";

  const contracts = SIZE_CONTRACTS[label] || 1;
  const mid = num(premium);
  const debit = mid != null ? Math.round(mid * 100 * contracts) : null;
  return {
    label,
    contracts,
    debit_usd: debit,
    sleeve_usd: SLEEVE_USD,
    scale_note: `Model sleeve $${(SLEEVE_USD / 1000).toFixed(0)}k → ${contracts} contract${contracts === 1 ? "" : "s"} (${label}). Scale 1 / 2 / 3 for light / medium / heavy.`,
  };
}

/**
 * The five-box plan Saty walks in the morning SPY process:
 * setup/thesis, trigger, entry (confirmation, not chase), exits
 * (scale out + trail), stop (technical first, then premium hard stop).
 */
export function buildSatyDayTradePlan({
  ticker,
  flavor,
  strike,
  expiration,
  spot,
  premium,
  execution,
  gamePlan,
  management,
  size,
  now,
} = {}) {
  const sym = String(ticker || "").toUpperCase();
  const flav = String(flavor || "").toLowerCase() === "put" ? "put" : "call";
  const isPut = flav === "put";
  const K = num(strike);
  const px = num(spot);
  const mid = num(premium) ?? num(execution?.premium_band?.premium);
  const gp = gamePlan || {};
  const mgmt = management || execution?.management || {};
  const band = execution?.premium_band || {};
  const ind = execution?.indicators || {};
  const lean = String(gp.lean || (isPut ? "SHORT" : "LONG")).toUpperCase();
  const target = isPut ? num(gp.bear_target) : num(gp.bull_target);
  const trigger = isPut ? num(gp.bear_trigger) : num(gp.bull_trigger);
  const flip = isPut ? num(gp.bull_trigger) : num(gp.bear_trigger);
  const inv = isPut
    ? num(mgmt.invalidation?.underlying_above) ?? num(gp.bull_trigger)
    : num(mgmt.invalidation?.underlying_below) ?? num(gp.bear_trigger);
  const ema21 = num(ind.ema21);
  const tf = ind.tf || "5";
  const dteBit = num(expiration?.dte) === 0 ? "0 DTE" : "1 DTE";
  const expBit = formatExpirationShort(expiration);
  const occ = K != null ? `${sym} ${Number.isInteger(K) ? K : K.toFixed(0)}${isPut ? "P" : "C"}` : `${sym} ${isPut ? "P" : "C"}`;
  const contractBit = `${occ}${expBit ? ` ${expBit}` : ""}${dteBit ? ` (${dteBit})` : ""}`;
  const buyCeil = num(band.buy_ceil);
  const pin = num(band.pin);
  const fmv = num(band.fmv);
  const expected = num(band.expected_close);
  const entryMax = (mid != null && mid > 0)
    ? (fmv != null ? Math.min(fmv, mid * 1.15) : mid * 1.08)
    : (buyCeil ?? fmv ?? mid);
  const fill = mid ?? entryMax;
  const rr = computePremiumRr({
    entry: fill,
    strike: K,
    flavor: flav,
    targetPx: target,
    pin,
  });
  const tp1 = rr?.trim ?? null;
  const tp2 = rr?.exit ?? null;
  const stopPrem = rr?.stop ?? (fill != null ? round2(fill * (1 + HARD_STOP_PCT / 100)) : null);
  const holdOvernight = typeof execution?.hold_overnight === "boolean"
    ? execution.hold_overnight
    : shouldHoldOvernight({
      dte: num(expiration?.dte),
      stWith: isPut ? num(ind.st_dir) > 0 : num(ind.st_dir) < 0,
      invalidated: false,
      premium: mid,
      entry: fill,
      targetPrem: rr?.target_prem,
      minutes: now != null ? nyMinutes(now) : null,
    });
  const timeStop = num(expiration?.dte) === 0
    ? "12:00"
    : (holdOvernight ? "overnight" : SESSION_FLAT_ET);
  const sz = size || sizeDayTradePlay({
    leanConviction: gp.lean_conviction,
    premiumBand: band.band,
    stWith: isPut ? num(ind.st_dir) > 0 : num(ind.st_dir) < 0,
    premium: mid,
  });

  const setup = `${contractBit} — ${lean} thesis. ${sym} at ${money(px)}` +
    (target != null ? `, first target ${money(target)}` : "") +
    (expected != null ? `. Pin / FMV uses expected close ${money(expected)}` : "") +
    `. Strike is ATM / one level — not a lottery print.`;

  const triggerLine = (() => {
    const stBit = `${tf}-minute SuperTrend ${isPut ? "short" : "long"}`;
    const emaSane = ema21 != null && px != null && px > 0 && Math.abs(ema21 - px) / px <= 0.04;
    const emaBit = emaSane
      ? ` and ${sym} holds the ${tf}-minute 21 EMA (${money(ema21)})`
      : ` and ${sym} pulls back into the ${tf}-minute 21 EMA band (do not chase an extended print)`;
  const levelBit = trigger != null
      ? `. ${isPut ? "Lose" : "Hold / break"} ${money(trigger)} to start the ${flav}.`
      : ". First pullback into the 21 EMA after 09:45 ET — not the open print.";
    return `Confirmation: ${stBit}${emaBit}${levelBit}`;
  })();

  const entry = `Enter the ${occ} on that confirmation. Pay at or under ${money(entryMax)}` +
    (pin != null && expected != null && target != null
      ? ` (FMV pin ${money(pin)} at ${money(expected)}; full target ${money(target)})`
      : (pin != null && expected != null ? ` (pin ${money(pin)} if ${sym} closes ${money(expected)})` : "")) +
    `. If the print is already rich or extended, wait for the next pullback — do not chase.`;

  const rrBit = rr
    ? ` R:R to target is ${rr.rr != null ? `${rr.rr}:1` : "n/a"}${rr.positive ? "" : " — below 1:1, do not pay this print"}.`
    : "";
  const exits = (sz.contracts >= MIN_CONTRACTS_FOR_TRIM)
    ? `Trim half at ${TRIM_R}R` +
      (tp1 != null ? ` (${money(tp1)})` : "") +
      `. Close the rest at ${EXIT_R}R` +
      (tp2 != null ? ` (${money(tp2)})` : "") +
      (target != null ? ` or if ${sym} reaches ${money(target)}` : "") +
      `. After the trim, trail the runner: stop to breakeven, then give back no more than ${Math.round(TRAIL_GIVEBACK_PCT * 100)}% from the peak premium.`
    : `Single contract — no partial trim. At ${TRIM_R}R` +
      (tp1 != null ? ` (${money(tp1)})` : "") +
      ` raise stop to breakeven and trail (${Math.round(TRAIL_GIVEBACK_PCT * 100)}% giveback from peak). Full exit at ${EXIT_R}R` +
      (tp2 != null ? ` (${money(tp2)})` : "") +
      (target != null ? ` or if ${sym} reaches ${money(target)}` : "") +
      ".";
  const exitsTail = (holdOvernight
    ? " Hold overnight — leftover R:R is still ≥ 1 and the thesis is intact. Trim and exit stay live at the next open — do not wait for 09:45; the opening print is often the profit-taking run."
    : ` Flatten by ${SESSION_FLAT_ET} ET, before the cash close. Overnight risk can erase the gain.`) +
    rrBit;

  const stop = `Technical stop: cut the ${flav} if ${sym} ${isPut ? "reclaims" : "loses"} ${money(inv)}` +
    `. Premium hard stop ${HARD_STOP_PCT}%` +
    (stopPrem != null ? ` (${money(stopPrem)})` : "") +
    `. Time stop ${timeStop === "overnight" ? "next session (overnight hold)" : `${timeStop} ET`}` +
    (num(expiration?.dte) === 0 ? " — 0 DTE force-liq from 15:15 ET." : ".");

  const flipLine = flip != null
    ? `Opposite side: if ${sym} ${isPut ? "reclaims" : "loses"} ${money(flip)}, the ${flav} is done. Do not hold and hope — that is the flip level.`
    : null;

  const bracket = {
    buy_limit: entryMax,
    trim: tp1,
    trim_r: rr?.trim_r ?? TRIM_R,
    trim_pct: sz.contracts >= MIN_CONTRACTS_FOR_TRIM ? 50 : null,
    protect_at_1r: sz.contracts < MIN_CONTRACTS_FOR_TRIM ? tp1 : null,
    exit: tp2,
    exit_r: rr?.exit_r ?? EXIT_R,
    stop_premium: stopPrem,
    stop_underlying: inv,
    trail_giveback_pct: TRAIL_GIVEBACK_PCT,
    time_stop_et: timeStop === "overnight" ? "15:45" : timeStop,
    hold_overnight: holdOvernight,
    rr: rr?.rr ?? null,
    rr_positive: !!rr?.positive,
    single_contract: sz.contracts < MIN_CONTRACTS_FOR_TRIM,
  };

  return {
    setup,
    trigger: triggerLine,
    entry,
    exits: exits + exitsTail,
    stop,
    flip: flipLine,
    bracket,
    rr,
    hold_overnight: holdOvernight,
    size: sz,
    occ,
    dte_bit: dteBit,
    exp_bit: expBit,
    flavor: flav,
    lean,
  };
}

function bookContracts(book, sz) {
  const c = num(book?.contracts) ?? num(sz?.contracts);
  return c != null && c > 0 ? Math.round(c) : 1;
}

function hardStopPremium(entry) {
  const e = num(entry);
  return e != null ? round2(e * (1 + HARD_STOP_PCT / 100)) : null;
}

function updatePeak(book, mid) {
  const peak = num(book?.peak_premium);
  if (mid == null) return peak;
  return peak == null ? mid : Math.max(peak, mid);
}

function trailFloorFromPeak(peak) {
  const p = num(peak);
  if (!(p > 0)) return null;
  return round2(p * (1 - TRAIL_GIVEBACK_PCT));
}

function isProfitArmed(book) {
  return !!book?.profit_armed || String(book?.status || "") === "trimmed";
}

function canTrimContracts(contracts) {
  return Number(contracts) >= MIN_CONTRACTS_FOR_TRIM;
}

function inferSellKind(clock) {
  const kind = String(clock?.sell_kind || "").toLowerCase();
  if (kind) return kind;
  const why = String(clock?.why || "").toLowerCase();
  if (why.includes("invalidation") || why.includes("reclaimed") || why.includes("lost the")) return "invalidation";
  if (why.includes("force-liq")) return "force_liq";
  if (why.includes("open_trim") || why.includes("trim at the open")) return "open_trim";
  if (why.includes("open_exit") || why.includes("open exit")) return "open_exit";
  if (why.includes("close-auction") || why.includes("16:15") || why.includes("cash close") || why.includes("15:45")) return "session_close";
  if (why.includes("time stop")) return "time_stop";
  return "exit";
}

/**
 * Paper-execution event from clock + open book.
 * BUY / TRIM / EXIT / STOP only — WAIT never fires a Discord.
 */
export function classifyPaperEvent({
  clock,
  book = null,
  premium,
  now = Date.now(),
  size = null,
} = {}) {
  const action = String(clock?.action || "WAIT").toUpperCase();
  const status = String(book?.status || "flat");
  const mid = num(premium) ?? num(clock?.premium_band?.premium);
  const entry = num(book?.entry_premium);
  const sellKind = inferSellKind(clock);
  const sz = size || book?.size || null;

  const closed = {
    status: "closed",
    needs_wait: true,
    entry_premium: entry,
    contracts: book?.contracts ?? sz?.contracts ?? null,
    contracts_remaining: book?.contracts_remaining ?? book?.contracts ?? sz?.contracts ?? null,
    size_label: book?.size_label ?? sz?.label ?? null,
    exit_premium: mid,
    exit_ts: now,
  };

  if (status === "closed") {
    if (action === "WAIT" || action === "SELL") {
      return { event: null, nextBook: { ...book, status: "flat", needs_wait: false } };
    }
    if (action === "BUY" && book?.needs_wait) {
      return { event: null, nextBook: book };
    }
  }

  const canEnter = status === "flat" || (status === "closed" && !book?.needs_wait);
  if (canEnter && action === "BUY" && !isOptionsBuyWindowEt(now)) {
    return { event: null, nextBook: null };
  }
  if (canEnter && action === "BUY") {
    const rr = clock?.rr?.trim != null
      ? clock.rr
      : computePremiumRr({
        entry: mid,
        strike: clock?.contract?.strike,
        flavor: clock?.contract?.flavor,
        pin: clock?.premium_band?.pin,
      });
    return {
      event: "BUY",
      nextBook: {
        status: "open",
        needs_wait: false,
        event: "BUY",
        entry_premium: mid,
        entry_ts: now,
        last_premium: mid,
        peak_premium: mid,
        trim_premium: rr?.trim ?? null,
        exit_premium: rr?.exit ?? null,
        contracts: sz?.contracts ?? 1,
        contracts_remaining: sz?.contracts ?? 1,
        size_label: sz?.label || "medium",
        ticker: clock?.contract?.ticker || null,
        flavor: clock?.contract?.flavor || null,
        strike: clock?.contract?.strike ?? null,
        expiration: clock?.contract?.expiration || null,
        held_overnight: false,
      },
    };
  }

  if (status !== "open" && status !== "trimmed") {
    return { event: null, nextBook: null };
  }

  const contracts = bookContracts(book, sz);
  const canTrim = canTrimContracts(contracts);
  const peak = updatePeak(book, mid);
  const stamped = {
    ...book,
    peak_premium: peak,
    last_premium: mid ?? book?.last_premium ?? null,
    held_overnight: !!clock?.hold_overnight || !!book?.held_overnight,
  };

  if (!isOptionsSellWindowEt(now)) {
    return { event: null, nextBook: stamped };
  }

  const trimPx = num(book?.trim_premium) ?? (entry != null
    ? round2(Math.max(entry + (entry * Math.abs(HARD_STOP_PCT) / 100), entry + MIN_TRIM_DOLLARS))
    : null);
  const exitPx = num(book?.exit_premium) ?? (entry != null
    ? round2(entry + 2 * (entry * Math.abs(HARD_STOP_PCT) / 100))
    : null);
  const hardStop = hardStopPremium(entry);

  if (sellKind === "invalidation") {
    return {
      event: "STOP",
      reason: "invalidation",
      nextBook: { ...closed, event: "STOP", held_overnight: false, peak_premium: peak },
    };
  }

  if (!isProfitArmed(stamped) && hardStop != null && mid != null && mid + 1e-9 <= hardStop) {
    return {
      event: "STOP",
      reason: "premium_stop",
      nextBook: { ...closed, event: "STOP", held_overnight: false, peak_premium: peak },
    };
  }

  if (isProfitArmed(stamped) && entry != null && mid != null && mid + 1e-9 <= entry) {
    return {
      event: "STOP",
      reason: "breakeven_stop",
      nextBook: { ...closed, event: "STOP", held_overnight: false, peak_premium: peak },
    };
  }

  const trailFloor = isProfitArmed(stamped) ? trailFloorFromPeak(peak ?? mid) : null;
  if (trailFloor != null && mid != null && peak != null && peak > (entry ?? 0) && mid + 1e-9 <= trailFloor) {
    return {
      event: "EXIT",
      reason: "trail_stop",
      nextBook: { ...closed, event: "EXIT", held_overnight: false, peak_premium: peak },
    };
  }

  if (action === "SELL" || sellKind === "force_liq" || sellKind === "time_stop"
    || sellKind === "close_auction" || sellKind === "session_close" || sellKind === "open_exit") {
    return {
      event: "EXIT",
      reason: sellKind || "exit",
      nextBook: { ...closed, event: "EXIT", held_overnight: false, peak_premium: peak },
    };
  }

  if (exitPx != null && mid != null && mid + 1e-9 >= exitPx) {
    if (status === "trimmed" || (status === "open" && !canTrim)) {
      return {
        event: "EXIT",
        reason: "tp2",
        nextBook: { ...closed, event: "EXIT", held_overnight: false, peak_premium: peak },
      };
    }
  }

  if ((sellKind === "open_trim" || action === "TRIM") && status === "open" && canTrim) {
    const sellQty = trimSellQty(contracts);
    return {
      event: "TRIM",
      reason: "open_trim",
      nextBook: {
        ...stamped,
        status: "trimmed",
        event: "TRIM",
        trim_premium: mid,
        trim_ts: now,
        trim_sell_qty: sellQty,
        contracts_remaining: Math.max(0, contracts - sellQty),
        profit_armed: true,
        trail_stop_premium: entry,
      },
    };
  }

  if (status === "open" && trimPx != null && mid != null && mid + 1e-9 >= trimPx) {
    if (canTrim) {
      const sellQty = trimSellQty(contracts);
      return {
        event: "TRIM",
        nextBook: {
          ...stamped,
          status: "trimmed",
          event: "TRIM",
          trim_premium: mid,
          trim_ts: now,
          trim_sell_qty: sellQty,
          contracts_remaining: Math.max(0, contracts - sellQty),
          profit_armed: true,
          trail_stop_premium: entry,
        },
      };
    }
    if (!stamped.profit_armed) {
      return {
        event: "PROTECT",
        reason: "profit_armed_single",
        nextBook: {
          ...stamped,
          profit_armed: true,
          trail_stop_premium: entry,
          profit_armed_ts: now,
          trim_premium: mid,
        },
      };
    }
  }

  const stampHold = !!clock?.hold_overnight || !!stamped.held_overnight;
  if (stampHold || mid != null) {
    return { event: null, nextBook: stamped };
  }

  return { event: null, nextBook: null };
}

export function buildDayTradeSignalEmbed({
  event,
  ticker,
  plan,
  size,
  execution,
  premium,
  spot,
  reason,
  now = Date.now(),
} = {}) {
  const ev = String(event || "BUY").toUpperCase();
  const sym = String(ticker || plan?.occ || "").toUpperCase();
  const occ = plan?.occ || sym;
  const sz = size || plan?.size || {};
  const mid = num(premium) ?? num(execution?.premium_band?.premium);
  const px = num(spot);
  const color = ev === "BUY" ? 0x22c55e
    : ev === "TRIM" ? 0xf59e0b
      : ev === "PROTECT" ? 0xfbbf24
        : ev === "STOP" ? 0xef4444
          : 0x3b82f6;
  const verb = ev === "BUY" ? "BUY"
    : ev === "TRIM" ? "TRIM 50%"
      : ev === "PROTECT" ? "PROTECT"
        : ev === "STOP" ? "STOP OUT"
          : "EXIT";
  const sizeBit = sz.label ? ` · ${String(sz.label).toUpperCase()}` : "";
  const expBit = plan?.exp_bit ? ` · ${plan.exp_bit}` : "";
  const dteBit = plan?.dte_bit ? ` · ${plan.dte_bit}` : "";
  const title = `${verb} ${occ}${expBit}${dteBit}${sizeBit}`.slice(0, 250);

  const descParts = [];
  if (ev === "BUY") {
    descParts.push(`Paper buy ${occ}${plan?.exp_bit ? ` ${plan.exp_bit}` : ""} at ${money(mid)}.` + (px != null ? ` ${sym} ${money(px)}.` : ""));
    if (sz.contracts) {
      descParts.push(`Size **${sz.contracts} contract${sz.contracts === 1 ? "" : "s"}** (${sz.label || "medium"})${sz.debit_usd != null ? ` · debit **$${sz.debit_usd}**` : ""}.`);
    }
  } else if (ev === "TRIM") {
    descParts.push(`Paper trim half of ${occ} at ${money(mid)} (${TRIM_R}R). Runner stays on — stop to breakeven, trail ${Math.round(TRAIL_GIVEBACK_PCT * 100)}% from peak.`);
  } else if (ev === "PROTECT") {
    const be = num(execution?.rr?.entry) ?? num(plan?.bracket?.protect_at_1r);
    descParts.push(`Single contract at ${money(mid)} (${TRIM_R}R) — stop raised to breakeven ${money(be)}. Trail ${Math.round(TRAIL_GIVEBACK_PCT * 100)}% giveback from peak; no partial trim.`);
  } else if (ev === "STOP") {
    descParts.push(`Paper stop on ${occ} at ${money(mid)}${reason === "invalidation" ? " — underlying invalidation." : reason === "breakeven_stop" ? " — breakeven / trail stop." : " — premium hard stop."}`);
  } else {
    descParts.push(`Paper exit ${occ} at ${money(mid)}${reason ? ` (${reason.replace(/_/g, " ")})` : ""}.`);
  }
  descParts.push("_Not investment advice. Matches the model's paper fill, not a live broker order._");

  const fields = [];
  if (plan?.setup) fields.push({ name: "Setup / Thesis", value: String(plan.setup).slice(0, 1024), inline: false });
  if (plan?.trigger) fields.push({ name: "Trigger", value: String(plan.trigger).slice(0, 1024), inline: false });
  if (plan?.entry) fields.push({ name: "Entry", value: String(plan.entry).slice(0, 1024), inline: false });
  if (plan?.exits) fields.push({ name: "Exits", value: String(plan.exits).slice(0, 1024), inline: false });
  if (plan?.stop) fields.push({ name: "Stop", value: String(plan.stop).slice(0, 1024), inline: false });
  if (plan?.flip) fields.push({ name: "Flip", value: String(plan.flip).slice(0, 1024), inline: false });

  const br = plan?.bracket || {};
  const bracketLines = [
    br.buy_limit != null ? `BUY limit ≤ ${money(br.buy_limit)}` : null,
    br.single_contract && br.protect_at_1r != null
      ? `PROTECT at 1R @ ${money(br.protect_at_1r)} (breakeven + ${Math.round((br.trail_giveback_pct ?? TRAIL_GIVEBACK_PCT) * 100)}% trail)`
      : null,
    !br.single_contract && br.trim != null
      ? `TRIM 50% @ ${money(br.trim)} (${br.trim_r ?? TRIM_R}R)` : null,
    br.exit != null ? `EXIT @ ${money(br.exit)} (${br.exit_r ?? EXIT_R}R)` : null,
    br.rr != null ? `R:R to target ${br.rr}:1${br.rr_positive ? "" : " — below 1:1"}` : null,
    br.hold_overnight
      ? "HOLD overnight — leftover R:R still ≥ 1. Trim/exit live at the next open (do not wait for 09:45)"
      : (br.time_stop_et ? `FLAT by ${br.time_stop_et} ET (before the cash close)` : null),
    br.stop_premium != null ? `STOP premium @ ${money(br.stop_premium)} (${HARD_STOP_PCT}%)` : null,
    br.stop_underlying != null ? `STOP underlying @ ${money(br.stop_underlying)}` : null,
    sz.scale_note || null,
  ].filter(Boolean);
  if (bracketLines.length) {
    fields.push({ name: "Bracket", value: bracketLines.join("\n").slice(0, 1024), inline: false });
  }

  return {
    title,
    description: descParts.join("\n").slice(0, 2048),
    color,
    fields,
    timestamp: new Date(Number(now) || Date.now()).toISOString(),
    footer: { text: "Timed Trading • Index day-trade • #trade-signals" },
  };
}
