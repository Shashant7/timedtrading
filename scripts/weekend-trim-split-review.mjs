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
 *   npx vite-node scripts/weekend-trim-split-review.mjs --trades /tmp/book90.json
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function extractRows(raw) {
  const start = raw.indexOf("[");
  if (start < 0) throw new Error("no JSON array in input");
  const parsed = JSON.parse(raw.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first ?? [];
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
  console.log("  Compare against the live markers:");
  console.log("    wrangler d1 execute --env production --remote timed-trading-ledger \\");
  console.log("      --command \"SELECT config_key, config_value, updated_by FROM model_config\\");
  console.log("        WHERE config_key LIKE 'deep_audit_setup_demotion%';\"");
  console.log("\n  A family losing money with no marker needs a look. A family with a");
  console.log("  marker is already handled — do not re-propose it. And a CALIBRATION");
  console.log("  family (Cloud Pivot) is deliberately left allowed: see");
  console.log("  skills/learning-loops.md before acting on its PF.");
  for (const [name, rs] of [...byFamily].sort((a, b) => stats(a[1]).pnl - stats(b[1]).pnl)) {
    const s = stats(rs);
    console.log(`    ${name.padEnd(28)}$${s.pnl.toFixed(2).padStart(9)}  over ${String(s.n).padStart(3)} closes`);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === (await import("node:url")).pathToFileURL(
    (await import("node:path")).resolve(process.argv[1]),
  ).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
