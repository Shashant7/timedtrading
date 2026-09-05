// worker/convexity-tickets.js
//
// Convexity ticket ledger (2026-09-05).
//
// The lotto strip (GET /timed/options/convexity) is a scan: it ranks
// earnings-prep lottos and gamma plays, prices them off the live chain,
// and forgets them five minutes later. The earnings desk called DELL 475c
// into the print and nothing owned it afterwards -- no entry premium on
// record, no exit, no grade. A called play has to be a ticket.
//
// This module turns every actionable, CONFLUENT, live-priced card into a
// D1 row with the premium it was called at, marks the open tickets off the
// chain, closes them by rule (premium stop, 3x take, peak giveback, the
// pre-print exit the crush block asked for, expiry), and grades them. Same
// pattern as the shadow report card that just kept daily_ema21_reclaim
// (45% positive, -0.31% median) away from capital: the desk earns the
// mirror by being graded, and the grade lives in one table.
//
// Scope (first slice): paper tickets + Discord, no broker order. The
// mirror decision is made from GET /timed/admin/convexity-tickets once the
// grade exists, not from a screenshot of one good call.

import { shareLaneExecutionWindow } from "./execution-window.js";
import { overlayConvexityCardPremium, chainStrikeRangeForPlay } from "./options-convexity.js";
import { getETDateStr } from "./market-calendar.js";

export const CONVEXITY_TICKET_MAX_OPEN = 4;
export const CONVEXITY_TICKET_MAX_DAILY = 2;
export const CONVEXITY_TICKET_MIN_CONFLUENCE = 75;
export const CONVEXITY_TICKET_STOP_FRAC = 0.5;   // premium halves -> out
export const CONVEXITY_TICKET_TAKE_MULT = 3;     // 3x premium -> take it
export const CONVEXITY_TICKET_TRAIL_ARM_MULT = 2; // after 2x, trail the peak
export const CONVEXITY_TICKET_TRAIL_KEEP = 0.6;  // keep 60% of the peak gain
const LAST_SESSION_EXIT_ET = 15 * 60 + 45;       // 15:45 ET on an exit-by date

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, dp = 2) {
  const v = num(n);
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export function contractSide(card) {
  return String(card?.direction || "").toUpperCase() === "SHORT" ? "P" : "C";
}

export function ticketIdFor(card) {
  const t = String(card?.ticker || "").toUpperCase();
  const exp = String(card?.expiration?.iso || card?.expiration || "").slice(0, 10);
  const k = num(card?.strike);
  return `cx:${t}:${exp}:${k}${contractSide(card)}`;
}

/**
 * Pure. Should this card become a ticket right now?
 *
 * Eligible: a live-chain premium (never an estimate), an actionable
 * card, and either an earnings-prep lotto whose four-pillar read is
 * CONFLUENT or a gamma/lotto card whose root confluence clears the floor.
 * Bounded by the options entry window and the daily / open caps.
 */
export function shouldOpenConvexityTicket(card, {
  now = Date.now(),
  openIds = new Set(),
  openCount = 0,
  todayCount = 0,
  cfg = {},
} = {}) {
  if (!card || typeof card !== "object") return { open: false, reason: "no_card" };
  const id = ticketIdFor(card);
  if (openIds.has(id)) return { open: false, reason: "already_open", id };
  if (card.chain_status !== "live" || card.premium_source !== "live_chain") {
    return { open: false, reason: "premium_not_live", id };
  }
  const prem = num(card.premium_mid);
  if (!(prem > 0)) return { open: false, reason: "no_premium", id };
  if (!String(card.expiration?.iso || "").match(/^\d{4}-\d{2}-\d{2}/)) {
    return { open: false, reason: "no_expiration", id };
  }
  if (card.h4_close_pending) return { open: false, reason: "h4_close_pending", id };

  const win = shareLaneExecutionWindow(now);
  if (!win.can_enter) return { open: false, reason: `window_${win.blocked_reason || "closed"}`, id };

  const maxOpen = num(cfg.convexity_ticket_max_open) ?? CONVEXITY_TICKET_MAX_OPEN;
  const maxDaily = num(cfg.convexity_ticket_max_daily) ?? CONVEXITY_TICKET_MAX_DAILY;
  if (openCount >= maxOpen) return { open: false, reason: "max_open", id };
  if (todayCount >= maxDaily) return { open: false, reason: "max_daily", id };

  const minConf = num(cfg.convexity_ticket_min_confluence) ?? CONVEXITY_TICKET_MIN_CONFLUENCE;
  if (card.earnings_prep) {
    const ep = card.earnings_play || null;
    const verdict = String(ep?.alignment?.verdict || "").toUpperCase();
    if (verdict !== "CONFLUENT") return { open: false, reason: `earnings_${verdict || "unread"}`, id };
    if (ep?.covers_print === false && ep?.crush?.recommendation !== "RUN_UP_ONLY") {
      return { open: false, reason: "expires_before_print", id };
    }
    return { open: true, reason: "earnings_confluent", id, conviction: num(ep?.alignment?.score) };
  }
  const conf = num(card.confluence_score);
  if (!(conf >= minConf)) return { open: false, reason: `confluence_${conf ?? "na"}_below_${minConf}`, id };
  return { open: true, reason: `confluence_${conf}`, id, conviction: conf };
}

/** Epoch ms for 15:45 ET on a YYYY-MM-DD date (DST-safe via ET offset probe). */
export function lastSessionExitTs(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const noonUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 16, 0, 0);
  // Find the ET offset in force on that date, then place 15:45 ET.
  const etHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit",
  }).format(new Date(noonUtc)));
  const offsetH = 16 - etHour; // 4 (EDT) or 5 (EST)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15 + offsetH, 45, 0);
}

