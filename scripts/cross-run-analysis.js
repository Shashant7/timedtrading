#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ARTIFACTS = path.join(__dirname, '..', 'data', 'backtest-artifacts');

const RUNS = [
  { id: 'calibrated-v5', dir: 'calibrated-v5--20260315-213634', label: 'Calibrated V5 (best WR)' },
  { id: 'clean-launch-v1', dir: 'clean-launch-v1--20260315-101522', label: 'Clean Launch V1' },
  { id: 'exit-upgrade-v3', dir: 'exit-upgrade-v3--20260315-094435', label: 'Exit Upgrade V3' },
  { id: 'liq-sweep-tuned-v1', dir: 'liq-sweep-tuned-v1--20260317-191052', label: 'Liq Sweep Tuned V1' },
  { id: 'sizing-fix-v1', dir: 'sizing-fix-v1--20260314-123742', label: 'Sizing Fix V1' },
  { id: 'doa-gate-v2', dir: 'doa-gate-v2--20260318-101738', label: 'DOA Gate V2 (buggy — ref only)' },
  { id: 'holistic-final-v2', dir: 'holistic-final-v2--20260317-020124', label: 'Holistic Final V2' },
  { id: 'smart-exits-v1', dir: 'smart-exits-v1--20260317-021831', label: 'Smart Exits V1' },
  { id: 'calibrated-from-winners-v1', dir: 'calibrated-from-winners-v1--20260316-142623', label: 'Calibrated From Winners V1' },
];

function loadJson(dir, file) {
  const fp = path.join(ARTIFACTS, dir, file);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function ms2date(ms) {
  if (!ms) return null;
  const d = new Date(ms > 1e12 ? ms : ms * 1000);
  return d.toISOString().slice(0, 10);
}

function holdHours(entry, exit) {
  if (!entry || !exit) return null;
  const e = entry > 1e12 ? entry : entry * 1000;
  const x = exit > 1e12 ? exit : exit * 1000;
  return (x - e) / 3600000;
}

// ── Main ──
const allTrades = [];
const runSummaries = [];

for (const run of RUNS) {
  const ledger = loadJson(run.dir, 'ledger-trades.json');
  const acct = loadJson(run.dir, 'account-summary.json');
  if (!ledger) { console.log(`[SKIP] ${run.id}: no ledger-trades.json`); continue; }

  const trades = (ledger.trades || []).map(t => ({ ...t, _runId: run.id, _runLabel: run.label }));
  const closed = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS' || t.status === 'FLAT');
  const wins = closed.filter(t => t.status === 'WIN');
  const losses = closed.filter(t => t.status === 'LOSS');
  const trimmed = trades.filter(t => (t.trimmed_pct || 0) >= 0.01);
  const wr = closed.length ? (wins.length / closed.length * 100).toFixed(1) : 'N/A';
  const pnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'inf';
  const avgWin = wins.length ? (grossWin / wins.length).toFixed(2) : 0;
  const avgLoss = losses.length ? (grossLoss / losses.length).toFixed(2) : 0;

  runSummaries.push({
    id: run.id, label: run.label,
    total: trades.length, closed: closed.length, open: trades.length - closed.length,
    wins: wins.length, losses: losses.length, wr, pnl: pnl.toFixed(2), pf, avgWin, avgLoss,
    trimmed: trimmed.length,
    trimmedStillOpen: trimmed.filter(t => t.status === 'OPEN' || t.status === 'TP_HIT_TRIM').length
  });

  for (const t of trades) allTrades.push(t);
}

console.log('\n' + '═'.repeat(90));
console.log('  CROSS-RUN BACKTEST ANALYSIS');
console.log('═'.repeat(90));

// ── 1. Run Comparison Table ──
console.log('\n── 1. Run Comparison ──\n');
console.log('Run'.padEnd(28) + 'Trades'.padStart(7) + 'Closed'.padStart(8) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12) + '  PF'.padStart(7) + '  AvgWin'.padStart(9) + '  AvgLoss'.padStart(10));
console.log('-'.repeat(90));
for (const r of runSummaries) {
  console.log(
    r.id.padEnd(28) +
    String(r.total).padStart(7) +
    String(r.closed).padStart(8) +
    String(r.wr + '%').padStart(7) +
    String(r.pnl).padStart(12) +
    String(r.pf).padStart(7) +
    String('$' + r.avgWin).padStart(9) +
    String('$' + r.avgLoss).padStart(10)
  );
}

