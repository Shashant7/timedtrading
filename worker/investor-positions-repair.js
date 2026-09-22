// Investor position snapshot repair — sync investor_positions from investor_lots.
//
// The ledger repair endpoint back-fills account_ledger from lots; this is the
// companion for the positions table when trims updated lots + ledger but left
// cost_basis / total_shares stale on investor_positions.
//
// Also: convenience-field heal (thesis / invalidation / stage / notes / DCA)
// so auto-opened rows never stay null after scores exist (CF 2026-07-15).
//
// And peak_price heal — the auto-rebalance SELECT omitted the column for
// months, so the Math.max high-water mark scored the stored peak as 0 and
// rewrote it to spot every run. Fixing the query stops the corruption but
// cannot recover a peak the book already forgot: all 20 OPEN rows were
// carrying spot (or avg_entry when underwater), understated by up to 10.9%.
// Daily candles remember, so rebuild from them.

import { replayInvestorLots } from "./investor-lot-ledger.js";
import { compactInvestorScoreProvenance } from "./investor.js";

const COST_TOLERANCE = 1;
const SHARE_TOLERANCE = 0.01;
const INVESTOR_CAPITAL_DEFAULT = 100000;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Load per-position lot-derived net shares/cost for OPEN rows. */
export async function loadInvestorPositionLotDerived(db) {
  const posRes = await db.prepare(
    `SELECT id, ticker, status, total_shares, cost_basis, avg_entry
       FROM investor_positions
      WHERE status = 'OPEN'`,
  ).all().catch(() => ({ results: [] }));
  const positions = posRes?.results || [];
  if (!positions.length) return [];

  const lotsRes = await db.prepare(
    `SELECT l.id, l.position_id, l.action, l.shares, l.price, l.value, l.ts
       FROM investor_lots l
       INNER JOIN investor_positions p ON l.position_id = p.id
      WHERE p.status = 'OPEN'
      ORDER BY l.position_id ASC, l.ts ASC, l.id ASC`,
  ).all().catch(() => ({ results: [] }));

  const lotsByPos = new Map();
  for (const lot of lotsRes?.results || []) {
    const pid = lot.position_id;
    if (!lotsByPos.has(pid)) lotsByPos.set(pid, []);
    lotsByPos.get(pid).push(lot);
  }

  return positions.map((p) => {
    const lots = lotsByPos.get(p.id) || [];
    const replay = replayInvestorLots(lots);
    return {
      id: p.id,
      ticker: p.ticker,
      status: p.status,
      total_shares: p.total_shares,
      cost_basis: p.cost_basis,
      avg_entry: p.avg_entry,
      lot_shares: replay.totalShares,
      lot_cost: replay.costBasis,
      lot_avg_entry: replay.avgEntry,
      lot_count: lots.length,
    };
  });
}

/** Compare OPEN positions to lot-derived totals; return drift rows. */
export function diffInvestorPositionsVsLots(rows) {
  const mismatches = [];
  let posCostSum = 0;
  let lotCostSum = 0;
  for (const r of rows || []) {
    const posShares = Number(r.total_shares) || 0;
    const posCost = Number(r.cost_basis) || 0;
    const lotShares = Number(r.lot_shares) || 0;
    const lotCost = Number(r.lot_cost) || 0;
    const lotCount = Number(r.lot_count) || 0;
    posCostSum += posCost;
    lotCostSum += lotCost;
    const shareDrift = posShares - lotShares;
    const costDrift = posCost - lotCost;
    if (Math.abs(shareDrift) <= SHARE_TOLERANCE && Math.abs(costDrift) <= COST_TOLERANCE) continue;
    mismatches.push({
      id: r.id,
      ticker: r.ticker,
      lot_count: lotCount,
      pos_shares: round2(posShares),
      lot_shares: round2(lotShares),
      share_drift: round2(shareDrift),
      pos_cost: round2(posCost),
      lot_cost: round2(lotCost),
      cost_drift: round2(costDrift),
      needs_manual: lotCount === 0 && posCost > COST_TOLERANCE,
    });
  }
  return {
    mismatches,
    pos_cost_sum: round2(posCostSum),
    lot_cost_sum: round2(lotCostSum),
    total_cost_drift: round2(posCostSum - lotCostSum),
  };
}