export function ticketFromCard(card, decision, now = Date.now()) {
  const ep = card.earnings_play || null;
  const rec = String(ep?.crush?.recommendation || "");
  const exitByDate = (rec === "EXIT_BEFORE_PRINT" || rec === "TIGHT_HOLD") ? (ep?.crush?.exit_by?.date || null) : null;
  const expIso = String(card.expiration?.iso || "").slice(0, 10);
  const prem = num(card.premium_mid);
  const contracts = Math.max(1, Math.round(num(card.contracts) || 1));
  return {
    id: decision.id || ticketIdFor(card),
    ticker: String(card.ticker || "").toUpperCase(),
    play_class: String(card.play_class || ""),
    direction: String(card.direction || "").toUpperCase(),
    side: contractSide(card),
    strike: num(card.strike),
    expiration: expIso,
    entry_premium: prem,
    entry_spot: null,
    contracts,
    max_loss_usd: round(prem * 100 * contracts, 0),
    conviction: decision.conviction ?? null,
    open_reason: decision.reason,
    earnings_prep: card.earnings_prep ? 1 : 0,
    report_date: ep?.report_date || null,
    report_session: ep?.report_session || null,
    crush_recommendation: rec || null,
    exit_by_date: exitByDate,
    exit_by_ts: exitByDate ? lastSessionExitTs(exitByDate) : null,
    expiry_ts: lastSessionExitTs(expIso),
    status: "open",
    mark_premium: prem,
    peak_premium: prem,
    opened_ts: now,
    updated_ts: now,
  };
}

/**
 * Pure. Given the latest chain mark, what happens to an open ticket?
 * @returns {{ action: "hold"|"close", reason: string|null, mark: number|null, peak: number }}
 */
