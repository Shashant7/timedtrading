/** Resolve CTO prediction anchor timestamps for feed + UI surfaces. */

/** Daily close anchor (~4:00 PM ET) for an ISO date (YYYY-MM-DD). */
export function asOfDateToCloseMs(dateStr) {
  const raw = String(dateStr || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  // 21:00 UTC ≈ 4:00 PM ET (EST). Good enough for display anchor; not session-aware.
  const ms = Date.UTC(y, mo - 1, d, 21, 0, 0, 0);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function backfillItemBarAsOfMs(item) {
  if (!item || typeof item !== "object") return item;
  const bar = Number(item.bar_as_of_ms);
  if (Number.isFinite(bar) && bar > 0) return item;
  const fromDate = asOfDateToCloseMs(item.as_of_date);
  if (fromDate) item.bar_as_of_ms = fromDate;
  return item;
}

/**
 * Pick the best prediction-as-of ms for a feed payload.
 * Order: explicit field → max item bar_as_of_ms → max item as_of_date → generated_at.
 */
export function resolvePredictionAsOfMs(feedOrItems, generatedAtMs = null) {
  const items = Array.isArray(feedOrItems)
    ? feedOrItems
    : (Array.isArray(feedOrItems?.items) ? feedOrItems.items : []);
  const explicit = Number(feedOrItems?.prediction_as_of_ms);
  if (!Array.isArray(feedOrItems) && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  let best = 0;
  for (const it of items) {
    backfillItemBarAsOfMs(it);
    const bar = Number(it?.bar_as_of_ms);
    if (Number.isFinite(bar) && bar > best) best = bar;
  }
  if (best > 0) return best;

  for (const it of items) {
    const fromDate = asOfDateToCloseMs(it?.as_of_date);
    if (fromDate && fromDate > best) best = fromDate;
  }
  if (best > 0) return best;

  const gen = Number(generatedAtMs ?? feedOrItems?.generated_at ?? feedOrItems?.updated_at);
  return Number.isFinite(gen) && gen > 0 ? gen : null;
}
