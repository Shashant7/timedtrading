// worker/chain-smoke.js
// ─────────────────────────────────────────────────────────────────────────────
// B2 (2026-07-03 stabilization plan) — END-TO-END CHAIN SMOKE.
//
// The Jul 2 incident took ~an hour to diagnose because every monitor watched
// a SYMPTOM (investor exclusions, freshness counts) instead of the LINK that
// broke. This module walks the actual data chain for a few sentinel tickers
// and names the first broken link:
//
//   feed     — timed:prices poll + vendor-quote receipt ages
//   candles  — newest 10m/30m bar in D1 ticker_candles (the live-sync output)
//   scoring  — timed:latest ingest age + _freshness grade (the */5 output)
//   overlay  — timed:latest price vs feed price divergence (the API's view)
//
// Session-aware via getMarketSession (the B1 canonical resolver): outside
// operating hours the intraday links report `idle` and never fail. Exposes
// NO prices — ages, grades and booleans only, so the route can stay public
// for the external watchdog (same policy as /timed/health).
// ─────────────────────────────────────────────────────────────────────────────

import { kvGetJSON } from "./storage.js";
import { getMarketSession } from "./market-calendar.js";

export const CHAIN_SMOKE_SENTINELS = ["SPY", "QQQ", "AAPL"];

const MIN = 60 * 1000;

// Paging thresholds (hard bounds — soft/AGING states are the freshness
// summary's job; the smoke check only pages on "this link is broken").
const FEED_POLL_MAX_MS_OPEN = 10 * MIN;      // */1 cron missing 10+ ticks
const FEED_QUOTE_MAX_MS_OPEN = 15 * MIN;     // vendor value frozen (GS zombie)
const CANDLE_10M_MAX_MS_RTH = 60 * MIN;      // freshness hard SLO for 10m
const CANDLE_30M_MAX_MS_RTH = 90 * MIN;      // freshness hard SLO for 30m
const SCORING_INGEST_MAX_MS_OPEN = 30 * MIN; // */5 scoring missing 6+ ticks
const OVERLAY_DIVERGENCE_PCT = 3;            // latest price vs feed price

function ageMs(ts, nowMs) {
  const n = Number(ts) || 0;
  return n > 0 ? Math.max(0, nowMs - n) : null;
}

function ageMin(ts, nowMs) {
  const a = ageMs(ts, nowMs);
  return a === null ? null : Math.round(a / MIN);
}

/**
 * Walk the chain for the sentinel tickers. Returns:
 * { ok, checked_at, session: {market_open, within_operating_hours, ...},
 *   sentinels, links: { feed, candles, scoring, overlay }, failing_links }
 * Each link: { status: "ok"|"fail"|"idle"|"unknown", detail, per_ticker }.
 */