export function evaluateConvexityTicket(ticket, mark, now = Date.now()) {
  const entry = num(ticket?.entry_premium);
  const prevPeak = num(ticket?.peak_premium) ?? entry;
  const m = num(mark);
  const peak = m !== null ? Math.max(prevPeak ?? 0, m) : prevPeak;
  const nowMs = Number(now);
  if (!(entry > 0)) return { action: "close", reason: "bad_entry", mark: m, peak };

  const expiryTs = num(ticket?.expiry_ts);
  if (expiryTs && nowMs >= expiryTs) return { action: "close", reason: "expiry", mark: m, peak };
  const exitByTs = num(ticket?.exit_by_ts);
  if (exitByTs && nowMs >= exitByTs) return { action: "close", reason: "pre_print_exit", mark: m, peak };

  if (m === null) return { action: "hold", reason: "no_mark", mark: null, peak };
  if (m >= entry * CONVEXITY_TICKET_TAKE_MULT) return { action: "close", reason: "take_3x", mark: m, peak };
  if (peak >= entry * CONVEXITY_TICKET_TRAIL_ARM_MULT) {
    const floor = entry + (peak - entry) * CONVEXITY_TICKET_TRAIL_KEEP;
    if (m <= floor) return { action: "close", reason: "peak_giveback", mark: m, peak };
  }
  if (m <= entry * CONVEXITY_TICKET_STOP_FRAC) return { action: "close", reason: "premium_stop", mark: m, peak };
  return { action: "hold", reason: null, mark: m, peak };
}

export function ticketPnlPct(ticket, exitPremium) {
  const e = num(ticket?.entry_premium);
  const x = num(exitPremium);
  if (!(e > 0) || x === null) return null;
  return round(((x - e) / e) * 100, 1);
}

// ─── D1 layer ───────────────────────────────────────────────────────────

let _schemaReady = false;
export async function ensureConvexityTicketSchema(env) {
  if (_schemaReady) return true;
  const db = env?.DB;
  if (!db) return false;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS convexity_tickets (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        play_class TEXT,
        direction TEXT,
        side TEXT,
        strike REAL,
        expiration TEXT,
        entry_premium REAL,
        entry_spot REAL,
        contracts INTEGER,
        max_loss_usd REAL,
        conviction REAL,
        open_reason TEXT,
        earnings_prep INTEGER DEFAULT 0,
        report_date TEXT,
        report_session TEXT,
        crush_recommendation TEXT,
        exit_by_date TEXT,
        exit_by_ts INTEGER,
        expiry_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        mark_premium REAL,
        peak_premium REAL,
        exit_premium REAL,
        exit_reason TEXT,
        pnl_pct REAL,
        mfe_pct REAL,
        opened_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        closed_ts INTEGER,
        card_json TEXT
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_convexity_tickets_status ON convexity_tickets(status, opened_ts)`,
    ).run().catch(() => {});
    _schemaReady = true;
    return true;
  } catch (e) {
    console.error("[CONVEXITY TICKET] schema init failed:", String(e?.message || e).slice(0, 200));
    return false;
  }
}

export async function listOpenConvexityTickets(env) {
  if (!(await ensureConvexityTicketSchema(env))) return [];
  const res = await env.DB.prepare(
    `SELECT * FROM convexity_tickets WHERE status = 'open' ORDER BY opened_ts ASC LIMIT 50`,
  ).all();
  return res?.results || [];
}

async function countOpenedToday(env, now) {
  const today = getETDateStr(new Date(now));
  // Opened on the same ET date: scan the last 36h and filter by ET day.
  const res = await env.DB.prepare(
    `SELECT opened_ts FROM convexity_tickets WHERE opened_ts >= ? LIMIT 200`,
  ).bind(now - 36 * 3600 * 1000).all();
  return (res?.results || []).filter((r) => getETDateStr(new Date(Number(r.opened_ts))) === today).length;
}

/**
 * Open tickets for the cards the scan just produced. Returns the tickets
 * opened this call (already persisted). Never throws.
 */
export async function openConvexityTicketsFromCards(env, cards, { now = Date.now(), cfg = {}, notify = null } = {}) {
  const opened = [];
  const skipped = [];
  try {
    if (!Array.isArray(cards) || cards.length === 0) return { opened, skipped };
    if (!(await ensureConvexityTicketSchema(env))) return { opened, skipped };
    const open = await listOpenConvexityTickets(env);
    const openIds = new Set(open.map((r) => r.id));
    let openCount = open.length;
    let todayCount = await countOpenedToday(env, now);
    // Highest conviction first so the daily cap goes to the best call.
    const ranked = [...cards].sort((a, b) =>
      (num(b?.earnings_play?.alignment?.score) ?? num(b?.confluence_score) ?? 0)
      - (num(a?.earnings_play?.alignment?.score) ?? num(a?.confluence_score) ?? 0));
    for (const card of ranked) {
      const d = shouldOpenConvexityTicket(card, { now, openIds, openCount, todayCount, cfg });
      if (!d.open) { skipped.push({ ticker: card?.ticker, reason: d.reason }); continue; }
      const t = ticketFromCard(card, d, now);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO convexity_tickets
          (id, ticker, play_class, direction, side, strike, expiration, entry_premium, entry_spot, contracts,
           max_loss_usd, conviction, open_reason, earnings_prep, report_date, report_session, crush_recommendation,
           exit_by_date, exit_by_ts, expiry_ts, status, mark_premium, peak_premium, opened_ts, updated_ts, card_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `).bind(
        t.id, t.ticker, t.play_class, t.direction, t.side, t.strike, t.expiration, t.entry_premium, t.entry_spot,
        t.contracts, t.max_loss_usd, t.conviction, t.open_reason, t.earnings_prep, t.report_date, t.report_session,
        t.crush_recommendation, t.exit_by_date, t.exit_by_ts, t.expiry_ts, t.mark_premium, t.peak_premium,
        t.opened_ts, t.updated_ts, JSON.stringify(card).slice(0, 12000),
      ).run();
      openIds.add(t.id);
      openCount += 1;
      todayCount += 1;
      opened.push(t);
      console.log(`[CONVEXITY TICKET] opened ${t.id} @ ${t.entry_premium} x${t.contracts} (${t.open_reason})`);
      if (typeof notify === "function") {
        try { await notify(openEmbed(t, card)); } catch (_) { /* best effort */ }
      }
    }
  } catch (e) {
    console.warn("[CONVEXITY TICKET] open failed:", String(e?.message || e).slice(0, 200));
  }
  return { opened, skipped };
}

