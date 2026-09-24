#!/usr/bin/env node
/*
 * Replay one session of index option day trades and grade them.
 *
 * Reads two production exports:
 *   --actions  the `timed:opt-dt-actions` ring (what the desk actually did)
 *   --marks    option_marks rows for the session (what the contract did)
 *
 * The action tape is ground truth for fills. The marks path is only used to
 * answer the counterfactual: what was reachable while the position was on,
 * and what happened after the desk let go.
 *
 * Usage:
 *   node scripts/replay-day-trades.mjs --actions /tmp/act.json \
 *     --marks /tmp/marks.json --date 2026-09-23
 */

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DATE = arg("date", "2026-09-23");
const ET_OFFSET_MIN = -240; // EDT

function et(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts + ET_OFFSET_MIN * 60000);
  return d.toISOString().slice(11, 19);
}

function loadActions(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  let v = raw?.value ?? raw;
  if (typeof v === "string") v = JSON.parse(v);
  const rows = Array.isArray(v) ? v : (v.rows || v.actions || []);
  return rows
    .filter((r) => String(r.signal_id || "").includes(`:${DATE}:`))
    .sort((a, b) => a.ts - b.ts);
}

function loadMarks(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(raw) ? (raw[0]?.results || []) : (raw.results || []);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.signal_id)) by.set(r.signal_id, []);
    by.get(r.signal_id).push(r);
  }
  for (const list of by.values()) list.sort((a, b) => a.ts - b.ts);
  return by;
}

/**
 * Split one signal's event tape into rounds. A round opens on a BUY and
 * closes on the EXIT/STOP that takes the last contract off. Re-entering the
 * same strike later in the day opens a NEW round against the same signal id
 * -- that is a legitimate day-trade pattern, not a duplicate.
 */
function roundsFor(events) {
  const rounds = [];
  let cur = null;
  for (const e of events) {
    const ev = String(e.event || "").toUpperCase();
    if (ev === "BUY") {
      if (cur) rounds.push(cur);
      cur = { entry: e, legs: [], qty: Number(e.contracts) || 0 };
      continue;
    }
    if (!cur) continue;
    cur.legs.push(e);
    if (ev === "EXIT" || ev === "STOP") {
      cur.qty -= Number(e.contracts) || 0;
      if (cur.qty <= 0) { rounds.push(cur); cur = null; }
    } else if (ev === "TRIM") {
      cur.qty -= Number(e.contracts) || 0;
    }
  }
  if (cur) rounds.push(cur);
  return rounds;
}

function pnlFor(round) {
  const entry = Number(round.entry.premium) || 0;
  const qty = Number(round.entry.contracts) || 0;
  let sold = 0;
  let proceeds = 0;
  for (const leg of round.legs) {
    const q = Number(leg.contracts) || 0;
    proceeds += (Number(leg.premium) || 0) * q * 100;
    sold += q;
  }
  const basis = entry * qty * 100;
  const openQty = Math.max(0, qty - sold);
  // Anything still open at the end of the tape is marked at the last fill.
  const lastPx = round.legs.length ? Number(round.legs[round.legs.length - 1].premium) || entry : entry;
  const markOpen = openQty * lastPx * 100;
  return {
    entry, qty, sold, openQty,
    basis: Math.round(basis * 100) / 100,
    realized: Math.round((proceeds + markOpen - basis) * 100) / 100,
    exitEvent: round.legs.length ? round.legs[round.legs.length - 1].event : "OPEN",
  };
}

/** Best and worst mid inside [from, to], plus the peak after `to`. */
function pathStats(marks, from, to) {
  if (!marks?.length) return null;
  const inWin = marks.filter((m) => m.ts >= from - 90_000 && m.ts <= to + 90_000);
  const after = marks.filter((m) => m.ts > to + 90_000);
  const mids = inWin.map((m) => Number(m.mid)).filter((n) => Number.isFinite(n));
  const aft = after.map((m) => Number(m.mid)).filter((n) => Number.isFinite(n));
  if (!mids.length) return null;
  const peak = Math.max(...mids);
  const peakRow = inWin.find((m) => Number(m.mid) === peak);
  const afterPeak = aft.length ? Math.max(...aft) : null;
  const afterPeakRow = afterPeak != null ? after.find((m) => Number(m.mid) === afterPeak) : null;
  return {
    n: inWin.length,
    peak,
    peakTs: peakRow?.ts || null,
    trough: Math.min(...mids),
    afterPeak,
    afterPeakTs: afterPeakRow?.ts || null,
    afterLow: aft.length ? Math.min(...aft) : null,
  };
}

/**
 * Letter grade for one round.
 *
 * Entry and management are graded separately on purpose -- a good read that
 * was managed badly and a bad read that was managed well are different
 * mistakes and want different fixes.
 */
function grade(res, path) {
  const rMult = res.basis > 0 ? res.realized / (res.basis * 0.35) : 0; // 35% hard stop = 1R
  const capture = path && path.peak > res.entry
    ? (res.realized / 100) / ((path.peak - res.entry) * res.qty)
    : null;

  let entryGrade;
  if (!path) entryGrade = "?";
  else {
    const reach = (path.peak - res.entry) / res.entry;
    entryGrade = reach >= 0.5 ? "A" : reach >= 0.25 ? "B" : reach >= 0.10 ? "C" : reach > 0.02 ? "D" : "F";
  }

  let mgmtGrade;
  if (capture == null) mgmtGrade = res.realized >= 0 ? "C" : "D";
  else if (capture >= 0.6) mgmtGrade = "A";
  else if (capture >= 0.4) mgmtGrade = "B";
  else if (capture >= 0.2) mgmtGrade = "C";
  else if (capture > 0) mgmtGrade = "D";
  else mgmtGrade = "F";

  return { rMult, capture, entryGrade, mgmtGrade };
}