// ── 2. Exit Reason Analysis (across all non-buggy runs) ──
console.log('\n── 2. Exit Reason Analysis (excluding doa-gate-v2) ──\n');
const validTrades = allTrades.filter(t => t._runId !== 'doa-gate-v2' && (t.status === 'WIN' || t.status === 'LOSS'));
const exitMap = {};
for (const t of validTrades) {
  const reason = (t.exit_reason || 'unknown').split(',')[0];
  if (!exitMap[reason]) exitMap[reason] = { n: 0, w: 0, l: 0, pnl: 0 };
  exitMap[reason].n++;
  if (t.status === 'WIN') exitMap[reason].w++;
  else exitMap[reason].l++;
  exitMap[reason].pnl += t.pnl || 0;
}
const exitArr = Object.entries(exitMap).sort((a, b) => b[1].n - a[1].n);
console.log('Exit Reason'.padEnd(42) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12));
console.log('-'.repeat(80));
for (const [reason, d] of exitArr) {
  const wr = d.n ? (d.w / d.n * 100).toFixed(1) : '0';
  console.log(reason.padEnd(42) + String(d.n).padStart(5) + String(d.w).padStart(5) + String(d.l).padStart(5) + (wr + '%').padStart(7) + ('$' + d.pnl.toFixed(2)).padStart(12));
}

// ── 3. Ticker Analysis (across all non-buggy runs) ──
console.log('\n── 3. Ticker Performance (across all non-buggy runs, min 2 trades) ──\n');
const tickerMap = {};
for (const t of validTrades) {
  const tk = t.ticker;
  if (!tickerMap[tk]) tickerMap[tk] = { n: 0, w: 0, l: 0, pnl: 0, dirs: new Set() };
  tickerMap[tk].n++;
  if (t.status === 'WIN') tickerMap[tk].w++;
  else tickerMap[tk].l++;
  tickerMap[tk].pnl += t.pnl || 0;
  tickerMap[tk].dirs.add(t.direction);
}
const tickerArr = Object.entries(tickerMap).filter(([, d]) => d.n >= 2).sort((a, b) => b[1].pnl - a[1].pnl);
console.log('Ticker'.padEnd(10) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12) + '  Dir'.padStart(8));
console.log('-'.repeat(55));
for (const [tk, d] of tickerArr) {
  const wr = d.n ? (d.w / d.n * 100).toFixed(0) : '0';
  console.log(tk.padEnd(10) + String(d.n).padStart(5) + String(d.w).padStart(5) + String(d.l).padStart(5) + (wr + '%').padStart(7) + ('$' + d.pnl.toFixed(2)).padStart(12) + ('  ' + [...d.dirs].join('/')));
}

// ── 4. Direction Analysis ──
console.log('\n── 4. Direction Breakdown (non-buggy runs) ──\n');
for (const dir of ['LONG', 'SHORT']) {
  const dt = validTrades.filter(t => t.direction === dir);
  const w = dt.filter(t => t.status === 'WIN').length;
  const l = dt.filter(t => t.status === 'LOSS').length;
  const pnl = dt.reduce((s, t) => s + (t.pnl || 0), 0);
  console.log(`${dir}: ${dt.length} trades, ${w}W/${l}L (${dt.length ? (w / dt.length * 100).toFixed(1) : 0}%), PnL: $${pnl.toFixed(2)}`);
}