/**
 * Sync investor_positions cost_basis / total_shares / avg_entry from lots.
 * Skips rows with no lots but non-zero cost (phantom positions — manual fix).
 */
export async function repairInvestorPositionsFromLots(db, { dryRun = true } = {}) {
  const rows = await loadInvestorPositionLotDerived(db);
  const { mismatches, pos_cost_sum, lot_cost_sum, total_cost_drift } = diffInvestorPositionsVsLots(rows);
  const repairs = [];
  const skipped = [];
  const now = Date.now();

  for (const m of mismatches) {
    if (m.needs_manual) {
      skipped.push({ ...m, reason: "open_position_no_lots" });
      continue;
    }
    const lotShares = Number(m.lot_shares) || 0;
    const lotCost = Number(m.lot_cost) || 0;
    const avgEntry = lotShares > 0 ? lotCost / lotShares : 0;
    const patch = {
      id: m.id,
      ticker: m.ticker,
      total_shares: round2(lotShares),
      cost_basis: round2(lotCost),
      avg_entry: round2(avgEntry),
      before: { shares: m.pos_shares, cost: m.pos_cost },
      after: { shares: round2(lotShares), cost: round2(lotCost), avg_entry: round2(avgEntry) },
    };
    repairs.push(patch);
    if (!dryRun) {
      await db.prepare(
        `UPDATE investor_positions
            SET total_shares = ?1, cost_basis = ?2, avg_entry = ?3, updated_at = ?4
          WHERE id = ?5`,
      ).bind(lotShares, lotCost, avgEntry, now, m.id).run();
    }
  }

  return {
    dryRun,
    mismatch_count: mismatches.length,
    repair_count: repairs.length,
    skipped_count: skipped.length,
    pos_cost_sum,
    lot_cost_sum,
    total_cost_drift,
    repairs,
    skipped,
  };
}

function _blank(v) {
  return v == null || String(v).trim() === "";
}

/** Serialize thesis_invalidation for D1 TEXT column. */
export function serializeInvestorThesisInvalidation(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    return JSON.stringify(raw).slice(0, 4000);
  }
  const s = String(raw).trim();
  return s ? s.slice(0, 4000) : null;
}

/**
 * Derive convenience fields from a live investor score row.
 * Used by auto-open INSERT and by heal of existing OPEN rows.
 */
export function convenienceFieldsFromInvestorScore(scoreRow = {}, opts = {}) {
  const stage = scoreRow?.stage ? String(scoreRow.stage) : null;
  const score = Number(scoreRow?.score);
  const thesis = (() => {
    if (scoreRow?.thesis) return String(scoreRow.thesis).slice(0, 2000);
    const why = scoreRow?.compounder?.why_hold || scoreRow?.compounder?.hold_thesis;
    if (Array.isArray(why) && why.length) return why.filter(Boolean).join(". ").slice(0, 2000);
    return null;
  })();
  const thesisInvalidation = serializeInvestorThesisInvalidation(
    scoreRow?.thesisInvalidation ?? scoreRow?.thesis_invalidation,
  );
  const stageReason = scoreRow?.stageReason || scoreRow?.stage_reason || null;
  const notes = [
    opts.notesPrefix || (stage ? `Auto-initiated: ${stage}${Number.isFinite(score) ? ` (score ${score})` : ""}` : null),
    stageReason ? `reason=${stageReason}` : null,
  ].filter(Boolean).join(" | ").slice(0, 500) || null;
  return {
    thesis,
    thesis_invalidation: thesisInvalidation,
    investor_stage: stage,
    notes,
    stageReason,
  };
}

/**
 * Pure patch planner — which convenience columns are missing on `pos`
 * and can be filled from `scoreRow`.
 */
