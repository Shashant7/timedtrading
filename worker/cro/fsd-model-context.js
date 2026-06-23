// worker/cro/fsd-model-context.js
// Shared TT model context for FSD publication rewrites (CTO levels, SPX→SPY).

import { loadCTOForTicker } from "../cto/cto-service.js";
import { RESEARCH_DESK_INDEX_ALIASES } from "./fsd-ingestion.js";

/** Memory theme tickers the desk scores and tracks (sector-mapping ai_infra_memory). */
export const MEMORY_THEME_TICKERS = ["MU", "WDC", "STX", "SNDK", "HIMX"];

const YAHOO_SPX_SYMBOL = "^GSPC";
const SPX_QUOTE_CACHE_KEY = "cro:spx_cash_quote";
const SPX_QUOTE_CACHE_TTL_SEC = 300;

export function publicationMentionsSpx(text) {
  return /\^?(SPX500|US500|SPX)\b/i.test(String(text || ""));
}

export function tickersIncludeMemoryTheme(tickers) {
  const set = new Set(MEMORY_THEME_TICKERS);
  return (tickers || []).some((t) => set.has(String(t || "").toUpperCase()));
}

export function publicationMentionsMemoryStocks(text) {
  return /\bmemory\s+stocks?\b/i.test(String(text || ""));
}

/** Live SPX/SPY ratio from market prints (not a fixed 10:1). */
export function computeSpxSpyRatio(spxPx, spyPx) {
  const spx = Number(spxPx);
  const spy = Number(spyPx);
  if (!Number.isFinite(spx) || !Number.isFinite(spy) || spx <= 0 || spy <= 0) return null;
  return Math.round((spx / spy) * 10000) / 10000;
}

/** Translate a source ^SPX level to SPY using the live ratio. */
export function translateSpxLevelToSpy(spxLevel, ratio) {
  const spx = Number(spxLevel);
  const r = Number(ratio);
  if (!Number.isFinite(spx) || !Number.isFinite(r) || spx <= 0 || r <= 0) return null;
  return Math.round((spx / r) * 100) / 100;
}

/** Translate a desk SPY level to approximate SPX cash index print. */
export function translateSpyLevelToSpx(spyLevel, ratio) {
  const spy = Number(spyLevel);
  const r = Number(ratio);
  if (!Number.isFinite(spy) || !Number.isFinite(r) || spy <= 0 || r <= 0) return null;
  return Math.round(spy * r * 100) / 100;
}

async function readSpyLivePrice(env) {
  try {
    const raw = await env?.KV?.get("timed:prices");
    if (!raw) return null;
    const prices = JSON.parse(raw);
    const snap = prices?.SPY || prices?.prices?.SPY;
    const px = Number(snap?.p ?? snap?.price);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch (_) {
    return null;
  }
}

/** Best-effort SPX cash index via Yahoo ^GSPC (TwelveData has no SPX feed). */
async function fetchYahooSpxCashQuote(env) {
  try {
    const kv = env?.KV_TIMED || env?.KV;
    if (kv) {
      const cached = await kv.get(SPX_QUOTE_CACHE_KEY, "json").catch(() => null);
      if (cached?.price > 0 && cached?.fetched_at && Date.now() - cached.fetched_at < SPX_QUOTE_CACHE_TTL_SEC * 1000) {
        return { spxPx: Number(cached.price), source: "yahoo_gspc_cached" };
      }
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SPX_SYMBOL)}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "TimedTrading/1.0 (research-desk context)" },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!resp?.ok) return null;
    const data = await resp.json().catch(() => null);
    const meta = data?.chart?.result?.[0]?.meta;
    const px = Number(meta?.regularMarketPrice ?? meta?.chartPreviousClose);
    if (!Number.isFinite(px) || px <= 0) return null;
    const out = { spxPx: px, source: "yahoo_gspc" };
    if (kv) {
      await kv.put(SPX_QUOTE_CACHE_KEY, JSON.stringify({ price: px, fetched_at: Date.now() }), {
        expirationTtl: SPX_QUOTE_CACHE_TTL_SEC,
      }).catch(() => {});
    }
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve SPX cash + SPY live prices and the current ratio.
 * SPX comes from Yahoo ^GSPC; SPY from timed:prices. No fixed 10:1 math.
 */
export async function resolveSpxSpyPrices(env) {
  let spyPx = await readSpyLivePrice(env);
  let spxPx = null;
  let spxSource = null;

  const yahoo = await fetchYahooSpxCashQuote(env);
  if (yahoo?.spxPx > 0) {
    spxPx = yahoo.spxPx;
    spxSource = yahoo.source;
  }

  const ratio = computeSpxSpyRatio(spxPx, spyPx);
  return { spxPx, spyPx, ratio, spxSource };
}

