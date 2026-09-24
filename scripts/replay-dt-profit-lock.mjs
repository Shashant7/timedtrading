#!/usr/bin/env node
/*
 * Counterfactual for the profit-lock floor change.
 *
 * Takes the real action tape (`timed:opt-dt-actions`, what the desk did) and
 * the real contract path (`option_marks`, what the contract traded at) and
 * replays each round under BOTH stop rules:
 *
 *   old  stop snaps to the entry premium once the peak clears +10% / $0.08
 *   new  stop rides profitLockFloor() -- max(hard stop, min(entry, giveback))
 *
 * Both arms of the replay run the rest of the ladder the same way (1R trim,
 * the breakeven a trim earns, the 40% runner trail, 2R exit, 15:45 flat), so
 * the only thing that differs is the floor under a book that went green
 * without tagging 1R.
 *
 * `option_marks` is sampled, not a tick tape. A round whose hold window
 * contains only a handful of marks cannot answer the counterfactual, so it
 * is reported but excluded from the totals rather than quietly scored.
 *
 * Usage:
 *   node scripts/replay-dt-profit-lock.mjs --actions /tmp/dt-actions.json \
 *     --marks /tmp/dt-marks.json [--min-marks 8]
 */

import { readFileSync } from "node:fs";
import {
  profitLockFloor,
  shouldArmProfitLock,
  HARD_STOP_PCT,
  TRAIL_GIVEBACK_PCT,
} from "../worker/option-day-trade-plan.js";

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const MIN_MARKS = Number(arg("min-marks", 8));
const ET_OFFSET_MIN = -240;
const etDate = (ts) => new Date(ts + ET_OFFSET_MIN * 60000);
const hhmm = (ts) => etDate(ts).toISOString().slice(11, 16);
const minutesEt = (ts) => etDate(ts).getUTCHours() * 60 + etDate(ts).getUTCMinutes();
const dayEt = (ts) => etDate(ts).toISOString().slice(0, 10);
const money = (v) => (v == null ? "  --  " : `$${Number(v).toFixed(2)}`);
const pct = (v) => (v == null ? "   --" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

const RTH_OPEN_MIN = 9 * 60 + 30;
const FLAT_MIN = 15 * 60 + 45; // SESSION_FLAT_ET
const TRIM_MULT = 1.5; // 1R on a -50% hard stop
const EXIT_MULT = 2.0; // 2R

function loadActions(path) {
  let v = JSON.parse(readFileSync(path, "utf8"));
  if (v?.value) v = v.value;
  if (typeof v === "string") v = JSON.parse(v);
  return (Array.isArray(v) ? v : v.rows || []).sort((a, b) => a.ts - b.ts);
}

function loadMarks(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(raw) ? raw[0]?.results || [] : raw?.result?.[0]?.results || raw.results || [];
  const by = new Map();
  for (const r of rows) {
    const m = minutesEt(r.ts);
    if (m < RTH_OPEN_MIN || m > FLAT_MIN) continue; // the lane is flat outside this
    if (!(Number(r.mid) > 0)) continue;
    if (!by.has(r.signal_id)) by.set(r.signal_id, []);
    by.get(r.signal_id).push({ ts: r.ts, mid: Number(r.mid) });
  }
  for (const list of by.values()) list.sort((a, b) => a.ts - b.ts);
  return by;
}

const actions = loadActions(arg("actions", "/tmp/dt-actions.json"));
const marks = loadMarks(arg("marks", "/tmp/dt-marks.json"));

// One round per BUY: opens on the BUY, closes on the reduce that takes the
// last contract off. Re-entering the same strike opens a new round.
const rounds = [];
const live = new Map();
for (const a of actions) {
  if (a.event === "BUY") {
    const r = {
      sig: a.signal_id, ticker: a.ticker, entry: a.premium,
      entryTs: a.ts, contracts: a.contracts, trimmed: false,
    };
    live.set(a.signal_id, r);
    rounds.push(r);
    continue;
  }
  const r = live.get(a.signal_id);
  if (!r) continue;
  if (a.event === "TRIM") { r.trimmed = true; continue; }
  r.exit = a.premium;
  r.exitTs = a.ts;
  r.reason = a.reason || a.event.toLowerCase();
  live.delete(a.signal_id);
}

/**
 * Run one round's real mark path through the full exit ladder. `snapToEntry`
 * picks the rule: true is the old behaviour (peak lock pins the stop at the
 * entry premium), false is the ratcheting floor.
 */
function runLadder(round, path, snapToEntry) {
  const entry = round.entry;
  const hard = entry * (1 + HARD_STOP_PCT / 100);
  const trimAt = entry * TRIM_MULT;
  const exitAt = entry * EXIT_MULT;
  let peak = entry;
  let trimArmed = false;
  let banked = 0; // premium % already taken off at the 1R trim
  let weight = 1;

  for (const m of path) {
    if (m.ts < round.entryTs) continue;
    peak = Math.max(peak, m.mid);

    if (!trimArmed && m.mid >= trimAt) {
      // Half off at 1R; the runner now has an EARNED breakeven.
      trimArmed = true;
      banked += 0.5 * (m.mid / entry - 1) * 100;
      weight = 0.5;
      continue;
    }
    if (trimArmed && m.mid >= exitAt) {
      return { px: m.mid, ts: m.ts, why: "tp2", pnl: banked + weight * (m.mid / entry - 1) * 100, peak };
    }

    const armed = trimArmed || shouldArmProfitLock(entry, peak);
    let floor;
    if (!armed) floor = hard;
    else if (trimArmed || snapToEntry) floor = entry;
    else floor = profitLockFloor(entry, peak);
    // The runner trail applies above breakeven under both rules.
    if (armed) floor = Math.max(floor, peak * (1 - TRAIL_GIVEBACK_PCT));

    if (m.mid <= floor) {
      const why = !armed ? "premium_stop"
        : trimArmed ? "breakeven_stop"
          : (snapToEntry ? "breakeven_stop" : "profit_lock_stop");
      return { px: m.mid, ts: m.ts, why, pnl: banked + weight * (m.mid / entry - 1) * 100, peak };
    }
  }
  const last = path[path.length - 1];
  return { px: last.mid, ts: last.ts, why: "15:45 flat", pnl: banked + weight * (last.mid / entry - 1) * 100, peak };
}

console.log("=== Profit-lock floor: old rule vs new, replayed on real option_marks ===");
console.log(`action tape ${actions.length} events · marks ${[...marks.values()].reduce((n, l) => n + l.length, 0)} RTH rows · scoring rounds with >= ${MIN_MARKS} marks in the hold\n`);

const hdr = `${"round".padEnd(34)} ${"entry".padEnd(6)} ${"actual".padEnd(18)} ${"OLD rule".padEnd(26)} ${"NEW rule".padEnd(26)} path`;
console.log(hdr);
console.log("-".repeat(hdr.length + 6));

let netOld = 0; let netNew = 0; let scored = 0; let skipped = 0;
const changed = [];
for (const r of rounds) {
  if (!r.exit) continue;
  const path = (marks.get(r.sig) || []).filter((m) => m.ts >= r.entryTs);
  const held = path.filter((m) => m.ts <= (r.exitTs ?? Infinity)).length;
  const actualPnl = (r.exit / r.entry - 1) * 100;
  const actual = `${money(r.exit)} ${pct(actualPnl).padStart(7)}`;
  if (path.length < MIN_MARKS) {
    skipped += 1;
    console.log(`${r.sig.padEnd(34)} ${money(r.entry)} ${actual.padEnd(18)} ${"-- path too thin to score --".padEnd(53)} ${path.length} marks (${held} held)`);
    continue;
  }
  const oldRun = runLadder(r, path, true);
  const newRun = runLadder(r, path, false);
  netOld += oldRun.pnl; netNew += newRun.pnl; scored += 1;
  const o = `${pct(oldRun.pnl).padStart(7)} ${oldRun.why.padEnd(16)}`;
  const n = `${pct(newRun.pnl).padStart(7)} ${newRun.why.padEnd(16)}`;
  console.log(`${r.sig.padEnd(34)} ${money(r.entry)} ${actual.padEnd(18)} ${o.padEnd(26)} ${n.padEnd(26)} ${path.length} marks (${held} held)`);
  if (Math.abs(newRun.pnl - oldRun.pnl) > 0.05) changed.push({ r, oldRun, newRun });
}

console.log(`\nscored ${scored} rounds · skipped ${skipped} with fewer than ${MIN_MARKS} marks after entry`);
console.log(`total premium P/L per contract   OLD ${pct(netOld)}   NEW ${pct(netNew)}   delta ${pct(netNew - netOld)}`);

console.log(`\n=== rounds the floor change moved (${changed.length}) ===`);
for (const { r, oldRun, newRun } of changed) {
  const d = newRun.pnl - oldRun.pnl;
  console.log(
    `  ${r.sig.padEnd(34)} entry ${money(r.entry)} @ ${hhmm(r.entryTs)}` +
    `  old ${pct(oldRun.pnl).padStart(7)} (${oldRun.why})` +
    `  ->  new ${pct(newRun.pnl).padStart(7)} (${newRun.why} @ ${hhmm(newRun.ts)})` +
    `   ${d >= 0 ? "+" : ""}${d.toFixed(1)} pts`,
  );
}
const better = changed.filter((c) => c.newRun.pnl > c.oldRun.pnl);
console.log(`\n  better under the new floor: ${better.length}/${changed.length}` +
  `   worse: ${changed.length - better.length}/${changed.length}`);
console.log("  Both arms run the identical ladder over the identical path, so the");
console.log("  delta is attributable to the floor alone. The absolute totals are");
console.log("  soft: option_marks is sampled, so a fill can land past its trigger.");

// Was the ENTRY the problem? If the desk were chasing, the contract would
// go little or nowhere after the fill. MFE/MAE are measured from the entry
// to the 15:45 flat, on the real path.
console.log("\n=== entry quality: what the contract did AFTER the fill ===");
console.log(`${"round".padEnd(34)} ${"entry".padEnd(6)} ${"MFE".padEnd(8)} ${"MAE".padEnd(8)} ${"MFE before MAE?".padEnd(16)} actual exit`);
console.log("-".repeat(95));
let goodEntries = 0; let entriesScored = 0;
for (const r of rounds) {
  if (!r.exit) continue;
  const path = (marks.get(r.sig) || []).filter((m) => m.ts >= r.entryTs);
  if (path.length < MIN_MARKS) continue;
  let hi = r.entry; let lo = r.entry; let hiTs = r.entryTs; let loTs = r.entryTs;
  for (const m of path) {
    if (m.mid > hi) { hi = m.mid; hiTs = m.ts; }
    if (m.mid < lo) { lo = m.mid; loTs = m.ts; }
  }
  const mfe = (hi / r.entry - 1) * 100;
  const mae = (lo / r.entry - 1) * 100;
  const favouredFirst = hiTs <= loTs;
  entriesScored += 1;
  if (mfe >= 50) goodEntries += 1; // the contract reached its own 1R trim
  console.log(
    `${r.sig.padEnd(34)} ${money(r.entry)} ${pct(mfe).padStart(7)}  ${pct(mae).padStart(7)}  ` +
    `${(favouredFirst ? "yes" : "no").padEnd(16)} ${pct((r.exit / r.entry - 1) * 100)} ${r.reason}`,
  );
}
console.log(`\n  ${goodEntries}/${entriesScored} entries saw the contract reach its own 1R trim (+50%) at some`);
console.log("  point after the fill. An entry that is a step behind the move does not");
console.log("  do that -- it is the exit that did not stay in.");

// Split those same entries by whether they were the day's FIRST position in
// that underlying and direction, or a re-entry behind one.
console.log("\n=== first position of the day vs re-entry, same underlying and side ===");
const seen = new Set();
const buckets = { first: [], reentry: [] };
for (const r of rounds) {
  const [, tkr, day, , right] = r.sig.split(":");
  const key = `${day}:${tkr}:${right}`;
  const isFirst = !seen.has(key);
  seen.add(key);
  if (!r.exit) continue;
  const path = (marks.get(r.sig) || []).filter((m) => m.ts >= r.entryTs);
  if (path.length < MIN_MARKS) continue;
  const mfe = (Math.max(...path.map((m) => m.mid)) / r.entry - 1) * 100;
  buckets[isFirst ? "first" : "reentry"].push({ sig: r.sig, ts: r.entryTs, mfe });
}
for (const [name, list] of Object.entries(buckets)) {
  const hit = list.filter((x) => x.mfe >= 50).length;
  const med = list.length ? [...list].sort((a, b) => a.mfe - b.mfe)[Math.floor(list.length / 2)].mfe : 0;
  console.log(`  ${name.padEnd(8)} n=${String(list.length).padEnd(3)} reached +50%: ${hit}/${list.length}   median MFE ${pct(med)}`);
  for (const x of list) console.log(`      ${hhmm(x.ts)}  ${x.sig.padEnd(34)} MFE ${pct(x.mfe)}`);
}
console.log("\n  A re-entry only happens because the previous position came off. Most");
console.log("  of these came off at the breakeven snap, so the floor fix removes the");
console.log("  cause; re-measure the split before adding a separate re-entry gate.");