export async function runChainSmoke(env, opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  const sentinels = (opts.sentinels || CHAIN_SMOKE_SENTINELS)
    .map((s) => String(s || "").toUpperCase()).filter(Boolean);
  const session = opts.session || await getMarketSession(env, nowMs);
  const marketOpen = session.market_open === true;
  const opHours = session.within_operating_hours === true;

  const links = {
    feed: { status: "unknown", per_ticker: {} },
    candles: { status: "unknown", per_ticker: {} },
    scoring: { status: "unknown", per_ticker: {} },
    overlay: { status: "unknown", per_ticker: {} },
  };

  // ── Link 1: feed (timed:prices) ──────────────────────────────────────────
  let pricesRows = {};
  try {
    const blob = await kvGetJSON(env?.KV_TIMED, "timed:prices");
    pricesRows = blob?.prices || {};
    const failures = [];
    for (const sym of sentinels) {
      const row = pricesRows[sym];
      const pollAge = ageMin(row?.t, nowMs);
      const quoteAge = ageMin(Math.max(Number(row?.q_ts) || 0, Number(row?.p_ts) || 0), nowMs);
      links.feed.per_ticker[sym] = { poll_age_min: pollAge, quote_age_min: quoteAge };
      if (!opHours) continue; // feed idles outside operating hours
      if (pollAge === null || pollAge * MIN > FEED_POLL_MAX_MS_OPEN) {
        failures.push(`${sym}:poll=${pollAge ?? "missing"}m`);
      } else if (marketOpen && (quoteAge === null || quoteAge * MIN > FEED_QUOTE_MAX_MS_OPEN)) {
        failures.push(`${sym}:quote=${quoteAge ?? "missing"}m`);
      }
    }
    links.feed.status = !opHours ? "idle" : failures.length ? "fail" : "ok";
    if (failures.length) links.feed.detail = failures.join(", ");
  } catch (e) {
    links.feed.status = "fail";
    links.feed.detail = `read_error: ${String(e?.message || e).slice(0, 120)}`;
  }

  // ── Link 2: candles (newest 10m/30m in D1 — the live-sync output) ────────
  try {
    if (!env?.DB) {
      links.candles.status = "unknown";
      links.candles.detail = "no_db_binding";
    } else {
      const placeholders = sentinels.map((_, i) => `?${i + 1}`).join(",");
      const { results } = await env.DB.prepare(
        `SELECT ticker, tf, MAX(ts) AS newest FROM ticker_candles
         WHERE ticker IN (${placeholders}) AND tf IN ('10','30')
         GROUP BY ticker, tf`,
      ).bind(...sentinels).all();
      const newest = {};
      for (const r of results || []) {
        newest[`${String(r.ticker).toUpperCase()}:${r.tf}`] = Number(r.newest) || 0;
      }
      const failures = [];
      for (const sym of sentinels) {
        const a10 = ageMin(newest[`${sym}:10`], nowMs);
        const a30 = ageMin(newest[`${sym}:30`], nowMs);
        links.candles.per_ticker[sym] = { tf10_age_min: a10, tf30_age_min: a30 };
        if (!marketOpen) continue; // intraday bars only expected during RTH
        if (a10 === null || a10 * MIN > CANDLE_10M_MAX_MS_RTH) {
          failures.push(`${sym}:10m=${a10 ?? "missing"}m`);
        }
        if (a30 === null || a30 * MIN > CANDLE_30M_MAX_MS_RTH) {
          failures.push(`${sym}:30m=${a30 ?? "missing"}m`);
        }
      }
      links.candles.status = !marketOpen ? "idle" : failures.length ? "fail" : "ok";
      if (failures.length) links.candles.detail = failures.join(", ");
    }
  } catch (e) {
    links.candles.status = "fail";
    links.candles.detail = `read_error: ${String(e?.message || e).slice(0, 120)}`;
  }

  // ── Links 3+4: scoring (timed:latest) + overlay (latest vs feed price) ───
  try {
    const scoringFailures = [];
    const overlayFailures = [];
    for (const sym of sentinels) {
      const latest = await kvGetJSON(env?.KV_TIMED, `timed:latest:${sym}`);
      const ingestAge = ageMin(Number(latest?.ingest_ts) || 0, nowMs);
      const grade = latest?._freshness?.grade || null;
      const enforced = latest?._freshness?.enforced === true;
      links.scoring.per_ticker[sym] = { ingest_age_min: ingestAge, grade };
      if (opHours) {
        if (ingestAge === null || ingestAge * MIN > SCORING_INGEST_MAX_MS_OPEN) {
          scoringFailures.push(`${sym}:ingest=${ingestAge ?? "missing"}m`);
        }
        if (enforced && grade === "STALE") {
          scoringFailures.push(`${sym}:grade=STALE`);
        }
      }

      const latestPx = Number(latest?._live_price ?? latest?.price) || 0;
      const feedPx = Number(pricesRows?.[sym]?.p) || 0;
      let divergencePct = null;
      if (latestPx > 0 && feedPx > 0) {
        divergencePct = Math.round(Math.abs(latestPx - feedPx) / feedPx * 10000) / 100;
      }
      links.overlay.per_ticker[sym] = { divergence_pct: divergencePct };
      if (marketOpen && divergencePct !== null && divergencePct > OVERLAY_DIVERGENCE_PCT) {
        overlayFailures.push(`${sym}:diverge=${divergencePct}%`);
      }
    }
    links.scoring.status = !opHours ? "idle" : scoringFailures.length ? "fail" : "ok";
    if (scoringFailures.length) links.scoring.detail = scoringFailures.join(", ");
    links.overlay.status = !marketOpen ? "idle" : overlayFailures.length ? "fail" : "ok";
    if (overlayFailures.length) links.overlay.detail = overlayFailures.join(", ");
  } catch (e) {
    links.scoring.status = "fail";
    links.scoring.detail = `read_error: ${String(e?.message || e).slice(0, 120)}`;
  }

  const failingLinks = Object.entries(links)
    .filter(([, l]) => l.status === "fail")
    .map(([name]) => name);

  return {
    ok: failingLinks.length === 0,
    checked_at: nowMs,
    sentinels,
    session: {
      market_open: marketOpen,
      within_operating_hours: opHours,
      session_type: session.session_type || null,
      is_holiday: session.is_holiday === true,
      source: session.source || null,
    },
    links,
    failing_links: failingLinks,
  };
}