// ── 5. Rank Bucket Analysis ──
console.log('\n── 5. Rank Bucket Analysis (non-buggy runs) ──\n');
const rankBuckets = { '<60': [], '60-69': [], '70-79': [], '80+': [] };
for (const t of validTrades) {
  const r = t.rank || 0;
  if (r < 60) rankBuckets['<60'].push(t);
  else if (r < 70) rankBuckets['60-69'].push(t);
  else if (r < 80) rankBuckets['70-79'].push(t);
  else rankBuckets['80+'].push(t);
}
console.log('Rank'.padEnd(10) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12) + '  AvgPnL'.padStart(10));
console.log('-'.repeat(55));
for (const [bucket, trades] of Object.entries(rankBuckets)) {
  const w = trades.filter(t => t.status === 'WIN').length;
  const l = trades.filter(t => t.status === 'LOSS').length;
  const pnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avg = trades.length ? pnl / trades.length : 0;
  const wr = trades.length ? (w / trades.length * 100).toFixed(1) : '0';
  console.log(bucket.padEnd(10) + String(trades.length).padStart(5) + String(w).padStart(5) + String(l).padStart(5) + (wr + '%').padStart(7) + ('$' + pnl.toFixed(2)).padStart(12) + ('$' + avg.toFixed(2)).padStart(10));
}

// ── 6. Hold Time Analysis ──
console.log('\n── 6. Hold Time Analysis (closed trades, non-buggy) ──\n');
const holdWins = [], holdLosses = [];
for (const t of validTrades) {
  const h = holdHours(t.entry_ts, t.exit_ts);
  if (h == null || h < 0) continue;
  if (t.status === 'WIN') holdWins.push(h);
  else holdLosses.push(h);
}
holdWins.sort((a, b) => a - b);
holdLosses.sort((a, b) => a - b);
const p50 = arr => arr.length ? arr[Math.floor(arr.length * 0.5)] : 0;
const p25 = arr => arr.length ? arr[Math.floor(arr.length * 0.25)] : 0;
const p75 = arr => arr.length ? arr[Math.floor(arr.length * 0.75)] : 0;
console.log(`Winners (n=${holdWins.length}): p25=${p25(holdWins).toFixed(1)}h, median=${p50(holdWins).toFixed(1)}h, p75=${p75(holdWins).toFixed(1)}h`);
console.log(`Losers  (n=${holdLosses.length}): p25=${p25(holdLosses).toFixed(1)}h, median=${p50(holdLosses).toFixed(1)}h, p75=${p75(holdLosses).toFixed(1)}h`);

// ── 7. Trimmed Trade Outcomes ──
console.log('\n── 7. Trimmed Trade Analysis (non-buggy runs) ──\n');
const trimmedClosed = validTrades.filter(t => (t.trimmed_pct || 0) >= 0.01);
const untrimmedClosed = validTrades.filter(t => (t.trimmed_pct || 0) < 0.01);
for (const [label, group] of [['Trimmed', trimmedClosed], ['Untrimmed', untrimmedClosed]]) {
  const w = group.filter(t => t.status === 'WIN').length;
  const l = group.filter(t => t.status === 'LOSS').length;
  const pnl = group.reduce((s, t) => s + (t.pnl || 0), 0);
  const wr = group.length ? (w / group.length * 100).toFixed(1) : '0';
  const avg = group.length ? (pnl / group.length).toFixed(2) : '0';
  console.log(`${label.padEnd(12)}: ${group.length} trades, ${w}W/${l}L (${wr}%), PnL: $${pnl.toFixed(2)}, AvgPnL: $${avg}`);
}