function contractLabel(t) {
  return `${t.ticker} ${t.strike}${t.side} ${t.expiration}`;
}

export function openEmbed(t, card = {}) {
  const lines = [
    `Entry premium $${t.entry_premium} x${t.contracts} (risk $${t.max_loss_usd})`,
    t.earnings_prep ? `Earnings ${t.report_session || ""} ${t.report_date || ""}`.trim() : `Class ${t.play_class}`,
    t.crush_recommendation ? `Crush: ${t.crush_recommendation}${t.exit_by_date ? ` -- exit by ${t.exit_by_date} close` : ""}` : null,
    `Stop ${Math.round(CONVEXITY_TICKET_STOP_FRAC * 100)}% of premium · take ${CONVEXITY_TICKET_TAKE_MULT}x · trail after ${CONVEXITY_TICKET_TRAIL_ARM_MULT}x`,
    card?.shot_reason ? String(card.shot_reason).slice(0, 240) : null,
  ].filter(Boolean);
  return {
    title: `OPTIONS DESK · ticket ${contractLabel(t)} (model fill)`,
    description: lines.join("\n"),
    color: t.side === "P" ? 0xe5484d : 0x30a46c,
  };
}

export function closeEmbed(t, { mark, reason, pnlPct, mfePct }) {
  const sign = pnlPct >= 0 ? "+" : "";
  return {
    title: `OPTIONS DESK · closed ${contractLabel(t)} ${sign}${pnlPct ?? "?"}% (${reason})`,
    description: [
      `Entry $${t.entry_premium} -> exit $${mark ?? "n/a"}`,
      mfePct !== null && mfePct !== undefined ? `Peak +${mfePct}%` : null,
    ].filter(Boolean).join("\n"),
    color: pnlPct >= 0 ? 0x30a46c : 0xe5484d,
  };
}

/**
 * Mark every open ticket off the chain and apply the exit rules.
 * @param opts.fetchChain (env, sym, expIso, opts) => chain
 */
