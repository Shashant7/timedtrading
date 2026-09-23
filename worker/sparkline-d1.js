/**
 * Daily-close sparklines out of D1, in chunks D1 will accept.
 *
 * D1 caps a statement at 100 bound parameters. The scoring tick asked for the
 * whole universe in one `ticker IN (...)` — 329 binds — so the query threw
 * `too many SQL variables` on every run and the snapshot carried whatever
 * `_sparkline` each payload happened to have. Chunking is the whole fix.
 */

export const SPARKLINE_BIND_LIMIT = 90;

/**
 * @param {object} DB            D1 binding
 * @param {string[]} syms        tickers to fetch
 * @param {object}  [opts]
 * @param {number}  [opts.chunkSize] tickers per statement (must stay under D1's 100 binds)
 * @param {number}  [opts.points]    closes to keep per ticker, most recent first
 * @param {number}  [opts.sinceMs]   lower bound on candle ts
 * @returns {Promise<Record<string, number[]>>} closes oldest-first per ticker
 */
export async function fetchSparklinesFromD1(DB, syms, {
  chunkSize = SPARKLINE_BIND_LIMIT,
  points = 60,
  sinceMs = 0,
} = {}) {
  const out = {};
  if (!DB || !Array.isArray(syms) || syms.length === 0) return out;
  const clean = [...new Set(syms.map((s) => String(s || "").toUpperCase()).filter((s) => s && s.length <= 12))];
  if (clean.length === 0) return out;
  // One bind slot is spent on the ts floor when there is one.
  const perChunk = Math.max(1, Math.min(chunkSize, SPARKLINE_BIND_LIMIT) - (sinceMs > 0 ? 1 : 0));

  for (let i = 0; i < clean.length; i += perChunk) {
    const chunk = clean.slice(i, i + perChunk);
    const placeholders = chunk.map(() => "?").join(",");
    const tsFloor = sinceMs > 0 ? " AND ts > ?" : "";
    const binds = sinceMs > 0 ? [...chunk, sinceMs] : chunk;
    let rows;
    try {
      rows = await DB.prepare(
        `WITH deduped AS (
          SELECT ticker, ts, c,
            ROW_NUMBER() OVER (PARTITION BY ticker, CAST(ts / 86400000 AS INTEGER) ORDER BY ts DESC) AS day_rn
          FROM ticker_candles WHERE tf = 'D' AND ticker IN (${placeholders})${tsFloor}
        )
        SELECT ticker, ts, c FROM (
          SELECT ticker, ts, c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
          FROM deduped WHERE day_rn = 1
        ) WHERE rn <= ${Math.max(1, Math.floor(points))}
        ORDER BY ticker, ts ASC`,
      ).bind(...binds).all();
    } catch (err) {
      // One bad chunk must not cost the other 300 tickers their sparkline.
      console.warn(
        `[sparklines] chunk ${i / perChunk | 0} (${chunk.length} tickers) failed:`,
        String(err?.message || err).slice(0, 160),
      );
      continue;
    }
    for (const r of (rows?.results || [])) {
      const sym = String(r.ticker || "").toUpperCase();
      const c = Number(r.c);
      if (!sym || !Number.isFinite(c)) continue;
      (out[sym] || (out[sym] = [])).push(c);
    }
  }
  return out;
}
