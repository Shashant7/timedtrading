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

  // ── Direction inference ─────────────────────────────────────────────
  // Ticker payloads don't consistently carry an explicit `direction` field.
  // Fall back to swing_consensus -> state -> htf_score.
  function inferDirection(ticker, explicit) {
    if (explicit) {
      const e = String(explicit).toUpperCase();
      if (e === "LONG" || e === "SHORT") return e;
    }
    const sc = ticker?.swing_consensus?.direction;
    if (sc === "LONG" || sc === "SHORT") return sc;
    const state = String(ticker?.state || "").toUpperCase();
    if (state.startsWith("HTF_BULL")) return "LONG";
    if (state.startsWith("HTF_BEAR")) return "SHORT";
    const bias = String(ticker?.bias || ticker?.direction || "").toUpperCase();
    if (bias === "LONG" || bias === "SHORT") return bias;
    const htf = Number(ticker?.htf_score);
    if (Number.isFinite(htf)) return htf >= 0 ? "LONG" : "SHORT";
    return "LONG";
  }

  // ── Score calculators (each returns 0-10) ───────────────────────────

  // LTF alignment across 10m / 15m / 30m ST direction.
  // Falls back to ltf_score (−25..+25) if tf_tech ST missing.
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
    if (n === 0) {
      const ltf = numFrom(ticker?.ltf_score);
      if (ltf != null) return clamp(5 + (sign * ltf) / 5, 0, 10);
      return 5;
    }
    return clamp((sum / n) * 10, 0, 10);
  }

  // HTF alignment across 1H / 4H / D ST. Blends ST vote with htf_score
  // (signed −25..+25) so HTF doesn't zero out just because one TF is
  // counter-trend (e.g. daily vs lower TF pullback).
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
    const htf = numFrom(ticker?.htf_score);
    if (wSum > 0) {
      const stScore = (sum / wSum) * 10;
      if (htf != null) {
        const htfScore = clamp(5 + (sign * htf) / 5, 0, 10);
        return clamp(stScore * 0.6 + htfScore * 0.4, 0, 10);
      }
      return clamp(stScore, 0, 10);
    }
    if (htf != null) return clamp(5 + (sign * htf) / 5, 0, 10);
    return 5;
  }

  // Relative volume — best of 30m / 1H / 10m from rvol_map[tf].vr
  function scoreRvol(ticker) {
    const map = ticker?.rvol_map || {};
    const r30 = numFrom(map["30"]?.vr, map["30"]?.r5);
    const r1h = numFrom(map["60"]?.vr, map["60"]?.r5, map["1H"]?.vr);
    const r10 = numFrom(map["10"]?.vr, map["10"]?.r5);
    const cands = [r30, r1h, r10].filter((x) => x != null);
    if (cands.length === 0) return 5;
    const best = Math.max(...cands);
    if (best <= 0) return 2;
    return clamp(((best - 0.5) / 1.5) * 10, 0, 10);
  }

  // Phase/RSI — payload has `saty_phase_pct` as 0..1 typically; sometimes 0..100.
  function scorePhase(ticker, dir) {
    const raw = numFrom(ticker?.saty_phase_pct, ticker?.phase_pct);
    if (raw == null) return 5;
    const phase01 = raw > 1.5 ? raw / 100 : raw;
    const phase = clamp(phase01 * 100, 0, 100);
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

  // R:R — derive from sl/tp if explicit rr missing (the live payload has
  // `tp_target_price`, `tp_trim`, `sl`, `sl_dynamic` but often no `rr`).
  function scoreRR(ticker) {
    const explicit = numFrom(ticker?.rr, ticker?.swing_rr, ticker?.rr_target, ticker?.rr_now_likely);
    if (explicit != null && explicit > 0) return clamp((explicit / 3) * 10, 0, 10);
    const price = numFrom(ticker?.price, ticker?.current_price);
    const sl = numFrom(ticker?.sl, ticker?.sl_dynamic);
    const tp = numFrom(ticker?.tp_target_price, ticker?.tp_exit, ticker?.tp_likely, ticker?.tp);
    if (price != null && sl != null && tp != null && price > 0) {
      const risk = Math.abs(price - sl);
      const reward = Math.abs(tp - price);
      if (risk > 0) return clamp((reward / risk / 3) * 10, 0, 10);
    }
    return 5;
  }

  // Sector — OW/N/UW rating (from SECTOR_RATINGS) direction-adjusted.
  // LONG: OW=10, N=5, UW=2.  SHORT: OW=2, N=5, UW=10.
  function scoreSector(ticker, dir) {
    const rating = String(
      ticker?._sector_rating ||
      ticker?.sector_rating ||
      ticker?.sectorRating ||
      ""
    ).toLowerCase();
    if (rating) {
      if (dir === "SHORT") {
        if (rating === "overweight") return 2;
        if (rating === "underweight") return 10;
        return 5;
      }
      if (rating === "overweight") return 10;
      if (rating === "underweight") return 2;
      return 5;
    }
    const rs = numFrom(ticker?.sector_rs_spy, ticker?.sector_beta_adj_rs);
    if (rs != null) {
      const base = clamp(5 + rs * 50, 0, 10);
      return dir === "SHORT" ? clamp(10 - base, 0, 10) : base;
    }
    return 5;
  }

  // Volatility — ATR% of price. Tighter ATR = higher score.
  function scoreVol(ticker) {
    let val = numFrom(ticker?.atr_d_pct, ticker?.atr_pct_d);
    if (val == null) {
      const price = numFrom(ticker?.price, ticker?.current_price, ticker?.prev_close);
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

  // Event risk — inverse of earnings proximity + macro severity.
  // V2.1 round 3 (2026-05-01) — Previously this returned 10 for nearly every
  // ticker because the per-ticker payload doesn't include days_to_earnings.
  // Now we also consult the global window._ttEarningsMap (built once in App
  // from /timed/earnings/upcoming) so the score reflects real EPS proximity.
  function scoreEvent(ticker) {
    let daysToEarn = numFrom(
      ticker?.days_to_earnings,
      ticker?.earnings_days_until,
      ticker?.earnings_countdown_days,
      ticker?.__earnings_days,
    );
    if (daysToEarn == null && typeof window !== "undefined" && window._ttEarningsMap) {
      const sym = String(ticker?.ticker || ticker?.symbol || "").toUpperCase();
      const evt = sym && window._ttEarningsMap[sym];
      if (evt && Number.isFinite(evt._daysAway)) daysToEarn = evt._daysAway;
    }
    const macro = ticker?.event_risk || ticker?._event_risk || ticker?.__eventRiskProfile;
    const macroSeverity = String(macro?.severity || "").toLowerCase();
    const macroHours = numFrom(macro?.hoursToEvent);
    /* If we have NO event signal at all, return 7 instead of 10 — the
       neutral "we don't know of an event" stance, not "definitely safe". */
    let base = (daysToEarn == null && !macroSeverity) ? 7 : 10;
    if (daysToEarn != null) {
      if (daysToEarn >= 0 && daysToEarn <= 1) base = 1;
      else if (daysToEarn <= 3) base = 3;
      else if (daysToEarn <= 7) base = 5;
      else if (daysToEarn <= 14) base = 7;
      else if (daysToEarn <= 30) base = 9;
      else base = 10;
    }
    if (macroSeverity === "high") base = Math.min(base, 3);
    else if (macroSeverity === "medium") base = Math.min(base, 5);
    else if (macroSeverity === "low" && macroHours != null && macroHours <= 24) {
      base = Math.min(base, 6);
    }
    return clamp(base, 0, 10);
  }

  // Divergence — real payload is tf-keyed:
  //   rsi_divergence["15"].bear = { active, strength, barsSince }
  //   rsi_divergence["15"].bull = { ... }
  // Active AGAINST direction subtracts; active WITH direction adds.
  function scoreDivergence(ticker, dir) {
    const favorSide = dir === "SHORT" ? "bear" : "bull";
    const opposeSide = dir === "SHORT" ? "bull" : "bear";
    let score = 10;
    const evalMap = (map) => {
      if (!map || typeof map !== "object") return;
      for (const tf of Object.keys(map)) {
        const entry = map[tf];
        if (!entry || typeof entry !== "object") continue;
        const against = entry[opposeSide];
        if (against && against.active === true) {
          const str = numFrom(against.strength) ?? 10;
          score -= clamp(str / 10, 0.5, 4);
        }
        const withDir = entry[favorSide];
        if (withDir && withDir.active === true) {
          const str = numFrom(withDir.strength) ?? 10;
          score += clamp(str / 20, 0.25, 1.5);
        }
      }
    };
    evalMap(ticker?.rsi_divergence);
    evalMap(ticker?.phase_divergence);
    return clamp(score, 0, 10);
  }

  function computeScores(ticker, direction) {
    const dir = inferDirection(ticker, direction);
    return {
      ltf: scoreLtf(ticker, dir),
      htf: scoreHtf(ticker, dir),
      rvol: scoreRvol(ticker),
      phase: scorePhase(ticker, dir),
      rr: scoreRR(ticker),
      sector: scoreSector(ticker, dir),
      vol: scoreVol(ticker),
      event: scoreEvent(ticker),
      div: scoreDivergence(ticker, dir),
      _direction: dir,
    };
  }

  /* V2 spider (2026-05-01) — Inspiration 3 styling.
     Single solid muted-purple-gray fill, only the outer pentagon edge
     drawn (no concentric rings), label-only at each vertex, uppercase
     tracked caption styling. Center: big avg score in JBM. */
  function SpiderSvg({ scores, size, compact, title, dir }) {
    const React = window.React;
    const cx = size / 2;
    const cy = size / 2;
    const radius = (size / 2) - (compact ? 28 : 36);
    const dims = DIMENSIONS;
    const n = dims.length;
    const angleFor = (i) => (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    const point = (score, i) => {
      const r = (clamp(score, 0, 10) / 10) * radius;
      const a = angleFor(i);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    const pts = dims.map((d, i) => point(scores[d.key] ?? 5, i));
    const polyPoints = pts.map(p => p.join(",")).join(" ");
    const outerPts = dims.map((_, i) => point(10, i));
    const outerPoly = outerPts.map(p => p.join(",")).join(" ");

    const avg = dims.reduce((s, d) => s + (scores[d.key] ?? 5), 0) / dims.length;
    /* v2 fill: muted violet-grey (Inspiration 3) for both directions; the
       direction is communicated via the chip in the panel header, not via
       chart fill color — keeps the eye on the SHAPE not the COLOR. */
    const dataFill = "rgba(167, 139, 250, 0.20)";
    const dataStroke = "rgba(167, 139, 250, 0.55)";
    const labelFs = compact ? 9 : 10;
    const labelTracking = "0.16em";

    return React.createElement("svg", {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      role: "img",
      "aria-label": title || "Ticker score radar",
      style: { display: "block" },
    },
      React.createElement("g", null,
        // Outer pentagon edge (only ring drawn — Inspiration 3 minimalism)
        React.createElement("polygon", {
          points: outerPoly,
          fill: "none",
          stroke: "rgba(255,255,255,0.14)",
          strokeWidth: 1,
          strokeLinejoin: "round",
        }),
        // Spokes — very faint
        dims.map((d, i) => {
          const [x2, y2] = outerPts[i];
          return React.createElement("line", {
            key: `spoke-${d.key}`,
            x1: cx, y1: cy, x2, y2,
            stroke: "rgba(255,255,255,0.04)",
            strokeWidth: 1,
          });
        }),
        // Data polygon — single solid fill
        React.createElement("polygon", {
          points: polyPoints,
          fill: dataFill,
          stroke: dataStroke,
          strokeWidth: 1.5,
          strokeLinejoin: "round",
        }),
        // Vertex dots
        pts.map((p, i) => React.createElement("circle", {
          key: `pt-${i}`, cx: p[0], cy: p[1], r: compact ? 2 : 2.5,
          fill: dataStroke,
        })),
        // Vertex labels — caption type, no values (less visual noise)
        dims.map((d, i) => {
          const [lx, ly] = point(13, i);
          const anchor = Math.abs(lx - cx) < 6 ? "middle" : (lx > cx ? "start" : "end");
          return React.createElement("text", {
            key: `lbl-${d.key}`,
            x: lx, y: ly,
            fontSize: labelFs,
            fontWeight: 700,
            fontFamily: "var(--tt-font-ui)",
            fill: "#8C92A0",
            textAnchor: anchor,
            dominantBaseline: "middle",
            letterSpacing: labelTracking,
            style: { textTransform: "uppercase" },
          }, d.label.toUpperCase());
        }),
        // Center: hero avg score in JBM
        React.createElement("text", {
          x: cx, y: cy - (compact ? 4 : 6),
          fontSize: compact ? 22 : 28,
          fontWeight: 600,
          fontFamily: "var(--tt-font-mono)",
          fill: "#F4F5F7",
          textAnchor: "middle",
          letterSpacing: "-0.02em",
        }, avg.toFixed(1)),
        React.createElement("text", {
          x: cx, y: cy + (compact ? 12 : 16),
          fontSize: compact ? 8 : 9,
          fontWeight: 700,
          fontFamily: "var(--tt-font-ui)",
          fill: "#5C6270",
          textAnchor: "middle",
          letterSpacing: "0.18em",
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
      /* v2 (2026-05-01) — header chip uses gold accent / direction semantic */
      const headerChipClass = avg >= 7.5 ? "ds-chip ds-chip--up"
                              : avg >= 6 ? "ds-chip ds-chip--accent"
                              : avg >= 4 ? "ds-chip"
                              : "ds-chip ds-chip--dn";

      return React.createElement("div", {
        className: "ds-glass",
      },
        React.createElement("div", { className: "ds-glass__head" },
          React.createElement("div", { className: "ds-glass__title" }, "Signal Radar"),
          React.createElement("span", { className: `${headerChipClass} ds-chip--sm`, title: `Avg score ${avg.toFixed(1)} / 10` },
            header, " · ", dir,
          ),
        ),
        React.createElement("div", { style: { display: "flex", justifyContent: "center" } },
          React.createElement(SpiderSvg, { scores, size, compact, dir, title: `${ticker.ticker || ""} signal radar` }),
        ),
        showLegend && React.createElement("div", {
          style: {
            marginTop: "var(--ds-space-3)",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "var(--ds-space-1)",
          },
        },
          DIMENSIONS.map((d) => {
            const v = scores[d.key] ?? 5;
            const color = v >= 7.5 ? "var(--ds-up)"
                          : v >= 5 ? "var(--ds-text-display)"
                          : v >= 3 ? "var(--ds-accent)"
                          : "var(--ds-dn)";
            return React.createElement("div", {
              key: d.key,
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 4,
                padding: "4px 8px",
                borderRadius: "var(--ds-radius-xs)",
                background: "var(--ds-bg-glass)",
                fontSize: "var(--ds-fs-meta)",
              },
              title: d.hint,
            },
              React.createElement("span", { style: { color: "var(--ds-text-muted)" } }, d.label),
              React.createElement("span", {
                style: {
                  fontFamily: "var(--tt-font-mono)",
                  fontWeight: 600,
                  color,
                  fontVariantNumeric: "tabular-nums",
                },
              }, v.toFixed(1)),
            );
          }),
        ),
      );
    };
  };
})();