export function planInvestorConvenienceHeal(pos = {}, scoreRow = null, opts = {}) {
  if (!scoreRow || typeof scoreRow !== "object") return null;
  const derived = convenienceFieldsFromInvestorScore(scoreRow, opts);
  const patch = {};
  if (_blank(pos.thesis) && derived.thesis) patch.thesis = derived.thesis;
  if (_blank(pos.thesis_invalidation) && derived.thesis_invalidation) {
    patch.thesis_invalidation = derived.thesis_invalidation;
  }
  if (_blank(pos.investor_stage) && derived.investor_stage) {
    patch.investor_stage = derived.investor_stage;
  }
  if (_blank(pos.notes) && derived.notes) patch.notes = derived.notes;

  // Calibration-loop provenance — stamp once from live scores when missing
  // so older auto-opens (CF) become attributable without a re-entry.
  if (_blank(pos.entry_provenance_json) && scoreRow) {
    try {
      const prov = compactInvestorScoreProvenance(scoreRow, {
        stage: pos.investor_stage || scoreRow.stage,
        score: scoreRow.score,
        healed: true,
      });
      // Mark heal so calibration can distinguish live entry stamps vs backfill.
      prov.provenance_source = "heal_from_scores";
      patch.entry_provenance_json = JSON.stringify(prov).slice(0, 16000);
    } catch (_) { /* ignore */ }
  }

  const autoDca = opts.autoDcaOnAccumulate !== false;
  const stage = String(pos.investor_stage || derived.investor_stage || scoreRow.stage || "").toLowerCase();
  const dcaOff = !(Number(pos.dca_enabled) > 0);
  const ownedShares = Number(pos.total_shares) > 0;
  if (autoDca && dcaOff && ownedShares && (stage === "accumulate" || stage === "core_hold")) {
    const capital = Number(opts.investorCapital) > 0 ? Number(opts.investorCapital) : INVESTOR_CAPITAL_DEFAULT;
    const pct = Number(opts.autoDcaAmountPct);
    const amount = Number.isFinite(pct) && pct > 0
      ? Math.round(capital * pct)
      : Math.round(capital * 0.02);
    const freq = ["weekly", "biweekly", "monthly"].includes(String(opts.autoDcaFrequency || ""))
      ? String(opts.autoDcaFrequency)
      : "monthly";
    const freqMs = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : 30;
    const now = Number(opts.now) || Date.now();
    patch.dca_enabled = 1;
    patch.dca_amount = amount;
    patch.dca_frequency = freq;
    patch.dca_next_ts = now + freqMs * 24 * 60 * 60 * 1000;
  }

  return Object.keys(patch).length ? patch : null;
}

/**
 * Backfill missing thesis / invalidation / stage / notes / DCA on OPEN rows
 * from timed:investor:scores. Idempotent — only fills blanks.
 */
export async function healInvestorPositionConvenience(db, scores = {}, opts = {}) {
  const dryRun = opts.dryRun === true;
  const now = Number(opts.now) || Date.now();
  const posRes = await db.prepare(
    `SELECT id, ticker, total_shares, thesis, thesis_invalidation, investor_stage, notes,
            dca_enabled, dca_amount, dca_frequency, dca_next_ts, entry_provenance_json
       FROM investor_positions
      WHERE status = 'OPEN' AND total_shares > 0`,
  ).all().catch(() => ({ results: [] }));
  const positions = posRes?.results || [];
  const healed = [];
  const skipped = [];

  for (const pos of positions) {
    const sym = String(pos.ticker || "").toUpperCase();
    const scoreRow = scores[sym] || scores[pos.ticker] || null;
    if (!scoreRow) {
      skipped.push({ id: pos.id, ticker: sym, reason: "no_score_row" });
      continue;
    }
    const patch = planInvestorConvenienceHeal(pos, scoreRow, { ...opts, now });
    if (!patch) {
      skipped.push({ id: pos.id, ticker: sym, reason: "already_complete" });
      continue;
    }
    healed.push({ id: pos.id, ticker: sym, fields: Object.keys(patch) });
    if (dryRun) continue;

    const sets = [];
    const vals = [];
    let idx = 1;
    for (const [col, val] of Object.entries(patch)) {
      sets.push(`${col} = ?${idx++}`);
      vals.push(val);
    }
    sets.push(`updated_at = ?${idx++}`);
    vals.push(now);
    vals.push(pos.id);
    await db.prepare(
      `UPDATE investor_positions SET ${sets.join(", ")} WHERE id = ?${idx}`,
    ).bind(...vals).run();
  }

  return {
    dryRun,
    open_count: positions.length,
    healed_count: healed.length,
    skipped_count: skipped.length,
    healed,
    skipped: skipped.filter((s) => s.reason !== "already_complete"),
  };
}

