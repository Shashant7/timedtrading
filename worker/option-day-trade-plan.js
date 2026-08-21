// option-day-trade-plan.js
//
// Saty-style day-trade plan + paper-execution events for index 0/1 DTE.
// Five boxes: Setup/Thesis, Trigger, Entry, Exits, Stop. Size is
// light / medium / heavy so a Discord #trade-signals embed can carry
// the same plan a bracket order would use.
//
// Pure. No I/O.

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
export const TP1_PCT = 40;
export const TP2_PCT = 100;
export const HARD_STOP_PCT = -50;
const SLEEVE_USD = 25000;

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
  const occ = K != null ? `${sym} ${Number.isInteger(K) ? K : K.toFixed(0)}${isPut ? "P" : "C"}` : `${sym} ${isPut ? "P" : "C"}`;
  const buyCeil = num(band.buy_ceil);
  const pin = num(band.pin);
  const expected = num(band.expected_close);
  const tp1 = mid != null ? round2(mid * (1 + TP1_PCT / 100)) : null;
  const tp2 = mid != null ? round2(mid * (1 + TP2_PCT / 100)) : null;
  const stopPrem = mid != null ? round2(mid * (1 + HARD_STOP_PCT / 100)) : null;
  const timeStop = num(expiration?.dte) === 0 ? "12:00" : "16:15";
  const sz = size || sizeDayTradePlay({
    leanConviction: gp.lean_conviction,
    premiumBand: band.band,
    stWith: isPut ? num(ind.st_dir) > 0 : num(ind.st_dir) < 0,
    premium: mid,
  });

  const setup = `${occ} ${dteBit} — ${lean} thesis. ${sym} at ${money(px)}` +
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

  const exits = `Trim half at +${TP1_PCT}% premium` +
    (tp1 != null ? ` (${money(tp1)})` : "") +
    `. Close the rest at +${TP2_PCT}%` +
    (tp2 != null ? ` (${money(tp2)})` : "") +
    (target != null ? ` or if ${sym} reaches ${money(target)}` : "") +
    `. After the trim, trail the runner: stop to breakeven, then to the last 5-minute 21 EMA hold. Flatten after ${timeStop} ET.`;

  const stop = `Technical stop: cut the ${flav} if ${sym} ${isPut ? "reclaims" : "loses"} ${money(inv)}` +
    `. Premium hard stop ${HARD_STOP_PCT}%` +
    (stopPrem != null ? ` (${money(stopPrem)})` : "") +
    `. Time stop ${timeStop} ET` +
    (num(expiration?.dte) === 0 ? " — 0 DTE force-liq from 15:15 ET." : " — 1 DTE holds 15:45–16:15, then done.");

  const flipLine = flip != null
    ? `Opposite side: if ${sym} ${isPut ? "reclaims" : "loses"} ${money(flip)}, the ${flav} is done. Do not hold and hope — that is the flip level.`
    : null;

  const bracket = {
    buy_limit: buyCeil ?? mid,
    trim: tp1,
    trim_pct: 50,
    exit: tp2,
    stop_premium: stopPrem,
    stop_underlying: inv,
    time_stop_et: timeStop,
  };

  return {
    setup,
    trigger: triggerLine,
    entry,
    exits,
    stop,
    flip: flipLine,
    bracket,
    size: sz,
    occ,
    dte_bit: dteBit,
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
  if (why.includes("close-auction") || why.includes("16:15")) return "close_auction";
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
  if (canEnter && action === "BUY") {
    return {
      event: "BUY",
      nextBook: {
        status: "open",
        needs_wait: false,
        event: "BUY",
        entry_premium: mid,
        entry_ts: now,
        contracts: sz?.contracts ?? 1,
        size_label: sz?.label || "medium",
      },
    };
  }

  if (status !== "open" && status !== "trimmed") {
    return { event: null, nextBook: null };
  }

  const stopHit = (entry != null && mid != null && mid <= entry * (1 + HARD_STOP_PCT / 100))
    || sellKind === "invalidation";
  if (stopHit) {
    return {
      event: "STOP",
      reason: sellKind === "invalidation" ? "invalidation" : "premium_stop",
      nextBook: { ...closed, event: "STOP" },
    };
  }

  if (action === "SELL" || sellKind === "force_liq" || sellKind === "time_stop" || sellKind === "close_auction") {
    return {
      event: "EXIT",
      reason: sellKind || "exit",
      nextBook: { ...closed, event: "EXIT" },
    };
  }

  if (status === "open" && entry != null && mid != null && mid >= entry * (1 + TP1_PCT / 100)) {
    return {
      event: "TRIM",
      nextBook: {
        ...book,
        status: "trimmed",
        event: "TRIM",
        trim_premium: mid,
        trim_ts: now,
      },
    };
  }

  if (status === "trimmed" && entry != null && mid != null && mid >= entry * (1 + TP2_PCT / 100)) {
    return {
      event: "EXIT",
      reason: "tp2",
      nextBook: { ...closed, event: "EXIT" },
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
  const dteBit = plan?.dte_bit ? ` · ${plan.dte_bit}` : "";
  const title = `${verb} ${occ}${dteBit}${sizeBit}`.slice(0, 250);

  const descParts = [];
  if (ev === "BUY") {
    descParts.push(`Paper buy ${occ} at ${money(mid)}.` + (px != null ? ` ${sym} ${money(px)}.` : ""));
    if (sz.contracts) {
      descParts.push(`Size **${sz.contracts} contract${sz.contracts === 1 ? "" : "s"}** (${sz.label || "medium"})${sz.debit_usd != null ? ` · debit **$${sz.debit_usd}**` : ""}.`);
    }
  } else if (ev === "TRIM") {
    descParts.push(`Paper trim half of ${occ} at ${money(mid)} (+${TP1_PCT}%). Runner stays on, stop to breakeven.`);
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
    br.trim != null ? `TRIM 50% @ ${money(br.trim)} (+${TP1_PCT}%)` : null,
    br.exit != null ? `EXIT rest @ ${money(br.exit)} (+${TP2_PCT}%)` : null,
    br.stop_premium != null ? `STOP premium @ ${money(br.stop_premium)} (${HARD_STOP_PCT}%)` : null,
    br.stop_underlying != null ? `STOP underlying @ ${money(br.stop_underlying)}` : null,
    br.time_stop_et ? `TIME stop ${br.time_stop_et} ET` : null,
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