export async function markConvexityTickets(env, { fetchChain, now = Date.now(), notify = null } = {}) {
  const out = { scanned: 0, marked: 0, closed: 0, held: 0, results: [] };
  try {
    const rows = await listOpenConvexityTickets(env);
    out.scanned = rows.length;
    for (const row of rows) {
      let mark = null;
      if (typeof fetchChain === "function") {
        try {
          const chain = await fetchChain(env, row.ticker, row.expiration, {
            strikeRangePct: chainStrikeRangeForPlay(null, row.strike, 0.08),
            skipOI: true,
            playStrike: row.strike,
          });
          const probe = {
            ticker: row.ticker, direction: row.direction, strike: row.strike,
            expiration: { iso: row.expiration, dte: null }, premium_mid: null,
          };
          overlayConvexityCardPremium(probe, chain, { spot: chain?.underlying_price });
          if (probe.premium_source === "live_chain") mark = num(probe.premium_mid);
        } catch (_) { /* hold without a mark */ }
      }
      const ev = evaluateConvexityTicket(row, mark, now);
      const mfePct = ticketPnlPct(row, ev.peak);
      if (ev.action === "hold") {
        out.held += 1;
        if (mark !== null) {
          out.marked += 1;
          await env.DB.prepare(
            `UPDATE convexity_tickets SET mark_premium = ?, peak_premium = ?, mfe_pct = ?, updated_ts = ? WHERE id = ? AND status = 'open'`,
          ).bind(mark, ev.peak, mfePct, now, row.id).run().catch(() => {});
        }
        continue;
      }
      // Close: expiry/pre-print with no live mark settles at the last mark
      // (worthless at expiry when there was never a mark).
      const exitMark = ev.mark ?? (ev.reason === "expiry" ? (num(row.mark_premium) ?? 0) : num(row.mark_premium));
      const pnlPct = ticketPnlPct(row, exitMark);
      await env.DB.prepare(`
        UPDATE convexity_tickets
           SET status = 'closed', exit_premium = ?, exit_reason = ?, pnl_pct = ?, mfe_pct = ?,
               mark_premium = ?, peak_premium = ?, updated_ts = ?, closed_ts = ?
         WHERE id = ? AND status = 'open'
      `).bind(exitMark, ev.reason, pnlPct, mfePct, exitMark, ev.peak, now, now, row.id).run().catch(() => {});
      out.closed += 1;
      out.results.push({ id: row.id, reason: ev.reason, exit: exitMark, pnl_pct: pnlPct, mfe_pct: mfePct });
      console.log(`[CONVEXITY TICKET] closed ${row.id} ${ev.reason} exit=${exitMark} pnl=${pnlPct}%`);
      if (typeof notify === "function") {
        try { await notify(closeEmbed(row, { mark: exitMark, reason: ev.reason, pnlPct, mfePct })); } catch (_) {}
      }
    }
  } catch (e) {
    console.warn("[CONVEXITY TICKET] mark failed:", String(e?.message || e).slice(0, 200));
  }
  return out;
}

/** Report card: every ticket, plus the grade the mirror decision needs. */
export async function convexityTicketReport(env, { days = 30, now = Date.now() } = {}) {
  if (!(await ensureConvexityTicketSchema(env))) return { ok: false, error: "no_db" };
  const since = now - days * 86400000;
  const res = await env.DB.prepare(
    `SELECT * FROM convexity_tickets WHERE opened_ts >= ? ORDER BY opened_ts DESC LIMIT 300`,
  ).bind(since).all();
  const rows = (res?.results || []).map((r) => ({ ...r, card_json: undefined }));
  const closed = rows.filter((r) => r.status === "closed" && num(r.pnl_pct) !== null);
  const pnls = closed.map((r) => Number(r.pnl_pct)).sort((a, b) => a - b);
  const median = pnls.length ? pnls[Math.floor(pnls.length / 2)] : null;
  const byReason = {};
  for (const r of closed) byReason[r.exit_reason] = (byReason[r.exit_reason] || 0) + 1;
  return {
    ok: true,
    days,
    open: rows.filter((r) => r.status === "open").length,
    closed_n: closed.length,
    win_rate_pct: closed.length ? Math.round((closed.filter((r) => Number(r.pnl_pct) > 0).length / closed.length) * 100) : null,
    median_pnl_pct: median,
    mean_pnl_pct: pnls.length ? round(pnls.reduce((a, b) => a + b, 0) / pnls.length, 1) : null,
    exit_reasons: byReason,
    tickets: rows,
  };
}
