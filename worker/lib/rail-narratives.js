// worker/lib/rail-narratives.js — LLM + rule-based narratives for Right Rail heroes.

const DEFAULT_MODEL = "gpt-4o-mini";
const FUNDAMENTALS_KV_PREFIX = "timed:fundamentals_narrative:v1:";
const CATALYSTS_KV_PREFIX = "timed:catalysts_narrative:v1:";
const FUNDAMENTALS_TTL_SEC = 6 * 60 * 60;
const CATALYSTS_TTL_SEC = 45 * 60;

async function callOpenAI(env, systemPrompt, userPrompt, { maxTokens = 600 } = {}) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };
  const body = {
    model: env?.OPENAI_MODEL || DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    temperature: 0.2,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error_kind: `openai_${resp.status}`, hint: errText.slice(0, 200) };
    }
    const json = await resp.json();
    return { ok: true, content: json.choices?.[0]?.message?.content || "" };
  } catch (e) {
    return { ok: false, error_kind: e?.name === "AbortError" ? "openai_timeout" : "openai_exception" };
  } finally {
    clearTimeout(t);
  }
}

function safeParseJson(s) {
  try {
    return JSON.parse(String(s || "").trim());
  } catch (_) {
    return null;
  }
}

function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

export function buildFundamentalsHeroNarrative(snapshot) {
  const F = snapshot || {};
  const prof = F.profile || {};
  const val = F.valuation || {};
  const grw = F.growth || {};
  const earn = F.earnings || {};
  const comp = F.compounder || {};
  const sector = prof.sector || "this sector";
  const industry = prof.industry || sector;
  const beatRate = num(earn.beat_rate_pct);
  const fvPrem = num(val.fair_value_premium_pct ?? comp.fv_premium_pct);
  const epsClass = String(grw.eps_growth_class || "unknown");
  const revClass = String(grw.rev_growth_class || "unknown");
  const tier = String(comp.tier || comp.compounder_tier || "").toLowerCase();

  let tone = "neutral";
  if (epsClass === "declining" || revClass === "declining") tone = "cautious";
  else if (["explosive", "exploding", "strong"].includes(epsClass) || ["explosive", "exploding", "strong"].includes(revClass)) tone = "bullish";
  if (fvPrem != null && fvPrem > 25) tone = tone === "bullish" ? "neutral" : "cautious";

  const bullets = [];
  if (beatRate != null) bullets.push(`Reported earnings beat the street in roughly ${Math.round(beatRate)}% of recent quarters.`);
  if (fvPrem != null) {
    bullets.push(fvPrem > 8
      ? `Fair-value model flags a ${Math.abs(fvPrem).toFixed(0)}% premium vs modeled intrinsic value.`
      : fvPrem < -8
        ? `Fair-value model shows a ${Math.abs(fvPrem).toFixed(0)}% discount vs modeled intrinsic value.`
        : "Valuation sits near the modeled fair-value band.");
  }
  if (grw.eps_growth_pct != null || grw.rev_growth_pct != null) {
    const eps = grw.eps_growth_pct != null ? `${grw.eps_growth_pct >= 0 ? "+" : ""}${Number(grw.eps_growth_pct).toFixed(0)}% EPS` : null;
    const rev = grw.rev_growth_pct != null ? `${grw.rev_growth_pct >= 0 ? "+" : ""}${Number(grw.rev_growth_pct).toFixed(0)}% revenue` : null;
    bullets.push(`Growth profile: ${[eps, rev].filter(Boolean).join(" · ") || "mixed"}.`);
  }
  while (bullets.length < 3) {
    bullets.push(`Capital structure and cash flow metrics should be read against ${industry} peers.`);
    if (bullets.length >= 3) break;
  }

  const qualityChip = tier === "elite" ? "Quality compounder"
    : tier === "watch" ? "Watch quality"
    : beatRate != null && beatRate >= 70 ? "Consistent reporter"
    : "Standard profile";

  const headline = tone === "bullish"
    ? `${prof.name || "This name"} screens as a constructive ${industry} fundamental story.`
    : tone === "cautious"
      ? `${prof.name || "This name"} carries caution flags in ${industry}.`
      : `${prof.name || "This name"} presents a balanced ${industry} fundamental picture.`;

  return {
    headline,
    bullets: bullets.slice(0, 3),
    quality_chip: qualityChip,
    tone,
    as_of: F.as_of || Date.now(),
    source: "rule_based",
  };
}

