// worker/cro/fsd-sanitize.js — strip source-brand + author bylines from
// FSD-derived copy before it hits any user-facing surface.
//
// Operator report (Jul 6 2026): a Discord/Slack Market Intel alert rendered
//   "Market Intel — SPY · Mark L. Newton, CMT – Monday's Technology rebound…"
// The FSD raw title carries the author + credentials; the LLM rewriter is
// prompted not to include Fundstrat, but the raw title also feeds fallback
// paths (Discord notify, ticker Intel panel) when the rewrite is empty or
// running behind. This module normalises both cases so nothing user-facing
// leaks a source brand or credentialed byline.

const AUTHOR_CRED_RE = /\b[A-Z][A-Za-z.]*(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z-]+\s*,\s*(?:CMT|CFA|CFP|PhD|MBA|CAIA|FRM)\b\.?/g;
const SOURCE_BRAND_RE = /\b(Fundstrat(?:\s+Direct)?|FSD|Fundstrat\.com|fundstratdirect\.com|FS Insight|FSInsight)\b/gi;
const BYLINE_PREFIX_RE = /^\s*(?:by\s+)?[A-Z][A-Za-z.]*(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z-]+\s*(?:,\s*(?:CMT|CFA|CFP|PhD|MBA|CAIA|FRM))?\s*[\u2013\u2014\-:|]\s+/;

/**
 * Strip source-brand references and credentialed author bylines from a title
 * or short prose block. Collapses whitespace and dangling separators.
 */
export function sanitizeFsdCopy(input) {
  if (input == null) return input;
  let out = String(input);
  // Credentialed bylines anywhere in the text (e.g. "Mark L. Newton, CMT").
  out = out.replace(AUTHOR_CRED_RE, "");
  // Source brand mentions.
  out = out.replace(SOURCE_BRAND_RE, "");
  // Byline prefix (e.g. "Tom Lee — Monday's ..." → "Monday's ...").
  out = out.replace(BYLINE_PREFIX_RE, "");
  // Cleanup: collapse whitespace + trim dangling separators / punctuation
  // left over from the substitutions.
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[\u2013\u2014\-]\s*[\u2013\u2014\-]\s*/g, " \u2014 ")
    .replace(/^\s*[\u2013\u2014\-:|,]\s*/, "")
    .replace(/\s*[\u2013\u2014\-:|,]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

/** Convenience — sanitize a title AND provide a safe fallback when it collapses to empty. */
export function sanitizeFsdTitle(input, fallback = "Market Intel update") {
  const cleaned = sanitizeFsdCopy(input);
  if (!cleaned || cleaned.length < 4) return fallback;
  return cleaned;
}
