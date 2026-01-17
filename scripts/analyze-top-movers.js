/**
 * Analyze top movers from TimedTrading trail data.
 *
 * Usage:
 *   node scripts/analyze-top-movers.js --days 120 --top 25
 *
 * Output:
 *   - docs/TOP_MOVERS_ANALYSIS.md
 *   - docs/TOP_MOVERS_ANALYSIS.json
 */
/* eslint-disable no-console */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null) return fallback;
  return v;
}

const DAYS = Number(argValue("--days", "120"));
const TOP = Number(argValue("--top", "25"));
const INCLUDE = String(argValue("--include", "") || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function nyDayKey(tsMs) {
  const ms = Number(tsMs);
  if (!Number.isFinite(ms)) return null;
  try {
    return NY_DAY_FMT.format(new Date(ms));
  } catch {
    return null;
  }
}

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeFlags(flags) {
  if (flags == null) return null;
  if (typeof flags === "object") return flags;
  if (typeof flags === "string") {
    const s = flags.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function boolish(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) return false;
    return s === "true" || s === "1" || s === "yes" || s === "y";
  }
  return false;
}

function flagOn(flags, key) {
  const f = normalizeFlags(flags);
  if (!f) return false;
  return boolish(f?.[key]);
}

function pickNum(o, keys) {
  for (const k of keys) {
    const v = Number(o?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function pct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 100; // percentage with 2 decimals
}

function fmtPct(v) {
  const p = pct(v);
  if (p == null) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function fmtMins(ms) {
  const m = Number(ms) / 60000;
  if (!Number.isFinite(m)) return "—";
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  const d = h / 24;
  return `${Math.round(d * 10) / 10}d`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function getTickers() {
  const json = await fetchJson(`${API_BASE}/timed/tickers?_t=${Date.now()}`);
  const list = Array.isArray(json?.tickers) ? json.tickers : Array.isArray(json) ? json : [];
  return list.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean);
}

async function getTrail(ticker, sinceMs) {
  const qs = new URLSearchParams();
  qs.set("ticker", ticker);
  qs.set("limit", "5000");
  if (Number.isFinite(sinceMs)) qs.set("since", String(sinceMs));
  const json = await fetchJson(`${API_BASE}/timed/trail?${qs.toString()}`);
  const trail = Array.isArray(json?.trail) ? json.trail : [];
  const pts = trail
    .map((p) => {
      const ts = toMs(p?.ts ?? p?.timestamp ?? p?.ingest_ts ?? p?.ingest_time);
      const price = Number(p?.price);
      if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return null;
      return { ...p, __ts: ts, __price: price, __flags: normalizeFlags(p?.flags) };
    })
    .filter(Boolean)
    .sort((a, b) => a.__ts - b.__ts);
  return pts;
}

function computeStats(ticker, pts) {
  if (!pts || pts.length < 2) return null;
  // Max run-up using min-so-far scan
  let minPrice = Infinity;
  let minTs = null;
  let maxRun = -Infinity;
  let maxRunFrom = null;
  let maxRunTo = null;

  for (const p of pts) {
    const price = p.__price;
    if (price < minPrice) {
      minPrice = price;
      minTs = p.__ts;
    }
    if (Number.isFinite(minPrice) && minPrice > 0) {
      const r = (price - minPrice) / minPrice;
      if (r > maxRun) {
        maxRun = r;
        maxRunFrom = minTs;
        maxRunTo = p.__ts;
      }
    }
  }

  // Daily closes / swings by NY day
  const byDay = new Map(); // dayKey -> {min,max,last,lastTs, first, firstTs}
  for (const p of pts) {
    const day = nyDayKey(p.__ts);
    if (!day) continue;
    const e = byDay.get(day) || {
      day,
      min: Infinity,
      max: -Infinity,
      first: null,
      firstTs: null,
      last: null,
      lastTs: null,
    };
    e.min = Math.min(e.min, p.__price);
    e.max = Math.max(e.max, p.__price);
    if (e.firstTs == null || p.__ts < e.firstTs) {
      e.firstTs = p.__ts;
      e.first = p.__price;
    }
    if (e.lastTs == null || p.__ts > e.lastTs) {
      e.lastTs = p.__ts;
      e.last = p.__price;
    }
    byDay.set(day, e);
  }

  const days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  let maxCloseToClose = -Infinity;
  let maxCloseToCloseDay = null;
  let maxIntraday = -Infinity;
  let maxIntradayDay = null;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (Number.isFinite(d.min) && Number.isFinite(d.max) && d.min > 0) {
      const swing = (d.max - d.min) / d.min;
      if (swing > maxIntraday) {
        maxIntraday = swing;
        maxIntradayDay = d.day;
      }
    }
    if (i > 0) {
      const prev = days[i - 1];
      if (Number.isFinite(prev.last) && Number.isFinite(d.last) && prev.last > 0) {
        const c2c = (d.last - prev.last) / prev.last;
        if (Math.abs(c2c) > Math.abs(maxCloseToClose)) {
          maxCloseToClose = c2c;
          maxCloseToCloseDay = d.day;
        }
      }
    }
  }

  // Journey features (start/end snapshots around max run-up)
  const snapAt = (ts) => {
    if (!Number.isFinite(ts)) return null;
    // nearest point
    let best = null;
    let bestDist = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.__ts - ts);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (!best) return null;
    return {
      ts: best.__ts,
      price: best.__price,
      state: best.state || null,
      htf: pickNum(best, ["htf_score"]),
      ltf: pickNum(best, ["ltf_score"]),
      phase_pct: pickNum(best, ["phase_pct"]),
      completion: pickNum(best, ["completion"]),
      rr: pickNum(best, ["rr"]),
      trigger_reason: best.trigger_reason || null,
      flags: best.__flags || null,
    };
  };

  const start = snapAt(maxRunFrom);
  const end = snapAt(maxRunTo);

  // Event alignment around max run-up start (squeeze + setup→momentum timing)
  const LOOKBACK_MS = 24 * 60 * 60 * 1000;
  const FORWARD_MS = 24 * 60 * 60 * 1000;
  const startTs = start?.ts;

  const journey = (() => {
    if (!Number.isFinite(startTs)) return null;
    const fromTs = startTs - LOOKBACK_MS;
    const toTs = startTs + FORWARD_MS;

    let lastSqReleaseTs = null;
    let anySqOn = false;
    let anySqRelease = false;

    let firstMomentumTs = null;
    let firstMomentumState = null;

    for (const p of pts) {
      const ts = p.__ts;
      if (!Number.isFinite(ts)) continue;

      // lookback scan
      if (ts >= fromTs && ts <= startTs) {
        const on = flagOn(p.__flags, "sq30_on");
        const rel = flagOn(p.__flags, "sq30_release");
        if (on) anySqOn = true;
        if (rel) {
          anySqRelease = true;
          if (lastSqReleaseTs == null || ts > lastSqReleaseTs) lastSqReleaseTs = ts;
        }
      }

      // forward scan for first momentum (after start)
      if (firstMomentumTs == null && ts >= startTs && ts <= toTs) {
        const st = String(p.state || "");
        const isPullback = st.includes("PULLBACK");
        const isMomentum = (st.includes("LTF_BULL") || st.includes("LTF_BEAR")) && !isPullback;
        if (isMomentum) {
          firstMomentumTs = ts;
          firstMomentumState = st || null;
        }
      }
    }

    return {
      lookback_ms: LOOKBACK_MS,
      forward_ms: FORWARD_MS,
      sq30_on_lookback: anySqOn,
      sq30_release_lookback: anySqRelease,
      sq30_on_at_start: flagOn(start?.flags, "sq30_on"),
      sq30_release_at_start: flagOn(start?.flags, "sq30_release"),
      sq30_last_release_ts: lastSqReleaseTs,
      sq30_release_to_start_ms:
        Number.isFinite(lastSqReleaseTs) && Number.isFinite(startTs) ? startTs - lastSqReleaseTs : null,
      first_momentum_ts: firstMomentumTs,
      first_momentum_state: firstMomentumState,
      start_to_momentum_ms:
        Number.isFinite(firstMomentumTs) && Number.isFinite(startTs) ? firstMomentumTs - startTs : null,
    };
  })();

  return {
    ticker,
    points: pts.length,
    range: { from: pts[0].__ts, to: pts[pts.length - 1].__ts },
    maxRunup: {
      pct: maxRun,
      from: maxRunFrom,
      to: maxRunTo,
      start,
      end,
    },
    journey,
    maxIntradaySwing: { pct: maxIntraday, day: maxIntradayDay },
    maxCloseToCloseAbs: { pct: maxCloseToClose, day: maxCloseToCloseDay },
  };
}

function summarizeCommonTraits(items) {
  const traits = {
    startPrimeLike: 0,
    startEarlyPhase: 0,
    startLowCompletion: 0,
    startHighRR: 0,
    startInSetupQuadrant: 0,
    startSqOnLookback: 0,
    startSqReleaseLookback: 0,
    startSqReleaseNear: 0,
    startTransitionsToMomentum: 0,
  };
  const n = items.length || 1;
  for (const it of items) {
    const s = it?.maxRunup?.start;
    if (!s) continue;
    const phase = Number(s.phase_pct);
    const comp = Number(s.completion);
    const rr = Number(s.rr);
    const st = String(s.state || "");
    if (Number.isFinite(phase) && phase < 0.35) traits.startEarlyPhase++;
    if (Number.isFinite(comp) && comp < 0.15) traits.startLowCompletion++;
    if (Number.isFinite(rr) && rr >= 2.0) traits.startHighRR++;
    if (st.includes("PULLBACK")) traits.startInSetupQuadrant++;
    // crude "prime-like": RR>=1.5, completion<0.4, phase<0.6
    if (
      Number.isFinite(rr) &&
      rr >= 1.5 &&
      Number.isFinite(comp) &&
      comp < 0.4 &&
      Number.isFinite(phase) &&
      phase < 0.6
    ) {
      traits.startPrimeLike++;
    }

    const j = it?.journey;
    if (j?.sq30_on_lookback) traits.startSqOnLookback++;
    if (j?.sq30_release_lookback) traits.startSqReleaseLookback++;
    if (Number.isFinite(j?.sq30_release_to_start_ms) && j.sq30_release_to_start_ms <= 3 * 60 * 60 * 1000) {
      traits.startSqReleaseNear++;
    }
    if (Number.isFinite(j?.start_to_momentum_ms) && j.start_to_momentum_ms <= 6 * 60 * 60 * 1000) {
      traits.startTransitionsToMomentum++;
    }
  }
  return Object.fromEntries(
    Object.entries(traits).map(([k, v]) => [k, { count: v, pct: Math.round((v / n) * 1000) / 10 }])
  );
}

function toMarkdown(results, topN) {
  const top = results.slice(0, topN);
  const included = INCLUDE.length
    ? INCLUDE.map((sym) => results.find((r) => r.ticker === sym)).filter(Boolean)
    : [];
  const traits = summarizeCommonTraits(top);

  const lines = [];
  lines.push(`# Top Movers Analysis`);
  lines.push(``);
  lines.push(`Source: \`${API_BASE}\``);
  lines.push(`Window: last **${DAYS}** days`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);

  lines.push(`## Summary (Top ${topN} by max run-up)`);
  lines.push(``);
  lines.push(`Common traits at the start of the max run-up window:`);
  lines.push(`- Prime-like (RR≥1.5, Completion<40%, Phase<60%): **${traits.startPrimeLike.pct}%**`);
  lines.push(`- Early Phase (<35%): **${traits.startEarlyPhase.pct}%**`);
  lines.push(`- Low Completion (<15%): **${traits.startLowCompletion.pct}%**`);
  lines.push(`- High RR (≥2.0): **${traits.startHighRR.pct}%**`);
  lines.push(`- Setup quadrant (PULLBACK): **${traits.startInSetupQuadrant.pct}%**`);
  lines.push(`- Squeeze on (sq30_on) within prior 24h: **${traits.startSqOnLookback.pct}%**`);
  lines.push(`- Squeeze release (sq30_release) within prior 24h: **${traits.startSqReleaseLookback.pct}%**`);
  lines.push(`- Squeeze release within prior 3h: **${traits.startSqReleaseNear.pct}%**`);
  lines.push(`- Setup→Momentum transition within 6h: **${traits.startTransitionsToMomentum.pct}%**`);
  lines.push(``);
  lines.push(`Winner signature checklist (early, high-probability):`);
  lines.push(`- Start state is a setup quadrant (often *LTF_PULLBACK*) **and** flips into LTF momentum within hours`);
  lines.push(`- Low completion at run start (typically <15%)`);
  lines.push(`- Phase tends to be early-to-mid at run start`);
  lines.push(`- If squeeze release occurs within a few hours of run start, it’s a strong “go-time” marker`);
  lines.push(``);

  lines.push(`## Table`);
  lines.push(``);
  lines.push(`| # | Ticker | Max run-up | From → To | Intraday max | C2C max (abs) |`);
  lines.push(`|---:|:---|---:|:---|---:|---:|`);
  top.forEach((r, i) => {
    const run = r.maxRunup?.pct ?? null;
    const runFrom = r.maxRunup?.from;
    const runTo = r.maxRunup?.to;
    const intr = r.maxIntradaySwing?.pct ?? null;
    const c2c = r.maxCloseToCloseAbs?.pct ?? null;
    lines.push(
      `| ${i + 1} | ${r.ticker} | ${fmtPct(run)} | ${fmtTs(runFrom)} → ${fmtTs(runTo)} | ${fmtPct(intr)} | ${fmtPct(c2c)} |`
    );
  });
  lines.push(``);

  lines.push(`## Journeys (Top ${Math.min(10, topN)})`);
  lines.push(``);
  top.slice(0, Math.min(10, topN)).forEach((r) => {
    const s = r.maxRunup?.start;
    const e = r.maxRunup?.end;
    const j = r.journey;
    lines.push(`### ${r.ticker}`);
    lines.push(`- **Max run-up**: ${fmtPct(r.maxRunup?.pct)} (${fmtTs(r.maxRunup?.from)} → ${fmtTs(r.maxRunup?.to)})`);
    if (s && e) {
      lines.push(
        `- **Start**: $${Number(s.price).toFixed(2)} | state=${s.state || "—"} | HTF=${s.htf ?? "—"} LTF=${s.ltf ?? "—"} | phase=${s.phase_pct != null ? Math.round(Number(s.phase_pct) * 100) + "%" : "—"} | completion=${s.completion != null ? Math.round(Number(s.completion) * 100) + "%" : "—"} | RR=${s.rr ?? "—"}`
      );
      lines.push(
        `- **End**: $${Number(e.price).toFixed(2)} | state=${e.state || "—"} | HTF=${e.htf ?? "—"} LTF=${e.ltf ?? "—"} | phase=${e.phase_pct != null ? Math.round(Number(e.phase_pct) * 100) + "%" : "—"} | completion=${e.completion != null ? Math.round(Number(e.completion) * 100) + "%" : "—"} | RR=${e.rr ?? "—"}`
      );
    }
    if (j) {
      lines.push(
        `- **Squeeze alignment**: sq30_on<=24h=${j.sq30_on_lookback ? "yes" : "no"} | sq30_release<=24h=${j.sq30_release_lookback ? "yes" : "no"}${Number.isFinite(j.sq30_release_to_start_ms) ? ` (Δ=${fmtMins(j.sq30_release_to_start_ms)})` : ""}`
      );
      lines.push(
        `- **Setup→Momentum**: ${Number.isFinite(j.start_to_momentum_ms) ? `${fmtMins(j.start_to_momentum_ms)} → ${j.first_momentum_state || "—"}` : "—"}`
      );
    }
    lines.push(``);
  });

  if (included.length > 0) {
    lines.push(`## Included deep dives`);
    lines.push(``);
    lines.push(
      `Requested tickers: ${INCLUDE.map((s) => `**${s}**`).join(", ")}`
    );
    lines.push(``);
    included.forEach((r) => {
      const s = r.maxRunup?.start;
      const e = r.maxRunup?.end;
      const j = r.journey;
      lines.push(`### ${r.ticker}`);
      lines.push(
        `- **Max run-up**: ${fmtPct(r.maxRunup?.pct)} (${fmtTs(
          r.maxRunup?.from
        )} → ${fmtTs(r.maxRunup?.to)})`
      );
      if (s && e) {
        lines.push(
          `- **Start**: $${Number(s.price).toFixed(
            2
          )} | state=${s.state || "—"} | HTF=${s.htf ?? "—"} LTF=${
            s.ltf ?? "—"
          } | phase=${
            s.phase_pct != null
              ? Math.round(Number(s.phase_pct) * 100) + "%"
              : "—"
          } | completion=${
            s.completion != null
              ? Math.round(Number(s.completion) * 100) + "%"
              : "—"
          } | RR=${s.rr ?? "—"}`
        );
        lines.push(
          `- **End**: $${Number(e.price).toFixed(
            2
          )} | state=${e.state || "—"} | HTF=${e.htf ?? "—"} LTF=${
            e.ltf ?? "—"
          } | phase=${
            e.phase_pct != null
              ? Math.round(Number(e.phase_pct) * 100) + "%"
              : "—"
          } | completion=${
            e.completion != null
              ? Math.round(Number(e.completion) * 100) + "%"
              : "—"
          } | RR=${e.rr ?? "—"}`
        );
      }
      if (j) {
        lines.push(
          `- **Squeeze alignment**: sq30_on<=24h=${j.sq30_on_lookback ? "yes" : "no"} | sq30_release<=24h=${j.sq30_release_lookback ? "yes" : "no"}${Number.isFinite(j.sq30_release_to_start_ms) ? ` (Δ=${fmtMins(j.sq30_release_to_start_ms)})` : ""}`
        );
        lines.push(
          `- **Setup→Momentum**: ${Number.isFinite(j.start_to_momentum_ms) ? `${fmtMins(j.start_to_momentum_ms)} → ${j.first_momentum_state || "—"}` : "—"}`
        );
      }
      lines.push(``);
    });
  }

  lines.push(`## Next improvements`);
  lines.push(`- **Tag trail points with explicit event markers** (Prime/Eligible transition, corridor entry/exit, squeeze on/release, TD9/TD13, EMA cross, entry/trim/exit) so we can sequence-mine “winner paths” vs “loser paths”.`);
  lines.push(`- This analysis uses the recorded trail points we store (not full market data).`);
  lines.push(``);

  return lines.join("\n");
}

async function main() {
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error("bad --days");
  if (!Number.isFinite(TOP) || TOP <= 0) throw new Error("bad --top");

  const sinceMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const tickers = await getTickers();

  console.log(`[top-movers] tickers=${tickers.length} days=${DAYS} top=${TOP}`);

  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    try {
      const pts = await getTrail(t, sinceMs);
      const stats = computeStats(t, pts);
      if (stats) results.push(stats);
    } catch (e) {
      console.warn(`[top-movers] ${t} failed: ${String(e?.message || e)}`);
    }
    if ((i + 1) % 20 === 0) console.log(`[top-movers] progress ${i + 1}/${tickers.length}`);
  }

  results.sort((a, b) => (Number(b.maxRunup?.pct) || -Infinity) - (Number(a.maxRunup?.pct) || -Infinity));

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  const md = toMarkdown(results, TOP);
  await fs.writeFile("docs/TOP_MOVERS_ANALYSIS.md", md, "utf-8");
  await fs.writeFile("docs/TOP_MOVERS_ANALYSIS.json", JSON.stringify({ generated: new Date().toISOString(), days: DAYS, top: TOP, results }, null, 2), "utf-8");

  console.log(`[top-movers] wrote docs/TOP_MOVERS_ANALYSIS.md and .json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