// ── 8. Setup Grade Analysis ──
console.log('\n── 8. Setup Grade Analysis (non-buggy runs) ──\n');
const gradeMap = {};
for (const t of validTrades) {
  const g = t.setup_grade || 'unknown';
  if (!gradeMap[g]) gradeMap[g] = { n: 0, w: 0, l: 0, pnl: 0 };
  gradeMap[g].n++;
  if (t.status === 'WIN') gradeMap[g].w++;
  else gradeMap[g].l++;
  gradeMap[g].pnl += t.pnl || 0;
}
console.log('Grade'.padEnd(15) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12));
console.log('-'.repeat(50));
for (const [g, d] of Object.entries(gradeMap).sort((a, b) => b[1].pnl - a[1].pnl)) {
  const wr = d.n ? (d.w / d.n * 100).toFixed(1) : '0';
  console.log(g.padEnd(15) + String(d.n).padStart(5) + String(d.w).padStart(5) + String(d.l).padStart(5) + (wr + '%').padStart(7) + ('$' + d.pnl.toFixed(2)).padStart(12));
}

// ── 9. Worst Losses Deep Dive ──
console.log('\n── 9. Worst 15 Losses (non-buggy runs) ──\n');
const losses = validTrades.filter(t => t.status === 'LOSS').sort((a, b) => a.pnl - b.pnl).slice(0, 15);
console.log('Ticker'.padEnd(8) + 'Run'.padEnd(22) + 'Dir'.padEnd(7) + 'Entry$'.padStart(9) + '  Exit$'.padStart(9) + '  PnL($)'.padStart(10) + '  PnL%'.padStart(8) + '  Hold(h)'.padStart(10) + '  Exit Reason'.padStart(10));
console.log('-'.repeat(110));
for (const t of losses) {
  const h = holdHours(t.entry_ts, t.exit_ts);
  console.log(
    (t.ticker || '').padEnd(8) +
    t._runId.padEnd(22) +
    (t.direction || '').padEnd(7) +
    ('$' + (t.entry_price || 0).toFixed(2)).padStart(9) +
    ('$' + (t.exit_price || 0).toFixed(2)).padStart(9) +
    ('$' + (t.pnl || 0).toFixed(2)).padStart(10) +
    ((t.pnl_pct || 0).toFixed(2) + '%').padStart(8) +
    (h != null ? h.toFixed(1) + 'h' : 'N/A').padStart(10) +
    '  ' + (t.exit_reason || 'unknown').slice(0, 40)
  );
}

// ── 10. Best 15 Winners ──
console.log('\n── 10. Best 15 Winners (non-buggy runs) ──\n');
const topWins = validTrades.filter(t => t.status === 'WIN').sort((a, b) => b.pnl - a.pnl).slice(0, 15);
console.log('Ticker'.padEnd(8) + 'Run'.padEnd(22) + 'Dir'.padEnd(7) + 'Entry$'.padStart(9) + '  Exit$'.padStart(9) + '  PnL($)'.padStart(10) + '  PnL%'.padStart(8) + '  Hold(h)'.padStart(10) + '  Trimmed'.padStart(8) + '  Exit Reason');
console.log('-'.repeat(120));
for (const t of topWins) {
  const h = holdHours(t.entry_ts, t.exit_ts);
  console.log(
    (t.ticker || '').padEnd(8) +
    t._runId.padEnd(22) +
    (t.direction || '').padEnd(7) +
    ('$' + (t.entry_price || 0).toFixed(2)).padStart(9) +
    ('$' + (t.exit_price || 0).toFixed(2)).padStart(9) +
    ('$' + (t.pnl || 0).toFixed(2)).padStart(10) +
    ((t.pnl_pct || 0).toFixed(2) + '%').padStart(8) +
    (h != null ? h.toFixed(1) + 'h' : 'N/A').padStart(10) +
    ('  ' + ((t.trimmed_pct || 0) * 100).toFixed(0) + '%').padStart(6) +
    '  ' + (t.exit_reason || 'unknown').slice(0, 40)
  );
}

