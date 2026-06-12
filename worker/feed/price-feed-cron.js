// ═══════════════════════════════════════════════════════════════════════════
// worker/feed/price-feed-cron.js — */1 price-feed cron pipeline.
//
// P2 monolith decomposition, Step 0 (2026-06-10). This module is the exact
// price-feed block that previously lived inline in worker/index.js
// scheduled() (~570 lines). It is extracted VERBATIM behind a
// dependency-injection seam so that:
//   1. the monolith keeps calling it with its own helpers (zero behavior
//      change in this step), and
//   2. the future `tt-feed` worker (Step 1 — see
//      tasks/2026-06-10-worker-decomposition-plan.md) can run the same
//      pipeline with its own thin deps implementation, on its own cron,
//      CPU budget, and deploy cadence.
//
// Deliberately NOT imported here (injected via `deps` instead) because they
// still live in worker/index.js and carry monolith-local state (cron
// calendar, in-process caches, D1 schema guards):
//   isNyRegularMarketOpen, d1GetActiveUserTickersCached, dataFetchSnapshots,
//   notifyPriceHub, mergeFreshnessIntoLatest, syncLivePricesToChartCandles,
//   usesTwelveData, isWithinOperatingHours, dataStream*, tradovateStream*.
//
// KV payload contract (timed:prices) is documented in
// .cursor/rules/price-data-pipeline.mdc — short keys p/pc/dc/dp/dh/dl/dv/t
// + extended-hours ahp/ahdc/ahdp with session-aware persistence.
// ═══════════════════════════════════════════════════════════════════════════

import { kvGetJSON, kvPutJSON } from "../storage.js";
import { SECTOR_MAP } from "../sector-mapping.js";
import { reconcileDailyChange } from "./prev-close-reconcile.js";

