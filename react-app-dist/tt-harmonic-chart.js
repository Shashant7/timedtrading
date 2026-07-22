/**
 * Harmonic composite wave chart — SVG overlay (price + magenta wave + projection).
 * Used by Today Market Pulse; data from GET /timed/harmonic-cycle.
 */
(function () {
  "use strict";

  const WAVE_COLOR = "#ff00ff";
  const PRICE_COLOR = "rgba(226, 232, 240, 0.85)";
  const PROJ_DASH = "6 4";

  function buildPath(points, xKey, yKey, width, height, pad, yMin, yMax) {
    if (!points.length) return "";
    const span = yMax - yMin || 1;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    return points.map(function (pt, i) {
      const x = pad + (i / Math.max(1, points.length - 1)) * innerW;
      const yVal = Number(pt[yKey]);
      const y = pad + innerH - ((yVal - yMin) / span) * innerH;
      return (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
  }

  function yBounds(history, projection) {
    const vals = [];
    (history || []).forEach(function (pt) {
      if (Number.isFinite(pt.p)) vals.push(pt.p);
      if (Number.isFinite(pt.w)) vals.push(pt.w);
    });
    (projection || []).forEach(function (pt) {
      if (Number.isFinite(pt.w)) vals.push(pt.w);
    });
    if (!vals.length) return { min: 0, max: 1 };
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = (max - min) * 0.08 || 1;
    return { min: min - pad, max: max + pad };
  }

  function renderSvg(payload, opts) {
    const series = payload && payload.wave_series;
    if (!series || !Array.isArray(series.history) || !series.history.length) return null;

    const width = (opts && opts.width) || 640;
    const height = (opts && opts.height) || 168;
    const pad = 8;
    const history = series.history;
    const projection = Array.isArray(series.projection) ? series.projection : [];
    const combinedWave = history.map(function (pt) { return { w: pt.w }; })
      .concat(projection.map(function (pt) { return { w: pt.w }; }));
    const bounds = yBounds(history, projection);

    const pricePath = buildPath(history, "d", "p", width, height, pad, bounds.min, bounds.max);
    const waveHistPath = buildPath(history, "d", "w", width, height, pad, bounds.min, bounds.max);

    let waveProjPath = "";
    if (projection.length) {
      const bridge = [
        { w: history[history.length - 1].w },
      ].concat(projection);
      const startX = pad + ((history.length - 1) / Math.max(1, history.length + projection.length - 1)) * (width - pad * 2);
      const totalLen = history.length + projection.length - 1;
      waveProjPath = bridge.map(function (pt, i) {
        const idx = history.length - 1 + i;
        const x = pad + (idx / Math.max(1, totalLen)) * (width - pad * 2);
        const yVal = Number(pt.w);
        const y = pad + (height - pad * 2) - ((yVal - bounds.min) / (bounds.max - bounds.min || 1)) * (height - pad * 2);
        return (i === 0 ? "M" + startX.toFixed(1) + " " + y.toFixed(1) : "L") + (i === 0 ? "" : x.toFixed(1) + " " + y.toFixed(1));
      }).join(" ");
    }

    const pivotX = pad + ((series.pivot_index || history.length - 1) / Math.max(1, history.length + projection.length - 1))
      * (width - pad * 2);

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Harmonic composite wave chart">' +
      '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="rgba(0,0,0,0.15)" rx="8"/>' +
      '<path d="' + pricePath + '" fill="none" stroke="' + PRICE_COLOR + '" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path d="' + waveHistPath + '" fill="none" stroke="' + WAVE_COLOR + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      (waveProjPath
        ? '<path d="' + waveProjPath + '" fill="none" stroke="' + WAVE_COLOR + '" stroke-width="1.6" stroke-dasharray="' + PROJ_DASH + '" opacity="0.75"/>'
        : "") +
      '<line x1="' + pivotX.toFixed(1) + '" y1="' + pad + '" x2="' + pivotX.toFixed(1) + '" y2="' + (height - pad) + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="3 4"/>' +
      "</svg>";
    return svg;
  }

  function formatMeta(payload) {
    if (!payload || !payload.ok) return null;
    const parts = [];
    if (payload.primary_period) parts.push(payload.primary_period + "d primary");
    if (payload.label) parts.push(payload.label);
    if (payload.direction) parts.push(payload.direction);
    if (Number.isFinite(payload.phase_pct)) {
      parts.push(Math.round(payload.phase_pct * 100) + "% phase");
    }
    return parts.join(" · ");
  }

  window.TTHarmonicChart = {
    waveColor: WAVE_COLOR,
    renderSvg,
    formatMeta,
    buildUrl: function (apiBase, ticker) {
      const base = String(apiBase || "").replace(/\/$/, "");
      return base + "/timed/harmonic-cycle?ticker=" + encodeURIComponent(String(ticker || "").toUpperCase());
    },
  };
})();

// cache-bust:1784755887242:628129399
