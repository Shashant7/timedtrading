/**
 * Historical Big Movers Analysis - Full Dataset
 * 
 * Analyzes ALL available trail data to:
 * 1. Identify peak-to-trough moves for each ticker (both directions)
 * 2. Capture the COMPLETE signal sequence before each major move
 * 3. Build a per-ticker reference database for entry/exit decisions
 * 4. Derive cross-ticker "gold standard" patterns
 * 
 * Output:
 *   - docs/historical-movers/[TICKER].json - Per-ticker analysis
 *   - docs/HISTORICAL_MOVERS_SUMMARY.md - Cross-ticker patterns
 *   - docs/HISTORICAL_MOVERS_DATA.json - Full dataset for programmatic use
 * 
 * Usage:
 *   node scripts/analyze-historical-movers.js
 *   node scripts/analyze-historical-movers.js --minMove 5 --top 100
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const MIN_MOVE_PCT = Number(argValue("--minMove", "3")); // minimum % move
const TOP_MOVES_PER_TICKER = Number(argValue("--perTicker", "5")); // top N moves per ticker
const TOP_GLOBAL = Number(argValue("--top", "100")); // top N moves globally
const LOOKBACK_POINTS = Number(argValue("--lookback", "50")); // signal points before move

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtPct(n, d = 1) { return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—"; }
function fmtNum(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }
function fmtTs(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) : "—"; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor(p / 100 * s.length), s.length - 1)];
}

function normalizeFlags(f) {
  if (!f) return {};
  if (typeof f === "object") return f;
  try { return JSON.parse(f); } catch { return {}; }
}

function flagOn(flags, key) {
  const v = normalizeFlags(flags)?.[key];
  return v === true || v === "true" || v === 1;
}

// Find all significant moves in a ticker's trail
function findMoves(points, minPct) {
  const moves = [];
  const n = points.length;
  if (n < 10) return moves;

  // Sliding window approach to find local maxima/minima moves
  for (let i = 0; i < n - 1; i++) {
    const start = points[i];
    
    // Track max up and max down from this starting point
    let maxUp = 0, maxUpIdx = i;
    let maxDown = 0, maxDownIdx = i;
    
    for (let j = i + 1; j < n; j++) {
      const end = points[j];
      const pctChange = (end.price - start.price) / start.price;
      
      if (pctChange > maxUp) { maxUp = pctChange; maxUpIdx = j; }
      if (pctChange < maxDown) { maxDown = pctChange; maxDownIdx = j; }
      
      // If we've seen significant reversal, stop extending this move
      if (maxUp > minPct && pctChange < maxUp * 0.5) break;
      if (maxDown < -minPct && pctChange > maxDown * 0.5) break;
    }

    if (maxUp >= minPct) {
      moves.push({
        direction: "UP",
        startIdx: i,
        endIdx: maxUpIdx,
        startTs: start.ts,
        endTs: points[maxUpIdx].ts,
        startPrice: start.price,
        endPrice: points[maxUpIdx].price,
        movePct: maxUp * 100,
        duration: (points[maxUpIdx].ts - start.ts) / 60000, // minutes
      });
    }
    
    if (maxDown <= -minPct) {
      moves.push({
        direction: "DOWN",
        startIdx: i,
        endIdx: maxDownIdx,
        startTs: start.ts,
        endTs: points[maxDownIdx].ts,
        startPrice: start.price,
        endPrice: points[maxDownIdx].price,
        movePct: maxDown * 100,
        duration: (points[maxDownIdx].ts - start.ts) / 60000,
      });
    }
  }

  // Deduplicate overlapping moves - keep the biggest
  moves.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  const kept = [];
  const usedRanges = [];
  
  for (const m of moves) {
    const overlaps = usedRanges.some(r => 
      (m.startIdx >= r.start && m.startIdx <= r.end) ||
      (m.endIdx >= r.start && m.endIdx <= r.end)
    );
    if (!overlaps) {
      kept.push(m);
      usedRanges.push({ start: m.startIdx, end: m.endIdx });
    }
  }

  return kept;
}

// Extract detailed signal sequence before a move
function extractSignalSequence(points, move, lookbackCount) {
  const startIdx = move.startIdx;
  const lookbackStart = Math.max(0, startIdx - lookbackCount);
  
  const sequence = [];
  let prevState = null;
  let prevFlags = {};
  
  for (let i = lookbackStart; i <= startIdx; i++) {
    const p = points[i];
    const flags = normalizeFlags(p.flags);
    
    // Detect state transitions
    const stateChanged = prevState && prevState !== p.state;
    
    // Detect flag changes (new flags turning on)
    const newFlags = [];
    const importantFlags = [
      "sq30_on", "sq30_release", "sq10_release", "sq3_release",
      "phase_dot", "phase_zone_change", "momentum_elite",
      "ema_cross_1h_13_48", "ema_cross_10m_13_48", "ema_cross_3m_13_48",
      "st_flip_1h", "st_flip_30m", "st_flip_10m", "st_flip_3m",
      "buyable_dip_1h_13_48", "htf_improving_4h", "htf_improving_1d",
      "htf_move_4h_ge_5", "thesis_match", "flip_watch",
      "move_invalidated", "move_completed"
    ];
    
    for (const f of importantFlags) {
      if (flagOn(flags, f) && !flagOn(prevFlags, f)) {
        newFlags.push(f);
      }
    }
    
    sequence.push({
      ts: p.ts,
      time: fmtTs(p.ts),
      price: p.price,
      htf: p.htf,
      ltf: p.ltf,
      state: p.state,
      stateChanged,
      prevState: stateChanged ? prevState : null,
      rank: p.rank,
      completion: p.completion,
      phase: p.phase,
      rr: p.rr,
      trigger_reason: p.trigger_reason,
      newFlags,
      activeFlags: importantFlags.filter(f => flagOn(flags, f)),
      isStart: i === startIdx,
    });
    
    prevState = p.state;
    prevFlags = flags;
  }
  
  return sequence;
}

// Analyze a single ticker
async function analyzeTicker(ticker) {
  try {
    // Fetch ALL trail data (no date filter)
    const resp = await fetchJson(`${API_BASE}/timed/trail?ticker=${ticker}&limit=10000`);
    const trail = Array.isArray(resp?.trail) ? resp.trail : [];
    
    if (trail.length < 20) return null;
    
    // Normalize points
    const points = trail
      .map(p => ({
        ts: Number(p.ts || p.timestamp),
        price: Number(p.price),
        htf: Number(p.htf_score),
        ltf: Number(p.ltf_score),
        state: p.state,
        rank: Number(p.rank),
        completion: Number(p.completion),
        phase: Number(p.phase_pct),
        rr: Number(p.rr),
        flags: p.flags || p.flags_json,
        trigger_reason: p.trigger_reason,
      }))
      .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.ts - b.ts);
    
    if (points.length < 20) return null;
    
    // Find all significant moves
    const allMoves = findMoves(points, MIN_MOVE_PCT / 100);
    
    // Keep top moves per direction
    const upMoves = allMoves.filter(m => m.direction === "UP")
      .sort((a, b) => b.movePct - a.movePct)
      .slice(0, TOP_MOVES_PER_TICKER);
    
    const downMoves = allMoves.filter(m => m.direction === "DOWN")
      .sort((a, b) => a.movePct - b.movePct)
      .slice(0, TOP_MOVES_PER_TICKER);
    
    const topMoves = [...upMoves, ...downMoves].sort((a, b) => 
      Math.abs(b.movePct) - Math.abs(a.movePct)
    );
    
    // Extract signal sequences for each move
    const movesWithSequences = topMoves.map(m => ({
      ...m,
      signalSequence: extractSignalSequence(points, m, LOOKBACK_POINTS),
      atStart: points[m.startIdx],
    }));
    
    // Compute ticker statistics
    const dataRange = {
      firstTs: points[0].ts,
      lastTs: points[points.length - 1].ts,
      firstDate: fmtTs(points[0].ts).slice(0, 10),
      lastDate: fmtTs(points[points.length - 1].ts).slice(0, 10),
      totalPoints: points.length,
      daysCovered: Math.round((points[points.length - 1].ts - points[0].ts) / (24 * 60 * 60 * 1000)),
    };
    
    return {
      ticker,
      dataRange,
      movesFound: allMoves.length,
      topMoves: movesWithSequences,
      biggestUp: upMoves[0] || null,
      biggestDown: downMoves[0] || null,
    };
  } catch (e) {
    return null;
  }
}

// Derive patterns across all tickers
function derivePatterns(allTickerData) {
  const upMoves = [];
  const downMoves = [];
  
  for (const td of allTickerData) {
    if (!td?.topMoves) continue;
    for (const m of td.topMoves) {
      if (m.direction === "UP") upMoves.push({ ticker: td.ticker, ...m });
      else downMoves.push({ ticker: td.ticker, ...m });
    }
  }
  
  // Sort by move magnitude
  upMoves.sort((a, b) => b.movePct - a.movePct);
  downMoves.sort((a, b) => a.movePct - b.movePct);
  
  function analyzeGroup(moves, label) {
    if (!moves.length) return { label, count: 0 };
    
    // At-start statistics
    const htfs = moves.map(m => m.atStart?.htf).filter(Number.isFinite);
    const ltfs = moves.map(m => m.atStart?.ltf).filter(Number.isFinite);
    const ranks = moves.map(m => m.atStart?.rank).filter(Number.isFinite);
    const completions = moves.map(m => m.atStart?.completion).filter(Number.isFinite);
    const phases = moves.map(m => m.atStart?.phase).filter(Number.isFinite);
    const durations = moves.map(m => m.duration).filter(Number.isFinite);
    const movePcts = moves.map(m => Math.abs(m.movePct));
    
    // State distribution at start
    const states = {};
    for (const m of moves) {
      const st = m.atStart?.state || "UNKNOWN";
      states[st] = (states[st] || 0) + 1;
    }
    
    // Pre-move signal patterns
    const patterns = {
      stateTransition: 0,        // State changed in lookback
      squeezeRelease: 0,         // sq30_release in lookback
      squeezeOn: 0,              // sq30_on in lookback
      emaCross: 0,               // Any EMA cross
      stFlip: 0,                 // Any ST flip
      htfImproving: 0,           // HTF improving flag
      flipWatch: 0,              // flip_watch flag
      momentumElite: 0,          // momentum_elite flag
      ltfPullback: 0,            // LTF in pullback direction
    };
    
    for (const m of moves) {
      const seq = m.signalSequence || [];
      const flags = seq.flatMap(s => s.newFlags || []);
      const activeAtStart = seq[seq.length - 1]?.activeFlags || [];
      
      if (seq.some(s => s.stateChanged)) patterns.stateTransition++;
      if (flags.includes("sq30_release")) patterns.squeezeRelease++;
      if (flags.includes("sq30_on") || activeAtStart.includes("sq30_on")) patterns.squeezeOn++;
      if (flags.some(f => f.includes("ema_cross"))) patterns.emaCross++;
      if (flags.some(f => f.includes("st_flip"))) patterns.stFlip++;
      if (flags.includes("htf_improving_4h") || flags.includes("htf_improving_1d")) patterns.htfImproving++;
      if (flags.includes("flip_watch") || activeAtStart.includes("flip_watch")) patterns.flipWatch++;
      if (flags.includes("momentum_elite") || activeAtStart.includes("momentum_elite")) patterns.momentumElite++;
      
      // LTF pullback check
      const lastLtf = m.atStart?.ltf;
      if (m.direction === "UP" && lastLtf < 0) patterns.ltfPullback++;
      if (m.direction === "DOWN" && lastLtf > 0) patterns.ltfPullback++;
    }
    
    // Trigger reason distribution
    const triggers = {};
    for (const m of moves) {
      const seq = m.signalSequence || [];
      for (const s of seq.slice(-5)) { // Last 5 points
        const tr = s.trigger_reason;
        if (tr) triggers[tr] = (triggers[tr] || 0) + 1;
      }
    }
    
    // Common state transitions
    const transitions = {};
    for (const m of moves) {
      const seq = m.signalSequence || [];
      for (const s of seq) {
        if (s.stateChanged && s.prevState) {
          const key = `${s.prevState} → ${s.state}`;
          transitions[key] = (transitions[key] || 0) + 1;
        }
      }
    }
    
    return {
      label,
      count: moves.length,
      stats: {
        avgMove: movePcts.reduce((a, b) => a + b, 0) / movePcts.length,
        medianMove: median(movePcts),
        p90Move: percentile(movePcts, 90),
        avgDuration: median(durations),
        avgHtf: htfs.length ? htfs.reduce((a, b) => a + b, 0) / htfs.length : null,
        medianHtf: median(htfs),
        avgLtf: ltfs.length ? ltfs.reduce((a, b) => a + b, 0) / ltfs.length : null,
        medianLtf: median(ltfs),
        avgRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
        avgCompletion: completions.length ? completions.reduce((a, b) => a + b, 0) / completions.length : null,
        avgPhase: phases.length ? phases.reduce((a, b) => a + b, 0) / phases.length : null,
      },
      stateDistribution: Object.entries(states)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((o, [k, v]) => ({ ...o, [k]: { count: v, pct: v / moves.length } }), {}),
      signalPatterns: Object.entries(patterns)
        .map(([k, v]) => ({ signal: k, count: v, pct: v / moves.length }))
        .sort((a, b) => b.pct - a.pct),
      triggerDistribution: Object.entries(triggers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((o, [k, v]) => ({ ...o, [k]: v }), {}),
      commonTransitions: Object.entries(transitions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((o, [k, v]) => ({ ...o, [k]: v }), {}),
      topMoves: moves.slice(0, 20).map(m => ({
        ticker: m.ticker,
        movePct: m.movePct,
        duration: m.duration,
        startTime: fmtTs(m.startTs),
        state: m.atStart?.state,
        htf: m.atStart?.htf,
        ltf: m.atStart?.ltf,
      })),
    };
  }
  
  return {
    upMoves: analyzeGroup(upMoves, "UP Moves"),
    downMoves: analyzeGroup(downMoves, "DOWN Moves"),
    globalTop: [...upMoves, ...downMoves]
      .sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))
      .slice(0, TOP_GLOBAL),
  };
}

function generateMarkdown(analysis, tickerData) {
  const lines = [];
  const { upMoves: up, downMoves: down, globalTop } = analysis;

  lines.push(`# Historical Big Movers Analysis`);
  lines.push(``);
  lines.push(`**Purpose:** Identify the biggest price moves across ALL historical data and analyze the signals that preceded them.`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Criteria: Moves ≥${MIN_MOVE_PCT}%, Top ${TOP_MOVES_PER_TICKER} per ticker, ${LOOKBACK_POINTS} signal points lookback`);
  lines.push(``);

  // Data coverage
  const allRanges = tickerData.filter(t => t?.dataRange).map(t => t.dataRange);
  const earliestDate = allRanges.length ? allRanges.reduce((m, r) => r.firstDate < m ? r.firstDate : m, "9999") : "—";
  const latestDate = allRanges.length ? allRanges.reduce((m, r) => r.lastDate > m ? r.lastDate : m, "0000") : "—";
  const totalPoints = allRanges.reduce((s, r) => s + r.totalPoints, 0);
  
  lines.push(`## Data Coverage`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Tickers analyzed | ${tickerData.filter(t => t).length} |`);
  lines.push(`| Date range | ${earliestDate} → ${latestDate} |`);
  lines.push(`| Total data points | ${totalPoints.toLocaleString()} |`);
  lines.push(`| UP moves found | ${up.count} |`);
  lines.push(`| DOWN moves found | ${down.count} |`);
  lines.push(``);

  // UP Moves
  lines.push(`## 📈 UP Moves Analysis (${up.count} moves)`);
  lines.push(``);
  
  lines.push(`### Statistics at Move Start`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Avg move | +${fmtNum(up.stats.avgMove)}% |`);
  lines.push(`| Median move | +${fmtNum(up.stats.medianMove)}% |`);
  lines.push(`| P90 move | +${fmtNum(up.stats.p90Move)}% |`);
  lines.push(`| Median duration | ${fmtNum(up.stats.avgDuration, 0)} min |`);
  lines.push(`| Avg HTF | ${fmtNum(up.stats.avgHtf, 1)} |`);
  lines.push(`| Median HTF | ${fmtNum(up.stats.medianHtf, 1)} |`);
  lines.push(`| Avg LTF | ${fmtNum(up.stats.avgLtf, 1)} |`);
  lines.push(`| Median LTF | ${fmtNum(up.stats.medianLtf, 1)} |`);
  lines.push(`| Avg Rank | ${fmtNum(up.stats.avgRank, 0)} |`);
  lines.push(`| Avg Completion | ${fmtPct(up.stats.avgCompletion)} |`);
  lines.push(`| Avg Phase | ${fmtPct(up.stats.avgPhase)} |`);
  lines.push(``);

  lines.push(`### State Distribution at Move Start`);
  lines.push(``);
  lines.push(`| State | Count | % |`);
  lines.push(`|:--|--:|--:|`);
  for (const [state, data] of Object.entries(up.stateDistribution)) {
    lines.push(`| ${state} | ${data.count} | ${fmtPct(data.pct)} |`);
  }
  lines.push(``);

  lines.push(`### Pre-Move Signal Patterns`);
  lines.push(``);
  lines.push(`| Signal | Count | % | Interpretation |`);
  lines.push(`|:--|--:|--:|:--|`);
  const signalDesc = {
    stateTransition: "State changed before move",
    squeezeRelease: "Squeeze released (volatility expansion)",
    squeezeOn: "Squeeze active (coiling)",
    emaCross: "EMA crossover signal",
    stFlip: "Supertrend flip",
    htfImproving: "HTF momentum improving",
    flipWatch: "Flip watch active",
    momentumElite: "Momentum elite condition",
    ltfPullback: "LTF in pullback (setup)",
  };
  for (const p of up.signalPatterns) {
    lines.push(`| ${p.signal} | ${p.count} | ${fmtPct(p.pct)} | ${signalDesc[p.signal] || "—"} |`);
  }
  lines.push(``);

  if (Object.keys(up.commonTransitions).length > 0) {
    lines.push(`### Common State Transitions Before UP Moves`);
    lines.push(``);
    lines.push(`| Transition | Count |`);
    lines.push(`|:--|--:|`);
    for (const [trans, count] of Object.entries(up.commonTransitions)) {
      lines.push(`| ${trans} | ${count} |`);
    }
    lines.push(``);
  }

  lines.push(`### Top 10 UP Moves`);
  lines.push(``);
  lines.push(`| # | Ticker | Move | Duration | Time | State | HTF | LTF |`);
  lines.push(`|--:|:--|--:|--:|:--|:--|--:|--:|`);
  for (let i = 0; i < Math.min(10, up.topMoves.length); i++) {
    const m = up.topMoves[i];
    lines.push(`| ${i + 1} | ${m.ticker} | +${fmtNum(m.movePct)}% | ${fmtNum(m.duration, 0)}m | ${m.startTime.slice(5, 16)} | ${m.state?.replace("HTF_", "").replace("LTF_", "") || "—"} | ${fmtNum(m.htf, 0)} | ${fmtNum(m.ltf, 0)} |`);
  }
  lines.push(``);

  // DOWN Moves (similar structure)
  lines.push(`## 📉 DOWN Moves Analysis (${down.count} moves)`);
  lines.push(``);
  
  lines.push(`### Statistics at Move Start`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Avg move | ${fmtNum(down.stats.avgMove)}% |`);
  lines.push(`| Median move | ${fmtNum(down.stats.medianMove)}% |`);
  lines.push(`| Median duration | ${fmtNum(down.stats.avgDuration, 0)} min |`);
  lines.push(`| Avg HTF | ${fmtNum(down.stats.avgHtf, 1)} |`);
  lines.push(`| Median HTF | ${fmtNum(down.stats.medianHtf, 1)} |`);
  lines.push(`| Avg LTF | ${fmtNum(down.stats.avgLtf, 1)} |`);
  lines.push(`| Median LTF | ${fmtNum(down.stats.medianLtf, 1)} |`);
  lines.push(``);

  lines.push(`### State Distribution at Move Start`);
  lines.push(``);
  lines.push(`| State | Count | % |`);
  lines.push(`|:--|--:|--:|`);
  for (const [state, data] of Object.entries(down.stateDistribution)) {
    lines.push(`| ${state} | ${data.count} | ${fmtPct(data.pct)} |`);
  }
  lines.push(``);

  lines.push(`### Pre-Move Signal Patterns`);
  lines.push(``);
  lines.push(`| Signal | Count | % |`);
  lines.push(`|:--|--:|--:|`);
  for (const p of down.signalPatterns) {
    lines.push(`| ${p.signal} | ${p.count} | ${fmtPct(p.pct)} |`);
  }
  lines.push(``);

  lines.push(`### Top 10 DOWN Moves`);
  lines.push(``);
  lines.push(`| # | Ticker | Move | Duration | Time | State | HTF | LTF |`);
  lines.push(`|--:|:--|--:|--:|:--|:--|--:|--:|`);
  for (let i = 0; i < Math.min(10, down.topMoves.length); i++) {
    const m = down.topMoves[i];
    lines.push(`| ${i + 1} | ${m.ticker} | ${fmtNum(m.movePct)}% | ${fmtNum(m.duration, 0)}m | ${m.startTime.slice(5, 16)} | ${m.state?.replace("HTF_", "").replace("LTF_", "") || "—"} | ${fmtNum(m.htf, 0)} | ${fmtNum(m.ltf, 0)} |`);
  }
  lines.push(``);

  // Derived Gold Standard Criteria
  lines.push(`## 🎯 Derived Gold Standard Entry Criteria`);
  lines.push(``);
  lines.push(`Based on analysis of ${up.count + down.count} significant moves:`);
  lines.push(``);

  lines.push(`### For LONG Entries:`);
  lines.push(``);
  const longCriteria = [];
  if (up.stats.medianHtf > 5) longCriteria.push(`HTF > ${Math.round(up.stats.medianHtf * 0.5)} (median at start: ${fmtNum(up.stats.medianHtf, 0)})`);
  if (up.stats.medianLtf < 5) longCriteria.push(`LTF in pullback (< 5) — median: ${fmtNum(up.stats.medianLtf, 0)}`);
  
  const ltfPullbackPct = up.signalPatterns.find(p => p.signal === "ltfPullback")?.pct || 0;
  if (ltfPullbackPct > 0.3) longCriteria.push(`LTF pullback setup (${fmtPct(ltfPullbackPct)} of winners)`);
  
  const sqRelPct = up.signalPatterns.find(p => p.signal === "squeezeRelease")?.pct || 0;
  if (sqRelPct > 0.1) longCriteria.push(`Squeeze release in lookback (${fmtPct(sqRelPct)} of winners)`);
  
  const transitionPct = up.signalPatterns.find(p => p.signal === "stateTransition")?.pct || 0;
  if (transitionPct > 0.2) longCriteria.push(`State transition in lookback (${fmtPct(transitionPct)} of winners)`);
  
  for (const c of longCriteria) lines.push(`- ${c}`);
  
  // Most common starting state for longs
  const topUpState = Object.entries(up.stateDistribution)[0];
  if (topUpState) lines.push(`- Most common state: **${topUpState[0]}** (${fmtPct(topUpState[1].pct)})`);
  lines.push(``);

  lines.push(`### For SHORT Entries:`);
  lines.push(``);
  const shortCriteria = [];
  if (down.stats.medianHtf < -5) shortCriteria.push(`HTF < ${Math.round(down.stats.medianHtf * 0.5)} (median at start: ${fmtNum(down.stats.medianHtf, 0)})`);
  if (down.stats.medianLtf > -5) shortCriteria.push(`LTF in pullback (> -5) — median: ${fmtNum(down.stats.medianLtf, 0)}`);
  
  const ltfPullbackPctD = down.signalPatterns.find(p => p.signal === "ltfPullback")?.pct || 0;
  if (ltfPullbackPctD > 0.3) shortCriteria.push(`LTF pullback setup (${fmtPct(ltfPullbackPctD)} of winners)`);
  
  for (const c of shortCriteria) lines.push(`- ${c}`);
  
  const topDownState = Object.entries(down.stateDistribution)[0];
  if (topDownState) lines.push(`- Most common state: **${topDownState[0]}** (${fmtPct(topDownState[1].pct)})`);
  lines.push(``);

  lines.push(`## Per-Ticker Analysis Files`);
  lines.push(``);
  lines.push(`Individual ticker analysis saved to \`docs/historical-movers/[TICKER].json\``);
  lines.push(``);
  lines.push(`Use these files for:`);
  lines.push(`- Reviewing signal sequences for specific tickers`);
  lines.push(`- Building ticker-specific entry criteria`);
  lines.push(`- Backtesting against historical moves`);
  lines.push(``);

  return lines.join("\n");
}

async function main() {
  console.log("[historical-movers] Starting comprehensive analysis...");
  console.log(`[historical-movers] Config: minMove=${MIN_MOVE_PCT}%, perTicker=${TOP_MOVES_PER_TICKER}, lookback=${LOOKBACK_POINTS} points`);

  // Get all tickers
  const tickersResp = await fetchJson(`${API_BASE}/timed/tickers`);
  const tickers = Array.isArray(tickersResp?.tickers) ? tickersResp.tickers : [];
  console.log(`[historical-movers] Found ${tickers.length} tickers to analyze`);

  // Analyze each ticker
  const tickerData = [];
  for (let i = 0; i < tickers.length; i++) {
    const result = await analyzeTicker(tickers[i]);
    if (result) tickerData.push(result);
    
    if ((i + 1) % 20 === 0) {
      console.log(`[historical-movers] Progress: ${i + 1}/${tickers.length} (${tickerData.length} with data)`);
    }
  }

  console.log(`[historical-movers] Analyzed ${tickerData.length} tickers with significant moves`);

  // Derive cross-ticker patterns
  const patterns = derivePatterns(tickerData);
  console.log(`[historical-movers] Found ${patterns.upMoves.count} UP and ${patterns.downMoves.count} DOWN moves total`);

  // Save outputs
  const fs = await import("node:fs/promises");
  await fs.mkdir("docs/historical-movers", { recursive: true });

  // Save per-ticker files
  for (const td of tickerData) {
    if (td?.topMoves?.length > 0) {
      await fs.writeFile(
        `docs/historical-movers/${td.ticker}.json`,
        JSON.stringify(td, null, 2),
        "utf-8"
      );
    }
  }
  console.log(`[historical-movers] Saved ${tickerData.length} per-ticker analysis files`);

  // Save full dataset
  const fullData = {
    generated: new Date().toISOString(),
    config: {
      minMovePct: MIN_MOVE_PCT,
      topMovesPerTicker: TOP_MOVES_PER_TICKER,
      lookbackPoints: LOOKBACK_POINTS,
    },
    patterns,
    tickerSummary: tickerData.map(t => ({
      ticker: t.ticker,
      dataRange: t.dataRange,
      movesFound: t.movesFound,
      biggestUp: t.biggestUp?.movePct,
      biggestDown: t.biggestDown?.movePct,
    })),
  };
  
  await fs.writeFile("docs/HISTORICAL_MOVERS_DATA.json", JSON.stringify(fullData, null, 2), "utf-8");
  console.log(`[historical-movers] Saved docs/HISTORICAL_MOVERS_DATA.json`);

  // Save markdown summary
  const md = generateMarkdown(patterns, tickerData);
  await fs.writeFile("docs/HISTORICAL_MOVERS_SUMMARY.md", md, "utf-8");
  console.log(`[historical-movers] Saved docs/HISTORICAL_MOVERS_SUMMARY.md`);

  console.log(`[historical-movers] Done!`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