// ─── Price feed (full + lightweight overnight modes) ────────────────────────
// opts:
//   isLightweight — 2-8 AM UTC window: overlay TV futures + crypto only,
//                   with REST/D1 fallbacks when stock prices are stale.
//   utcMinute     — current UTC minute (drives the 30-min lightweight refresh).
export async function runPriceFeedCron(env, ctx, opts, deps) {
  const { isLightweight, utcMinute } = opts || {};
      const KV = env.KV_TIMED;
      const _marketOpen = deps.isNyRegularMarketOpen();
      const _marketClosed = !_marketOpen;
      try {
        const userAddedForPriceFeed = await deps.d1GetActiveUserTickersCached(env);
        // 2026-06-11 — SMCI incident v3 (the ACTUAL root cause). The feed's
        // symbol list was SECTOR_MAP + user-added only — but the live
        // trading universe is the DYNAMIC `timed:tickers` KV list (screener
        // promotions, theme adds). SMCI and 28 other universe tickers are
        // NOT in the static SECTOR_MAP: they were seeded into timed:prices
        // once (Jun 5, when added) and then NO feed path — not the stream,
        // not the REST fallback, not the v1/v2 stale sweep (which iterate
        // THIS list) — ever touched them again. A VIP user found SMCI 5.4
        // days stale at $41.64 vs the real $29.27. The feed now covers the
        // full union, so the stale sweep can actually reach every symbol
        // the platform scores and displays.
        let universeTickers = [];
        try {
          const u = await kvGetJSON(KV, "timed:tickers");
          if (Array.isArray(u)) universeTickers = u.map((t) => String(t).toUpperCase()).filter(Boolean);
        } catch (_) { /* universe list optional — static map still covers the core */ }
        const allTickers = [...new Set([...Object.keys(SECTOR_MAP), ...universeTickers, ...userAddedForPriceFeed])];

        // ── Lightweight mode: overlay TV futures + crypto onto existing prices ──
        // Runs during 2-8 AM UTC when stocks aren't actively trading.
        // If stock prices are stale (all zero changes), does a one-time Alpaca
        // REST snapshot fetch to seed today's close and prev_close.
        if (isLightweight) {
          let existing = {};
          try {
            const raw = await kvGetJSON(KV, "timed:prices");
            existing = raw?.prices || {};
          } catch (_) {}

          // Refresh stock prices from Alpaca REST every 30 min during lightweight window,
          // or immediately when prices are stale (<10 non-zero changes).
          // This provides both proper day-change values and EXT (after-hours) data.
          const nonZeroCount = Object.values(existing).filter(p => Number(p?.dc) !== 0 || Number(p?.dp) !== 0).length;
          const hasAhData = Object.values(existing).some(p => Number.isFinite(Number(p?.ahdp)) && Number(p.ahdp) !== 0);
          const needsRefresh = nonZeroCount < 10 || !hasAhData || (utcMinute % 30 === 0);
          if (needsRefresh) {
            try {
              const snapResult = await deps.dataFetchSnapshots(env, allTickers);
              const snapshots = snapResult.snapshots || {};
              let restCount = 0;
              const CRYPTO_24H = new Set(["BTCUSD", "ETHUSD"]);
              for (const [sym, snap] of Object.entries(snapshots)) {
                const ahPrice = snap.price;
                const rthClose = snap.dailyClose;
                const pc = snap.prevDailyClose;
                const isCryptoSym = CRYPTO_24H.has(sym);
                const displayPrice = isCryptoSym ? (ahPrice > 0 ? ahPrice : rthClose) : (rthClose > 0 ? rthClose : ahPrice);
                if (!displayPrice || displayPrice <= 0) continue;
                // Prefer TwelveData's native change/percent_change when available
                const nativeDc = Number(snap.change);
                const nativeDp = Number(snap.percentChange);
                const dc = (Number.isFinite(nativeDc) && nativeDc !== 0) ? Math.round(nativeDc * 100) / 100
                  : (displayPrice > 0 && pc > 0) ? Math.round((displayPrice - pc) * 100) / 100 : 0;
                const dp = (Number.isFinite(nativeDp) && nativeDp !== 0) ? Math.round(nativeDp * 100) / 100
                  : (displayPrice > 0 && pc > 0) ? Math.round(((displayPrice - pc) / pc) * 10000) / 100 : 0;
                const reconciled = reconcileDailyChange(displayPrice, pc, dc, dp);
                let usePc = reconciled.pc;
                let useDc = reconciled.dc;
                let useDp = reconciled.dp;
                let extDc = 0, extDp = 0, extP = 0;
                if (_marketClosed && !isCryptoSym) {
                  const nativeExtP = Number(snap.extendedPrice);
                  if (Number.isFinite(nativeExtP) && nativeExtP > 0 && displayPrice > 0 && Math.abs(nativeExtP - displayPrice) > 0.001) {
                    // 2026-06-03 — Drift sanity. TwelveData's extended_price
                    // field is cached server-side and can be 12+ hours
                    // stale (CRDO 6/3: RTH closed -7.66% at $214.56 but
                    // extended_price still showed $226.30 — yesterday's
                    // premarket high captured before today's selloff).
                    // Two layered guards before accepting the EXT quote:
                    //   1. Reject if drift > 8% from RTH close (covers
                    //      most legitimate AH moves, rejects extreme
                    //      stale that crosses sessions).
                    //   2. Reject if drift > 3% AND direction disagrees
                    //      with today's RTH move (a -7% day with EXT
                    //      showing +5% is almost certainly stale, not
                    //      a real reversal).
                    const _driftPct = ((nativeExtP - displayPrice) / displayPrice) * 100;
                    const _absDrift = Math.abs(_driftPct);
                    const _dirDisagree = Math.abs(useDp) > 1.5
                      && Math.sign(useDp) !== Math.sign(_driftPct);
                    const _looksStale = _absDrift > 8 || (_absDrift > 3 && _dirDisagree);
                    if (!_looksStale) {
                      extP = Math.round(nativeExtP * 100) / 100;
                      extDc = Math.round((nativeExtP - displayPrice) * 100) / 100;
                      extDp = Math.round(((nativeExtP - displayPrice) / displayPrice) * 10000) / 100;
                    }
                  }
                }
                const prev = existing[sym] || {};
                const dayRolled = !isCryptoSym && _marketClosed && useDc === 0 && useDp === 0;
                const keepPc = dayRolled && prev.pc > 0 ? prev.pc : (usePc > 0 ? Math.round(usePc * 100) / 100 : (prev.pc || 0));
                let keepDc = useDc, keepDp = useDp;
                if (dayRolled) {
                  if (Number.isFinite(prev.dc) && prev.dc !== 0) { keepDc = prev.dc; keepDp = prev.dp; }
                  else if (keepPc > 0 && displayPrice > 0) { keepDc = Math.round((displayPrice - keepPc) * 100) / 100; keepDp = Math.round(((displayPrice - keepPc) / keepPc) * 10000) / 100; }
                }
                existing[sym] = {
                  ...prev,
                  p: Math.round(displayPrice * 100) / 100,
                  pc: keepPc,
                  dc: keepDc,
                  dp: keepDp,
                  dh: snap.dailyHigh > 0 ? Math.round(snap.dailyHigh * 100) / 100 : (prev.dh || 0),
                  dl: snap.dailyLow > 0 ? Math.round(snap.dailyLow * 100) / 100 : (prev.dl || 0),
                  dv: snap.dailyVolume || prev.dv || 0,
                  t: snap.trade_ts || Date.now(),
                  /* Phase C — Stage 0.5 (2026-05-02) — Invalidate stale AH cache
                     when the regular-session price has moved past the cached
                     AH price. Bug: TWLO ahdp cached as +18.59% when AH was
                     175 vs prev close 148; later the regular close moved to
                     183 (above the AH 175), but the cached ahdp still showed
                     +18.59% — wrong direction. The cache only makes sense when
                     ahp is NEWER than the regular-session p. We invalidate
                     when |p - ahp| / p > 1.5% (price moved past AH range). */
                  ahp: (() => {
                    if (extDc !== 0) return extP;
                    if (!_marketClosed) return undefined;
                    const _prevAhp = Number(prev.ahp);
                    if (Number.isFinite(_prevAhp) && _prevAhp > 0 && displayPrice > 0
                        && Math.abs(displayPrice - _prevAhp) / displayPrice > 0.015) {
                      return undefined; // stale — drop it
                    }
                    return prev.ahp;
                  })(),
                  ahdc: (() => {
                    if (extDc !== 0) return extDc;
                    if (!_marketClosed) return undefined;
                    const _prevAhp = Number(prev.ahp);
                    if (Number.isFinite(_prevAhp) && _prevAhp > 0 && displayPrice > 0
                        && Math.abs(displayPrice - _prevAhp) / displayPrice > 0.015) {
                      return undefined;
                    }
                    return prev.ahdc;
                  })(),
                  ahdp: (() => {
                    if (extDc !== 0) return extDp;
                    if (!_marketClosed) return undefined;
                    const _prevAhp = Number(prev.ahp);
                    if (Number.isFinite(_prevAhp) && _prevAhp > 0 && displayPrice > 0
                        && Math.abs(displayPrice - _prevAhp) / displayPrice > 0.015) {
                      return undefined;
                    }
                    return prev.ahdp;
                  })(),
                };
                restCount++;
              }
              console.log(`[PRICE FEED LIGHT] REST fallback updated ${restCount} tickers (nonZero was ${nonZeroCount})`);
            } catch (e) {
              console.warn("[PRICE FEED LIGHT] REST fallback error:", String(e?.message || e).slice(0, 200));
            }
          }

          // D1 daily candle fallback for tickers still stale after REST snapshot
          // Uses date-bounded query (last 14 days) to avoid slow unbounded window scans.
          try {
            if (env?.DB) {
              const staleSyms = allTickers.filter(sym => {
                const e = existing[sym];
                return !e || Number(e.dp) === 0 || !Number.isFinite(Number(e.dp));
              });
              if (staleSyms.length > 0) {
                const cutoff = Date.now() - 14 * 86400000;
                const candleRows = await env.DB.prepare(
                  `SELECT ticker, ts, c FROM (
                    SELECT ticker, ts, c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) as rn
                    FROM (
                      SELECT ticker, MAX(ts) as ts, c
                      FROM ticker_candles WHERE tf = 'D' AND ts > ?1
                      GROUP BY ticker, CAST(ts / 86400000 AS INTEGER)
                    )
                  ) WHERE rn <= 2
                  ORDER BY ticker, ts DESC`
                ).bind(cutoff).all();
                const cMap = {};
                for (const r of (candleRows?.results || [])) {
                  const s = String(r.ticker).toUpperCase();
                  if (!cMap[s]) cMap[s] = [];
                  cMap[s].push({ ts: Number(r.ts), c: Number(r.c) });
                }
                let d1Count = 0;
                for (const sym of staleSyms) {
                  const candles = cMap[sym];
                  if (!candles || candles.length < 2) continue;
                  const todayC = candles[0]?.c;
                  const prevC = candles[1]?.c;
                  if (!todayC || todayC <= 0 || !prevC || prevC <= 0) continue;
                  const dc = Math.round((todayC - prevC) * 100) / 100;
                  const dp = Math.round(((todayC - prevC) / prevC) * 10000) / 100;
                  if (dp === 0) continue;
                  const prev = existing[sym] || {};
                  existing[sym] = {
                    ...prev,
                    p: prev.p || Math.round(todayC * 100) / 100,
                    pc: Math.round(prevC * 100) / 100,
                    dc, dp,
                    t: prev.t || candles[0].ts || Date.now(),
                  };
                  d1Count++;
                }
                if (d1Count > 0) console.log(`[PRICE FEED LIGHT] D1 candle fallback updated ${d1Count} tickers (stale: ${staleSyms.length})`);
              }
            }
          } catch (e) {
            console.warn("[PRICE FEED LIGHT] D1 fallback error:", String(e?.message || e).slice(0, 200));
          }

          // 1. Overlay TV futures heartbeats
          const TV_FUTURES_LIGHT = ["ES1!", "NQ1!", "GC1!", "SI1!", "VX1!", "US500", "CL1!"];
          let tvUpdated = 0;
          for (const tvSym of TV_FUTURES_LIGHT) {
            try {
              const hbData = await kvGetJSON(KV, `timed:heartbeat:${tvSym}`);
              const latestData = await kvGetJSON(KV, `timed:latest:${tvSym}`);
              const tvData = (hbData && hbData.price > 0) ? hbData : latestData;
              if (tvData && tvData.price > 0) {
                const prevClose = Number(tvData.prev_close || tvData.previous_close || 0);
                const price = Number(tvData.price);
                const dc = prevClose > 0 ? Math.round((price - prevClose) * 100) / 100 : null;
                const dp = prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
                const prev = existing[tvSym] || {};
                existing[tvSym] = {
                  ...prev,
                  p: Math.round(price * 100) / 100,
                  pc: prevClose > 0 ? Math.round(prevClose * 100) / 100 : (prev.pc || 0),
                  dc: dc ?? prev.dc, dp: dp ?? prev.dp,
                  dh: Math.round(Number(tvData.high || tvData.dailyHigh || 0) * 100) / 100 || prev.dh,
                  dl: Math.round(Number(tvData.low || tvData.dailyLow || 0) * 100) / 100 || prev.dl,
                  t: Number(tvData.ts || tvData.ingest_ts || 0) || Date.now(),
                };
                tvUpdated++;
              }
            } catch (_) {}
          }

          // 2. Overlay crypto from Alpaca snapshots
          let cryptoUpdated = 0;
          try {
            const CRYPTO_PAIRS = { "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD" };
            const headers = {
              "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
              "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY,
              "Accept": "application/json",
            };
            const params = new URLSearchParams();
            params.set("symbols", Object.values(CRYPTO_PAIRS).join(","));
            const url = `https://data.alpaca.markets/v1beta3/crypto/us/snapshots?${params.toString()}`;
            const resp = await fetch(url, { headers });
            if (resp.ok) {
              const data = await resp.json();
              const cryptoSnaps = data.snapshots || data;
              const reverseMap = {};
              for (const [k, v] of Object.entries(CRYPTO_PAIRS)) reverseMap[v] = k;
              for (const [alpacaSym, snap] of Object.entries(cryptoSnaps)) {
                const ourSym = reverseMap[alpacaSym] || alpacaSym.replace("/", "");
                const lt = snap.latestTrade;
                const db = snap.dailyBar;
                const pdb = snap.prevDailyBar;
                const price = Number(lt?.p) || Number(db?.c) || 0;
                if (price <= 0) continue;
                const prevClose = Number(pdb?.c) || 0;
                const prev = existing[ourSym] || {};
                existing[ourSym] = {
                  ...prev,
                  p: price,
                  pc: prevClose > 0 ? prevClose : (prev.pc || 0),
                  dc: prevClose > 0 ? Math.round((price - prevClose) * 100) / 100 : prev.dc,
                  dp: prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : prev.dp,
                  t: lt?.t ? new Date(lt.t).getTime() : Date.now(),
                };
                cryptoUpdated++;
              }
            }
          } catch (_) {}

          // 3. Write merged result + push to PriceHub
          const lightUpdateTs = Date.now();
          await kvPutJSON(KV, "timed:prices", {
            prices: existing,
            updated_at: lightUpdateTs,
            ticker_count: Object.keys(existing).length,
            _source: "lightweight_overnight",
          });
          ctx.waitUntil(deps.notifyPriceHub(env, {
            type: "prices",
            data: existing,
            updated_at: lightUpdateTs,
          }));
          console.log(`[PRICE FEED LIGHT] TV futures: ${tvUpdated}, crypto: ${cryptoUpdated}, total: ${Object.keys(existing).length}`);
          ctx.waitUntil(deps.mergeFreshnessIntoLatest(KV, existing).catch(e => console.warn("[FRESHNESS LIGHT]", e?.message)));
          // Skip the rest of the heavy pipeline
        } else {
        // ── Full pipeline (active hours) ──
        // Primary: AlpacaStream DO handles all Alpaca stock + crypto price computation.
        // Fallback: If DO prices are stale (>3 min old or all-zero changes), fetch
        //           snapshots from Alpaca REST API so prices stay accurate even when
        //           the stream isn't running.

        let prices = {};
        let pricesSource = "kv";
        let pricesUpdatedAt = 0;
        try {
          const raw = await kvGetJSON(KV, "timed:prices");
          prices = raw?.prices || {};
          pricesUpdatedAt = Number(raw?.updated_at) || 0;
        } catch (_) {}

        // Detect stale DO-managed prices: either >3 min old or all tickers show zero change
        const priceAgeMs = Date.now() - pricesUpdatedAt;
        const priceAgeMin = priceAgeMs / 60000;
        const nonZeroChanges = Object.values(prices).filter(p => Number(p?.dc) !== 0 || Number(p?.dp) !== 0).length;
        const doFresh = priceAgeMin < 3 && nonZeroChanges > 5;

        // When market is closed, always fetch REST snapshots to get extended-hours pricing
        // (the DO websocket only carries RTH data, so AH fields would never update otherwise)
        const needsRestFetch = !doFresh || _marketClosed;

        // ── REST snapshot fallback when DO isn't providing fresh data ──
        let restFallbackCount = 0;
        if (needsRestFetch) {
          try {
            const userAddedForPF = await deps.d1GetActiveUserTickersCached(env);
            const allTickersForSnap = [...new Set([...Object.keys(SECTOR_MAP), ...userAddedForPF])];
            const snapResult = await deps.dataFetchSnapshots(env, allTickersForSnap);
            const snapshots = snapResult.snapshots || {};
            const CRYPTO_24H_FULL = new Set(["BTCUSD", "ETHUSD"]);
            for (const [sym, snap] of Object.entries(snapshots)) {
              const ahPrice = snap.price;
              const rthClose = snap.dailyClose;
              const pc = snap.prevDailyClose;
              const isCryptoSym = CRYPTO_24H_FULL.has(sym);
              const displayPrice = isCryptoSym ? (ahPrice > 0 ? ahPrice : rthClose) : (rthClose > 0 ? rthClose : ahPrice);
              if (!displayPrice || displayPrice <= 0) continue;
              // Prefer TwelveData's native change/percent_change when available
              const nativeDc = Number(snap.change);
              const nativeDp = Number(snap.percentChange);
              const dc = (Number.isFinite(nativeDc) && nativeDc !== 0) ? Math.round(nativeDc * 100) / 100
                : (displayPrice > 0 && pc > 0) ? Math.round((displayPrice - pc) * 100) / 100 : 0;
              const dp = (Number.isFinite(nativeDp) && nativeDp !== 0) ? Math.round(nativeDp * 100) / 100
                : (displayPrice > 0 && pc > 0) ? Math.round(((displayPrice - pc) / pc) * 10000) / 100 : 0;
              const reconciled = reconcileDailyChange(displayPrice, pc, dc, dp);
              let usePc = reconciled.pc;
              let useDc = reconciled.dc;
              let useDp = reconciled.dp;
              let extDc = 0, extDp = 0, extP = 0;
              if (_marketClosed && !isCryptoSym) {
                const nativeExtP = Number(snap.extendedPrice);
                if (Number.isFinite(nativeExtP) && nativeExtP > 0 && displayPrice > 0 && Math.abs(nativeExtP - displayPrice) > 0.001) {
                  // 2026-06-03 — Same drift-sanity gate as the lightweight
                  // path above. See that block's comment for the full
                  // reasoning (CRDO 6/3 incident).
                  const _driftPct = ((nativeExtP - displayPrice) / displayPrice) * 100;
                  const _absDrift = Math.abs(_driftPct);
                  const _dirDisagree = Math.abs(useDp) > 1.5
                    && Math.sign(useDp) !== Math.sign(_driftPct);
                  const _looksStale = _absDrift > 8 || (_absDrift > 3 && _dirDisagree);
                  if (!_looksStale) {
                    extP = Math.round(nativeExtP * 100) / 100;
                    extDc = Math.round((nativeExtP - displayPrice) * 100) / 100;
                    extDp = Math.round(((nativeExtP - displayPrice) / displayPrice) * 10000) / 100;
                  }
                }
              }
              const prev = prices[sym] || {};
              const dayRolled = !isCryptoSym && _marketClosed && useDc === 0 && useDp === 0;
              const keepPc = dayRolled && prev.pc > 0 ? prev.pc : (usePc > 0 ? Math.round(usePc * 100) / 100 : (prev.pc || 0));
              let keepDc = useDc, keepDp = useDp;
              if (dayRolled) {
                if (Number.isFinite(prev.dc) && prev.dc !== 0) { keepDc = prev.dc; keepDp = prev.dp; }
                else if (keepPc > 0 && displayPrice > 0) { keepDc = Math.round((displayPrice - keepPc) * 100) / 100; keepDp = Math.round(((displayPrice - keepPc) / keepPc) * 10000) / 100; }
              }
              /* Phase C — Stage 0.5 (2026-05-02) — Stale-AH cache invalidation
                 (same fix as the lightweight-feed path above). */
              const _ahStale = (() => {
                if (!_marketClosed) return false;
                const _prevAhp = Number(prev.ahp);
                if (!Number.isFinite(_prevAhp) || _prevAhp <= 0 || displayPrice <= 0) return false;
                return Math.abs(displayPrice - _prevAhp) / displayPrice > 0.015;
              })();
              prices[sym] = {
                ...prev,
                p: Math.round(displayPrice * 100) / 100,
                pc: keepPc,
                dc: keepDc,
                dp: keepDp,
                dh: snap.dailyHigh > 0 ? Math.round(snap.dailyHigh * 100) / 100 : (prev.dh || 0),
                dl: snap.dailyLow > 0 ? Math.round(snap.dailyLow * 100) / 100 : (prev.dl || 0),
                dv: snap.dailyVolume || prev.dv || 0,
                t: snap.trade_ts || Date.now(),
                ahp: extDc !== 0 ? extP : (_marketClosed && !_ahStale ? prev.ahp : undefined),
                ahdc: extDc !== 0 ? extDc : (_marketClosed && !_ahStale ? prev.ahdc : undefined),
                ahdp: extDc !== 0 ? extDp : (_marketClosed && !_ahStale ? prev.ahdp : undefined),
              };
              restFallbackCount++;
            }
            pricesSource = "rest_snapshot";
          } catch (e) {
            console.warn("[PRICE FEED] REST fallback error:", String(e?.message || e).slice(0, 200));
          }
        }

        // D1 daily candle fallback for tickers still stale after REST snapshot
        // Uses date-bounded query (last 14 days) to avoid slow unbounded window scans.
        try {
          if (env?.DB) {
            const staleFullSyms = allTickers.filter(sym => {
              const e = prices[sym];
              return !e || Number(e.dp) === 0 || !Number.isFinite(Number(e.dp));
            });
            if (staleFullSyms.length > 0) {
              const cutoff = Date.now() - 14 * 86400000;
              const d1Rows = await env.DB.prepare(
                `SELECT ticker, ts, c FROM (
                  SELECT ticker, ts, c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) as rn
                  FROM (
                    SELECT ticker, MAX(ts) as ts, c
                    FROM ticker_candles WHERE tf = 'D' AND ts > ?1
                    GROUP BY ticker, CAST(ts / 86400000 AS INTEGER)
                  )
                ) WHERE rn <= 2
                ORDER BY ticker, ts DESC`
              ).bind(cutoff).all();
              const d1Map = {};
              for (const r of (d1Rows?.results || [])) {
                const s = String(r.ticker).toUpperCase();
                if (!d1Map[s]) d1Map[s] = [];
                d1Map[s].push({ ts: Number(r.ts), c: Number(r.c) });
              }
              let d1FullCount = 0;
              for (const sym of staleFullSyms) {
                const candles = d1Map[sym];
                if (!candles || candles.length < 2) continue;
                const todayC = candles[0]?.c;
                const prevC = candles[1]?.c;
                if (!todayC || todayC <= 0 || !prevC || prevC <= 0) continue;
                const dc = Math.round((todayC - prevC) * 100) / 100;
                const dp = Math.round(((todayC - prevC) / prevC) * 10000) / 100;
                if (dp === 0) continue;
                const prev = prices[sym] || {};
                prices[sym] = { ...prev, p: prev.p || Math.round(todayC * 100) / 100, pc: Math.round(prevC * 100) / 100, dc, dp, t: prev.t || candles[0].ts || Date.now() };
                d1FullCount++;
              }
              if (d1FullCount > 0) console.log(`[PRICE FEED] D1 candle fallback updated ${d1FullCount} stale tickers`);
            }
          }
        } catch (e) {
          console.warn("[PRICE FEED] D1 fallback error:", String(e?.message || e).slice(0, 200));
        }

        // Overlay TV heartbeat prices for futures/macro tickers not handled by the DO
        const TV_FUTURES_ACTIVE = ["ES1!", "NQ1!", "GC1!", "SI1!", "VX1!", "US500", "CL1!", "SPX"];
        let tvOverlayCount = 0;
        for (const tvSym of TV_FUTURES_ACTIVE) {
          try {
            const hbData = await kvGetJSON(KV, `timed:heartbeat:${tvSym}`);
            const latestData = await kvGetJSON(KV, `timed:latest:${tvSym}`);
            const tvData = (hbData && hbData.price > 0) ? hbData : latestData;
            if (tvData && tvData.price > 0) {
              const prevClose = Number(tvData.prev_close || tvData.previous_close || 0);
              const price = Number(tvData.price);
              const dc = prevClose > 0 ? Math.round((price - prevClose) * 100) / 100 : null;
              const dp = prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
              const prev = prices[tvSym] || {};
              prices[tvSym] = {
                ...prev,
                p: Math.round(price * 100) / 100,
                pc: prevClose > 0 ? Math.round(prevClose * 100) / 100 : (prev.pc || 0),
                dc: dc ?? prev.dc, dp: dp ?? prev.dp,
                dh: Math.round(Number(tvData.high || tvData.dailyHigh || 0) * 100) / 100 || prev.dh,
                dl: Math.round(Number(tvData.low || tvData.dailyLow || 0) * 100) / 100 || prev.dl,
                dv: Number(tvData.volume || 0) || prev.dv,
                t: Number(tvData.ts || tvData.ingest_ts || 0) || Date.now(),
              };
              tvOverlayCount++;
            }
          } catch (_) {}
        }

        // ── 2026-06-10 — PER-SYMBOL STALE SWEEP (SMCI incident) ────────────
        // A VIP user caught SMCI displayed at $41.64 while the real price
        // was $29.27: its KV entry was 5.4 DAYS old. Census showed 29
        // symbols frozen at the same moment — the AlpacaStream DO wasn't
        // ticking them, the REST fallback only fires when prices are
        // GLOBALLY stale (>3 min for the whole blob), and every per-symbol
        // failure path is a silent `continue`. The KV merge then preserved
        // the corpse forever. Every health signal is global, so 29 stale
        // symbols among 260 fresh ones alarmed nothing.
        //
        // This sweep makes per-symbol staleness self-healing: any symbol
        // whose trade timestamp is >30 min old during the full pipeline
        // gets a targeted REST snapshot refresh (capped per run to bound
        // API credits). Symbols that STILL fail are surfaced in the KV
        // blob (stale_symbols) so /timed/health + the watchdog can alarm
        // instead of staying silent.
        let _stillStale = [];
        try {
          const _sweepNow = Date.now();
          // 2026-06-10 v2 — SESSION-AWARE threshold. v1 used a flat 30 min,
          // which after the close flagged the ENTIRE universe (last trades
          // are hours old once RTH ends — live probe showed 244 "stale"
          // symbols at 23:30 UTC). Market open: 30 min is real staleness.
          // Market closed: only a trade timestamp older than 26 HOURS is a
          // corpse (normal overnight age is ≤ ~18h; 26h spans a full
          // session + overnight without false-flagging weekends' first
          // ticks either, since the sweep just re-confirms them cheaply).
          const STALE_SWEEP_MS = _marketOpen ? 30 * 60 * 1000 : 26 * 60 * 60 * 1000;
          const SWEEP_CAP = 48;
          // 2026-06-11 v4 — sweep EVERYTHING in the price blob, not just
          // the configured lists. SMCI was in neither SECTOR_MAP nor
          // timed:tickers — it's a screener/discovery candidate that got
          // seeded into timed:prices once and was then invisible to every
          // feed path INCLUDING v2/v3 of this sweep (which iterated the
          // configured lists). Anything the platform ever displays a
          // price for lives in this blob — so the blob itself is the
          // authoritative sweep universe. Futures / index gauges are
          // excluded (REST equity quotes can't heal them; they have their
          // own TV-heartbeat lane) so they don't permanently occupy the
          // stale list and page the operator forever.
          const _NON_SWEEPABLE = new Set(["SPX", "US500", "VIX", "VVIX", "NDX", "DJI", "RUT", "DXY", "TNX"]);
          const _sweepEligible = (sym) => !/[!:.$/]/.test(sym) && !_NON_SWEEPABLE.has(sym);
          const _sweepUniverse = [...new Set([...allTickers, ...Object.keys(prices)])];
          const _staleList = _sweepUniverse.filter((sym) => {
            if (!_sweepEligible(sym)) return false;
            const e = prices[sym];
            if (!e) return true;
            const t = Number(e.t) || 0;
            return (_sweepNow - t) > STALE_SWEEP_MS;
          });
          if (_staleList.length > 0) {
            // 2026-06-10 v2 — OLDEST FIRST. v1 sliced the list in stable
            // universe order, so with more stale symbols than the cap the
            // sweep churned the same head every run and never reached the
            // worst corpses (SMCI sat 5.4 days stale behind ~100
            // fresher entries). The most-stale symbols are the most
            // user-visible damage — heal them first.
            _staleList.sort((a, b) => (Number(prices[a]?.t) || 0) - (Number(prices[b]?.t) || 0));
            const _sweepSyms = _staleList.slice(0, SWEEP_CAP);
            const _sweepRes = await deps.dataFetchSnapshots(env, _sweepSyms);
            const _sweepSnaps = _sweepRes?.snapshots || {};
            let _healed = 0;
            for (const sym of _sweepSyms) {
              const snap = _sweepSnaps[sym];
              const price = Number(snap?.dailyClose || snap?.price) || 0;
              if (!(price > 0)) continue;
              const pc = Number(snap.prevDailyClose) || 0;
              const prev = prices[sym] || {};
              const nativeDc = Number(snap.change);
              const nativeDp = Number(snap.percentChange);
              const rawDc = (Number.isFinite(nativeDc) && nativeDc !== 0) ? Math.round(nativeDc * 100) / 100
                : (pc > 0 ? Math.round((price - pc) * 100) / 100 : (prev.dc ?? 0));
              const rawDp = (Number.isFinite(nativeDp) && nativeDp !== 0) ? Math.round(nativeDp * 100) / 100
                : (pc > 0 ? Math.round(((price - pc) / pc) * 10000) / 100 : (prev.dp ?? 0));
              const reconciled = reconcileDailyChange(price, pc, rawDc, rawDp);
              prices[sym] = {
                ...prev,
                p: Math.round(price * 100) / 100,
                pc: reconciled.pc > 0 ? Math.round(reconciled.pc * 100) / 100 : (prev.pc || 0),
                dc: reconciled.dc,
                dp: reconciled.dp,
                dh: snap.dailyHigh > 0 ? Math.round(snap.dailyHigh * 100) / 100 : (prev.dh || 0),
                dl: snap.dailyLow > 0 ? Math.round(snap.dailyLow * 100) / 100 : (prev.dl || 0),
                dv: snap.dailyVolume || prev.dv || 0,
                t: snap.trade_ts || _sweepNow,
              };
              _healed++;
            }
            _stillStale = _staleList.filter((sym) => {
              const e = prices[sym];
              return !e || (_sweepNow - (Number(e.t) || 0)) > STALE_SWEEP_MS;
            });
            console.warn(
              `[PRICE FEED] STALE SWEEP: ${_staleList.length} symbols >30m stale, refreshed ${_healed}/${_sweepSyms.length}` +
              (_stillStale.length > 0 ? ` — STILL STALE (${_stillStale.length}): ${_stillStale.slice(0, 12).join(", ")}` : ""),
            );
          }
        } catch (e) {
          console.warn("[PRICE FEED] stale sweep error:", String(e?.message || e).slice(0, 200));
        }

        const priceUpdateTs = Date.now();
        await kvPutJSON(KV, "timed:prices", {
          prices,
          updated_at: priceUpdateTs,
          ticker_count: Object.keys(prices).length,
          _source: pricesSource,
          // Symbols that survived the stale sweep un-healed — the health
          // endpoint + watchdog surface these (count + samples).
          stale_symbols: _stillStale.slice(0, 30),
          stale_symbol_count: _stillStale.length,
        });
        ctx.waitUntil(deps.notifyPriceHub(env, { type: "prices", data: prices, updated_at: priceUpdateTs }));

        console.log(`[PRICE FEED] source=${pricesSource}, doFresh=${doFresh}, restFallback=${restFallbackCount}, tvOverlay=${tvOverlayCount}, total=${Object.keys(prices).length}`);

        // ── SL/TP Exit Checking on price loop ──
        // Check open positions against current prices and LOG when an SL or
        // TP boundary is crossed. The actual close happens on the next */5
        // scoring cron via processTradeSimulation's SL safety net (line
        // ~19507) — this loop only provides visibility into sub-5-minute
        // SL hits in the worker logs.
        //
        // P2 HOTFIX 2026-05-19 (part 13 — Bug #7): the previous version
        // stamped `trade._price_sl_triggered`/`_price_tp_triggered` flags on
        // every flagged trade and wrote the entire trades list back to KV.
        // BUT NOTHING ELSE IN THE CODEBASE READS THESE FLAGS — grep confirms
        // zero consumers. Dead code that did expensive KV writes (full
        // trades list) on every flag hit and created false confidence in
        // "fast SL protection" that didn't exist. Replaced with a single
        // INFO log per cron tick. To get true sub-5-minute SL reaction in
        // the future, wire the flag through to processTradeSimulation OR
        // call closeTradeAtPrice directly from here — either is a separate
        // PR with its own risk surface.
        try {
          const allTrades = (await kvGetJSON(KV, "timed:trades:all")) || [];
          const openTrades = allTrades.filter(t => t.status === "OPEN" || t.status === "TP_HIT_TRIM");
          let slCrossed = 0, tpCrossed = 0;
          const slDetail = [];

          for (const trade of openTrades) {
            const sym = String(trade.ticker || "").toUpperCase();
            const snap = prices[sym];
            if (!snap || !snap.p) continue;

            const currentPrice = snap.p;
            const sl = Number(trade.stop_loss || trade.sl);
            const tp = Number(trade.take_profit || trade.tp);
            const direction = String(trade.direction || "").toUpperCase();
            const isLong = direction === "LONG";

            if (Number.isFinite(sl) && sl > 0) {
              const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
              if (slHit) {
                slCrossed++;
                slDetail.push(`${sym}(${direction}) px=${currentPrice} sl=${sl}`);
              }
            }

            if (Number.isFinite(tp) && tp > 0) {
              const tpHit = isLong ? currentPrice >= tp : currentPrice <= tp;
              if (tpHit) tpCrossed++;
            }
          }

          if (slCrossed > 0 || tpCrossed > 0) {
            console.log(`[PRICE FEED] SL/TP check: ${slCrossed} past SL, ${tpCrossed} past TP — will close on next */5 cron via safety net. ${slDetail.length ? `SL detail: ${slDetail.join(", ")}` : ""}`);
          }
        } catch (e) {
          console.warn("[PRICE FEED] SL/TP check error:", e);
        }

        console.log(`[PRICE FEED] Updated ${Object.keys(prices).length} tickers`);
        ctx.waitUntil(deps.mergeFreshnessIntoLatest(KV, prices).catch(e => console.warn("[FRESHNESS]", e?.message)));

        // Merge live quotes into chart TFs (10/15/30/60) so right-rail
        // charts and freshness grades track the same price the header shows
        // between */5 REST bar fetches.
        if (_marketOpen && env?.DB) {
          ctx.waitUntil((async () => {
            try {
              let priorityTickers = [];
              try {
                if (typeof deps.collectPriorityChartTickers === "function") {
                  priorityTickers = await deps.collectPriorityChartTickers(env);
                } else {
                  const openTrades = ((await kvGetJSON(KV, "timed:trades:all")) || [])
                    .filter((t) => t?.status === "OPEN" || t?.status === "TP_HIT_TRIM");
                  priorityTickers = openTrades.map((t) => String(t?.ticker || "").toUpperCase()).filter(Boolean);
                }
              } catch (_) {}
              await deps.syncLivePricesToChartCandles(env, prices, {
                priorityTickers,
                maxTickers: 280,
              });
            } catch (syncErr) {
              console.warn("[LIVE_CANDLE_SYNC] price-feed hook failed:", String(syncErr?.message || syncErr).slice(0, 200));
            }
          })());
        }

        // Every 15 min during RTH: backfill 4H + D for open/alerted tickers.
        // Live sync only patches 30/15/60m — structural TFs were days behind.
        if (_marketOpen && env?.DB && typeof deps.refreshPriorityChartCandles === "function"
            && typeof deps.collectPriorityChartTickers === "function"
            && Number(utcMinute) % 15 === 0) {
          ctx.waitUntil((async () => {
            try {
              const throttleKey = "timed:chart_refresh:last";
              const last = Number(await KV.get(throttleKey)) || 0;
              if (Date.now() - last < 12 * 60 * 1000) return;
              await KV.put(throttleKey, String(Date.now()));
              const tickers = await deps.collectPriorityChartTickers(env);
              await deps.refreshPriorityChartCandles(env, tickers, { tfs: ["240", "D"], sinceDays: 7 });
            } catch (e) {
              console.warn("[CHART_REFRESH] price-feed hook failed:", String(e?.message || e).slice(0, 200));
            }
          })());
        }

        // NOTE: Scoring chain removed from price feed to prevent dual-scoring race.
        // The */5 cron handler is the SOLE scoring loop. Running scoring here AND
        // in the */5 handler caused concurrent KV writes → kanban stage oscillation.
        } // end of full pipeline else block
      } catch (e) {
        console.error("[PRICE FEED] Error:", e);
      }
      // Don't return — D1 sync below may also run
}