/** A peak only ever ratchets up — never let a heal walk one back down. */
export function planInvestorPeakHeal(pos = {}, candleHigh = null) {
  const stored = Number(pos.peak_price) || 0;
  const high = Number(candleHigh);
  if (!Number.isFinite(high) || high <= 0) return null;
  // avg_entry is the floor the live loop already applies, so a row that has
  // never traded above its cost still reports a peak instead of a 0.
  const target = Math.max(high, Number(pos.avg_entry) || 0);
  if (!(target > stored)) return null;
  return { peak_price: target, before: stored, after: target };
}

/**
 * Rebuild `investor_positions.peak_price` from daily candle highs since each
 * position's first entry. Idempotent and monotonic: a row already carrying a
 * peak at or above its true high is left alone, so this is safe on every run
 * and degrades to a no-op once the book has healed.
 */
export async function healInvestorPositionPeaks(db, opts = {}) {
  const dryRun = opts.dryRun === true;
  const now = Number(opts.now) || Date.now();
  const empty = {
    dryRun, open_count: 0, healed_count: 0, skipped_count: 0, healed: [], skipped: [],
  };
  if (!db) return empty;

  const posRes = await db.prepare(
    `SELECT id, ticker, avg_entry, peak_price, first_entry_ts
       FROM investor_positions
      WHERE status = 'OPEN' AND total_shares > 0`,
  ).all().catch(() => ({ results: [] }));
  const positions = posRes?.results || [];
  if (!positions.length) return empty;

  const dated = positions.filter((p) => Number(p.first_entry_ts) > 0);
  const skipped = positions
    .filter((p) => !(Number(p.first_entry_ts) > 0))
    .map((p) => ({ id: p.id, ticker: p.ticker, reason: "no_first_entry_ts" }));
  if (!dated.length) {
    return { ...empty, open_count: positions.length, skipped_count: skipped.length, skipped };
  }

  // One pull covering the whole book: every ticker from the earliest entry
  // onward, then windowed per position in JS. Each row's own first_entry_ts
  // still bounds its peak — a ticker re-entered later must not inherit the
  // high of a previous hold.
  const tickers = [...new Set(dated.map((p) => String(p.ticker || "").toUpperCase()).filter(Boolean))];
  const earliest = Math.min(...dated.map((p) => Number(p.first_entry_ts)));
  const placeholders = tickers.map((_, i) => `?${i + 2}`).join(", ");
  const candleRes = await db.prepare(
    `SELECT ticker, ts, h FROM ticker_candles
      WHERE tf = 'D' AND ts >= ?1 AND ticker IN (${placeholders})`,
  ).bind(earliest, ...tickers).all().catch(() => ({ results: [] }));

  const barsByTicker = new Map();
  for (const row of candleRes?.results || []) {
    const sym = String(row.ticker || "").toUpperCase();
    const h = Number(row.h);
    if (!Number.isFinite(h) || h <= 0) continue;
    if (!barsByTicker.has(sym)) barsByTicker.set(sym, []);
    barsByTicker.get(sym).push({ ts: Number(row.ts) || 0, h });
  }

  const healed = [];
  for (const pos of dated) {
    const sym = String(pos.ticker || "").toUpperCase();
    const bars = barsByTicker.get(sym) || [];
    const entryTs = Number(pos.first_entry_ts);
    let high = 0;
    for (const b of bars) {
      if (b.ts < entryTs) continue;
      if (b.h > high) high = b.h;
    }
    if (!(high > 0)) {
      skipped.push({ id: pos.id, ticker: sym, reason: "no_candles_since_entry" });
      continue;
    }
    const patch = planInvestorPeakHeal(pos, high);
    if (!patch) {
      skipped.push({ id: pos.id, ticker: sym, reason: "already_at_peak" });
      continue;
    }
    healed.push({
      id: pos.id,
      ticker: sym,
      before: round2(patch.before),
      after: round2(patch.after),
    });
    if (dryRun) continue;
    await db.prepare(
      `UPDATE investor_positions SET peak_price = ?1, updated_at = ?2 WHERE id = ?3`,
    ).bind(patch.peak_price, now, pos.id).run();
  }

  return {
    dryRun,
    open_count: positions.length,
    healed_count: healed.length,
    skipped_count: skipped.length,
    healed,
    skipped: skipped.filter((s) => s.reason !== "already_at_peak"),
  };
}
