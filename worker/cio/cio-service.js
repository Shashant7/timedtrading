// worker/cio/cio-service.js
// CIO entry/lifecycle evaluation service — proposal builders, chart vision, OpenAI API calls.

import {
  AI_CIO_TIMEOUT_MS,
  AI_CIO_MODEL,
  AI_CIO_SYSTEM_PROMPT,
  AI_CIO_USER_TEMPLATE,
  AI_CIO_LIFECYCLE_PROMPT,
  AI_CIO_LIFECYCLE_TEMPLATE,
} from "./cio-prompts.js";

// ── Proposal Builders ──────────────────────────────────────────────────────

/**
 * Build an entry proposal object for CIO review.
 * @param {Function} getTickerProfile - (sym) => profile object
 */
export function buildCIOProposal(sym, direction, entryPx, finalSL, validTP, tickerData, sizingMeta, confidence, setupGrade, setupName, calculatedRR, getTickerProfile) {
  const orb = tickerData?.orb?.primary;
  const _tp = getTickerProfile(sym);
  return {
    ticker: sym,
    direction,
    entry_price: entryPx,
    sl: finalSL,
    tp: validTP,
    rr: Math.round((calculatedRR || 0) * 100) / 100,
    rank: Number(tickerData?.rank) || 0,
    setup: { name: setupName, grade: setupGrade, path: tickerData?.__entry_path },
    confidence: Math.round((confidence || 0) * 100) / 100,
    state: tickerData?.state,
    ticker_profile: {
      type: _tp.profileKey,
      label: _tp.label,
      sl_mult: _tp.sl_mult,
      doa_hours: _tp.doa_hours,
      max_hold_hours: _tp.max_hold_hours,
    },
    pullback: {
      confirmed: !!tickerData?.__pullback_confirmed,
      details: tickerData?.__pullback_details || null,
    },
    fvg_imbalance: tickerData?.__fvg_imbalance || null,
    ema21_dist_pct: tickerData?.__ema21_dist_pct ?? null,
    regime: {
      ticker: tickerData?.regime_class,
      score: tickerData?.regime_score,
      market: tickerData?._env?._marketRegime?.regime,
      market_score: tickerData?._env?._marketInternals?.score,
    },
    scores: {
      htf: Number(tickerData?.htf_score) || 0,
      ltf: Number(tickerData?.ltf_score) || 0,
    },
    technicals: {
      atr: Number(tickerData?.atr) || 0,
      completion: Number(tickerData?.completion) || 0,
      phase_pct: Number(tickerData?.phase_pct) || 0,
      ema_regime_d: tickerData?.ema_regime_daily,
      st_dir_d: tickerData?.tf_tech?.D?.stDir,
      rsi_30m: tickerData?.tf_tech?.["30"]?.rsi,
      rsi_15m: tickerData?.tf_tech?.["15"]?.rsi,
      st_dir_30m: tickerData?.tf_tech?.["30"]?.stDir,
      st_dir_1h: tickerData?.tf_tech?.["1H"]?.stDir,
    },
    flags: {
      momentum_elite: !!tickerData?.flags?.momentum_elite,
      squeeze_release: !!tickerData?.flags?.sq30_release,
      squeeze_on: !!tickerData?.flags?.sq30_on,
      orb_confirmed: !!tickerData?.__orb_confirmed,
      orb_against: !!tickerData?.__orb_against,
      orb_fakeout: !!tickerData?.__orb_fakeout,
    },
    orb: orb ? {
      breakout: orb.breakout, priceVsORM: orb.priceVsORM,
      dayBias: orb.dayBias, widthPct: orb.widthPct,
    } : null,
    danger: {
      score: tickerData?.__danger_score ?? 0,
      flags: tickerData?.__danger_flags || [],
    },
    sizing: {
      method: sizingMeta?.method,
      risk_pct: Math.round((sizingMeta?.riskPct || 0) * 10000) / 100,
      vix: sizingMeta?.vixAtEntry || 0,
    },
    ichimoku: tickerData?.ichimoku_d ? {
      position: tickerData.ichimoku_d.position,
      tk_bull: tickerData.ichimoku_d.tkBull,
      cloud_bullish: tickerData.ichimoku_d.cloudBullish,
    } : null,
    entry_path: tickerData?.__entry_path || setupName,
    pdz_zone_D: tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone,
    pdz_pct_D: tickerData?.pdz_pct_D || tickerData?.tf_tech?.D?.pdz?.pct,
    pdz_zone_4h: tickerData?.pdz_zone_4h || tickerData?.tf_tech?.["4H"]?.pdz?.zone,
    pdz_size_mult: tickerData?.__pdz_size_mult || null,
    ripster_bias_state: tickerData?.__ripster_bias_state || null,
    cloud_alignment: {
      c5_12_10m: tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bear ? "bear" : "flat",
      c34_50_10m: tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bear ? "bear" : "flat",
      c34_50_1H: tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bear ? "bear" : "flat",
      c34_50_D: tickerData?.tf_tech?.D?.ripster?.c34_50?.bull ? "bull" : tickerData?.tf_tech?.D?.ripster?.c34_50?.bear ? "bear" : "flat",
      c72_89_10m: tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bull ? "bull" : tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bear ? "bear" : "flat",
    },
  };
}