export function buildCatalystsStreetBuzz(catalysts) {
  const C = catalysts || {};
  const news = C.news || {};
  const dom = String(news.dominant_sentiment || "neutral").toLowerCase();
  const count = Number(news.count) || 0;
  const top = news.top_catalyst?.headline || news.latest_3?.[0]?.headline || null;
  const macro = C.macro?.macro_narrative || C.macro?.one_liner || null;
  const fsdCount = Number(C.fsd_intel?.count) || 0;

  let vibe = "quiet";
  if (count === 0 && fsdCount === 0) vibe = "quiet";
  else if (dom === "bullish" && count >= 2) vibe = "bullish";
  else if (dom === "bearish" && count >= 2) vibe = "bearish";
  else if (count > 0 || fsdCount > 0) vibe = "mixed";

  const headline = vibe === "quiet"
    ? "Street is quiet on this ticker right now."
    : vibe === "bullish"
      ? "Recent headlines lean constructive."
      : vibe === "bearish"
        ? "Recent headlines lean cautious."
        : "Street buzz is mixed — read headlines before acting.";

  const summaryParts = [];
  if (top) summaryParts.push(`Lead headline: "${String(top).slice(0, 120)}".`);
  if (count > 0) summaryParts.push(`${count} filtered headline${count === 1 ? "" : "s"} in the last few days (${dom} tone).`);
  if (fsdCount > 0) summaryParts.push(`${fsdCount} research-desk mention${fsdCount === 1 ? "" : "s"} on tape.`);
  if (macro) summaryParts.push(String(macro).slice(0, 160));
  const summary = summaryParts.join(" ") || "No fresh catalyst flow after relevance filtering.";

  const topDrivers = [];
  if (top) topDrivers.push(String(top).slice(0, 100));
  if (fsdCount > 0 && C.fsd_intel?.publications?.[0]?.title) {
    topDrivers.push(String(C.fsd_intel.publications[0].title).slice(0, 100));
  }

  return {
    vibe,
    headline,
    summary,
    top_drivers: topDrivers.slice(0, 2),
    freshness_note: count > 0 ? "News filtered to headlines mentioning this symbol." : "Waiting for ticker-specific headlines.",
    as_of: C.fetched_at || Date.now(),
    source: "rule_based",
  };
}

function compactFundamentalsInput(snapshot) {
  const F = snapshot || {};
  return {
    ticker: F.ticker,
    sector: F.profile?.sector,
    industry: F.profile?.industry,
    valuation: F.valuation,
    growth: F.growth,
    earnings: {
      beat_rate_pct: F.earnings?.beat_rate_pct,
      avg_surprise_pct: F.earnings?.avg_surprise_pct,
      next_date: F.earnings?.next?.date,
      history: (F.earnings?.history || []).slice(0, 8).map((r) => ({
        date: r.date,
        result: r.result,
        surprise_pct: r.surprise_pct,
      })),
    },
    compounder: F.compounder,
    capital_structure: {
      cash_rich: F.capital_structure?.cash_rich,
      fcf_ttm: F.capital_structure?.fcf_ttm,
      total_debt: F.capital_structure?.total_debt,
    },
  };
}

const FUNDAMENTALS_SYSTEM = `The trader reads a fundamentals hero card. Return JSON only:
{ "headline": string, "bullets": [string,string,string], "quality_chip": string, "tone": "bullish"|"neutral"|"cautious" }
Plain language. Reference sector/industry context. No trade calls. No second-person pronouns. Cite beat rate, fair-value premium, or growth inflection when data supports it.`;

const CATALYSTS_SYSTEM = `The trader reads a "Street Buzz" catalyst card. Return JSON only:
{ "vibe": "bullish"|"mixed"|"quiet"|"bearish", "headline": string, "summary": string, "top_drivers": [string,string], "freshness_note": string }
Plain language. No trade calls. No second-person pronouns. Summarize filtered news + research mentions.`;

