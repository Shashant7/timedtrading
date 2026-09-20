#!/usr/bin/env node
/**
 * Weekend book review through the trim/no-trim lens (added 2026-09-20).
 *
 * The nightly edge scorecard rolls a family up to one PF, which is what the
 * weekly governor and the demotion proposals read. That number cannot tell an
 * entry that has no edge apart from an exit that gives the edge back, and on
 * 2026-09-19 it produced two proposals to block the only profitable family in
 * the book.
 *
 * Splitting the same trades by whether the trim ever fired does separate them:
 * over 90 days the 61 trades that reached a trim were 77% WR at PF 3.27, while
 * the 68 that never did were 5.9% WR at PF 0.01. Every family showed the same
 * shape. That is where a refinement is worth looking for.
 *
 * Read it as a diagnostic, not a verdict: "trimmed" partly means "worked", so
 * the split is not a free edge. What it localizes is whether the untrimmed
 * cohort's losses are BOUNDED. Book-wide they are (median -2.01%, matching
 * deep_audit_max_loss_pct normal:-2); Cloud Pivot's were not, because the
 * family had a profit lock above its missing-print guard and no loss rule
 * under it. That is the asymmetry this lens is for.
 *
 * Usage:
 *   cd worker && ../node_modules/.bin/wrangler d1 execute --env production \
 *     --remote timed-trading-ledger --json --command "SELECT setup_name,
 *     entry_path, direction, pnl, pnl_pct, max_favorable_excursion mfe,
 *     max_adverse_excursion mae, trimmed_pct, exit_reason FROM trades
 *     WHERE status IN ('WIN','LOSS')
 *       AND entry_ts > (strftime('%s','now')-90*86400)*1000;" > /tmp/book90.json
 *   cd worker && ../node_modules/.bin/wrangler d1 execute --env production \
 *     --remote timed-trading-ledger --json --command "SELECT config_key,
 *     config_value, updated_by FROM model_config
 *     WHERE config_key LIKE 'deep_audit_setup_demotion%';" > /tmp/markers.json
 *   npx vite-node scripts/weekend-trim-split-review.mjs \
 *     --trades /tmp/book90.json --markers /tmp/markers.json
 *
 * --markers is optional but strongly recommended: without it the governance
 * section can only rank families by PnL, which is how a family that is
 * ALREADY blocked gets re-proposed.
 */

