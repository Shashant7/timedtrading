/** Shared markdown cleanup for Daily Brief display (web + email). */

export function stripBriefMarkdownForDisplay(md) {
  if (!md || typeof md !== "string") return "";
  let cleaned = md
    .replace(/ (#{2,4}) /g, "\n\n$1 ")
    .replace(/ - \*\*/g, "\n- **")
    .replace(/ - ([A-Z])/g, "\n- $1");

  // Today's Three TOC — rendered by the infographic strip.
  const stripIdx = cleaned.search(/^\s*1\.\s+(?:\*\*?)?(?:SPY|QQQ|IWM|S&P|ES|NQ|Today)/im);
  if (stripIdx >= 0 && stripIdx < 800) {
    const after = cleaned.slice(stripIdx);
    const m = after.match(/^\s*1\.[\s\S]*?\n\s*2\.[\s\S]*?\n\s*3\.[^\n]*\n/);
    if (m) cleaned = cleaned.slice(0, stripIdx) + cleaned.slice(stripIdx + m[0].length);
  }

  // Per-index prediction headings — rendered in Index Outlook cards at end.
  cleaned = cleaned.replace(
    /\n#{2,4}\s*(?:ES|SPY|QQQ|IWM|NQ|DIA)\s+Prediction\b[\s\S]*?(?=\n#{2,4}\s|$)/gi,
    "\n",
  );

  // Merged Index Outlook section (morning game plan + evening scorecard).
  cleaned = cleaned.replace(
    /\n#{1,3}\s*Index\s+Outlook\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
    "\n",
  );

  // CRO Desk wrap — rendered in the structured Desk card on evening briefs.
  cleaned = cleaned.replace(
    /\n#{1,3}\s*CRO\s+(?:Research\s+)?Desk(?:\s+Wrap)?\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
    "\n",
  );

  // Legacy headings merged into The Market Read.
  cleaned = cleaned.replace(
    /\n#{1,3}\s*(?:The\s+)?Desk'?s?\s*Read\b[\s\S]*?(?=\n#{1,3}\s)/gi,
    "\n",
  );
  cleaned = cleaned.replace(
    /\n#{1,3}\s*Sector\s*Themes?\b[\s\S]*?(?=\n#{1,3}\s)/gi,
    "\n",
  );
  cleaned = cleaned.replace(
    /\n#{1,3}\s*Market\s*Context\b[\s\S]*?(?=\n#{1,3}\s)/gi,
    "\n",
  );
  cleaned = cleaned.replace(
    /\n#{1,3}\s*Session\s+Recap\b[\s\S]*?(?=\n#{1,3}\s)/gi,
    "\n",
  );

  // Investor Portfolio narrative stays in the body — chip row renders above it.

  // Stale LLM Key Levels — live mechanical copy renders at end of brief.
  cleaned = cleaned.replace(
    /\n#{1,3}\s*Key Levels\s*(?:&|and)\s*Game Plan\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
    "\n",
  );

  // If the model front-loads Index Outlook before The Market Read, drop the
  // leading block so the body opens on the narrative.
  cleaned = cleaned.replace(
    /^\s*(?:#{1,3}\s*Index\s+Outlook[\s\S]*?)(?=\n#{1,3}\s*The\s+Market\s+Read\b)/i,
    "\n",
  );

  return cleaned.trim();
}

/** Split display markdown into ## sections (after stripBriefMarkdownForDisplay). */
export function parseBriefDisplaySections(md) {
  const cleaned = stripBriefMarkdownForDisplay(md);
  if (!cleaned) return [];
  const chunks = cleaned.split(/\n(?=##\s+)/).map((c) => c.trim()).filter(Boolean);
  return chunks.map((chunk) => {
    const m = chunk.match(/^##\s+(.+?)(?:\n([\s\S]*))?$/);
    if (!m) return { title: "", body: chunk, key: null };
    const title = m[1].trim();
    const body = (m[2] || "").trim();
    const lower = title.toLowerCase();
    let key = null;
    if (lower.includes("model actions")) key = "modelActions";
    else if (lower.includes("top movers")) key = "topMovers";
    else if (lower.includes("active trader")) key = "activeTrader";
    else if (lower.includes("investor portfolio")) key = "investorPortfolio";
    return { title, body, key };
  });
}

export function briefSectionChipKey(title) {
  const lower = String(title || "").toLowerCase();
  if (lower.includes("model actions")) return "modelActions";
  if (lower.includes("top movers")) return "topMovers";
  if (lower.includes("active trader")) return "activeTrader";
  if (lower.includes("investor portfolio")) return "investorPortfolio";
  return null;
}