/**
 * Build a lifecycle (trim/exit) proposal object for CIO review.
 * @param {Function} getTickerProfile - (sym) => profile object
 */
export function buildCIOLifecycleProposal(action, sym, openTrade, tickerData, pxNow, getTickerProfile) {
  const entryPx = Number(openTrade?.entryPrice) || 0;
  const dir = String(openTrade?.direction || "").toUpperCase();
  const isLong = dir === "LONG";
  const pnlPct = entryPx > 0 ? ((isLong ? pxNow - entryPx : entryPx - pxNow) / entryPx) * 100 : 0;
  const holdMs = (Date.now() - (Number(openTrade?.entry_ts) || Date.now()));
  const holdHours = holdMs / 3600000;
  const trimmedPct = Number(openTrade?.trimmedPct) || 0;
  const orb = tickerData?.orb?.primary;
  const mfe = Number(openTrade?.maxFavorableExcursion) || Number(openTrade?.mfe_pct) || (pnlPct > 0 ? pnlPct : 0);
  const mae = Number(openTrade?.maxAdverseExcursion) || Number(openTrade?.mae_pct) || (pnlPct < 0 ? pnlPct : 0);

  const profitRetainedPct = mfe > 0 ? +(pnlPct / mfe * 100).toFixed(0) : null;
  const _tp = getTickerProfile(sym);

  return {
    action,
    ticker: sym,
    direction: dir,
    entry_price: entryPx,
    current_price: pxNow,
    pnl_pct: +pnlPct.toFixed(2),
    mfe_pct: +mfe.toFixed(2),
    mae_pct: +mae.toFixed(2),
    profit_retained_pct: profitRetainedPct,
    hold_hours: +holdHours.toFixed(1),
    trimmed_pct: +trimmedPct.toFixed(2),
    exit_reason: openTrade?.exitReason || tickerData?.__exit_reason || null,
    sl: Number(openTrade?.sl) || null,
    tp: Number(openTrade?.tp) || null,
    setup: { name: openTrade?.setupName, grade: openTrade?.setupGrade },
    ticker_profile: { type: _tp.profileKey, label: _tp.label, max_hold_hours: _tp.max_hold_hours },
    fvg_imbalance: tickerData?.fvg_imbalance_D || null,
    regime: {
      ticker: tickerData?.regime_class,
      market: tickerData?._env?._marketRegime?.regime,
    },
    technicals: {
      ema_regime_d: tickerData?.ema_regime_daily,
      st_dir_d: tickerData?.tf_tech?.D?.stDir,
      st_dir_1h: tickerData?.tf_tech?.["1H"]?.stDir,
      st_dir_30m: tickerData?.tf_tech?.["30"]?.stDir,
      rsi_30m: tickerData?.tf_tech?.["30"]?.rsi,
      rsi_1h: tickerData?.tf_tech?.["1H"]?.rsi,
      completion: Number(tickerData?.completion) || 0,
      phase_pct: Number(tickerData?.phase_pct) || 0,
    },
    orb: orb ? { breakout: orb.breakout, priceVsORM: orb.priceVsORM } : null,
    rank: Number(tickerData?.rank) || 0,
    entry_path: openTrade?.entryPath || openTrade?.setupName || null,
    pdz_zone_entry: openTrade?.pdz_zone_D || null,
    pdz_zone_current: tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone || null,
    pdz_zone_shift: (() => {
      const _e = openTrade?.pdz_zone_D; const _c = tickerData?.pdz_zone_D || tickerData?.tf_tech?.D?.pdz?.zone;
      return (_e && _c && _e !== _c) ? `${_e}\u2192${_c}` : null;
    })(),
    ripster_cloud_status: {
      c5_12_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c5_12?.bear),
      c34_50_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bull && tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c34_50?.bear && tickerData?.tf_tech?.["1H"]?.ripster?.c34_50?.bear),
      c72_89_aligned: dir === "LONG"
        ? !!(tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bull)
        : !!(tickerData?.tf_tech?.["10"]?.ripster?.c72_89?.bear),
    },
    exit_family: tickerData?.__exit_family || null,
  };
}

