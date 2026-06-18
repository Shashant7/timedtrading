/** Browser copy — keep in sync with worker/daily-brief-markdown.js */
(function () {
  if (typeof window === "undefined") return;

  function stripBriefMarkdownForDisplay(md) {
    if (!md || typeof md !== "string") return "";
    let cleaned = md
      .replace(/ (#{2,4}) /g, "\n\n$1 ")
      .replace(/ - \*\*/g, "\n- **")
      .replace(/ - ([A-Z])/g, "\n- $1");

    const stripIdx = cleaned.search(/^\s*1\.\s+(?:\*\*?)?(?:SPY|QQQ|IWM|S&P|ES|NQ|Today)/im);
    if (stripIdx >= 0 && stripIdx < 800) {
      const after = cleaned.slice(stripIdx);
      const m = after.match(/^\s*1\.[\s\S]*?\n\s*2\.[\s\S]*?\n\s*3\.[^\n]*\n/);
      if (m) cleaned = cleaned.slice(0, stripIdx) + cleaned.slice(stripIdx + m[0].length);
    }

    cleaned = cleaned.replace(
      /\n#{2,4}\s*(?:ES|SPY|QQQ|IWM|NQ|DIA)\s+Prediction\b[\s\S]*?(?=\n#{2,4}\s|$)/gi,
      "\n",
    );
    cleaned = cleaned.replace(
      /\n#{1,3}\s*Index\s+Outlook\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
      "\n",
    );
    cleaned = cleaned.replace(
      /\n#{1,3}\s*CRO\s+(?:Research\s+)?Desk(?:\s+Wrap)?\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
      "\n",
    );
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
    cleaned = cleaned.replace(
      /\n#{1,3}\s*Investor\s*Portfolio\b[\s\S]*?(?=\n#{1,3}\s|$)/gi,
      "\n",
    );
    cleaned = cleaned.replace(
      /\n#{1,3}\s*Key Levels\s*(?:&|and)\s*Game Plan\b[\s\S]*?(?=\n#{1,3}\s|\n\*\*Risk Factors\b|$)/gi,
      "\n",
    );
    cleaned = cleaned.replace(
      /^\s*(?:#{1,3}\s*Index\s+Outlook[\s\S]*?)(?=\n#{1,3}\s*The\s+Market\s+Read\b)/i,
      "\n",
    );

    return cleaned.trim();
  }

  window.TimedBriefMarkdown = { stripBriefMarkdownForDisplay };
})();

// cache-bust:1781817187143:733775959
