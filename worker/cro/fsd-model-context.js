// worker/cro/fsd-model-context.js
// Shared TT model context for FSD publication rewrites (CTO levels, SPX→SPY).

import { loadCTOForTicker } from "../cto/cto-service.js";
import { RESEARCH_DESK_INDEX_ALIASES } from "./fsd-ingestion.js";

/** Memory theme tickers the desk scores and tracks (sector-mapping ai_infra_memory). */
export const MEMORY_THEME_TICKERS = ["MU", "WDC", "STX", "SNDK", "HIMX"];

const SPX_INDEX_TOKENS = new Set(["SPX", "SPX500", "US500"]);

/** SPX cash index level → SPY ETF proxy (≈10×). */
export function spxLevelToSpy(spxLevel) {
  const n = Number(spxLevel);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 10) * 100) / 100;
}

/** SPY price → approximate SPX cash index print. */
export function spyPriceToSpx(spyPrice) {
  const n = Number(spyPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10 * 100) / 100;
}

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

async function readSpyLivePrice(env) {
  try {
    const raw = await env?.KV?.get("timed:prices");
    if (!raw) return null;
    const prices = JSON.parse(raw);
    const snap = prices?.SPY;
    const px = Number(snap?.p ?? snap?.price);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch (_) {
    return null;
  }
}

/** Best-effort SPX index quote via TwelveData; falls back to SPY×10. */
export async function resolveSpxSpyPrices(env) {
  let spyPx = await readSpyLivePrice(env);
  let spxPx = null;
  let spxSource = null;

  try {
    const { tdFetchQuote } = await import("../twelvedata.js");
    const r = await tdFetchQuote(env, ["SPX"]);
    const q = r?.snapshots?.SPX;
    if (q && Number(q.price) > 0) {
      spxPx = Number(q.price);
      spxSource = "twelvedata";
      if (!spyPx) spyPx = spxLevelToSpy(spxPx);
    }
  } catch (_) {}

  if (!spxPx && spyPx) {
    spxPx = spyPriceToSpx(spyPx);
    spxSource = spxSource || "spy_proxy";
  }
  if (!spyPx && spxPx) {
    spyPx = spxLevelToSpy(spxPx);
  }

  return { spxPx, spyPx, spxSource };
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

/** SPX cash index context block — always routes levels through SPY proxy. */
export async function buildSpxIndexContextBlock(env, { spyScoringLine = null, spyCtoLine = null } = {}) {
  const { spxPx, spyPx, spxSource } = await resolveSpxSpyPrices(env);
  const lines = [];
  if (Number.isFinite(spxPx) && spxPx > 0) {
    const src = spxSource === "twelvedata" ? "TwelveData SPX" : "SPY×10 proxy";
    lines.push(`SPX (cash index): ~$${spxPx.toFixed(2)} (${src})`);
  }
  if (Number.isFinite(spyPx) && spyPx > 0) {
    lines.push(`SPY (tradeable proxy): $${spyPx.toFixed(2)} — use SPX_source_level ÷ 10 ≈ SPY_level in key points`);
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