import {
  demotionProposalConfigKey,
} from "../worker/pipeline/setup-demotion.js";
import {
  isCalibrationPlay,
  resolveGovernancePlay,
} from "../worker/foundation/play-catalog.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function extractRows(raw) {
  // Not indexOf("["): wrangler prefixes its payload with lines like
  // "▲ [WARNING] Unexpected fields ...", so the first bracket in the stream is
  // usually part of a log tag. Take the first line that opens a JSON value and
  // actually parses.
  let parsed = null;
  for (const m of String(raw).matchAll(/^[ \t]*[[{]/gm)) {
    try {
      parsed = JSON.parse(raw.slice(m.index));
      break;
    } catch { /* a log line that merely looks like JSON */ }
  }
  if (parsed == null) throw new Error("no JSON payload in input");
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first ?? [];
}

/** model_config rows -> { key: value }. D1 holds some values JSON-encoded. */
export function parseMarkers(raw) {
  const out = {};
  for (const row of extractRows(raw)) {
    const k = String(row.config_key ?? "");
    if (!k) continue;
    let v = row.config_value;
    if (typeof v === "string" && v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { /* leave as written */ }
    }
    out[k] = { value: String(v ?? "").toLowerCase(), updated_by: row.updated_by ?? "" };
  }
  return out;
}

/**
 * Keys no runtime read will ever match. `checkSetupDemotion` canonicalizes the
 * path it is asked about and reads THAT key; a marker whose own spelling does
 * not canonicalize back onto itself is decoration. This is the 2026-09-20 bug
 * class (a key naming the paper sibling "TT Cloud Pivot Long") and the
 * 2026-07-23 one ("TT Tt Ath Breakout") in a form a script can catch.
 */
export function inertMarkers(markers) {
  const rows = [];
  for (const [key, m] of Object.entries(markers)) {
    if (!key.startsWith("deep_audit_setup_demotion_")) continue;
    const body = key.slice("deep_audit_setup_demotion_".length);
    const parts = body.match(/^(.*)_([a-z]+)$/i);
    if (!parts) continue; // enforce_paths / index_only — scalars, not markers
    const [, name, dir] = parts;
    const canonical = demotionProposalConfigKey(name, dir);
    if (canonical && canonical !== key) {
      rows.push({ key, canonical, value: m.value, updated_by: m.updated_by });
    }
  }
  return rows;
}

export function stats(rows) {
  if (!rows.length) return null;
  const wins = rows.filter((r) => num(r.pnl) > 0);
  const gp = wins.reduce((a, r) => a + num(r.pnl), 0);
  const gl = Math.abs(rows.filter((r) => num(r.pnl) <= 0).reduce((a, r) => a + num(r.pnl), 0));
  return {
    n: rows.length,
    wr: (100 * wins.length) / rows.length,
    pnl: rows.reduce((a, r) => a + num(r.pnl), 0),
    pf: gl > 0 ? gp / gl : Infinity,
  };
}

const fmt = (s) => `n=${String(s.n).padEnd(4)}WR=${s.wr.toFixed(1).padStart(5)}%  `
  + `pnl=$${s.pnl.toFixed(2).padStart(9)}  PF=${Number.isFinite(s.pf) ? s.pf.toFixed(2).padStart(5) : "  inf"}`;

const trimmed = (r) => num(r.trimmed_pct) > 0;

function section(title) {
  console.log(`\n${"=".repeat(80)}\n${title}\n${"=".repeat(80)}`);
}

async function main() {
  const argv = process.argv;
  const file = argv[argv.indexOf("--trades") + 1];
  if (!argv.includes("--trades") || !file) {
    console.error("usage: --trades <d1-json>");
    process.exit(1);
  }
  const fs = await import("node:fs");
  const rows = extractRows(fs.readFileSync(file, "utf8"));
  const markerFile = argv.includes("--markers") ? argv[argv.indexOf("--markers") + 1] : null;
  const markers = markerFile ? parseMarkers(fs.readFileSync(markerFile, "utf8")) : null;

  section("BOOK-WIDE — split by whether the trim ever fired");
  console.log(`  trim fired         ${fmt(stats(rows.filter(trimmed)))}`);
  console.log(`  trim never fired   ${fmt(stats(rows.filter((r) => !trimmed(r))))}`);
  console.log(`\n  total              ${fmt(stats(rows))}`);

  section("PER FAMILY");
  const byFamily = new Map();
  for (const r of rows) {
    const k = String(r.setup_name ?? "(unstamped)");
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(r);
  }
  for (const [name, rs] of [...byFamily].sort((a, b) => b[1].length - a[1].length)) {
    const t = rs.filter(trimmed);
    const u = rs.filter((r) => !trimmed(r));
    console.log(`\n  ${name}  (${rs.length} closes)`);
    console.log(`     overall     ${fmt(stats(rs))}`);
    if (t.length) console.log(`     trimmed     ${fmt(stats(t))}`);
    if (u.length) console.log(`     untrimmed   ${fmt(stats(u))}`);
  }

  section("ARE THE UNTRIMMED LOSSES BOUNDED? (the actionable half)");
  const ul = rows.filter((r) => !trimmed(r) && num(r.pnl) <= 0);
  const pcts = ul.map((r) => num(r.pnl_pct)).sort((a, b) => a - b);
  if (pcts.length) {
    const median = pcts[Math.floor(pcts.length / 2)];
    const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    console.log(`  n=${pcts.length}  median=${median.toFixed(2)}%  mean=${mean.toFixed(2)}%  worst=${pcts[0].toFixed(2)}%`);
    console.log("\n  tail past each threshold (a family clustered here lacks a loss rule):");
    for (const thr of [-3, -4, -5, -6, -8]) {
      const deep = ul.filter((r) => num(r.pnl_pct) <= thr);
      const fams = [...new Set(deep.map((r) => String(r.setup_name)))];
      console.log(
        `    past ${`${thr}%`.padEnd(5)} ${String(deep.length).padStart(3)} trades  `
        + `$${deep.reduce((a, r) => a + num(r.pnl), 0).toFixed(2).padStart(9)}`
        + (fams.length ? `   ${fams.join(", ")}` : ""),
      );
    }
  }

  section("GOVERNANCE CROSS-CHECK — is a bleeding family already blocked?");
  if (!markers) {
    console.log("  (no --markers file; ranking by PnL only. A family that is already");
    console.log("   blocked will look identical to one that needs a look.)");
    for (const [name, rs] of [...byFamily].sort((a, b) => stats(a[1]).pnl - stats(b[1]).pnl)) {
      const s = stats(rs);
      console.log(`    ${name.padEnd(28)}$${s.pnl.toFixed(2).padStart(9)}  over ${String(s.n).padStart(3)} closes`);
    }
  } else {
    console.log("  BLOCKED      already handled — do not re-propose.");
    console.log("  CALIBRATION  deliberately left allowed; PF is not a verdict here.");
    console.log("  LOOK         losing money with no marker — this is the actionable row.\n");
    const legs = new Map();
    for (const r of rows) {
      const name = String(r.setup_name ?? "(unstamped)");
      const dir = String(r.direction ?? "").toLowerCase() || "long";
      const k = `${name}\u0000${dir}`;
      if (!legs.has(k)) legs.set(k, { name, dir, rows: [], path: r.entry_path ?? name });
      legs.get(k).rows.push(r);
    }
    const verdicts = [...legs.values()].map((leg) => {
      const s = stats(leg.rows);
      const key = demotionProposalConfigKey(leg.name, leg.dir);
      const marker = key ? markers[key] : null;
      const calibration = isCalibrationPlay(leg.path, leg.dir)
        || isCalibrationPlay(leg.name, leg.dir);
      let verdict = "ok";
      if (marker?.value === "blocked") verdict = "BLOCKED";
      else if (calibration) verdict = "CALIBRATION";
      else if (s.pnl < 0) verdict = "LOOK";
      return { ...leg, s, key, marker, verdict };
    }).sort((a, b) => a.s.pnl - b.s.pnl);

    for (const v of verdicts) {
      const play = resolveGovernancePlay(v.path, v.dir);
      console.log(
        `    ${v.verdict.padEnd(12)}${`${v.name} (${v.dir})`.padEnd(34)}`
        + `$${v.s.pnl.toFixed(2).padStart(9)}  over ${String(v.s.n).padStart(3)} closes`
        + (v.marker ? `   marker=${v.marker.value} by ${v.marker.updated_by}` : "   no marker")
        + (play ? `   play=${play.id}` : "   play=UNRESOLVED"),
      );
    }
    const look = verdicts.filter((v) => v.verdict === "LOOK");
    console.log(
      look.length
        ? `\n  ${look.length} unmarked losing leg(s) to review: `
          + look.map((v) => `${v.name} (${v.dir})`).join(", ")
        : "\n  No unmarked losing legs. Every bleeder already carries a marker.",
    );

    section("INERT-MARKER AUDIT — does each marker canonicalize onto itself?");
    const inert = inertMarkers(markers);
    if (!inert.length) {
      console.log("  Clean. Every marker is on a key checkSetupDemotion actually reads.");
    } else {
      console.log("  These markers are decoration — the runtime reads the canonical key:\n");
      for (const r of inert) {
        console.log(`    ${r.key}`);
        console.log(`      value=${r.value} by ${r.updated_by}`);
        console.log(`      runtime reads -> ${r.canonical}`);
      }
      console.log("\n  Fix the spelling or add the path to sibling_paths in play-catalog.js.");
    }
  }
}

// Guarded on the argument rather than on import.meta.url: vite-node resolves
// process.argv[1] relatively, so the usual direct-invocation check never
// matches there and the script silently prints nothing.
if (process.argv.includes("--trades")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
