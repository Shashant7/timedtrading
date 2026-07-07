// Trust Spine — unified Today's Plays queue (server-side priority sort).

const MODE_RANK = { RIDE: 0, READY: 1, DRIFT: 2, FADE: 3, WAIT: 4, UNKNOWN: 5 };

function playPriority(item) {
  const mode = String(item?.confluence_mode || item?.mode || "UNKNOWN").toUpperCase();
  const tier = String(item?.conviction_tier || item?.tier || "C").toUpperCase();
  const tierBoost = tier === "A" ? 0 : tier === "B" ? 10 : 20;
  const score = Number(item?.confluence_score || item?.score || 0);
  return (MODE_RANK[mode] ?? 5) * 1000 + tierBoost * 10 - score;
}

/**
 * Merge options plays + ready setups into one prioritized queue.
 */
export function buildTodayPlaysQueue({ optionsPlays = [], readySetups = [], limit = 20 } = {}) {
  const items = [];

  for (const p of optionsPlays || []) {
    if (!p?.ticker) continue;
    items.push({
      kind: "options",
      ticker: String(p.ticker).toUpperCase(),
      direction: p.direction || null,
      mode: p.confluence_mode || p.mode || null,
      confluence_mode: p.confluence_mode || null,
      confluence_score: p.confluence_score ?? p.score ?? null,
      conviction_tier: p.conviction_tier || p.__conviction_tier || null,
      archetype: p.primary_archetype || p.archetype || null,
      headline: p.headline || p.label || null,
      priority: playPriority(p),
      source: "options_all",
    });
  }

  for (const s of readySetups || []) {
    if (!s?.ticker) continue;
    items.push({
      kind: "setup",
      ticker: String(s.ticker).toUpperCase(),
      direction: s.direction || s.trigger_dir || null,
      mode: s.kanban_stage || s.stage || "READY",
      confluence_mode: s.confluence_mode || "READY",
      confluence_score: s.rank ?? s.score ?? null,
      conviction_tier: s.__conviction_tier || null,
      archetype: s.setup_name || s.entry_path || null,
      headline: s.setup_name || s.ticker,
      priority: playPriority({ ...s, mode: "READY" }),
      source: "ready_setups",
    });
  }

  items.sort((a, b) => a.priority - b.priority);
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = `${it.ticker}:${it.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
    if (deduped.length >= limit) break;
  }

  return {
    generated_at: Date.now(),
    count: deduped.length,
    plays: deduped,
  };
}
