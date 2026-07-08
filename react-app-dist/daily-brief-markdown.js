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

    // Investor Portfolio narrative stays in the body — chip row renders above it.
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

  function parseBriefPositionGuidanceByTicker(body) {
    var map = {};
    if (!body || typeof body !== "string") return map;
    var lines = body.split(/\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || "").trim().replace(/^[-*•]\s+/, "");
      if (!line) continue;
      var m = line.match(/^\*\*([A-Z][A-Z0-9.-]{0,9})\*\*:?\s*(.+)$/i);
      if (m) {
        map[m[1].toUpperCase()] = m[2].trim();
        continue;
      }
      m = line.match(/^\*\*([A-Z][A-Z0-9.-]{0,9})\*\*\s+(.+)$/i);
      if (m) {
        map[m[1].toUpperCase()] = m[2].trim();
        continue;
      }
      m = line.match(/^([A-Z][A-Z0-9.-]{0,9})\s*[·—–-]\s*(.+)/);
      if (m) map[m[1].toUpperCase()] = m[2].trim();
    }
    return map;
  }

  /** Split display markdown into ## sections (after stripBriefMarkdownForDisplay). */
  function parseBriefDisplaySections(md) {
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

  function briefSectionChipKey(title) {
    const lower = String(title || "").toLowerCase();
    if (lower.includes("model actions")) return "modelActions";
    if (lower.includes("top movers")) return "topMovers";
    if (lower.includes("active trader")) return "activeTrader";
    if (lower.includes("investor portfolio")) return "investorPortfolio";
    return null;
  }

  function parseBriefTopMoversText(text) {
    if (!text || typeof text !== "string") return { gainers: [], losers: [] };
    const parseSide = (line, sign) => {
      const out = [];
      const alt = /\b([A-Z][A-Z0-9.-]{0,9})\b\s*([+-]\d+(?:\.\d+)?)%/g;
      let m;
      while ((m = alt.exec(line)) != null) {
        const ticker = String(m[1] || "").toUpperCase();
        const pct = Number(m[2]);
        if (!ticker || !Number.isFinite(pct)) continue;
        if (sign === "up" && pct <= 0) continue;
        if (sign === "dn" && pct >= 0) continue;
        out.push({ ticker, pct, price: null });
      }
      return out;
    };
    const gainersLine = text.split("\n").find((l) => /gainers?/i.test(l)) || text;
    const losersLine = text.split("\n").find((l) => /losers?/i.test(l)) || "";
    return {
      gainers: parseSide(gainersLine, "up"),
      losers: parseSide(losersLine, "dn"),
    };
  }

  window.TimedBriefMarkdown = {
    stripBriefMarkdownForDisplay,
    parseBriefDisplaySections,
    parseBriefPositionGuidanceByTicker,
    briefSectionChipKey,
    parseBriefTopMoversText,
  };
})();

// cache-bust:1783471129819:313628963