// ── Chart Vision ────────────────────────────────────────────────────────────

export function generateCIOChartSVG(ticker, candleCache, entryAnnotation = null) {
  const TFS = [
    { key: "240", label: "4H", bars: 60, role: "DIRECTION" },
    { key: "60",  label: "1H", bars: 60, role: "DIRECTION" },
    { key: "30",  label: "30m", bars: 60, role: "MANAGEMENT" },
    { key: "15",  label: "15m", bars: 60, role: "ENTRY" },
  ];

  const W = 1200, H = 900;
  const paneW = W / 2, paneH = H / 2;
  const PAD = 8, CANDLE_PAD = 2;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="10">`;
  svg += `<rect width="${W}" height="${H}" fill="#1a1a2e"/>`;

  TFS.forEach((tf, idx) => {
    const col = idx % 2, row = Math.floor(idx / 2);
    const ox = col * paneW, oy = row * paneH;
    const candles = (candleCache?.[tf.key] || []).slice(-tf.bars);
    if (candles.length < 5) {
      svg += `<text x="${ox + paneW/2}" y="${oy + paneH/2}" fill="#666" text-anchor="middle">${tf.label}: No data</text>`;
      return;
    }

    svg += `<rect x="${ox}" y="${oy}" width="${paneW}" height="${paneH}" fill="none" stroke="#333" stroke-width="1"/>`;
    svg += `<text x="${ox + 8}" y="${oy + 16}" fill="#8af" font-weight="bold">${tf.label} — ${tf.role}</text>`;

    const chartY = oy + 24, chartH = (tf.key === "30" || tf.key === "15") ? paneH * 0.65 - 24 : paneH - 32;
    const chartW = paneW - PAD * 2;
    const cw = Math.max(2, (chartW - CANDLE_PAD * candles.length) / candles.length);

    const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
    const maxP = Math.max(...highs), minP = Math.min(...lows);
    const range = maxP - minP || 1;
    const yScale = (p) => chartY + chartH - ((p - minP) / range) * chartH;

    candles.forEach((c, i) => {
      const x = ox + PAD + i * (cw + CANDLE_PAD);
      const isGreen = c.c >= c.o;
      const color = isGreen ? "#26a69a" : "#ef5350";
      const bodyTop = yScale(Math.max(c.o, c.c));
      const bodyBot = yScale(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bodyBot - bodyTop);
      svg += `<line x1="${x + cw/2}" y1="${yScale(c.h)}" x2="${x + cw/2}" y2="${yScale(c.l)}" stroke="${color}" stroke-width="1"/>`;
      svg += `<rect x="${x}" y="${bodyTop}" width="${cw}" height="${bodyH}" fill="${color}"/>`;
    });

    const closes = candles.map(c => c.c);
    const drawEma = (period, color) => {
      if (closes.length < period) return;
      const emaVals = [];
      let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) { emaVals.push(null); continue; }
        if (i === period - 1) { emaVals.push(prev); continue; }
        prev = closes[i] * (2 / (period + 1)) + prev * (1 - 2 / (period + 1));
        emaVals.push(prev);
      }
      let pts = [];
      emaVals.forEach((v, i) => {
        if (v === null) return;
        const x = ox + PAD + i * (cw + CANDLE_PAD) + cw / 2;
        pts.push(`${x},${yScale(v)}`);
      });
      if (pts.length > 1) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.8"/>`;
    };
    drawEma(9, "#4fc3f7");
    drawEma(21, "#ffa726");
    drawEma(48, "#ef5350");

    const stLevels = candles.map(c => ({ dir: c.stDir, line: c.stLine })).filter(s => s.line > 0);
    if (stLevels.length > 2) {
      let stPts = [];
      stLevels.forEach((s, i) => {
        const ci = candles.length - stLevels.length + i;
        const x = ox + PAD + ci * (cw + CANDLE_PAD) + cw / 2;
        const stColor = s.dir === -1 ? "#26a69a" : "#ef5350";
        stPts.push({ x, y: yScale(s.line), color: stColor });
      });
      for (let i = 1; i < stPts.length; i++) {
        svg += `<line x1="${stPts[i-1].x}" y1="${stPts[i-1].y}" x2="${stPts[i].x}" y2="${stPts[i].y}" stroke="${stPts[i].color}" stroke-width="1.5" opacity="0.6"/>`;
      }
    }

    if (tf.key === "30" || tf.key === "15") {
      const rsiY = oy + paneH * 0.65, rsiH = paneH * 0.30;
      svg += `<line x1="${ox}" y1="${rsiY}" x2="${ox + paneW}" y2="${rsiY}" stroke="#333" stroke-width="0.5"/>`;
      svg += `<line x1="${ox + PAD}" y1="${rsiY + rsiH * 0.3}" x2="${ox + chartW + PAD}" y2="${rsiY + rsiH * 0.3}" stroke="#555" stroke-width="0.5" stroke-dasharray="3"/>`;
      svg += `<line x1="${ox + PAD}" y1="${rsiY + rsiH * 0.7}" x2="${ox + chartW + PAD}" y2="${rsiY + rsiH * 0.7}" stroke="#555" stroke-width="0.5" stroke-dasharray="3"/>`;
      svg += `<text x="${ox + 8}" y="${rsiY + 12}" fill="#888" font-size="9">RSI</text>`;
      svg += `<text x="${ox + chartW}" y="${rsiY + rsiH * 0.3 + 3}" fill="#666" font-size="8" text-anchor="end">70</text>`;
      svg += `<text x="${ox + chartW}" y="${rsiY + rsiH * 0.7 + 3}" fill="#666" font-size="8" text-anchor="end">30</text>`;

      if (closes.length >= 15) {
        const rsiPeriod = 14;
        let gains = 0, losses = 0;
        for (let i = 1; i <= rsiPeriod; i++) {
          const d = closes[i] - closes[i - 1];
          if (d > 0) gains += d; else losses -= d;
        }
        let avgGain = gains / rsiPeriod, avgLoss = losses / rsiPeriod;
        const rsiArr = [100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss))];
        for (let i = rsiPeriod + 1; i < closes.length; i++) {
          const d = closes[i] - closes[i - 1];
          avgGain = (avgGain * (rsiPeriod - 1) + (d > 0 ? d : 0)) / rsiPeriod;
          avgLoss = (avgLoss * (rsiPeriod - 1) + (d < 0 ? -d : 0)) / rsiPeriod;
          rsiArr.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
        }
        let rsiPts = [];
        const rsiStart = closes.length - rsiArr.length;
        rsiArr.forEach((v, i) => {
          const ci = rsiStart + i;
          const x = ox + PAD + ci * (cw + CANDLE_PAD) + cw / 2;
          const y = rsiY + rsiH * (1 - v / 100);
          rsiPts.push(`${x},${y}`);
        });
        if (rsiPts.length > 1) svg += `<polyline points="${rsiPts.join(" ")}" fill="none" stroke="#ba68c8" stroke-width="1.2"/>`;
      }
    }

    if (tf.key === "15" && entryAnnotation) {
      const ep = Number(entryAnnotation.price);
      if (ep > minP && ep < maxP) {
        const ey = yScale(ep);
        svg += `<line x1="${ox + PAD}" y1="${ey}" x2="${ox + paneW - PAD}" y2="${ey}" stroke="#ffeb3b" stroke-width="1" stroke-dasharray="4"/>`;
        svg += `<text x="${ox + paneW - PAD - 4}" y="${ey - 4}" fill="#ffeb3b" font-size="9" text-anchor="end">${entryAnnotation.label || "ENTRY"} ${ep.toFixed(2)}</text>`;
      }
    }

    svg += `<text x="${ox + paneW - PAD}" y="${chartY + 12}" fill="#aaa" font-size="9" text-anchor="end">${maxP.toFixed(2)}</text>`;
    svg += `<text x="${ox + paneW - PAD}" y="${chartY + chartH - 2}" fill="#aaa" font-size="9" text-anchor="end">${minP.toFixed(2)}</text>`;
  });

  svg += `<text x="${W/2}" y="${H - 4}" fill="#555" font-size="9" text-anchor="middle">${ticker} — CIO Chart Vision</text>`;
  svg += `</svg>`;
  return svg;
}