export function summarizeCTOForPrompt(sym, cto) {
  if (!cto || typeof cto !== "object") return null;
  const S = String(sym || "").toUpperCase();
  const parts = [`CTO ${S}:`];
  const px = Number(cto.current_price);
  if (Number.isFinite(px) && px > 0) parts.push(`anchor=$${px.toFixed(2)}`);
  const up = Array.isArray(cto.top_upside) ? cto.top_upside[0] : cto.top_upside;
  const dn = Array.isArray(cto.top_downside) ? cto.top_downside[0] : cto.top_downside;
  if (up?.price) {
    const prob = Number(up.regime_adjusted_prob ?? up.adj_prob);
    const probStr = Number.isFinite(prob) ? `${(prob * 100).toFixed(0)}%` : "?";
    parts.push(`upside=${up.label || "magnet"}@$${Number(up.price).toFixed(2)}(${probStr})`);
  }
  if (dn?.price) {
    const prob = Number(dn.regime_adjusted_prob ?? dn.adj_prob);
    const probStr = Number.isFinite(prob) ? `${(prob * 100).toFixed(0)}%` : "?";
    parts.push(`downside=${dn.label || "magnet"}@$${Number(dn.price).toFixed(2)}(${probStr})`);
  }
  if (cto.read?.label) parts.push(`read=${cto.read.label}`);
  return parts.length > 1 ? parts.join(" ") : null;
}

export async function loadCTOLineForTicker(env, sym) {
  const S = String(sym || "").toUpperCase();
  if (!S) return null;
  try {
    const cto = await loadCTOForTicker(env, S);
    return summarizeCTOForPrompt(S, cto);
  } catch (_) {
    return null;
  }
}

/**
 * SPX cash index context — desk scores SPY (and ES); never invent SPX from ÷10.
 * When ratio is known, show how to translate source ^SPX levels to SPY equivalents.
 */
export async function buildSpxIndexContextBlock(env, { spyScoringLine = null, spyCtoLine = null } = {}) {
  const { spxPx, spyPx, ratio, spxSource } = await resolveSpxSpyPrices(env);
  const lines = [];

  lines.push("SPX (cash index): not in TT price feed — use Yahoo ^GSPC snapshot below for level translation only.");
  if (Number.isFinite(spxPx) && spxPx > 0) {
    const src = spxSource?.includes("yahoo") ? "Yahoo ^GSPC" : "external index";
    lines.push(`SPX cash print: ~$${spxPx.toFixed(2)} (${src})`);
  }
  if (Number.isFinite(spyPx) && spyPx > 0) {
    lines.push(`SPY (desk tradeable proxy): $${spyPx.toFixed(2)} — cite SPY triggers/stops from model context`);
  }
  if (Number.isFinite(ratio) && ratio > 0) {
    lines.push(`Live SPX/SPY ratio: ${ratio.toFixed(4)} (NOT fixed 10:1 — dividends/expense drift)`);
    lines.push(`To convert source ^SPX level → SPY: SPY ≈ SPX_level ÷ ${ratio.toFixed(4)}`);
    if (Number.isFinite(spxPx) && spxPx > 0 && Number.isFinite(spyPx)) {
      const exampleSpx = Math.round(spxPx / 10) * 10;
      const exampleSpy = translateSpxLevelToSpy(exampleSpx, ratio);
      if (exampleSpy) {
        lines.push(`Example: SPX ${exampleSpx} ≈ SPY $${exampleSpy.toFixed(2)} at current ratio`);
      }
    }
  } else {
    lines.push("Ratio unavailable — present source SPX levels as quoted; blend desk read using SPY model context only.");
  }

  if (spyScoringLine) lines.push(spyScoringLine);
  if (spyCtoLine) lines.push(spyCtoLine);
  for (const alias of RESEARCH_DESK_INDEX_ALIASES.SPX || []) {
    if (alias === "SPY") continue;
    lines.push(`Also tagged: ${alias} (futures proxy for SPX)`);
  }
  return lines.join("\n");
}

export function memoryThemeHeaderLine() {
  return `MEMORY THEME (ai_infra_memory): desk tracks ${MEMORY_THEME_TICKERS.join(", ")} with scoring + CTO probabilistic magnets — cite these when present; do not claim the model lacks memory-stock levels.`;
}
