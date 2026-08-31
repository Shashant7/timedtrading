// index-trend-paper.js
//
// Paper book classification for index trend LETF share plays (SPYU/SPXU).
// Pure — no I/O.

import { isNyRegularMarketOpenStatic } from "./market-calendar.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

/** ISO week label for multi-day signal ids (e.g. 2026-W35). */
export function indexTrendWeekLabel(ts = Date.now()) {
  const d = new Date(Number(ts));
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildIndexTrendSignalId(underlying, letfTicker, direction, now = Date.now()) {
  const u = String(underlying || "").toUpperCase();
  const letf = String(letfTicker || "").toUpperCase();
  const dir = String(direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  return `it:${u}:${letf}:${dir}:${indexTrendWeekLabel(now)}`;
}

export function defaultIndexTrendPaperShares(letfPrice, budgetUsd = 2000) {
  const px = num(letfPrice);
  if (!(px > 0)) return 1;
  const budget = num(budgetUsd) || 2000;
  return Math.max(1, Math.floor(budget / px));
}

export function computeUnderlyingR({
  direction = "LONG",
  entryUnderlying,
  stopUnderlying,
  currentUnderlying,
} = {}) {
  const entry = num(entryUnderlying);
  const stop = num(stopUnderlying);
  const px = num(currentUnderlying);
  if (!(entry > 0) || !(stop > 0) || !(px > 0)) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const dir = String(direction).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const gain = dir === "LONG" ? px - entry : entry - px;
  return round2(gain / risk);
}

function bookIsLive(book) {
  const status = String(book?.status || "");
  return status === "open" || status === "trimmed";
}

function trimSize(shares, fraction = 0.25) {
  const s = Math.max(1, Math.round(Number(shares) || 1));
  return Math.max(1, Math.round(s * fraction));
}

/**
 * Classify paper events for index trend LETF shares.
 * BUY / TRIM / DCA_ADD / EXIT / STOP — WAIT never fires.
 */
export function classifyIndexTrendPaperEvent({
  book = null,
  letfPrice,
  underlyingPrice,
  management = {},
  direction = "LONG",
  activate = true,
  now = Date.now(),
  shares = null,
} = {}) {
  const status = String(book?.status || "flat");
  const dir = String(direction).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const letfPx = num(letfPrice);
  const ulPx = num(underlyingPrice);
  const mgmt = management || {};
  const stopUl = num(mgmt.stop_underlying);
  const targetUl = num(mgmt.target_underlying);
  const deadlineMs = num(mgmt.target_deadline_ms);
  const defaultShares = shares || defaultIndexTrendPaperShares(letfPx);

  const closed = (event, reason, extra = {}) => ({
    event,
    reason,
    nextBook: {
      ...extra,
      status: "closed",
      event,
      reason,
      needs_wait: true,
      exit_ts: now,
      exit_letf_price: letfPx,
      exit_underlying_price: ulPx,
      shares_remaining: 0,
    },
  });

  // After EXIT/STOP, stay flat while the same weekly play is still live.
  // Clearing needs_wait on the next tick used to BUY the same SPYU book
  // immediately (Discord EXIT + Today still HELD, plus a second BUY card).
  if (status === "closed" || status === "flat") {
    if (book?.needs_wait) {
      return {
        event: null,
        nextBook: { ...book, status: "flat", needs_wait: !!activate },
      };
    }
    if (status === "closed" && !activate) return { event: null, nextBook: book };
  }

  const canEnter = (status === "flat" || status === "closed") && !book?.needs_wait;
  if (canEnter && activate && isNyRegularMarketOpenStatic(new Date(now))) {
    if (!(letfPx > 0) || !(ulPx > 0)) return { event: null, nextBook: null };
    // Price action first: do not open a book that is already through the stop
    // (TNA 2026-08-31: IWM $293.23 vs stop $297.27 — FSD still said BUY).
    if (stopUl != null && ulPx != null) {
      const alreadyDead = dir === "LONG" ? ulPx <= stopUl + 1e-9 : ulPx >= stopUl - 1e-9;
      if (alreadyDead) {
        return { event: null, nextBook: book || null, reason: "already_invalidated" };
      }
    }
    return {
      event: "BUY",
      nextBook: {
        status: "open",
        needs_wait: false,
        event: "BUY",
        direction: dir,
        entry_letf_price: letfPx,
        entry_underlying_price: ulPx,
        entry_ts: now,
        last_letf_price: letfPx,
        last_underlying_price: ulPx,
        peak_underlying_r: 0,
        shares: defaultShares,
        shares_remaining: defaultShares,
        trims_fired: [],
        dca_count: 0,
        stop_underlying: stopUl,
        target_underlying: targetUl,
        management: management && typeof management === "object" ? { ...management } : null,
      },
    };
  }

  if (!bookIsLive(book)) return { event: null, nextBook: null };
  if (!(letfPx > 0) || !(ulPx > 0)) return { event: null, nextBook: null };

  const entryUl = num(book.entry_underlying_price);
  const r = computeUnderlyingR({
    direction: dir,
    entryUnderlying: entryUl,
    stopUnderlying: stopUl ?? book.stop_underlying,
    currentUnderlying: ulPx,
  });
  const peakR = Math.max(num(book.peak_underlying_r) || 0, r ?? 0);
  const stamped = {
    ...book,
    last_letf_price: letfPx,
    last_underlying_price: ulPx,
    peak_underlying_r: peakR,
  };

  // Hard stop on underlying invalidation.
  if (stopUl != null && ulPx != null) {
    const stopped = dir === "LONG" ? ulPx <= stopUl + 1e-9 : ulPx >= stopUl - 1e-9;
    if (stopped) {
      return closed("STOP", "underlying_invalidation", { ...stamped, peak_underlying_r: peakR });
    }
  }

  // FSD month-end is guidance, not a flatten. Replay `replay_end_close`
  // runners held past month-end carried most of the PnL. Price action
  // (stop / target / trail) drives EXIT. After the deadline, stop adding.
  const pastDeadline = deadlineMs != null && now >= deadlineMs;

  // Target hit on underlying.
  if (targetUl != null && ulPx != null) {
    const hit = dir === "LONG" ? ulPx >= targetUl - 1e-9 : ulPx <= targetUl + 1e-9;
    if (hit) {
      return closed("EXIT", "target_hit", { ...stamped, peak_underlying_r: peakR });
    }
  }

  const trimsFired = Array.isArray(book.trims_fired) ? [...book.trims_fired] : [];
  const ladder = Array.isArray(mgmt.trim_ladder) ? mgmt.trim_ladder : [];
  const sharesRem = Math.max(0, Math.round(Number(book.shares_remaining) || Number(book.shares) || 1));

  // Trim ladder: +1R and +2R (25% each).
  for (const step of ladder) {
    const atR = num(step?.at_r);
    if (atR == null || trimsFired.includes(atR)) continue;
    if (r != null && r + 1e-9 >= atR && sharesRem >= 2) {
      const sellQty = trimSize(sharesRem, num(step?.size) || 0.25);
      return {
        event: "TRIM",
        reason: `trim_${atR}r`,
        trim_at_r: atR,
        trim_sell_qty: sellQty,
        nextBook: {
          ...stamped,
          status: "trimmed",
          event: "TRIM",
          trim_ts: now,
          trim_sell_qty: sellQty,
          shares_remaining: Math.max(0, sharesRem - sellQty),
          trims_fired: [...trimsFired, atR],
          peak_underlying_r: peakR,
        },
      };
    }
  }

  // Trail remainder after +2R trim: exit if R gives back 40% from peak.
  const trailStep = ladder.find((s) => s?.trail_remainder);
  if (trailStep && trimsFired.includes(2) && peakR >= 2 && r != null && peakR > 0) {
    const floorR = peakR * 0.6;
    if (r + 1e-9 <= floorR) {
      return closed("EXIT", "trail_giveback", { ...stamped, peak_underlying_r: peakR });
    }
  }

  // DCA on compression dip while rally window active (not after FSD month-end).
  if (!pastDeadline && mgmt.dca_on_dip && r != null && r >= -0.25 && r <= 0.5
    && (Number(book.dca_count) || 0) < 1
    && isNyRegularMarketOpenStatic(new Date(now))) {
    const addQty = Math.max(1, Math.round(defaultShares * 0.5));
    return {
      event: "DCA_ADD",
      reason: "compression_dip",
      dca_add_qty: addQty,
      nextBook: {
        ...stamped,
        event: "DCA_ADD",
        dca_count: (Number(book.dca_count) || 0) + 1,
        shares: (Number(book.shares) || sharesRem) + addQty,
        shares_remaining: sharesRem + addQty,
        peak_underlying_r: peakR,
      },
    };
  }

  return { event: null, nextBook: stamped };
}

export function buildIndexTrendSignalEmbed({
  event,
  underlying,
  letfTicker,
  direction,
  management,
  book,
  letfPrice,
  underlyingPrice,
  reason,
  now = Date.now(),
} = {}) {
  const ev = String(event || "").toUpperCase();
  const letf = String(letfTicker || "").toUpperCase();
  const ul = String(underlying || "").toUpperCase();
  const dir = String(direction || "LONG").toUpperCase();
  const mgmt = management || book?.management || {};
  const pxLetf = round2(letfPrice);
  const pxUl = round2(underlyingPrice);
  const entry = round2(book?.entry_letf_price);
  const isExit = ev === "EXIT" || ev === "STOP";
  const isTrim = ev === "TRIM";
  const isEntry = ev === "BUY" || ev === "DCA_ADD";
  const sharesRem = Number(book?.shares_remaining);
  const sharesOrig = Number(book?.shares);
  // EXIT stamps remaining=0 — do not fall back to original size as "still held".
  const shares = isExit
    ? (Number.isFinite(sharesOrig) && sharesOrig > 0 ? sharesOrig : null)
    : ((Number.isFinite(sharesRem) && sharesRem > 0)
      ? sharesRem
      : (Number.isFinite(sharesOrig) && sharesOrig > 0 ? sharesOrig : null));
  const pnlPct = entry > 0 && pxLetf > 0
    ? Math.round(((pxLetf - entry) / entry) * 10000) / 100
    : null;

  // Title mirrors Short Term Discord: horizon · event · vehicle · fill.
  let title;
  if (isExit) {
    const pnlBit = pnlPct != null ? ` ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "";
    title = `SHORT TERM · Exit: ${letf} ${dir} — ${ev === "STOP" ? "Stopped out" : "Closed"}${pnlBit}${pxLetf != null ? ` @ $${pxLetf.toFixed(2)}` : ""}`;
  } else if (isTrim) {
    title = `SHORT TERM · Trim: ${letf} ${dir}${pnlPct != null ? ` ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : ""}${pxLetf != null ? ` @ $${pxLetf.toFixed(2)}` : ""}`;
  } else {
    title = `SHORT TERM · Entry: ${letf} ${dir}${pxLetf != null ? ` @ $${pxLetf.toFixed(2)}` : ""} · Index Swings (${ul})`;
  }

  const lines = [
    `**${ev}** ${dir} trend on **${ul}** via **${letf}** (share order, not day-trade options).`,
    reason ? `Reason: ${String(reason).replace(/_/g, " ")}` : null,
  ].filter(Boolean);

  const fields = [];
  // Trade Summary — same skeleton as equity Short Term / day-trade exits.
  if (isExit || isTrim) {
    const bits = [
      entry != null ? `Entry $${entry.toFixed(2)}` : null,
      pxLetf != null ? `${isTrim ? "Fill" : "Exit"} $${pxLetf.toFixed(2)}` : null,
      pnlPct != null ? `P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : null,
      shares != null ? `Qty ${shares}` : null,
    ].filter(Boolean);
    if (bits.length) {
      fields.push({ name: "Trade Summary", value: bits.join(" · "), inline: false });
    }
  } else if (isEntry) {
    const bits = [
      pxLetf != null ? `Entry $${pxLetf.toFixed(2)}` : null,
      shares != null ? `Shares ${shares}` : null,
      mgmt.stop_underlying ? `Stop (U/L) $${Number(mgmt.stop_underlying).toFixed(2)}` : null,
      mgmt.target_underlying ? `Target (U/L) $${Number(mgmt.target_underlying).toFixed(2)}` : null,
    ].filter(Boolean);
    if (bits.length) {
      fields.push({ name: "Trade Summary", value: bits.join(" · "), inline: false });
    }
  }

  if (pxUl != null) fields.push({ name: ul, value: `$${pxUl.toFixed(2)}`, inline: true });
  if (mgmt.stop_underlying) {
    fields.push({ name: "Stop (underlying)", value: `$${Number(mgmt.stop_underlying).toFixed(2)}`, inline: true });
  }
  if (mgmt.target_underlying) {
    fields.push({ name: "Target (underlying)", value: `$${Number(mgmt.target_underlying).toFixed(2)}`, inline: true });
  }
  if (mgmt.exit_by) {
    fields.push({ name: "Exit doctrine", value: String(mgmt.exit_by).slice(0, 256), inline: false });
  }
  if (isTrim && Number.isFinite(sharesRem)) {
    fields.push({ name: "Shares remaining", value: String(Math.max(0, sharesRem)), inline: true });
  } else if (isExit) {
    fields.push({ name: "Shares remaining", value: "0 — closed", inline: true });
  }

  return {
    title: title.slice(0, 250),
    description: lines.join("\n").slice(0, 2048),
    color: ev === "STOP" ? 0xef4444 : isEntry ? 0x22c55e : isExit ? (pnlPct != null && pnlPct < 0 ? 0xef4444 : 0x22c55e) : 0xf59e0b,
    fields,
    timestamp: new Date(now).toISOString(),
    footer: { text: "Timed Trading · Index Swings LETF · #trade-signals" },
  };
}
