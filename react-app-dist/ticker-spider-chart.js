/**
 * Ticker Spider / Radar Chart — shared UI primitive for Active Trader,
 * Investor Mode, and Trade Autopsy. Renders a 9-dimensional scorecard
 * over a dark radar polygon so a user can read conviction at a glance.
 *
 * Usage:
 *   const TickerSpiderChart = window.TickerSpiderChartFactory({ React });
 *   <TickerSpiderChart ticker={tickerPayload} direction="LONG" compact={false} />
 *
 * The `ticker` prop is the same object used elsewhere (from /timed/latest
 * or the worker's assembleTickerData output), so it already carries
 * tf_tech, phase_pct, rvol_map, rr, atr_d, rsi_divergence, regime_class,
 * swing_consensus, _ticker_profile, etc.
 *
 * Direction (LONG|SHORT) is optional; when provided, HTF/LTF/Phase/Divergence
 * scores flip polarity so a stacked-bearish ticker scores high on a SHORT.
 *
 * The 9 dimensions (all 0-10):
 *   - LTF       — 10m / 15m / 30m SuperTrend alignment with direction
 *   - HTF       — 1H / 4H / D SuperTrend alignment with direction
 *   - RVol      — best rvol across 30m / 1H, normalized (2.0x -> 10)
 *   - Phase/RSI — phase_pct position weighted by RSI posture
 *   - R:R       — swing R:R (>=3 -> 10, 0 -> 0)
 *   - Sector    — sector leadership vs SPY from ticker.sector_* fields
 *   - Volatility— compressed ATR % is good; bucketed into 0-10
 *   - Event     — inverse event risk (far from earnings / macro = 10)
 *   - Divergence— inverse divergence severity (clean = 10)
 */
