// worker/chart-svg.js
//
// 2026-06-01 — Server-side SVG chart generator for email + lightweight
// embed surfaces.
//
// Why SVG (not PNG):
//   - Zero dependencies. Pure string templating.
//   - Renders inline in modern email clients (Gmail web, Apple Mail,
//     Outlook 2016+). Older Outlook can still fetch via `<img src=...>`
//     because we serve from a public route with `Content-Type:
//     image/svg+xml`.
//   - Sharp at any DPI. Email clients on retina displays look clean.
//   - Cheap to generate (~5ms per chart in a Worker).
//
// What's drawn (default):
//   - Background panel matching the email's dark theme
//   - Line chart of close prices over N bars (default 48 = ~2 trading days @ 1H)
//   - Optional horizontal annotation lines: entry (white), stop loss
//     (red), take profit (green) — for trade-alert context
//   - Min/max price labels in the gutters
//   - Latest price + ticker + timeframe label in the header
//
// Inputs: array of candles { ts, o, h, l, c, v }. The endpoint pulls
// these from ticker_candles in D1 and passes them through.

const PANEL_W = 600;
const PANEL_H = 280;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 38;
const PAD_BOTTOM = 28;
const PLOT_W = PANEL_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = PANEL_H - PAD_TOP - PAD_BOTTOM;

const COLORS = {
  bg: "#0b0e11",
  panel: "#111318",
  border: "#1e2128",
  text: "#e5e7eb",
  textMuted: "#9ca3af",
  textFaint: "#6b7280",
  gridLine: "#1a1d22",
  upColor: "#00c853",
  downColor: "#f43f5e",
  entryLine: "#ffffff",
  slLine: "#f43f5e",
  tpLine: "#00c853",
  trendLine: "#a78bfa",
};

function _fmtPrice(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function _fmtTimeHHMM(ts) {
  try {
    return new Date(Number(ts)).toLocaleString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "America/New_York", hour12: false,
    });
  } catch (_) { return ""; }
}

function _fmtDateMMDD(ts) {
  try {
    return new Date(Number(ts)).toLocaleString("en-US", {
      month: "numeric", day: "numeric", timeZone: "America/New_York",
    });
  } catch (_) { return ""; }
}

function _isDayWeekMonth(tf) {
  const t = String(tf || "").toUpperCase();
  return t === "D" || t === "1D" || t === "W" || t === "1W" || t === "M" || t === "1M";
}

