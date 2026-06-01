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
 * @returns {string} SVG string
 */
export function renderChartSvg(opts) {
  const candles = Array.isArray(opts?.candles) ? opts.candles.filter(c => c && Number.isFinite(Number(c.c))) : [];
  const ticker = String(opts?.ticker || "").toUpperCase();
  const tfLabel = _formatTfLabel(opts?.tf);
  const entry = Number.isFinite(Number(opts?.entry)) ? Number(opts.entry) : null;
  const sl = Number.isFinite(Number(opts?.sl)) ? Number(opts.sl) : null;
  const tp = Number.isFinite(Number(opts?.tp)) ? Number(opts.tp) : null;
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
  let yMin = Math.min(...lows);
  let yMax = Math.max(...highs);
  for (const v of [entry, sl, tp]) {
    if (Number.isFinite(v)) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
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

  // ── Annotation lines (entry / SL / TP) ─────────────────────────────
  const annotations = [];
  if (entry !== null) {
    const y = yFor(entry).toFixed(1);
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.entryLine}" stroke-width="1.2" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.entryLine}" text-anchor="end">E ${_fmtPrice(entry)}</text>`,
    );
  }
  if (sl !== null) {
    const y = yFor(sl).toFixed(1);
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.slLine}" stroke-width="1" stroke-dasharray="4,3" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.slLine}" text-anchor="end">SL ${_fmtPrice(sl)}</text>`,
    );
  }
  if (tp !== null) {
    const y = yFor(tp).toFixed(1);
    annotations.push(
      `<line x1="${PAD_LEFT}" x2="${PAD_LEFT + PLOT_W}" y1="${y}" y2="${y}" stroke="${COLORS.tpLine}" stroke-width="1" stroke-dasharray="4,3" />`,
      `<text x="${PAD_LEFT + PLOT_W - 4}" y="${Number(y) - 4}" font-family="Menlo,Monaco,monospace" font-size="9" fill="${COLORS.tpLine}" text-anchor="end">TP ${_fmtPrice(tp)}</text>`,
    );
  }

  // ── Y-axis labels (top + bottom) ────────────────────────────────────
  const yLabelTop = `<text x="${PAD_LEFT - 6}" y="${PAD_TOP + 4}" font-family="Menlo,Monaco,monospace" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${_fmtPrice(yMax)}</text>`;
  const yLabelBot = `<text x="${PAD_LEFT - 6}" y="${PAD_TOP + PLOT_H + 4}" font-family="Menlo,Monaco,monospace" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${_fmtPrice(yMin)}</text>`;

  // ── X-axis labels (first + last timestamp) ─────────────────────────
  const firstTs = Number(candles[0].ts);
  const lastTs = Number(candles[candles.length - 1].ts);
  const xLabelLeft = `<text x="${PAD_LEFT}" y="${PANEL_H - 8}" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textFaint}">${_fmtDateMMDD(firstTs)} ${_fmtTimeHHMM(firstTs)}</text>`;
  const xLabelRight = `<text x="${PAD_LEFT + PLOT_W}" y="${PANEL_H - 8}" font-family="Inter,Arial,sans-serif" font-size="10" fill="${COLORS.textFaint}" text-anchor="end">${_fmtDateMMDD(lastTs)} ${_fmtTimeHHMM(lastTs)}</text>`;

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
  <path d="${areaPath}" fill="${lineColor}" opacity="0.10" />
  <polyline points="${linePoints}" fill="none" stroke="${lineColor}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
  ${annotations.join("")}
  ${yLabelTop}
  ${yLabelBot}
  ${xLabelLeft}
  ${xLabelRight}
</svg>`;
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
