// Ingest module — payload validation for /timed/ingest, /timed/ingest-capture, /timed/ingest-candles

/** Normalize ticker symbol (BRK.B → BRK-B, etc.). */
export const normTicker = (t) => {
  let normalized = String(t || "")
    .trim()
    .toUpperCase();
  if (normalized === "BRK.B" || normalized === "BRK-B") {
    normalized = "BRK-B";
  }
  return normalized;
};

/** Check if value is a finite number. */
export const isNum = (x) => Number.isFinite(Number(x));

/** Normalize timeframe key (1M→1, 1H→60, etc.). */
export function normalizeTfKey(tf) {
  const raw = String(tf == null ? "" : tf).trim().toUpperCase();
  if (!raw) return null;
  if (raw === "1" || raw === "1M") return "1";
  if (raw === "3" || raw === "3M") return "3";
  if (raw === "5" || raw === "5M") return "5";
  if (raw === "10" || raw === "10M") return "10";
  if (raw === "30" || raw === "30M") return "30";
  if (raw === "60" || raw === "1H" || raw === "1HR") return "60";
  if (raw === "240" || raw === "4H" || raw === "4HR") return "240";
  if (raw === "D" || raw === "1D" || raw === "DAY") return "D";
  if (raw === "W" || raw === "1W" || raw === "WEEK" || raw === "WEEKLY") return "W";
  // Monthly: "M" standalone, "MONTH", "MONTHLY", "1MONTH"
  // Note: "1M" is already mapped to 1-minute above, so not included here
  if (raw === "M" || raw === "MONTH" || raw === "MONTHLY" || raw === "1MONTH") return "M";
  return null;
}

/**
 * Validate /timed/ingest payload. Returns { ok, ticker?, payload?, error?, details? }.
 */
export function validateTimedPayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const ts = Number(body?.ts);
  const htf = Number(body?.htf_score);
  const ltf = Number(body?.ltf_score);

  if (!isNum(ts)) {
    return {
      ok: false,
      error: "missing/invalid ts",
      details: { received: body?.ts, type: typeof body?.ts },
    };
  }
  if (!isNum(htf)) {
    return {
      ok: false,
      error: "missing/invalid htf_score",
      details: { received: body?.htf_score, type: typeof body?.htf_score },
    };
  }
  if (!isNum(ltf)) {
    return {
      ok: false,
      error: "missing/invalid ltf_score",
      details: { received: body?.ltf_score, type: typeof body?.ltf_score },
    };
  }

  return {
    ok: true,
    ticker,
    payload: { ...body, ticker, ts, htf_score: htf, ltf_score: ltf },
  };
}

/**
 * Validate /timed/ingest-capture payload. Returns { ok, ticker?, payload?, error?, details? }.
 */
export function validateCapturePayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const ts = Number(body?.ts);
  if (!isNum(ts)) {
    return {
      ok: false,
      error: "missing/invalid ts",
      details: { received: body?.ts, type: typeof body?.ts },
    };
  }

  const price =
    body?.price != null && Number.isFinite(Number(body?.price))
      ? Number(body?.price)
      : null;

  return {
    ok: true,
    ticker,
    payload: {
      ...body,
      ticker,
      ts,
      price,
      ingest_kind: "capture",
    },
  };
}

/**
 * Validate /timed/ingest-candles payload. Returns { ok, ticker?, payload?, error?, details? }.
 */
export function validateCandlesPayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const tfCandles = body?.tf_candles;
  if (!tfCandles || typeof tfCandles !== "object") {
    return { ok: false, error: "missing tf_candles" };
  }

  let byTf = null;
  if (Array.isArray(tfCandles)) {
    byTf = {};
    for (const it of tfCandles) {
      const tf = normalizeTfKey(it?.tf);
      if (!tf) continue;
      byTf[tf] = it;
    }
  } else {
    byTf = tfCandles;
  }

  const out = {};
  let n = 0;
  for (const [tfRaw, candleOrArray] of Object.entries(byTf)) {
    const tf = normalizeTfKey(tfRaw);
    if (!tf) continue;

    const candleList = Array.isArray(candleOrArray)
      ? candleOrArray
      : [candleOrArray];

    const validCandles = [];
    for (const candle of candleList) {
      if (!candle || typeof candle !== "object") continue;
      const ts = Number(candle?.ts);
      const o = Number(candle?.o);
      const h = Number(candle?.h);
      const l = Number(candle?.l);
      const c = Number(candle?.c);
      const v = candle?.v != null ? Number(candle?.v) : null;
      if (!Number.isFinite(ts)) continue;
      if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;
      validCandles.push({ tf, ts, o, h, l, c, v });
      n++;
    }

    if (validCandles.length > 0) {
      out[tf] = validCandles.length === 1 ? validCandles[0] : validCandles;
    }
  }

  if (n === 0) return { ok: false, error: "no_valid_candles" };

  const tsTop = Number(body?.ts);
  return {
    ok: true,
    ticker,
    payload: {
      ...body,
      ticker,
      ts: Number.isFinite(tsTop) ? tsTop : Date.now(),
      tf_candles: out,
      ingest_kind: "candles",
    },
  };
}