// ── 11. Entry Time-of-Day Analysis ──
console.log('\n── 11. Entry Time-of-Day (ET) Distribution ──\n');
const hourBuckets = {};
for (const t of validTrades) {
  if (!t.entry_ts) continue;
  const ms = t.entry_ts > 1e12 ? t.entry_ts : t.entry_ts * 1000;
  const d = new Date(ms);
  const etHour = (d.getUTCHours() - 4 + 24) % 24;
  const label = `${String(etHour).padStart(2, '0')}:00`;
  if (!hourBuckets[label]) hourBuckets[label] = { n: 0, w: 0, l: 0, pnl: 0 };
  hourBuckets[label].n++;
  if (t.status === 'WIN') hourBuckets[label].w++;
  else hourBuckets[label].l++;
  hourBuckets[label].pnl += t.pnl || 0;
}
console.log('Hour(ET)'.padEnd(10) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12));
console.log('-'.repeat(45));
for (const hr of Object.keys(hourBuckets).sort()) {
  const d = hourBuckets[hr];
  const wr = d.n ? (d.w / d.n * 100).toFixed(0) : '0';
  console.log(hr.padEnd(10) + String(d.n).padStart(5) + String(d.w).padStart(5) + String(d.l).padStart(5) + (wr + '%').padStart(7) + ('$' + d.pnl.toFixed(2)).padStart(12));
}

// ── 12. doa-gate-v2 specific: Known-rank trades vs Unknown-rank (bug impact) ──
console.log('\n── 12. DOA-Gate-V2 Bug Impact: Known-Rank vs Unknown-Rank ──\n');
const doa = allTrades.filter(t => t._runId === 'doa-gate-v2' && (t.status === 'WIN' || t.status === 'LOSS'));
const doaKnown = doa.filter(t => t.rank > 0 && t.rank !== undefined);
const doaUnknown = doa.filter(t => !t.rank || t.rank === 0);
for (const [label, group] of [['Known rank (valid)', doaKnown], ['Unknown rank (bug)', doaUnknown]]) {
  const w = group.filter(t => t.status === 'WIN').length;
  const l = group.filter(t => t.status === 'LOSS').length;
  const pnl = group.reduce((s, t) => s + (t.pnl || 0), 0);
  const wr = group.length ? (w / group.length * 100).toFixed(1) : '0';
  console.log(`${label.padEnd(24)}: ${group.length} trades, ${w}W/${l}L (${wr}%), PnL: $${pnl.toFixed(2)}`);
}

// ── 13. Monthly PnL (valid runs only) ──
console.log('\n── 13. Monthly PnL by Entry Date (non-buggy runs) ──\n');
const monthMap = {};
for (const t of validTrades) {
  const dt = ms2date(t.entry_ts);
  if (!dt) continue;
  const month = dt.slice(0, 7);
  if (!monthMap[month]) monthMap[month] = { n: 0, w: 0, l: 0, pnl: 0 };
  monthMap[month].n++;
  if (t.status === 'WIN') monthMap[month].w++;
  else monthMap[month].l++;
  monthMap[month].pnl += t.pnl || 0;
}
console.log('Month'.padEnd(10) + 'N'.padStart(5) + '  W'.padStart(5) + '  L'.padStart(5) + '  WR%'.padStart(7) + '  PnL($)'.padStart(12));
console.log('-'.repeat(45));
for (const m of Object.keys(monthMap).sort()) {
  const d = monthMap[m];
  const wr = d.n ? (d.w / d.n * 100).toFixed(0) : '0';
  console.log(m.padEnd(10) + String(d.n).padStart(5) + String(d.w).padStart(5) + String(d.l).padStart(5) + (wr + '%').padStart(7) + ('$' + d.pnl.toFixed(2)).padStart(12));
}

console.log('\n' + '═'.repeat(90));
console.log('  END OF CROSS-RUN ANALYSIS');
console.log('═'.repeat(90) + '\n');