export function svgToBase64DataUri(svgString) {
  const encoded = btoa(unescape(encodeURIComponent(svgString)));
  return `data:image/svg+xml;base64,${encoded}`;
}

// ── API Evaluation Functions ────────────────────────────────────────────────

export async function evaluateWithAICIO(env, proposal, memory, chartSvg = null) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { decision: "APPROVE", fallback: true, reason: "no_api_key" };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_CIO_TIMEOUT_MS);

    const useVision = !!chartSvg;
    const entryModel = useVision ? "gpt-4o" : AI_CIO_MODEL;

    const userContent = useVision ? [
      { type: "text", text: AI_CIO_USER_TEMPLATE(proposal, memory) },
      { type: "image_url", image_url: { url: svgToBase64DataUri(chartSvg), detail: "high" } },
    ] : AI_CIO_USER_TEMPLATE(proposal, memory);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: entryModel,
        messages: [
          { role: "system", content: AI_CIO_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[AI_CIO] OpenAI ${resp.status}: ${errText.slice(0, 150)}`);
      return { decision: "APPROVE", fallback: true, reason: `api_error_${resp.status}` };
    }

    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[AI_CIO] Failed to parse response: ${raw.slice(0, 200)}`);
      return { decision: "APPROVE", fallback: true, reason: "parse_error" };
    }

    parsed.model_used = entryModel;
    parsed.chart_vision = useVision;

    const decision = String(parsed.decision || "APPROVE").toUpperCase();
    if (!["APPROVE", "ADJUST", "REJECT"].includes(decision)) {
      return { decision: "APPROVE", fallback: true, reason: "invalid_decision" };
    }

    return {
      decision,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      adjustments: decision === "ADJUST" ? {
        sl: Number.isFinite(Number(parsed.adjustments?.sl)) ? Number(parsed.adjustments.sl) : null,
        tp: Number.isFinite(Number(parsed.adjustments?.tp)) ? Number(parsed.adjustments.tp) : null,
        size_mult: Number.isFinite(Number(parsed.adjustments?.size_mult))
          ? Math.max(0.25, Math.min(1.5, Number(parsed.adjustments.size_mult)))
          : null,
        reason: String(parsed.adjustments?.reason || "").slice(0, 200),
      } : null,
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.slice(0, 5).map(f => String(f).slice(0, 50)) : [],
      edge_score: Math.max(0, Math.min(1, Number(parsed.edge_score) || 0.5)),
      fallback: false,
      model: AI_CIO_MODEL,
      latency_ms: null,
    };
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    console.warn(`[AI_CIO] ${isTimeout ? "Timeout" : "Error"}: ${String(err).slice(0, 150)}`);
    return { decision: "APPROVE", fallback: true, reason: isTimeout ? "timeout" : "exception" };
  }
}

