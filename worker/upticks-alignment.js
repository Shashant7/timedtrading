/**
 * Newton Upticks list alignment.
 *
 * Live KV `timed:admin:upticks` drives the +10 conviction bonus.
 * `TT_SELECTED_DEFAULT` drives the +15 curated bonus and cold-isolate
 * fallbacks. After a monthly rotation those two sets must be equal.
 * Sep 2026: KV had DDOG/LITE/NVDA and had dropped IRM/MAR/VLO/VST,
 * but the hardcoded set was still August — DDOG looked like dead weight.
 */

export function normalizeTickerList(list) {
  return [...new Set(
    (list || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean),
  )].sort();
}

export function diffUpticksAlignment(live, hardcoded) {
  const liveSet = new Set(normalizeTickerList(live));
  const codeSet = new Set(normalizeTickerList(hardcoded));
  const missingInCode = [...liveSet].filter((t) => !codeSet.has(t));
  const extraInCode = [...codeSet].filter((t) => !liveSet.has(t));
  return {
    aligned: missingInCode.length === 0 && extraInCode.length === 0,
    live_count: liveSet.size,
    code_count: codeSet.size,
    missingInCode,
    extraInCode,
  };
}
