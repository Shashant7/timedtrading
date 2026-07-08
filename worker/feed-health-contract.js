// worker/feed-health-contract.js
// Trust Spine — extend /timed/health beyond prices/candles to research,
// catalysts, fundamentals, and macro event feeds. Fail-loud: any feed past
// its SLO marks feeds.ok=false so the watchdog can page.

const SAMPLE_TICKERS = ["SPY", "QQQ", "NVDA"];

/** Age in minutes from a row's updated_at / computed_at / ts field. */
export function feedAgeMin(row, now = Date.now()) {
  if (!row || typeof row !== "object") return null;
  const ts = Number(row.updated_at ?? row.computed_at ?? row.ts ?? row._ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.round((now - ts) / 60000);
}

/**
 * Summarize auxiliary feed freshness from KV snapshots.
 * @param {object} snapshots - keyed blobs already fetched by the health route
 */
export function summarizeFeedHealth(snapshots = {}, now = Date.now()) {
  const slos = {
    fundamentals_h: 168,   // 7d — slow-moving
    macro_events_h: 48,
    macro_cross_asset_h: 24,
    fsd_accuracy_h: 168,
  };

  const fundamentals = [];
  for (const t of SAMPLE_TICKERS) {
    const row = snapshots.fundamentals?.[t];
    const ageMin = feedAgeMin(row, now);
    fundamentals.push({
      ticker: t,
      present: !!row,
      age_min: ageMin,
      slo_min: slos.fundamentals_h * 60,
      ok: row ? (ageMin == null || ageMin <= slos.fundamentals_h * 60) : false,
    });
  }

  const macroEvents = snapshots.macroEvents;
  const macroEventsAge = feedAgeMin(macroEvents, now);
  const macroCross = snapshots.macroCrossAsset;
  const macroCrossAge = feedAgeMin(macroCross, now);
  const fsdAcc = snapshots.fsdAccuracy;
  const fsdAccAge = feedAgeMin(fsdAcc, now);

  const feeds = {
    fundamentals: {
      sample: fundamentals,
      ok: fundamentals.every((f) => f.ok),
      slo_hours: slos.fundamentals_h,
    },
    macro_events: {
      present: !!macroEvents,
      age_min: macroEventsAge,
      ok: macroEvents ? (macroEventsAge == null || macroEventsAge <= slos.macro_events_h * 60) : null,
      slo_hours: slos.macro_events_h,
    },
    macro_cross_asset: {
      present: !!macroCross,
      age_min: macroCrossAge,
      ok: macroCross ? (macroCrossAge == null || macroCrossAge <= slos.macro_cross_asset_h * 60) : null,
      slo_hours: slos.macro_cross_asset_h,
    },
    fsd_accuracy: {
      present: !!fsdAcc,
      age_min: fsdAccAge,
      ok: fsdAcc ? (fsdAccAge == null || fsdAccAge <= slos.fsd_accuracy_h * 60) : null,
      slo_hours: slos.fsd_accuracy_h,
    },
  };

  const checked = [feeds.fundamentals, feeds.macro_events, feeds.macro_cross_asset, feeds.fsd_accuracy]
    .filter((f) => f.ok != null);
  const failing = checked.filter((f) => f.ok === false);
  feeds.ok = failing.length === 0;
  feeds.failing = failing.map((f) => Object.keys(feeds).find((k) => feeds[k] === f)).filter(Boolean);

  return feeds;
}

/**
 * Fetch KV blobs needed for summarizeFeedHealth.
 * @param {object} kv - KV_TIMED binding
 * @param {function} kvGetJSON - async (kv, key) => object
 */
export async function loadFeedHealthSnapshots(kv, kvGetJSON) {
  const fundamentals = {};
  await Promise.all(
    SAMPLE_TICKERS.map(async (t) => {
      try {
        fundamentals[t] = await kvGetJSON(kv, `timed:fundamentals_v7:${t}`);
      } catch {
        fundamentals[t] = null;
      }
    }),
  );
  let macroEvents = null;
  let macroCrossAsset = null;
  let fsdAccuracy = null;
  try { macroEvents = await kvGetJSON(kv, "timed:macro:events"); } catch { /* */ }
  try { macroCrossAsset = await kvGetJSON(kv, "timed:macro:cross-asset-summary"); } catch { /* */ }
  try { fsdAccuracy = await kvGetJSON(kv, "timed:fsd:accuracy"); } catch { /* */ }
  return { fundamentals, macroEvents, macroCrossAsset, fsdAccuracy };
}