function _utcDayKey(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Daily/weekly D1 rows sometimes carry two stamps for the same
 * session (00:00 UTC and 04:00 UTC) with the same OHLC. AMAT's
 * weekend chart drew each June/July day twice. Collapse to one
 * bar per UTC day; prefer the later stamp / higher volume.
 */
export function collapseChartCandles(candles, tf) {
  const list = Array.isArray(candles) ? candles.filter((c) => c && Number.isFinite(Number(c.c))) : [];
  if (list.length < 2) return list;
  if (!_isDayWeekMonth(tf)) {
    const seen = new Set();
    const out = [];
    for (const c of list) {
      const ts = Number(c.ts) || 0;
      if (seen.has(ts)) continue;
      seen.add(ts);
      out.push(c);
    }
    return out;
  }
  const byDay = new Map();
  for (const c of list) {
    const ts = Number(c.ts);
    const key = _utcDayKey(ts);
    if (!key) continue;
    const prev = byDay.get(key);
    if (!prev) {
      byDay.set(key, c);
      continue;
    }
    const prevTs = Number(prev.ts) || 0;
    const prevV = Number(prev.v) || 0;
    const nextV = Number(c.v) || 0;
    if (ts > prevTs || (ts === prevTs && nextV > prevV)) byDay.set(key, c);
  }
  return [...byDay.values()].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/**
 * Render an SVG chart for an array of candles. Returns the SVG string.
 *
 * @param {object} opts
 * @param {Array<{ts:number,o:number,h:number,l:number,c:number,v?:number}>} opts.candles
 * @param {string} opts.ticker
 * @param {string} [opts.tf="60"]   Display label (1H, 5M, D, etc.)
 * @param {number} [opts.entry]     Horizontal annotation (white solid)
 * @param {number} [opts.sl]        Stop-loss annotation (red dashed)
 * @param {number} [opts.tp]        Take-profit annotation (green dashed)
 * @param {string} [opts.subtitle]  Small label below ticker (e.g. "Entry +1.4% · 14:22 ET")
 * @param {string} [opts.style="line"]  `line` (trade alerts) or `candles` (gaps / weekend desk)
 * @param {number} [opts.tl0]       Trendline price at the first visible bar
 * @param {number} [opts.tl1]       Trendline price at the last visible bar
 * @param {string} [opts.tlLabel]   Trendline role ("Support" / "Resistance")
 * @param {string} [opts.levelLabel] Horizontal level role instead of "E"
 * @returns {string} SVG string
 */
export function renderChartSvg(opts) {
  const candles = collapseChartCandles(
    Array.isArray(opts?.candles) ? opts.candles : [],
    opts?.tf,
  );
  const ticker = String(opts?.ticker || "").toUpperCase();
  const tfLabel = _formatTfLabel(opts?.tf);
  const styleRaw = String(opts?.style || "line").toLowerCase();
  const candleStyle = styleRaw === "candles" || styleRaw === "candle" || styleRaw === "ohlc";
  /* 2026-06-01 — Strict positive-price guard for annotations.

     The DIA EXIT email rendered a flat-line chart with y-axis -25.69 to
     539.4 and an "SL 0.00" label at the bottom-right. Bug chain:

       1. Email passed sl=0 (exit has no live stop) → URL sl=0
       2. Chart endpoint: Number("0") || null === null → sl=null
       3. renderChartSvg: Number.isFinite(Number(null)) === Number.isFinite(0)
          === true → sl coerced to 0
       4. yMin/yMax expanded down to 0 → candles squeezed to ~1% of plot
          height → visually empty chart

     Fix: prices for a real equity / ETF are always > 0. Require both
     `Number.isFinite` AND `> 0` for any annotation value. Zero or
     negative passes as null (no annotation). */
  const _toPositivePrice = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const entry = _toPositivePrice(opts?.entry);
  const sl = _toPositivePrice(opts?.sl);
  const tp = _toPositivePrice(opts?.tp);
  const tl0 = _toPositivePrice(opts?.tl0);
  const tl1 = _toPositivePrice(opts?.tl1);
  const tlSpanRaw = Number(opts?.tlSpan ?? opts?.tl_span);
  const tlSpan = Number.isFinite(tlSpanRaw) && tlSpanRaw > 0 ? Math.round(tlSpanRaw) : null;
  const tlLabel = String(opts?.tlLabel || opts?.tl_label || "").slice(0, 24);
  const levelLabel = String(opts?.levelLabel || opts?.level_label || "").slice(0, 24);
  const subtitle = String(opts?.subtitle || "").slice(0, 80);

  // ── Empty-state ─────────────────────────────────────────────────────
  if (candles.length < 2) {
    return _emptyStateSvg(ticker, tfLabel, "Chart not available — no recent candles");
  }

  // ── Price-range computation ────────────────────────────────────────
  // Use high/low when available, fallback to close. Pad ±2% so the line
  // doesn't kiss the panel edges, and ensure annotation lines fit.
  const highs = candles.map(c => Number(c.h) || Number(c.c));
  const lows  = candles.map(c => Number(c.l) || Number(c.c));
  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  let yMin = priceMin;
  let yMax = priceMax;
  /* 2026-06-01 — Outlier guard on annotations. Even with the >0 filter
     above, a stale or wrong annotation (e.g. SL from a previous trade
     at a price that's been left far behind) can still blow up the
     y-axis. Reject any annotation whose absolute distance from the
     price band is more than 30% of the price midpoint — that's outside
     the chart's useful viewing range anyway, and including it would
     render the candles as a thin sliver. */
  const _priceMid = (priceMin + priceMax) / 2;
  const _maxAnnotDist = Math.max(_priceMid * 0.30, (priceMax - priceMin) * 4);
  const _annotIncluded = [];
  const _annotExcluded = [];
  for (const [label, v] of [["entry", entry], ["sl", sl], ["tp", tp], ["tl0", tl0], ["tl1", tl1]]) {
    if (v == null) continue;
    if (Math.abs(v - _priceMid) > _maxAnnotDist) {
      _annotExcluded.push({ label, value: v });
      continue;
    }
    _annotIncluded.push({ label, value: v });
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  if (_annotExcluded.length > 0) {
    console.warn(
      `[chart-svg] ${ticker} ${tfLabel} — excluded ${_annotExcluded.length} annotation(s) out of range ` +
      `(price band $${priceMin.toFixed(2)}-$${priceMax.toFixed(2)}, mid $${_priceMid.toFixed(2)}): ` +
      _annotExcluded.map(a => `${a.label}=$${a.value.toFixed(2)}`).join(", "),
    );
  }
  const pad = (yMax - yMin) * 0.05 || (yMax * 0.005) || 1;
  yMin -= pad;
  yMax += pad;
  const yRange = (yMax - yMin) || 1;

  // ── Coordinate helpers ─────────────────────────────────────────────
  const xFor = (i) => PAD_LEFT + (i / Math.max(1, candles.length - 1)) * PLOT_W;
  const yFor = (price) => PAD_TOP + PLOT_H - ((Number(price) - yMin) / yRange) * PLOT_H;

  // ── Line path ──────────────────────────────────────────────────────
  const linePoints = candles.map((c, i) => `${xFor(i).toFixed(1)},${yFor(c.c).toFixed(1)}`).join(" ");
  const firstClose = Number(candles[0].c);
  const lastClose = Number(candles[candles.length - 1].c);
  const lineColor = lastClose >= firstClose ? COLORS.upColor : COLORS.downColor;

  // ── Area fill under the line for visual weight ─────────────────────
  const areaPath = (() => {
    const points = candles.map((c, i) => `${xFor(i).toFixed(1)},${yFor(c.c).toFixed(1)}`);
    return [
      `M ${PAD_LEFT.toFixed(1)},${(PAD_TOP + PLOT_H).toFixed(1)}`,
      ...points.map(p => `L ${p}`),
      `L ${xFor(candles.length - 1).toFixed(1)},${(PAD_TOP + PLOT_H).toFixed(1)}`,
      "Z",
    ].join(" ");
  })();

  // ── Horizontal grid lines (4 evenly spaced) ────────────────────────
  const gridYs = [0.25, 0.5, 0.75].map(frac => PAD_TOP + frac * PLOT_H);
  const gridLines = gridYs.map(y =>
    `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.gridLine}" stroke-width="1" stroke-dasharray="2,4" />`
  ).join("");

  /* ── Annotation lines (entry / SL / TP) ─────────────────────────────
     2026-06-01 — Only draw annotations that survived the in-range
     filter above. _annotIncluded was populated with the kept values. */
  const _annotByLabel = {};
  for (const a of _annotIncluded) _annotByLabel[a.label] = a.value;
  const annotations = [];
  if (_annotByLabel.entry != null) {
    const y = yFor(_annotByLabel.entry).toFixed(1);
    const eLabel = levelLabel || "E";
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.entryLine}" stroke-width="1.2" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.entryLine}" text-anchor="end">${_escape(eLabel)} ${_fmtPrice(_annotByLabel.entry)}</text>`,
    );
  }
  if (_annotByLabel.sl != null) {
    const y = yFor(_annotByLabel.sl).toFixed(1);
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.slLine}" stroke-width="1" stroke-dasharray="4,3" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.slLine}" text-anchor="end">SL ${_fmtPrice(_annotByLabel.sl)}</text>`,
    );
  }
  if (_annotByLabel.tp != null) {
    const y = yFor(_annotByLabel.tp).toFixed(1);
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.tpLine}" stroke-width="1" stroke-dasharray="4,3" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.tpLine}" text-anchor="end">TP ${_fmtPrice(_annotByLabel.tp)}</text>`,
    );
  }
  if (tl0 != null && tl1 != null) {
    const lastIdx = candles.length - 1;
    const startIdx = tlSpan != null
      ? Math.max(0, lastIdx - tlSpan)
      : 0;
    const xA = candleStyle
      ? PAD_LEFT + ((startIdx + 0.5) / candles.length) * PLOT_W
      : xFor(startIdx);
    const xB = candleStyle
      ? PAD_LEFT + ((lastIdx + 0.5) / candles.length) * PLOT_W
      : xFor(lastIdx);
    const yA = yFor(tl0);
    const yB = yFor(tl1);
    annotations.push(
      `<line x1="${xA.toFixed(1)}" y1="${yA.toFixed(1)}" x2="${xB.toFixed(1)}" y2="${yB.toFixed(1)}" stroke="${COLORS.trendLine}" stroke-width="1.6" />`,
    );
    if (tlLabel) {
      annotations.push(
        `<text x="${(xB - 4).toFixed(1)}" y="${(yB - 5).toFixed(1)}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.trendLine}" text-anchor="end">${_escape(tlLabel)} ${_fmtPrice(tl1)}</text>`,
      );
    }
  }

  // ── Y-axis labels (top + bottom) ────────────────────────────────────
  const yLabelTop = `<text x="${PAD_LEFT - 6}" y="${PAD_TOP + 4}" font-family="Menlo,Monaco,monospace" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${_fmtPrice(yMax)}</text>`;
  const yLabelBot = `<text x="${PAD_LEFT - 6}" y="${PAD_TOP + PLOT_H + 4}" font-family="Menlo,Monaco,monospace" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${_fmtPrice(yMin)}</text>`;

  // ── X-axis labels (first + last timestamp) ─────────────────────────
  const firstTs = Number(candles[0].ts);
  const lastTs = Number(candles[candles.length - 1].ts);
  const xLeft = _isDayWeekMonth(opts?.tf)
    ? _fmtDateMMDD(firstTs)
    : `${_fmtDateMMDD(firstTs)} ${_fmtTimeHHMM(firstTs)}`.trim();
  const xRight = _isDayWeekMonth(opts?.tf)
    ? _fmtDateMMDD(lastTs)
    : `${_fmtDateMMDD(lastTs)} ${_fmtTimeHHMM(lastTs)}`.trim();
  const xLabelLeft = `<text x="${PAD_LEFT}" y="${PANEL_H - 8}" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textFaint}">${xLeft}</text>`;
  const xLabelRight = `<text x="${PAD_LEFT + PLOT_W}" y="${PANEL_H - 8}" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${xRight}</text>`;

  // ── Header row ─────────────────────────────────────────────────────
  const lastPriceFmt = _fmtPrice(lastClose);
  const changePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose * 100) : 0;
  const changeSign = changePct >= 0 ? "+" : "";
  const changeColor = changePct >= 0 ? COLORS.upColor : COLORS.downColor;

  const header = [
    `<text x="${PAD_LEFT}" y="20" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="14" fill="${COLORS.text}">${_escape(ticker)}</text>`,
    `<text x="${PAD_LEFT + 8 + ticker.length * 9}" y="20" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textMuted}">${_escape(tfLabel)}</text>`,
    `<text x="${PAD_LEFT + PLOT_W}" y="20" font-family="Menlo,Monaco,monospace" font-weight="700" font-size="14" fill="${COLORS.text}" text-anchor="end">$${lastPriceFmt}</text>`,
    `<text x="${PAD_LEFT + PLOT_W}" y="34" font-family="Menlo,Monaco,monospace" font-size="10" fill="${changeColor}" text-anchor="end">${changeSign}${changePct.toFixed(2)}%</text>`,
  ].join("");
  const subtitleEl = subtitle
    ? `<text x="${PAD_LEFT}" y="34" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textMuted}">${_escape(subtitle)}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H}" viewBox="0 0 ${PANEL_W} ${PANEL_H}">
  <rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" fill="${COLORS.bg}" />
  <rect x="0.5" y="0.5" width="${PANEL_W - 1}" height="${PANEL_H - 1}" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="1" rx="6" />
  ${header}
  ${subtitleEl}
  ${gridLines}
  ${candleStyle ? _renderCandleBodies(candles, xFor, yFor, PLOT_W) : `<path d="${areaPath}" fill="${lineColor}" opacity="0.10" /><polyline points="${linePoints}" fill="none" stroke="${lineColor}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />`}
  ${annotations.join("")}
  ${yLabelTop}
  ${yLabelBot}
  ${xLabelLeft}
  ${xLabelRight}