export async function evaluateCIOLifecycle(env, proposal, memory, chartSvg = null) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { decision: "PROCEED", fallback: true, reason: "no_api_key" };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_CIO_TIMEOUT_MS);

    const useVision = !!chartSvg;
    const userContent = useVision ? [
      { type: "text", text: AI_CIO_LIFECYCLE_TEMPLATE(proposal, memory) },
      { type: "image_url", image_url: { url: svgToBase64DataUri(chartSvg), detail: "low" } },
    ] : AI_CIO_LIFECYCLE_TEMPLATE(proposal, memory);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_CIO_MODEL,
        messages: [
          { role: "system", content: AI_CIO_LIFECYCLE_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_completion_tokens: 400,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[AI_CIO_LIFECYCLE] OpenAI ${resp.status}: ${errText.slice(0, 150)}`);
      return { decision: "PROCEED", fallback: true, reason: `api_error_${resp.status}` };
    }

    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      console.warn(`[AI_CIO_LIFECYCLE] Parse error: ${raw.slice(0, 200)}`);
      return { decision: "PROCEED", fallback: true, reason: "parse_error" };
    }

    const decision = String(parsed.decision || "PROCEED").toUpperCase();
    if (!["PROCEED", "HOLD", "OVERRIDE"].includes(decision)) {
      return { decision: "PROCEED", fallback: true, reason: "invalid_decision" };
    }

    return {
      decision,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      override: decision === "OVERRIDE" ? {
        trim_pct: Number.isFinite(Number(parsed.override?.trim_pct)) ? Math.max(0, Math.min(1, Number(parsed.override.trim_pct))) : null,
        trail_stop_pct: Number.isFinite(Number(parsed.override?.trail_stop_pct)) ? Number(parsed.override.trail_stop_pct) : null,
        hold_bars: Number.isFinite(Number(parsed.override?.hold_bars)) ? Math.min(20, Number(parsed.override.hold_bars)) : null,
      } : null,
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.slice(0, 5) : [],
      edge_remaining: Math.max(0, Math.min(1, Number(parsed.edge_remaining) || 0.5)),
      fallback: false,
      model: AI_CIO_MODEL,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[AI_CIO_LIFECYCLE] Timeout (${AI_CIO_TIMEOUT_MS}ms)`);
      return { decision: "PROCEED", fallback: true, reason: "timeout" };
    }
    console.warn(`[AI_CIO_LIFECYCLE] Error: ${String(err).slice(0, 150)}`);
    return { decision: "PROCEED", fallback: true, reason: "exception" };
  }
}