// ─── Stream keep-alives (PriceStream / Tradovate DOs) ───────────────────────
// The DOs self-heal via alarm loops, but the alarm chain only re-arms while
// isRunning=true — after a CF eviction something must call /start again.
// This is that something (runs on the */1 cron).
export async function runFeedStreamKeepAlives(env, ctx, deps) {
      // P0.7.131 (2026-05-11) — PriceStream (TwelveData equities) keep-alive.
      //
      // The PriceStream Durable Object self-heals via a 5-10s alarm
      // loop, but the alarm chain only re-arms while isRunning=true.
      // If CF evicts the DO and there's no in-flight request, the
      // DO stays stopped until something explicitly calls /start.
      //
      // Per-minute keep-alive ping. Cost = 1 DO RPC/min ~=
      // 1,440/day, well within the free DO request budget. The DO's
      // /start handler is idempotent (no-op when isRunning=true) so
      // this only does work after an actual eviction.
      try {
        if (deps.usesTwelveData(env) && env?.PRICE_STREAM && deps.isWithinOperatingHours()) {
          // P0.7.167 (2026-05-15) — Was `KV.get(...)` but `const KV` is declared
          // 200 lines below in the */5 block (line ~73585), so this reference
          // hit the TDZ ("Cannot access 'KV' before initialization") on every
          // */1 cron tick. The whole STREAM keep-alive silently failed —
          // visible in tail as "[STREAM keep-alive] outer check failed".
          // Use env.KV_TIMED directly to avoid the hoist dependency.
          const _muteKv = env?.KV_TIMED || env?.KV;
          const _muteCheck = _muteKv ? await _muteKv.get("phase-c:cron-mute").catch(() => null) : null;
          if (!_muteCheck) {
            ctx.waitUntil((async () => {
              try {
                const status = await deps.dataStreamStatus(env);
                if (status && status.isRunning === false) {
                  const blocklist = new Set(["ES1!","NQ1!","YM1!","RTY1!","CL1!","GC1!","SI1!","HG1!","NG1!","BTCUSD","ETHUSD","US500","VX1!"]);
                  const userAdded = await deps.d1GetActiveUserTickersCached(env);
                  const symbols = [...new Set([...Object.keys(SECTOR_MAP), ...userAdded])]
                    .filter(t => !blocklist.has(t) && /^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t));
                  const startRes = await deps.dataStreamStart(env, symbols);
                  console.log(`[STREAM keep-alive] DO was stopped → restarted with ${symbols.length} symbols.`,
                    String(JSON.stringify(startRes)).slice(0, 200));
                }
              } catch (e) {
                console.warn("[STREAM keep-alive] check failed:", String(e?.message || e).slice(0, 200));
              }
            })());
          }
        }
      } catch (kaErr) {
        console.warn("[STREAM keep-alive] outer check failed:", String(kaErr?.message || kaErr).slice(0, 200));
      }

      // P0.7.132 — Tradovate WS keep-alive (futures feed). Sibling to the
      // PriceStream keep-alive above. Disabled by default until
      // TRADOVATE_ENABLED="true" + the 6 TRADOVATE_* secrets are in CF
      // Dashboard. Same idempotent start pattern: cheap NO-OP when the DO
      // is already running, restarts within ~60s of any CF eviction.
      // Currently dormant — see the docstring at the top of
      // worker/tradovate.js for status (blocked on a $290/mo Tradovate
      // CME data subscription that we decided not to pay for).
      try {
        if (deps.isTradovateEnabled(env) && env?.TRADOVATE_STREAM && deps.isWithinOperatingHours()) {
          // Same TDZ fix as STREAM keep-alive above — env.KV_TIMED instead of KV.
          const _muteKvTv = env?.KV_TIMED || env?.KV;
          const _muteCheckTv = _muteKvTv ? await _muteKvTv.get("phase-c:cron-mute").catch(() => null) : null;
          if (!_muteCheckTv) {
            ctx.waitUntil((async () => {
              try {
                const status = await deps.tradovateStreamStatus(env);
                if (status && status.isRunning === false) {
                  const { tradovateTrackedTvSymbols } = await import("../tradovate.js");
                  const tvSyms = tradovateTrackedTvSymbols();
                  const startRes = await deps.tradovateStreamStart(env, tvSyms);
                  console.log(`[TRADOVATE keep-alive] DO was stopped → restarted with ${tvSyms.length} TV symbols.`,
                    String(JSON.stringify(startRes)).slice(0, 200));
                }
              } catch (e) {
                console.warn("[TRADOVATE keep-alive] check failed:", String(e?.message || e).slice(0, 200));
              }
            })());
          }
        }
      } catch (kaErr) {
        console.warn("[TRADOVATE keep-alive] outer check failed:", String(kaErr?.message || kaErr).slice(0, 200));
      }
}
