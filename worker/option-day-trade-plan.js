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
  const expected = num(band.expected_close);
  const fill = mid ?? buyCeil;
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

  const triggerLine = `Confirmation: ${tf}-minute SuperTrend ${isPut ? "short" : "long"} and ${sym} holds the ${tf}-minute 21 EMA` +
    (ema21 != null ? ` (${money(ema21)})` : "") +
    (trigger != null
      ? `. ${isPut ? "Lose" : "Hold / break"} ${money(trigger)} to start the ${flav}.`
      : ". First pullback into the 21 EMA after 09:45 ET — not the open print.");

  const entry = `Enter the ${occ} on that confirmation. Pay at or under ${money(buyCeil ?? mid)}` +
    (pin != null && expected != null ? ` (pin ${money(pin)} if ${sym} closes ${money(expected)})` : "") +
    `. If the print is already rich or extended, wait for the next pullback — do not chase.`;

  const rrBit = rr
    ? ` R:R to target is ${rr.rr != null ? `${rr.rr}:1` : "n/a"}${rr.positive ? "" : " — below 1:1, do not pay this print"}.`
    : "";
  const exits = `Trim half at ${TRIM_R}R` +
    (tp1 != null ? ` (${money(tp1)})` : "") +
    `. Close the rest at ${EXIT_R}R` +
    (tp2 != null ? ` (${money(tp2)})` : "") +
    (target != null ? ` or if ${sym} reaches ${money(target)}` : "") +
    `. After the trim, trail the runner: stop to breakeven, then to the last 5-minute 21 EMA hold.` +
    (holdOvernight
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
    buy_limit: buyCeil ?? mid,
    trim: tp1,
    trim_r: rr?.trim_r ?? TRIM_R,
    trim_pct: 50,
    exit: tp2,
    exit_r: rr?.exit_r ?? EXIT_R,
    stop_premium: stopPrem,
    stop_underlying: inv,
    time_stop_et: timeStop === "overnight" ? "15:45" : timeStop,
    hold_overnight: holdOvernight,
    rr: rr?.rr ?? null,
    rr_positive: !!rr?.positive,
  };

  return {
    setup,
    trigger: triggerLine,
    entry,
    exits,
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
        trim_premium: rr?.trim ?? null,
        exit_premium: rr?.exit ?? null,
        contracts: sz?.contracts ?? 1,
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

  if (!isOptionsSellWindowEt(now)) {
    return {
      event: null,
      nextBook: {
        ...book,
        last_premium: mid ?? book?.last_premium ?? null,
        held_overnight: !!clock?.hold_overnight || !!book?.held_overnight,
      },
    };
  }

  const stopHit = (entry != null && mid != null && mid <= entry * (1 + HARD_STOP_PCT / 100))
    || sellKind === "invalidation";
  if (stopHit) {
    return {
      event: "STOP",
      reason: sellKind === "invalidation" ? "invalidation" : "premium_stop",
      nextBook: { ...closed, event: "STOP", held_overnight: false },
    };
  }

  if ((sellKind === "open_trim" || action === "TRIM") && status === "open") {
    return {
      event: "TRIM",
      reason: "open_trim",
      nextBook: {
        ...book,
        status: "trimmed",
        event: "TRIM",
        last_premium: mid,
        trim_premium: mid,
        trim_ts: now,
      },
    };
  }

  if (action === "SELL" || sellKind === "force_liq" || sellKind === "time_stop" || sellKind === "close_auction" || sellKind === "session_close" || sellKind === "open_exit") {
    return {
      event: "EXIT",
      reason: sellKind || "exit",
      nextBook: { ...closed, event: "EXIT", held_overnight: false },
    };
  }

  const trimPx = num(book?.trim_premium) ?? (entry != null ? round2(Math.max(entry * 1.5, entry + MIN_TRIM_DOLLARS)) : null);
  const exitPx = num(book?.exit_premium) ?? (entry != null ? round2(entry + 2 * (entry * Math.abs(HARD_STOP_PCT) / 100)) : null);
  if (status === "open" && trimPx != null && mid != null && mid + 1e-9 >= trimPx) {
    return {
      event: "TRIM",
      nextBook: {
        ...book,
        status: "trimmed",
        event: "TRIM",
        last_premium: mid,
        trim_premium: mid,
        trim_ts: now,
      },
    };
  }

  if (status === "trimmed" && exitPx != null && mid != null && mid + 1e-9 >= exitPx) {
    return {
      event: "EXIT",
      reason: "tp2",
      nextBook: { ...closed, event: "EXIT", held_overnight: false },
    };
  }

  const stampHold = !!clock?.hold_overnight || !!book?.held_overnight;
  if (stampHold || mid != null) {
    return {
      event: null,
      nextBook: {
        ...book,
        last_premium: mid ?? book?.last_premium ?? null,
        held_overnight: stampHold,
      },
    };
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
      : ev === "STOP" ? 0xef4444
        : 0x3b82f6;
  const verb = ev === "BUY" ? "BUY"
    : ev === "TRIM" ? "TRIM 50%"
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
    descParts.push(`Paper trim half of ${occ} at ${money(mid)} (${TRIM_R}R). Runner stays on, stop to breakeven.`);
  } else if (ev === "STOP") {
    descParts.push(`Paper stop on ${occ} at ${money(mid)}${reason === "invalidation" ? " — underlying invalidation." : " — premium hard stop."}`);
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
    br.trim != null ? `TRIM 50% @ ${money(br.trim)} (${br.trim_r ?? TRIM_R}R)` : null,
    br.exit != null ? `EXIT rest @ ${money(br.exit)} (${br.exit_r ?? EXIT_R}R)` : null,
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