</svg>`;
}

function _ohlcOf(c) {
  const close = Number(c?.c);
  if (!Number.isFinite(close)) return null;
  const open = Number.isFinite(Number(c.o)) ? Number(c.o) : close;
  const high = Number.isFinite(Number(c.h)) ? Number(c.h) : Math.max(open, close);
  const low = Number.isFinite(Number(c.l)) ? Number(c.l) : Math.min(open, close);
  return { o: open, h: high, l: low, c: close };
}

function _renderCandleBodies(candles, _xFor, yFor, plotW) {
  const n = candles.length;
  const slot = plotW / Math.max(n, 1);
  const bodyW = Math.max(1.2, Math.min(6.5, slot * 0.62));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const bar = _ohlcOf(candles[i]);
    if (!bar) continue;
    const x = PAD_LEFT + (i + 0.5) * slot;
    const yH = yFor(bar.h);
    const yL = yFor(bar.l);
    const yO = yFor(bar.o);
    const yC = yFor(bar.c);
    const color = bar.c >= bar.o ? COLORS.upColor : COLORS.downColor;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${color}" stroke-width="1"/>`,
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}" fill="${color}"/>`,
    );
  }
  return parts.join("");
}

function _formatTfLabel(tf) {
  const t = String(tf || "60").toUpperCase();
  if (t === "60" || t === "1H" || t === "H") return "1H";
  if (t === "5" || t === "5M") return "5M";
  if (t === "15" || t === "15M") return "15M";
  if (t === "30" || t === "30M") return "30M";
  if (t === "240" || t === "4H") return "4H";
  if (t === "D" || t === "1D") return "Daily";
  if (t === "W" || t === "1W") return "Weekly";
  if (t === "M" || t === "1M") return "Monthly";
  return t;
}

function _escape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _emptyStateSvg(ticker, tfLabel, msg) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H}" viewBox="0 0 ${PANEL_W} ${PANEL_H}">
  <rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" fill="${COLORS.bg}" />
  <rect x="0.5" y="0.5" width="${PANEL_W - 1}" height="${PANEL_H - 1}" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="1" rx="6" />
  <text x="${PAD_LEFT}" y="20" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="14" fill="${COLORS.text}">${_escape(String(ticker || "—"))}</text>
  <text x="${PAD_LEFT + 8 + (String(ticker || "—").length * 9)}" y="20" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textMuted}">${_escape(tfLabel)}</text>
  <text x="${PANEL_W / 2}" y="${PANEL_H / 2}" font-family="Inter,Arial,sans-serif" font-size="12" fill="${COLORS.textFaint}" text-anchor="middle">${_escape(msg)}</text>
</svg>`;
}