(function () {
  const DIMENSIONS = [
    { key: "ltf", label: "LTF", hint: "10m/15m/30m trend alignment" },
    { key: "htf", label: "HTF", hint: "1H/4H/Daily trend alignment" },
    { key: "rvol", label: "RVol", hint: "Relative volume vs 20-bar avg" },
    { key: "phase", label: "Phase/RSI", hint: "Phase zone + RSI posture" },
    { key: "rr", label: "R:R", hint: "Swing risk:reward to next TP" },
    { key: "sector", label: "Sector", hint: "Sector strength vs SPY" },
    { key: "vol", label: "Volatility", hint: "ATR compression (tight = better)" },
    { key: "event", label: "Event", hint: "Inverse: distance from earnings / macro" },
    { key: "div", label: "Divergence", hint: "Inverse: indicator cleanness" },
  ];

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function numFrom(...candidates) {
    for (const c of candidates) {
      const v = Number(c);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  // ── Score calculators (each returns 0-10) ───────────────────────────
  function scoreLtf(ticker, dir) {
    const sign = dir === "SHORT" ? -1 : 1;
    const tf = ticker?.tf_tech || {};
    const picks = [tf["10"], tf["15"], tf["30"]];
    let sum = 0;
    let n = 0;
    for (const t of picks) {
      if (!t) continue;
      const st = Number(t.stDir);
      if (!Number.isFinite(st)) continue;
      n += 1;
      if (Math.sign(st) === sign) sum += 1;
      else if (st === 0) sum += 0.5;
    }
    if (n === 0) return 5;
    return clamp((sum / n) * 10, 0, 10);
  }

  function scoreHtf(ticker, dir) {
    const sign = dir === "SHORT" ? -1 : 1;
    const tf = ticker?.tf_tech || {};
    const picks = [
      { tf: tf["1H"] || tf["60"], w: 1 },
      { tf: tf["4H"] || tf["240"], w: 1.2 },
      { tf: tf["D"], w: 1.5 },
    ];
    let sum = 0;
    let wSum = 0;
    for (const p of picks) {
      if (!p.tf) continue;
      const st = Number(p.tf.stDir);
      if (!Number.isFinite(st)) continue;
      wSum += p.w;
      if (Math.sign(st) === sign) sum += p.w;
      else if (st === 0) sum += p.w * 0.5;
    }
    if (wSum === 0) return 5;
    return clamp((sum / wSum) * 10, 0, 10);
  }

  function scoreRvol(ticker) {
    const map = ticker?.rvol_map || {};
    const r30 = numFrom(map["30"]?.vr, map["30"]?.r5) ?? 0;
    const r1h = numFrom(map["60"]?.vr, map["60"]?.r5) ?? 0;
    const best = Math.max(r30, r1h);
    if (best <= 0) return 2;
    return clamp(((best - 0.5) / 1.5) * 10, 0, 10);
  }

  function scorePhase(ticker, dir) {
    const raw = numFrom(ticker?.saty_phase_pct, ticker?.phase_pct);
    if (raw == null) return 5;
    const phase = clamp(raw, 0, 100);
    const baseLong = phase < 30 ? 8 : phase < 60 ? 6 : phase < 80 ? 4 : 2;
    const baseShort = phase > 70 ? 8 : phase > 40 ? 6 : phase > 20 ? 4 : 2;
    let base = dir === "SHORT" ? baseShort : baseLong;
    const tf = ticker?.tf_tech || {};
    const rsi30 = numFrom(tf["30"]?.rsi?.r5);
    if (rsi30 != null) {
      if (dir === "SHORT") {
        if (rsi30 >= 65) base += 1.5;
        else if (rsi30 <= 40) base -= 1.5;
      } else {
        if (rsi30 <= 40) base += 1.5;
        else if (rsi30 >= 70) base -= 1.5;
      }
    }
    return clamp(base, 0, 10);
  }

  function scoreRR(ticker) {
    const rr = numFrom(ticker?.rr, ticker?.swing_rr, ticker?.rr_target);
    if (rr == null) return 5;
    return clamp((rr / 3) * 10, 0, 10);
  }

  function scoreSector(ticker) {
    const explicit = numFrom(
      ticker?.sector_strength,
      ticker?.sector_score_normalized,
      ticker?.sector_relative_strength,
    );
    if (explicit != null) return clamp(explicit, 0, 10);
    const rs = numFrom(ticker?.sector_rs_spy, ticker?.sector_beta_adj_rs);
    if (rs != null) return clamp(5 + rs * 50, 0, 10);
    const bucket = String(ticker?.sector_rating || "").toLowerCase();
    if (bucket.includes("lead")) return 8;
    if (bucket.includes("strong")) return 7;
    if (bucket.includes("neutral")) return 5;
    if (bucket.includes("weak")) return 3;
    if (bucket.includes("lag")) return 2;
    return 5;
  }

  function scoreVol(ticker) {
    const atrD = numFrom(ticker?.atr_d_pct, ticker?.atr_pct_d);
    let val = atrD;
    if (val == null) {
      const price = numFrom(ticker?.price, ticker?.current_price);
      const atr = numFrom(ticker?.atr_d);
      if (price && atr) val = (atr / price) * 100;
    }
    if (val == null) return 5;
    if (val <= 1.5) return 9;
    if (val <= 2.5) return 8;
    if (val <= 3.5) return 6;
    if (val <= 5.0) return 4;
    if (val <= 7.0) return 3;
    return 2;
  }

  function scoreEvent(ticker) {
    const daysToEarn = numFrom(
      ticker?.days_to_earnings,
      ticker?.earnings_days_until,
      ticker?.earnings_countdown_days,
    );
    const macro = ticker?.event_risk || ticker?._event_risk;
    const macroSeverity = String(macro?.severity || "").toLowerCase();
    const macroHours = numFrom(macro?.hoursToEvent);
    let base = 10;
    if (daysToEarn != null) {
      if (daysToEarn >= 0 && daysToEarn <= 1) base = 2;
      else if (daysToEarn <= 3) base = 4;
      else if (daysToEarn <= 7) base = 6;
      else if (daysToEarn <= 14) base = 8;
    }
    if (macroSeverity === "high") base = Math.min(base, 3);
    else if (macroSeverity === "medium") base = Math.min(base, 5);
    else if (macroSeverity === "low" && macroHours != null && macroHours <= 24) {
      base = Math.min(base, 6);
    }
    return clamp(base, 0, 10);
  }

  function scoreDivergence(ticker, dir) {
    const signFavors = dir === "SHORT" ? "bearish" : "bullish";
    const pd = ticker?.phase_divergence || {};
    const rd = ticker?.rsi_divergence || {};
    let clean = 10;
    const pdStr = String(pd.strength || pd.signal || "").toLowerCase();
    const rdStr = String(rd.strength || rd.signal || "").toLowerCase();
    const adverse = (s) => s && !s.includes(signFavors) && (s.includes("bear") || s.includes("bull") || s.includes("weak") || s.includes("strong"));
    if (adverse(pdStr)) clean -= pdStr.includes("strong") ? 4 : 2;
    if (adverse(rdStr)) clean -= rdStr.includes("strong") ? 4 : 2;
    if (pdStr.includes(signFavors)) clean += 1;
    if (rdStr.includes(signFavors)) clean += 1;
    return clamp(clean, 0, 10);
  }

  function computeScores(ticker, direction) {
    const dir = String(direction || ticker?.direction || ticker?.bias || "LONG").toUpperCase();
    return {
      ltf: scoreLtf(ticker, dir),
      htf: scoreHtf(ticker, dir),
      rvol: scoreRvol(ticker),
      phase: scorePhase(ticker, dir),
      rr: scoreRR(ticker),
      sector: scoreSector(ticker),
      vol: scoreVol(ticker),
      event: scoreEvent(ticker),
      div: scoreDivergence(ticker, dir),
      _direction: dir,
    };
  }

  // ── Native SVG radar (no Recharts dep — keeps bundle light and works
  // everywhere: Active Trader, Investor Mode, Trade Autopsy, Daily Brief).
  function SpiderSvg({ scores, size, compact, title, dir }) {
    const React = window.React;
    const cx = size / 2;
    const cy = size / 2;
    const radius = (size / 2) - (compact ? 26 : 34);
    const dims = DIMENSIONS;
    const n = dims.length;
    const angleFor = (i) => (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    const point = (score, i) => {
      const r = (clamp(score, 0, 10) / 10) * radius;
      const a = angleFor(i);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const rings = [0.25, 0.5, 0.75, 1];
    const pts = dims.map((d, i) => point(scores[d.key] ?? 5, i));
    const polyPoints = pts.map(p => p.join(",")).join(" ");

    const avg = dims.reduce((s, d) => s + (scores[d.key] ?? 5), 0) / dims.length;
    const dirColor = dir === "SHORT" ? "#f87171" : "#34d399";
    const dirFill = dir === "SHORT" ? "rgba(248,113,113,0.22)" : "rgba(52,211,153,0.22)";
    const labelFs = compact ? 9 : 10;
    const valueFs = compact ? 8 : 9;

    return React.createElement("svg", {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      role: "img",
      "aria-label": title || "Ticker score radar",
    },
      React.createElement("g", null,
        rings.map((r, i) => React.createElement("circle", {
          key: `ring-${i}`, cx, cy,
          r: radius * r,
          fill: "none",
          stroke: i === rings.length - 1 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)",
          strokeWidth: i === rings.length - 1 ? 1 : 0.6,
          strokeDasharray: i === rings.length - 1 ? "" : "3 3",
        })),
        dims.map((d, i) => {
          const [x2, y2] = point(10, i);
          return React.createElement("line", {
            key: `spoke-${d.key}`,
            x1: cx, y1: cy, x2, y2,
            stroke: "rgba(255,255,255,0.06)",
            strokeWidth: 0.6,
          });
        }),
        React.createElement("polygon", {
          points: polyPoints,
          fill: dirFill,
          stroke: dirColor,
          strokeWidth: 1.4,
          strokeLinejoin: "round",
        }),
        pts.map((p, i) => React.createElement("circle", {
          key: `pt-${i}`, cx: p[0], cy: p[1], r: compact ? 1.8 : 2.4,
          fill: dirColor,
        })),
        dims.map((d, i) => {
          const [lx, ly] = point(12.5, i);
          const s = scores[d.key] ?? 5;
          const v = Number.isFinite(s) ? s.toFixed(1) : "—";
          const anchor = Math.abs(lx - cx) < 6 ? "middle" : (lx > cx ? "start" : "end");
          return React.createElement("g", { key: `lbl-${d.key}` },
            React.createElement("text", {
              x: lx, y: ly,
              fontSize: labelFs,
              fontWeight: 600,
              fill: "#d1d5db",
              textAnchor: anchor,
              dominantBaseline: "middle",
            }, d.label),
            React.createElement("text", {
              x: lx,
              y: ly + labelFs + 1,
              fontSize: valueFs,
              fill: "#9ca3af",
              textAnchor: anchor,
              dominantBaseline: "middle",
            }, v),
          );
        }),
        React.createElement("text", {
          x: cx, y: cy - (compact ? 5 : 7),
          fontSize: compact ? 16 : 20,
          fontWeight: 700,
          fill: "#f9fafb",
          textAnchor: "middle",
        }, avg.toFixed(1)),
        React.createElement("text", {
          x: cx, y: cy + (compact ? 10 : 12),
          fontSize: compact ? 8 : 9,
          fontWeight: 500,
          fill: "#6b7280",
          textAnchor: "middle",
          letterSpacing: "0.12em",
        }, (dir || "LONG") + " SCORE"),
      ),
    );
  }

  window.TickerSpiderChartDimensions = DIMENSIONS;
  window.TickerSpiderScores = computeScores;

  window.TickerSpiderChartFactory = function (deps) {
    const React = (deps && deps.React) || window.React;
    if (!React) {
      return function Unavailable() { return null; };
    }
    return function TickerSpiderChart(props) {
      const ticker = props.ticker || {};
      const direction = String(props.direction || "").toUpperCase() || null;
      const compact = !!props.compact;
      const showLegend = props.showLegend !== false;
      const size = Number(props.size) || (compact ? 200 : 260);
      const scores = React.useMemo(() => computeScores(ticker, direction), [ticker, direction]);
      const dir = scores._direction;
      const avg = DIMENSIONS.reduce((s, d) => s + (scores[d.key] ?? 5), 0) / DIMENSIONS.length;
      const header = avg >= 7.5 ? "Strong setup" : avg >= 6 ? "Constructive" : avg >= 4 ? "Mixed" : "Weak";
      const headerColor = avg >= 7.5 ? "text-emerald-300" : avg >= 6 ? "text-sky-300" : avg >= 4 ? "text-amber-300" : "text-rose-300";

      return React.createElement("div", {
        className: "rounded-xl border border-white/[0.08] bg-white/[0.02] p-3",
      },
        React.createElement("div", { className: "flex items-start justify-between mb-2 gap-2" },
          React.createElement("div", null,
            React.createElement("div", {
              className: "text-[10px] uppercase tracking-[0.16em] text-[#6b7280]",
            }, "Signal Radar"),
            React.createElement("div", {
              className: `mt-0.5 text-xs font-semibold ${headerColor}`,
            }, header, " — ", dir),
          ),
          showLegend && React.createElement("div", {
            className: "text-[9px] text-[#6b7280] text-right leading-tight",
          }, "Scale 0-10", React.createElement("br"), "Direction-aware"),
        ),
        React.createElement("div", { className: "flex justify-center" },
          React.createElement(SpiderSvg, { scores, size, compact, dir, title: `${ticker.ticker || ""} signal radar` }),
        ),
        showLegend && React.createElement("div", {
          className: "mt-2 grid grid-cols-3 gap-1 text-[9px]",
        },
          DIMENSIONS.map((d) => {
            const v = scores[d.key] ?? 5;
            const color = v >= 7.5 ? "text-emerald-300" : v >= 5 ? "text-slate-300" : v >= 3 ? "text-amber-300" : "text-rose-300";
            return React.createElement("div", {
              key: d.key,
              className: "flex items-center justify-between gap-1 px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.04]",
              title: d.hint,
            },
              React.createElement("span", { className: "text-[#6b7280]" }, d.label),
              React.createElement("span", { className: `tabular-nums font-semibold ${color}` }, v.toFixed(1)),
            );
          }),
        ),
      );
    };
  };
})();