const actions = loadActions(arg("actions", "/tmp/act.json"));
const marks = loadMarks(arg("marks", "/tmp/marks.json"));

const bySignal = new Map();
for (const a of actions) {
  if (!bySignal.has(a.signal_id)) bySignal.set(a.signal_id, []);
  bySignal.get(a.signal_id).push(a);
}

console.log(`\nINDEX OPTION DAY TRADES -- ${DATE} (ET)\n${"=".repeat(100)}`);

const all = [];
for (const [sid, events] of [...bySignal.entries()].sort()) {
  for (const round of roundsFor(events)) {
    const res = pnlFor(round);
    const from = round.entry.ts;
    const to = round.legs.length ? round.legs[round.legs.length - 1].ts : from;
    const path = pathStats(marks.get(sid), from, to);
    const g = grade(res, path);
    all.push({ sid, round, res, path, g, from, to });
  }
}
all.sort((a, b) => a.from - b.from);

let n = 0;
for (const row of all) {
  n++;
  const { sid, round, res, path, g } = row;
  const label = sid.replace(/^dt:/, "").replace(`:${DATE}:2026-09-24:`, " ");
  const legs = round.legs
    .map((l) => `${l.event}${l.contracts}@${Number(l.premium).toFixed(2)}${l.reason ? `(${l.reason})` : ""}`)
    .join(" ");
  const hold = Math.round((row.to - row.from) / 60000);
  console.log(
    `\n${String(n).padStart(2)}. ${label.padEnd(18)} ${et(row.from)} -> ${et(row.to)}  (${hold}m)`,
  );
  console.log(
    `    BUY ${res.qty}@${res.entry.toFixed(2)}  ${legs}`,
  );
  console.log(
    `    debit $${res.basis.toFixed(0)}   P&L $${res.realized >= 0 ? "+" : ""}${res.realized.toFixed(0)}   ${g.rMult >= 0 ? "+" : ""}${g.rMult.toFixed(2)}R`,
  );
  if (path) {
    const reach = ((path.peak - res.entry) / res.entry) * 100;
    console.log(
      `    while held: peak $${path.peak.toFixed(2)} (${reach >= 0 ? "+" : ""}${reach.toFixed(0)}% @ ${et(path.peakTs)})  trough $${path.trough.toFixed(2)}  [${path.n} marks]`,
    );
    if (path.afterPeak != null) {
      const missed = (path.afterPeak - res.entry) * res.qty * 100 - res.realized;
      console.log(
        `    after exit: peak $${path.afterPeak.toFixed(2)} @ ${et(path.afterPeakTs)}  low $${path.afterLow.toFixed(2)}   left on table $${missed.toFixed(0)}`,
      );
    }
    console.log(
      `    capture ${g.capture != null ? `${(g.capture * 100).toFixed(0)}% of the reachable move` : "n/a"}   entry ${g.entryGrade}   management ${g.mgmtGrade}`,
    );
  } else {
    console.log("    no premium marks in the hold window -- ungraded");
  }
}

const net = all.reduce((s, r) => s + r.res.realized, 0);
const risked = all.reduce((s, r) => s + r.res.basis, 0);
const wins = all.filter((r) => r.res.realized > 0).length;
const losses = all.filter((r) => r.res.realized < 0).length;
const grossWin = all.filter((r) => r.res.realized > 0).reduce((s, r) => s + r.res.realized, 0);
const grossLoss = all.filter((r) => r.res.realized < 0).reduce((s, r) => s + r.res.realized, 0);
const worstDrawdown = (() => {
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (const r of all) {
    run += r.res.realized;
    peak = Math.max(peak, run);
    dd = Math.min(dd, run - peak);
  }
  return dd;
})();

console.log(`\n${"=".repeat(100)}`);
console.log(`rounds ${all.length}   wins ${wins}   losses ${losses}   win rate ${Math.round((wins / all.length) * 100)}%`);
console.log(`debit deployed $${risked.toFixed(0)}   net P&L $${net >= 0 ? "+" : ""}${net.toFixed(0)}   gross win $${grossWin.toFixed(0)}   gross loss $${grossLoss.toFixed(0)}`);
console.log(`profit factor ${grossLoss < 0 ? (grossWin / -grossLoss).toFixed(2) : "inf"}`);
console.log(`worst intraday equity drawdown $${worstDrawdown.toFixed(0)}`);

const peakConcurrent = (() => {
  const pts = [];
  for (const r of all) { pts.push([r.from, r.res.basis]); pts.push([r.to, -r.res.basis]); }
  pts.sort((a, b) => a[0] - b[0]);
  let cur = 0; let mx = 0;
  for (const [, d] of pts) { cur += d; mx = Math.max(mx, cur); }
  return mx;
})();
console.log(`peak concurrent debit at risk $${peakConcurrent.toFixed(0)}`);
