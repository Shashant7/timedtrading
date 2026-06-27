/**
 * Phase-C T3 — block new entries during dense earnings clusters.
 * Anchor day ±N when >= minTickers report within windowDays, unless rank bypass.
 */

function parseDateKey(tsOrKey) {
  if (!tsOrKey) return null;
  const s = String(tsOrKey);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10))) return s.slice(0, 10);
  const d = new Date(Number(tsOrKey) || Date.parse(s));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(dateKey, delta) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return parseDateKey(d.getTime());
}

function expandBlockDates(anchor, windowDates, dayPad) {
  const pad = Math.max(0, Number(dayPad) || 0);
  const seeds = new Set([anchor, ...(windowDates || [])].filter(Boolean));
  const out = new Set();
  for (const seed of seeds) {
    for (let i = -pad; i <= pad; i++) {
      const dk = addDays(seed, i);
      if (dk) out.add(dk);
    }
  }
  return out;
}

/**
 * Build cluster windows from market_events rows (earnings only).
 * @param {Array<object>} events
 * @param {{ minTickers?: number, windowDays?: number }} opts
 */
export function buildEarningsClusterWindowsFromEvents(events, opts = {}) {
  const minTickers = Number(opts.minTickers) || 4;
  const windowDays = Number(opts.windowDays) || 3;
  const byDate = new Map();
  for (const row of events || []) {
    if (String(row?.event_type || "").toLowerCase() !== "earnings") continue;
    const tk = String(row?.ticker || "").toUpperCase();
    const dateKey = parseDateKey(row?.date || row?.date_key);
    if (!tk || !dateKey) continue;
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Set());
    byDate.get(dateKey).add(tk);
  }
  const dateKeys = [...byDate.keys()].sort();
  const clusters = [];
  for (const anchor of dateKeys) {
    const tickers = new Set();
    const windowDates = [];
    for (let off = 0; off < windowDays; off++) {
      const dk = addDays(anchor, off);
      if (!dk) continue;
      windowDates.push(dk);
      for (const t of byDate.get(dk) || []) tickers.add(t);
    }
    if (tickers.size >= minTickers) {
      clusters.push({
        anchor,
        window_dates: windowDates,
        tickers: [...tickers],
      });
    }
  }
  return clusters;
}

/**
 * @returns {{ blocked: boolean, reason?: string, cluster?: object }}
 */
export function checkEarningsClusterEntryBlock(args) {
  const {
    dateKey,
    ticker,
    rank,
    daCfg,
    clusterWindows,
  } = args || {};
  const enabled = String(daCfg?.deep_audit_earnings_cluster_gate_enabled ?? "true") === "true";
  if (!enabled) return { blocked: false };
  const minTickers = Number(daCfg?.deep_audit_earnings_cluster_min_tickers) || 4;
  const rankBypass = Number(daCfg?.deep_audit_earnings_cluster_rank_bypass) || 97;
  const dayPad = Number(daCfg?.deep_audit_earnings_cluster_day_pad) || 1;
  const tk = String(ticker || "").toUpperCase();
  const dk = parseDateKey(dateKey);
  if (!tk || !dk) return { blocked: false };
  const rankScore = Number(rank) || 0;

  for (const cluster of clusterWindows || []) {
    const tickers = Array.isArray(cluster?.tickers) ? cluster.tickers : [];
    if (tickers.length < minTickers) continue;
    if (!tickers.includes(tk)) continue;
    const blockDates = expandBlockDates(cluster.anchor, cluster.window_dates, dayPad);
    if (!blockDates.has(dk)) continue;
    if (rankScore >= rankBypass) continue;
    return {
      blocked: true,
      reason: "earnings_cluster_entry_block",
      cluster,
    };
  }
  return { blocked: false };
}

export { parseDateKey, expandBlockDates };
