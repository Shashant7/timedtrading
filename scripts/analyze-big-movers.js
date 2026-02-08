/**
 * Big Movers Analysis - Identify Market Winners & Analyze Pre-Move Signals
 * 
 * This script:
 * 1. Scans trail data for all tickers to find significant price moves
 * 2. For each big move, captures the sequence of signals/scores BEFORE the move
 * 3. Derives "gold standard" patterns from actual market winners
 * 
 * Usage:
 *   node scripts/analyze-big-movers.js --days 2 --minMove 3
 *   node scripts/analyze-big-movers.js --since 2026-02-02 --until 2026-02-03
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v != null ? v : fallback;
}

const DAYS = Number(argValue("--days", "2"));
const MIN_MOVE_PCT = Number(argValue("--minMove", "3")); // minimum % move to qualify
const WINDOW_HOURS = Number(argValue("--window", "4")); // window to measure move
const LOOKBACK_HOURS = Number(argValue("--lookback", "4")); // hours of signals before move
const SINCE_RAW = argValue("--since", "");
const UNTIL_RAW = argValue("--until", "");
const TOP_N = Number(argValue("--top", "50")); // top N moves to analyze

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function fmtPct(n, decimals = 1) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(decimals)}%` : "—";
}

function fmtNum(n, decimals = 2) {
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace(".000Z", "Z").slice(0, 19);
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeFlags(flags) {
  if (flags == null) return {};
  if (typeof flags === "object") return flags;
  if (typeof flags === "string") {
    try { return JSON.parse(flags); } catch { return {}; }
  }
  return {};
}

function flagOn(flags, key) {
  const f = normalizeFlags(flags);
  const v = f?.[key];
  return v === true || v === "true" || v === 1 || v === "1";
}

async function main() {
  console.log("[big-movers] Starting analysis...");
  console.log(`[big-movers] Config: minMove=${MIN_MOVE_PCT}%, window=${WINDOW_HOURS}h, lookback=${LOOKBACK_HOURS}h`);

  // Get tickers
  const tickersResp = await fetchJson(`${API_BASE}/timed/tickers`);
  const tickers = Array.isArray(tickersResp?.tickers) ? tickersResp.tickers : [];
  console.log(`[big-movers] Found ${tickers.length} tickers`);

  const now = Date.now();
  const sinceMs = SINCE_RAW ? Date.parse(SINCE_RAW) : now - DAYS * 24 * 60 * 60 * 1000;
  const untilMs = UNTIL_RAW ? Date.parse(UNTIL_RAW) + 24 * 60 * 60 * 1000 : now;
  console.log(`[big-movers] Window: ${fmtTs(sinceMs)} → ${fmtTs(untilMs)}`);

  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const lookbackMs = LOOKBACK_HOURS * 60 * 60 * 1000;
  const minMovePct = MIN_MOVE_PCT / 100;

  const allMoves = [];

  // Process each ticker
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      const trailResp = await fetchJson(`${API_BASE}/timed/trail?ticker=${ticker}&limit=5000&since=${sinceMs}`);
      const trail = Array.isArray(trailResp?.trail) ? trailResp.trail : [];
      
      if (trail.length < 10) continue;

      // Sort by timestamp
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
          flags: normalizeFlags(p.flags || p.flags_json),
          trigger_reason: p.trigger_reason,
        }))
        .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.price) && p.price > 0)
        .filter(p => p.ts >= sinceMs && p.ts <= untilMs)
        .sort((a, b) => a.ts - b.ts);

      if (points.length < 10) continue;

      // Scan for significant moves within the window
      for (let j = 0; j < points.length; j++) {
        const start = points[j];
        
        // Find max move within window
        let maxUp = 0, maxDown = 0;
        let maxUpIdx = j, maxDownIdx = j;
        
        for (let k = j + 1; k < points.length; k++) {
          const end = points[k];
          if (end.ts - start.ts > windowMs) break;
          
          const move = (end.price - start.price) / start.price;
          if (move > maxUp) { maxUp = move; maxUpIdx = k; }
          if (move < maxDown) { maxDown = move; maxDownIdx = k; }
        }

        // Record significant moves
        if (maxUp >= minMovePct) {
          const endPoint = points[maxUpIdx];
          const duration = (endPoint.ts - start.ts) / 60000; // minutes
          
          // Get pre-move signals (lookback period)
          const preSignals = points.filter(p => 
            p.ts >= start.ts - lookbackMs && p.ts < start.ts
          );
          
          allMoves.push({
            ticker,
            direction: "UP",
            movePct: maxUp * 100,
            startTs: start.ts,
            endTs: endPoint.ts,
            duration,
            startPrice: start.price,
            endPrice: endPoint.price,
            atStart: {
              htf: start.htf,
              ltf: start.ltf,
              state: start.state,
              rank: start.rank,
              completion: start.completion,
              phase: start.phase,
              rr: start.rr,
              flags: start.flags,
              trigger_reason: start.trigger_reason,
            },
            preSignals,
          });
        }
        
        if (maxDown <= -minMovePct) {
          const endPoint = points[maxDownIdx];
          const duration = (endPoint.ts - start.ts) / 60000;
          
          const preSignals = points.filter(p => 
            p.ts >= start.ts - lookbackMs && p.ts < start.ts
          );
          
          allMoves.push({
            ticker,
            direction: "DOWN",
            movePct: maxDown * 100,
            startTs: start.ts,
            endTs: endPoint.ts,
            duration,
            startPrice: start.price,
            endPrice: endPoint.price,
            atStart: {
              htf: start.htf,
              ltf: start.ltf,
              state: start.state,
              rank: start.rank,
              completion: start.completion,
              phase: start.phase,
              rr: start.rr,
              flags: start.flags,
              trigger_reason: start.trigger_reason,
            },
            preSignals,
          });
        }
      }
    } catch (e) {
      // Skip failed tickers
    }
    
    if ((i + 1) % 20 === 0) {
      console.log(`[big-movers] Progress: ${i + 1}/${tickers.length} tickers, ${allMoves.length} moves found`);
    }
  }

  console.log(`[big-movers] Total moves found: ${allMoves.length}`);

  // Dedupe moves (same ticker within 30 min)
  allMoves.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  const deduped = [];
  const seen = new Set();
  for (const m of allMoves) {
    const key = `${m.ticker}:${Math.floor(m.startTs / 1800000)}`; // 30 min buckets
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  const topMoves = deduped.slice(0, TOP_N);
  console.log(`[big-movers] Top ${topMoves.length} moves after deduplication`);

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYZE PATTERNS
  // ═══════════════════════════════════════════════════════════════════════════

  const upMoves = topMoves.filter(m => m.direction === "UP");
  const downMoves = topMoves.filter(m => m.direction === "DOWN");

  function analyzeGroup(moves, label) {
    if (!moves.length) return { label, count: 0 };

    // At-start conditions
    const htfs = moves.map(m => m.atStart.htf).filter(Number.isFinite);
    const ltfs = moves.map(m => m.atStart.ltf).filter(Number.isFinite);
    const ranks = moves.map(m => m.atStart.rank).filter(Number.isFinite);
    const completions = moves.map(m => m.atStart.completion).filter(Number.isFinite);
    const phases = moves.map(m => m.atStart.phase).filter(Number.isFinite);
    const rrs = moves.map(m => m.atStart.rr).filter(Number.isFinite);
    const durations = moves.map(m => m.duration).filter(Number.isFinite);

    // State distribution
    const states = {};
    for (const m of moves) {
      const st = m.atStart.state || "UNKNOWN";
      states[st] = (states[st] || 0) + 1;
    }

    // Flag analysis
    const flagCounts = {};
    const flagKeys = [
      "sq30_on", "sq30_release", "phase_dot", "phase_zone_change", 
      "momentum_elite", "ema_cross_1h_13_48", "st_flip_1h", "st_flip_30m",
      "buyable_dip_1h_13_48", "sq10_release", "ema_cross_10m_13_48",
      "htf_improving_4h", "htf_improving_1d", "htf_move_4h_ge_5",
      "thesis_match", "flip_watch"
    ];
    for (const key of flagKeys) {
      let count = 0;
      for (const m of moves) {
        if (flagOn(m.atStart.flags, key)) count++;
      }
      flagCounts[key] = { count, pct: count / moves.length };
    }

    // Trigger reason distribution
    const triggers = {};
    for (const m of moves) {
      const tr = m.atStart.trigger_reason || "NONE";
      triggers[tr] = (triggers[tr] || 0) + 1;
    }

    // Pre-signal sequence analysis
    const preSignalPatterns = {
      htfImproving: 0,    // HTF trending in direction of move
      ltfSetup: 0,        // LTF in pullback before move
      corridorEntry: 0,   // Entered corridor recently
      squeezeRelease: 0,  // Squeeze released recently
      stateTransition: 0, // State changed recently
    };

    for (const m of moves) {
      const pre = m.preSignals;
      if (!pre.length) continue;

      // HTF improving check
      const firstPre = pre[0];
      const lastPre = pre[pre.length - 1];
      if (m.direction === "UP" && lastPre.htf > firstPre.htf) preSignalPatterns.htfImproving++;
      if (m.direction === "DOWN" && lastPre.htf < firstPre.htf) preSignalPatterns.htfImproving++;

      // LTF in pullback (opposite direction of HTF)
      const ltfPullback = (m.direction === "UP" && lastPre.ltf < 0) || 
                          (m.direction === "DOWN" && lastPre.ltf > 0);
      if (ltfPullback) preSignalPatterns.ltfSetup++;

      // Corridor entry (came from outside corridor)
      const inCorridor = Math.abs(lastPre.ltf) < 12;
      const wasOutside = pre.some(p => Math.abs(p.ltf) > 15);
      if (inCorridor && wasOutside) preSignalPatterns.corridorEntry++;

      // Squeeze release
      if (pre.some(p => flagOn(p.flags, "sq30_release"))) preSignalPatterns.squeezeRelease++;

      // State transition
      const states = pre.map(p => p.state).filter(Boolean);
      const uniqueStates = [...new Set(states)];
      if (uniqueStates.length > 1) preSignalPatterns.stateTransition++;
    }

    return {
      label,
      count: moves.length,
      avgMovePct: moves.reduce((s, m) => s + Math.abs(m.movePct), 0) / moves.length,
      avgDuration: median(durations),
      atStart: {
        avgHtf: htfs.length ? htfs.reduce((a, b) => a + b, 0) / htfs.length : null,
        medianHtf: median(htfs),
        avgLtf: ltfs.length ? ltfs.reduce((a, b) => a + b, 0) / ltfs.length : null,
        medianLtf: median(ltfs),
        avgRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
        avgCompletion: completions.length ? completions.reduce((a, b) => a + b, 0) / completions.length : null,
        avgPhase: phases.length ? phases.reduce((a, b) => a + b, 0) / phases.length : null,
        avgRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
      },
      stateDistribution: states,
      flagAnalysis: Object.entries(flagCounts)
        .filter(([_, v]) => v.pct > 0.1) // Only flags present >10% of time
        .sort((a, b) => b[1].pct - a[1].pct)
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
      triggerDistribution: triggers,
      preSignalPatterns: {
        htfImproving: { count: preSignalPatterns.htfImproving, pct: preSignalPatterns.htfImproving / moves.length },
        ltfSetup: { count: preSignalPatterns.ltfSetup, pct: preSignalPatterns.ltfSetup / moves.length },
        corridorEntry: { count: preSignalPatterns.corridorEntry, pct: preSignalPatterns.corridorEntry / moves.length },
        squeezeRelease: { count: preSignalPatterns.squeezeRelease, pct: preSignalPatterns.squeezeRelease / moves.length },
        stateTransition: { count: preSignalPatterns.stateTransition, pct: preSignalPatterns.stateTransition / moves.length },
      },
    };
  }

  const upAnalysis = analyzeGroup(upMoves, "UP Moves (Bulls)");
  const downAnalysis = analyzeGroup(downMoves, "DOWN Moves (Bears)");

  // ═══════════════════════════════════════════════════════════════════════════
  // DETAILED JOURNEY FOR TOP MOVES
  // ═══════════════════════════════════════════════════════════════════════════

  const journeys = topMoves.slice(0, 15).map(m => {
    const preSignalSummary = m.preSignals.map(p => ({
      ts: fmtTs(p.ts),
      htf: fmtNum(p.htf, 1),
      ltf: fmtNum(p.ltf, 1),
      state: p.state?.replace("HTF_", "").replace("LTF_", "") || "?",
      flags: Object.entries(p.flags || {})
        .filter(([k, v]) => v === true || v === "true" || v === 1)
        .map(([k]) => k.replace("sq30_", "sq_").replace("_1h_13_48", ""))
        .join(", ") || "—",
    }));

    return {
      ticker: m.ticker,
      direction: m.direction,
      movePct: `${m.movePct > 0 ? "+" : ""}${fmtNum(m.movePct, 2)}%`,
      duration: `${Math.round(m.duration)} min`,
      startTime: fmtTs(m.startTs),
      atStart: {
        price: `$${fmtNum(m.startPrice)}`,
        htf: fmtNum(m.atStart.htf, 1),
        ltf: fmtNum(m.atStart.ltf, 1),
        state: m.atStart.state,
        rank: m.atStart.rank,
        completion: fmtPct(m.atStart.completion),
        phase: fmtPct(m.atStart.phase),
      },
      preSignals: preSignalSummary.slice(-5), // Last 5 points before move
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════════════════════════

  const analysis = {
    generated: new Date().toISOString(),
    config: {
      minMovePct: MIN_MOVE_PCT,
      windowHours: WINDOW_HOURS,
      lookbackHours: LOOKBACK_HOURS,
      since: fmtTs(sinceMs),
      until: fmtTs(untilMs),
    },
    summary: {
      totalMoves: deduped.length,
      upMoves: upMoves.length,
      downMoves: downMoves.length,
      avgMovePct: deduped.length ? deduped.reduce((s, m) => s + Math.abs(m.movePct), 0) / deduped.length : 0,
    },
    upAnalysis,
    downAnalysis,
    journeys,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  
  await fs.writeFile("docs/BIG_MOVERS_ANALYSIS.json", JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`[big-movers] Wrote docs/BIG_MOVERS_ANALYSIS.json`);

  const md = generateMarkdown(analysis);
  await fs.writeFile("docs/BIG_MOVERS_ANALYSIS.md", md, "utf-8");
  console.log(`[big-movers] Wrote docs/BIG_MOVERS_ANALYSIS.md`);
}

function generateMarkdown(analysis) {
  const lines = [];
  const { upAnalysis: up, downAnalysis: down, journeys, config, summary } = analysis;

  lines.push(`# Big Movers Analysis - Signal Sequence Study`);
  lines.push(``);
  lines.push(`**Goal:** Find tickers with massive moves, analyze the signals BEFORE the move started.`);
  lines.push(``);
  lines.push(`Generated: ${analysis.generated}`);
  lines.push(`Window: ${config.since} → ${config.until}`);
  lines.push(`Criteria: ≥${config.minMovePct}% move within ${config.windowHours}h, ${config.lookbackHours}h signal lookback`);
  lines.push(``);

  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Total significant moves | ${summary.totalMoves} |`);
  lines.push(`| UP moves | ${summary.upMoves} |`);
  lines.push(`| DOWN moves | ${summary.downMoves} |`);
  lines.push(`| Avg move magnitude | ${fmtNum(summary.avgMovePct)}% |`);
  lines.push(``);

  // UP Moves Analysis
  if (up.count > 0) {
    lines.push(`## 📈 UP Moves (${up.count} total)`);
    lines.push(``);
    lines.push(`### Conditions at Move Start`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|:--|--:|`);
    lines.push(`| Avg move | +${fmtNum(up.avgMovePct)}% |`);
    lines.push(`| Median duration | ${fmtNum(up.avgDuration, 0)} min |`);
    lines.push(`| Avg HTF score | ${fmtNum(up.atStart.avgHtf, 1)} |`);
    lines.push(`| Median HTF score | ${fmtNum(up.atStart.medianHtf, 1)} |`);
    lines.push(`| Avg LTF score | ${fmtNum(up.atStart.avgLtf, 1)} |`);
    lines.push(`| Median LTF score | ${fmtNum(up.atStart.medianLtf, 1)} |`);
    lines.push(`| Avg Rank | ${fmtNum(up.atStart.avgRank, 0)} |`);
    lines.push(`| Avg Completion | ${fmtPct(up.atStart.avgCompletion)} |`);
    lines.push(`| Avg Phase | ${fmtPct(up.atStart.avgPhase)} |`);
    lines.push(``);

    lines.push(`### State at Move Start`);
    lines.push(``);
    lines.push(`| State | Count | % |`);
    lines.push(`|:--|--:|--:|`);
    for (const [state, count] of Object.entries(up.stateDistribution).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${state} | ${count} | ${fmtPct(count / up.count)} |`);
    }
    lines.push(``);

    lines.push(`### Pre-Move Signal Patterns`);
    lines.push(``);
    lines.push(`| Pattern | Count | % | Interpretation |`);
    lines.push(`|:--|--:|--:|:--|`);
    const pre = up.preSignalPatterns;
    lines.push(`| HTF Improving | ${pre.htfImproving.count} | ${fmtPct(pre.htfImproving.pct)} | HTF trending in direction of move |`);
    lines.push(`| LTF Pullback Setup | ${pre.ltfSetup.count} | ${fmtPct(pre.ltfSetup.pct)} | LTF negative before up move |`);
    lines.push(`| Recent Corridor Entry | ${pre.corridorEntry.count} | ${fmtPct(pre.corridorEntry.pct)} | Just entered entry zone |`);
    lines.push(`| Squeeze Release | ${pre.squeezeRelease.count} | ${fmtPct(pre.squeezeRelease.pct)} | Volatility expansion starting |`);
    lines.push(`| State Transition | ${pre.stateTransition.count} | ${fmtPct(pre.stateTransition.pct)} | Momentum shift detected |`);
    lines.push(``);

    if (Object.keys(up.flagAnalysis).length > 0) {
      lines.push(`### Active Flags at Move Start (>10% frequency)`);
      lines.push(``);
      lines.push(`| Flag | Count | % |`);
      lines.push(`|:--|--:|--:|`);
      for (const [flag, data] of Object.entries(up.flagAnalysis)) {
        lines.push(`| ${flag} | ${data.count} | ${fmtPct(data.pct)} |`);
      }
      lines.push(``);
    }
  }

  // DOWN Moves Analysis
  if (down.count > 0) {
    lines.push(`## 📉 DOWN Moves (${down.count} total)`);
    lines.push(``);
    lines.push(`### Conditions at Move Start`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|:--|--:|`);
    lines.push(`| Avg move | ${fmtNum(down.avgMovePct)}% |`);
    lines.push(`| Median duration | ${fmtNum(down.avgDuration, 0)} min |`);
    lines.push(`| Avg HTF score | ${fmtNum(down.atStart.avgHtf, 1)} |`);
    lines.push(`| Median HTF score | ${fmtNum(down.atStart.medianHtf, 1)} |`);
    lines.push(`| Avg LTF score | ${fmtNum(down.atStart.avgLtf, 1)} |`);
    lines.push(`| Median LTF score | ${fmtNum(down.atStart.medianLtf, 1)} |`);
    lines.push(`| Avg Rank | ${fmtNum(down.atStart.avgRank, 0)} |`);
    lines.push(`| Avg Completion | ${fmtPct(down.atStart.avgCompletion)} |`);
    lines.push(`| Avg Phase | ${fmtPct(down.atStart.avgPhase)} |`);
    lines.push(``);

    lines.push(`### State at Move Start`);
    lines.push(``);
    lines.push(`| State | Count | % |`);
    lines.push(`|:--|--:|--:|`);
    for (const [state, count] of Object.entries(down.stateDistribution).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${state} | ${count} | ${fmtPct(count / down.count)} |`);
    }
    lines.push(``);

    lines.push(`### Pre-Move Signal Patterns`);
    lines.push(``);
    lines.push(`| Pattern | Count | % | Interpretation |`);
    lines.push(`|:--|--:|--:|:--|`);
    const preD = down.preSignalPatterns;
    lines.push(`| HTF Improving | ${preD.htfImproving.count} | ${fmtPct(preD.htfImproving.pct)} | HTF trending in direction of move |`);
    lines.push(`| LTF Pullback Setup | ${preD.ltfSetup.count} | ${fmtPct(preD.ltfSetup.pct)} | LTF positive before down move |`);
    lines.push(`| Recent Corridor Entry | ${preD.corridorEntry.count} | ${fmtPct(preD.corridorEntry.pct)} | Just entered entry zone |`);
    lines.push(`| Squeeze Release | ${preD.squeezeRelease.count} | ${fmtPct(preD.squeezeRelease.pct)} | Volatility expansion starting |`);
    lines.push(`| State Transition | ${preD.stateTransition.count} | ${fmtPct(preD.stateTransition.pct)} | Momentum shift detected |`);
    lines.push(``);
  }

  // Journeys
  lines.push(`## 🎬 Top Move Journeys (Signal Sequences)`);
  lines.push(``);
  
  for (const j of journeys) {
    lines.push(`### ${j.ticker} ${j.direction} ${j.movePct}`);
    lines.push(``);
    lines.push(`- **Time:** ${j.startTime} (${j.duration})`);
    lines.push(`- **At start:** ${j.atStart.state} | HTF=${j.atStart.htf} LTF=${j.atStart.ltf} | Rank=${j.atStart.rank} | Comp=${j.atStart.completion} Phase=${j.atStart.phase}`);
    lines.push(``);
    
    if (j.preSignals.length > 0) {
      lines.push(`**Pre-move signals (last ${j.preSignals.length} points):**`);
      lines.push(``);
      lines.push(`| Time | HTF | LTF | State | Flags |`);
      lines.push(`|:--|--:|--:|:--|:--|`);
      for (const p of j.preSignals) {
        lines.push(`| ${p.ts.slice(11)} | ${p.htf} | ${p.ltf} | ${p.state} | ${p.flags} |`);
      }
      lines.push(``);
    }
  }

  lines.push(`## 🎯 Gold Standard Entry Criteria (Derived)`);
  lines.push(``);
  lines.push(`Based on the signal sequences that preceded big moves:`);
  lines.push(``);
  
  // Derive criteria from UP moves
  if (up.count > 0) {
    lines.push(`### For LONG entries (UP moves):`);
    lines.push(``);
    const criteria = [];
    if (up.atStart.medianHtf > 10) criteria.push(`HTF score > ${Math.round(up.atStart.medianHtf / 2)} (median at move start: ${fmtNum(up.atStart.medianHtf, 0)})`);
    if (up.atStart.medianLtf < 0) criteria.push(`LTF score in pullback (< 0) — median: ${fmtNum(up.atStart.medianLtf, 0)}`);
    if (up.preSignalPatterns.ltfSetup.pct > 0.3) criteria.push(`LTF pullback setup present (${fmtPct(up.preSignalPatterns.ltfSetup.pct)} of winners)`);
    if (up.preSignalPatterns.htfImproving.pct > 0.3) criteria.push(`HTF improving in lookback (${fmtPct(up.preSignalPatterns.htfImproving.pct)} of winners)`);
    if (up.preSignalPatterns.stateTransition.pct > 0.3) criteria.push(`State transition in lookback (${fmtPct(up.preSignalPatterns.stateTransition.pct)} of winners)`);
    
    for (const c of criteria) {
      lines.push(`- ${c}`);
    }
    lines.push(``);
  }

  if (down.count > 0) {
    lines.push(`### For SHORT entries (DOWN moves):`);
    lines.push(``);
    const criteria = [];
    if (down.atStart.medianHtf < -10) criteria.push(`HTF score < ${Math.round(down.atStart.medianHtf / 2)} (median at move start: ${fmtNum(down.atStart.medianHtf, 0)})`);
    if (down.atStart.medianLtf > 0) criteria.push(`LTF score in pullback (> 0) — median: ${fmtNum(down.atStart.medianLtf, 0)}`);
    if (down.preSignalPatterns.ltfSetup.pct > 0.3) criteria.push(`LTF pullback setup present (${fmtPct(down.preSignalPatterns.ltfSetup.pct)} of winners)`);
    if (down.preSignalPatterns.htfImproving.pct > 0.3) criteria.push(`HTF improving (going more negative) in lookback (${fmtPct(down.preSignalPatterns.htfImproving.pct)} of winners)`);
    
    for (const c of criteria) {
      lines.push(`- ${c}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