export async function fetchFundamentalsNarrative(env, ticker, { force = false, snapshot = null } = {}) {
  const sym = String(ticker || "").toUpperCase().trim();
  const KV = env?.KV_TIMED || env?.KV;
  if (!sym || !KV) return { ok: false, error: "missing_kv_or_ticker" };

  const cacheKey = `${FUNDAMENTALS_KV_PREFIX}${sym}`;
  if (!force) {
    try {
      const raw = await KV.get(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.headline) return { ok: true, narrative: parsed, from_cache: true };
      }
    } catch (_) {}
  }

  const snap = snapshot || null;
  if (!snap) return { ok: false, error: "snapshot_required" };

  const llm = await callOpenAI(
    env,
    FUNDAMENTALS_SYSTEM,
    JSON.stringify(compactFundamentalsInput(snap)),
  );
  let narrative = null;
  if (llm.ok) {
    const parsed = safeParseJson(llm.content);
    if (parsed?.headline && Array.isArray(parsed.bullets)) {
      narrative = {
        headline: String(parsed.headline).slice(0, 220),
        bullets: parsed.bullets.slice(0, 3).map((b) => String(b).slice(0, 220)),
        quality_chip: String(parsed.quality_chip || "Fundamentals").slice(0, 40),
        tone: ["bullish", "neutral", "cautious"].includes(parsed.tone) ? parsed.tone : "neutral",
        as_of: snap.as_of || Date.now(),
        source: "llm",
      };
    }
  }
  if (!narrative) narrative = buildFundamentalsHeroNarrative(snap);

  try {
    await KV.put(cacheKey, JSON.stringify(narrative), { expirationTtl: FUNDAMENTALS_TTL_SEC });
  } catch (_) {}

  return { ok: true, narrative, from_cache: false, llm_ok: !!llm.ok };
}

export async function fetchCatalystsNarrative(env, ticker, catalystsPayload, { force = false } = {}) {
  const sym = String(ticker || "").toUpperCase().trim();
  const KV = env?.KV_TIMED || env?.KV;
  if (!sym || !KV) return { ok: false, error: "missing_kv_or_ticker" };

  const cacheKey = `${CATALYSTS_KV_PREFIX}${sym}`;
  if (!force) {
    try {
      const raw = await KV.get(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.headline) return { ok: true, narrative: parsed, from_cache: true };
      }
    } catch (_) {}
  }

  const C = catalystsPayload || {};
  const llmInput = {
    ticker: sym,
    news: C.news,
    fsd_count: C.fsd_intel?.count,
    fsd_titles: (C.fsd_intel?.publications || []).slice(0, 3).map((p) => p.title),
    social: C.social?.summary || C.social,
    themes: C.themes?.active_themes || C.themes,
    macro: C.macro?.macro_narrative || C.macro?.one_liner,
  };

  const llm = await callOpenAI(env, CATALYSTS_SYSTEM, JSON.stringify(llmInput));
  let narrative = null;
  if (llm.ok) {
    const parsed = safeParseJson(llm.content);
    if (parsed?.headline) {
      narrative = {
        vibe: ["bullish", "mixed", "quiet", "bearish"].includes(parsed.vibe) ? parsed.vibe : "mixed",
        headline: String(parsed.headline).slice(0, 200),
        summary: String(parsed.summary || "").slice(0, 400),
        top_drivers: Array.isArray(parsed.top_drivers) ? parsed.top_drivers.slice(0, 2).map((d) => String(d).slice(0, 120)) : [],
        freshness_note: String(parsed.freshness_note || "").slice(0, 160),
        as_of: C.fetched_at || Date.now(),
        source: "llm",
      };
    }
  }
  if (!narrative) narrative = buildCatalystsStreetBuzz(C);

  try {
    await KV.put(cacheKey, JSON.stringify(narrative), { expirationTtl: CATALYSTS_TTL_SEC });
  } catch (_) {}

  return { ok: true, narrative, from_cache: false, llm_ok: !!llm.ok };
}
