// Email module — SendGrid integration for outbound emails
// Handles: welcome, daily brief digest, trade alerts, re-engagement, unsubscribe tokens.

import { optionsPlayEmailHtml } from "./options-plays.js";

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";
const FROM_EMAIL = "notifications@timed-trading.com";
const FROM_NAME = "Timed Trading";
const REPLY_TO_EMAIL = "support@timed-trading.com";
const REPLY_TO_NAME = "Timed Trading Support";

const BRAND = {
  green: "#00c853",
  dark: "#0b0e11",
  cardBg: "#111318",
  border: "#1e2128",
  textPrimary: "#e5e7eb",
  textSecondary: "#9ca3af",
  textMuted: "#6b7280",
  // Editorial accent — matches web --tt-editorial (purple)
  editorial: "#a78bfa",
  warning: "#f59e0b",
};

// Email-safe font stacks (webfonts are unreliable in Gmail/Outlook/Apple Mail,
// so we fall back to universally-available families that match the web look).
// - UI: same Helvetica Neue / Arial already used
// - Editorial: Georgia is available on ~100% of mail clients and matches
//   Instrument Serif closely enough in tone.
// - Mono/num: Menlo / Consolas / Courier New for data.
const EMAIL_FONT_UI = "'Helvetica Neue',Arial,sans-serif";
const EMAIL_FONT_EDITORIAL = "Georgia,'Iowan Old Style','Palatino Linotype',Palatino,serif";
const EMAIL_FONT_MONO = "'SF Mono',Menlo,Consolas,'Courier New',monospace";

// ═══════════════════════════════════════════════════════════════════════
// Brief Infographic → Email HTML
// Renders the same structured data the web BriefInfographic consumes,
// using tables + inline styles for cross-client compatibility
// (Gmail, Outlook, Apple Mail).
// ═══════════════════════════════════════════════════════════════════════

function _esc(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _vixColor(bucket) {
  return bucket === "calm" ? "#34d399"
    : bucket === "normal" ? "#86efac"
      : bucket === "elevated" ? "#fbbf24"
        : bucket === "high" ? "#fb923c"
          : bucket === "panic" ? "#ef4444" : "#9ca3af";
}

function _ggColor(gg) {
  return (gg === "OPEN_UP" || gg === "COMPLETE_UP") ? "#34d399" : (gg === "OPEN_DOWN" || gg === "COMPLETE_DN") ? "#fb7185" : "#9ca3af";
}

function _pctColor(p) {
  if (p == null) return "#9ca3af";
  return p > 0 ? "#34d399" : p < 0 ? "#ef4444" : "#9ca3af";
}

function _ggLabel(gg) {
  // Plain-language bias (matches the web brief), not Saty "GG" jargon.
  return (gg === "OPEN_UP" || gg === "COMPLETE_UP") ? "▲ Bullish" : (gg === "OPEN_DOWN" || gg === "COMPLETE_DN") ? "▼ Bearish" : "◆ Neutral";
}

/** Plain-language "what it means for equities" tag for a cross-asset row. */
function _macroRead(m) {
  const s = String(m?.sym || m?.label || "").toUpperCase();
  const v = Number(m?.chgPct);
  const up = Number.isFinite(v) && v > 0.15;
  const dn = Number.isFinite(v) && v < -0.15;
  if (s.includes("VIX") || s.includes("VX")) {
    const lvl = Number(m?.value);
    if (Number.isFinite(lvl) && lvl >= 20) return "fear elevated";
    if (Number.isFinite(lvl) && lvl < 14) return "calm tape";
    return up ? "hedging up" : dn ? "calmer" : "steady";
  }
  if (s.includes("BTC") || s.includes("ETH")) return up ? "risk appetite on" : dn ? "risk-off" : "flat";
  if (s.includes("CL") || s.includes("CRUDE") || s.includes("OIL") || s.includes("USO")) return up ? "energy bid · cost push" : dn ? "consumer relief" : "flat";
  if (s.includes("GC") || s.includes("GOLD") || s.includes("GLD") || s.includes("SI") || s.includes("SILVER")) return up ? "risk-off hedge bid" : dn ? "risk-on" : "flat";
  if (s.includes("TLT") || s.includes("BOND") || s.includes("ZB") || s.includes("ZN") || s.includes("TREASUR")) return up ? "yields down · duration bid" : dn ? "yields up · growth headwind" : "flat";
  if (s.includes("DXY") || s.includes("DOLLAR") || s.includes("UUP")) return up ? "headwind for risk" : dn ? "tailwind for risk" : "flat";
  return up ? "bid" : dn ? "soft" : "flat";
}

/**
 * Builds the email-safe infographic HTML. Returns empty string if data is
 * insufficient (caller can safely interpolate either way).
 */
export function buildEmailInfographic(infographic) {
  if (!infographic || typeof infographic !== "object") return "";
  const hl = infographic.headline || {};
  const indices = Array.isArray(infographic.indices) ? infographic.indices : [];
  const macro = Array.isArray(infographic.macro) ? infographic.macro : [];
  const events = Array.isArray(infographic.events) ? infographic.events : [];
  const risks = Array.isArray(infographic.risks) ? infographic.risks : [];
  const opps = Array.isArray(infographic.opportunities) ? infographic.opportunities : [];
  const topThree = Array.isArray(infographic.topThree) ? infographic.topThree : null;
  const closingLine = infographic.closingLine || null;
  const topHeadlines = Array.isArray(infographic.topHeadlines) ? infographic.topHeadlines : [];

  // ── Today's Three (Galloway-style TOC) ──
  let topThreeHtml = "";
  if (topThree && topThree.length === 3) {
    const items = topThree.map(t => `
      <tr>
        <td valign="top" style="padding:6px 0 0;width:24px;color:#fcd34d;font-weight:700;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums">${_esc(t.n)}.</td>
        <td style="padding:6px 0 0;font-size:13px;line-height:1.5;color:${BRAND.textPrimary}">
          ${t.label ? `<span style="color:${BRAND.textSecondary};font-weight:500">${_esc(t.label)}:</span> ` : ""}${_esc(t.body)}
        </td>
      </tr>`).join("");
    topThreeHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.22);border-radius:8px">
        <tr><td style="padding:12px 14px">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#fcd34d;margin:0 0 6px">Today's Three</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
        </td></tr>
      </table>`;
  }

  // ── Headline badges (Regime / VIX / Breadth / Open) ──
  const badges = [];
  if (hl.regime) {
    badges.push({ label: "Regime", value: String(hl.regime).replace(/_/g, " "), color: "#67e8f9" });
  }
  if (hl.vix) {
    const bucket = hl.vix.bucket;
    badges.push({
      label: "VIX",
      value: `${Number(hl.vix.level || 0).toFixed(2)} · ${bucket || "?"}`,
      color: _vixColor(bucket),
    });
  }
  if (hl.breadth) {
    const g = Number(hl.breadth.green || 0);
    const t = Number(hl.breadth.total || 0);
    const color = t === 0 ? "#9ca3af" : g >= t * 0.6 ? "#34d399" : g <= t * 0.4 ? "#ef4444" : "#fbbf24";
    badges.push({ label: "Breadth", value: `${g}/${t}`, color });
  }
  if (hl.openTrades != null) {
    badges.push({ label: "Open", value: String(hl.openTrades), color: "#a78bfa" });
  }
  const headlineHtml = badges.length
    ? `<table role="presentation" cellpadding="0" cellspacing="4" style="margin:0 0 14px">
         <tr>
           ${badges.map(b => `
             <td style="padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;min-width:72px">
               <div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(b.label)}</div>
               <div style="font-size:13px;font-weight:600;color:${b.color};font-variant-numeric:tabular-nums;margin-top:2px">${_esc(b.value)}</div>
             </td>`).join("")}
         </tr>
       </table>`
    : "";

  // ── Index Playbook rows (parity with the web brief: bias + expected move +
  //    the call-side and put-side plays + a one-line weekly read) ──
  let indicesHtml = "";
  if (indices.length > 0) {
    const _n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const rows = indices.map(idx => {
      const lvls = idx.levels || {};
      const gg = lvls.goldenGate || "NEUTRAL";
      const price = _n(idx.price ?? lvls.currentPrice);
      const chgPct = idx.chgPct;
      const atr = _n(idx.atr);
      const gp = lvls.gamePlan || null;
      const dayProb = lvls.goldenGateProbability;
      const ggPct = (dayProb && gg !== "NEUTRAL" && _n(dayProb.day) != null) ? ` · ${Math.round(_n(dayProb.day) * 100)}%` : "";
      // Calls / Puts plays
      let playsHtml = "";
      const bt = _n(gp?.bullTrigger), btg = _n(gp?.bullTarget);
      const rt = _n(gp?.bearTrigger), rtg = _n(gp?.bearTarget);
      if (bt != null && btg != null) {
        const pct = (btg - bt) / bt * 100;
        const arm = price != null ? (price >= bt ? "in play" : `+${((bt - price) / price * 100).toFixed(2)}% to arm`) : "";
        playsHtml += `<tr><td style="padding:2px 0;font-size:11.5px;color:#34d399;font-variant-numeric:tabular-nums">▲ Calls ${price != null && price >= bt ? "armed" : `over $${bt.toFixed(2)}`} → $${btg.toFixed(2)} <span style="color:rgba(52,211,153,0.7)">(+${pct.toFixed(1)}%)</span> <span style="color:${BRAND.textMuted}">${arm}</span></td></tr>`;
      }
      if (rt != null && rtg != null) {
        const pct = (rtg - rt) / rt * 100;
        const arm = price != null ? (price <= rt ? "in play" : `${((rt - price) / price * 100).toFixed(2)}% to arm`) : "";
        playsHtml += `<tr><td style="padding:2px 0;font-size:11.5px;color:#fb7185;font-variant-numeric:tabular-nums">▼ Puts ${price != null && price <= rt ? "armed" : `under $${rt.toFixed(2)}`} → $${rtg.toFixed(2)} <span style="color:rgba(251,113,133,0.7)">(${pct.toFixed(1)}%)</span> <span style="color:${BRAND.textMuted}">${arm}</span></td></tr>`;
      }
      // Weekly one-liner
      let weekLine = "";
      const wl = idx.weeklyLevels || null;
      if (wl) {
        const wgg = wl.goldenGate || "NEUTRAL";
        const wUp = _n(wl.levels?.["+61.8%"]), wDn = _n(wl.levels?.["-61.8%"]);
        const wlo = _n(wl.levels?.["-38.2%"]), whi = _n(wl.levels?.["+38.2%"]);
        if ((wgg === "OPEN_UP" || wgg === "COMPLETE_UP") && wUp != null) weekLine = `▲ Bullish · toward $${wUp.toFixed(2)} by Fri`;
        else if ((wgg === "OPEN_DOWN" || wgg === "COMPLETE_DN") && wDn != null) weekLine = `▼ Bearish · toward $${wDn.toFixed(2)} by Fri`;
        else if (wlo != null && whi != null) weekLine = `◆ Range $${wlo.toFixed(2)}–$${whi.toFixed(2)}`;
      }
      const weekHtml = weekLine
        ? `<tr><td style="padding:5px 0 0;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:${BRAND.textSecondary}"><span style="color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em;font-size:9px;margin-right:5px">This week</span>${_esc(weekLine)}</td></tr>`
        : "";
      return `<tr>
        <td style="padding:10px 12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);border-radius:6px" valign="top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;font-weight:700;color:white">${_esc(idx.sym)} <span style="font-size:11px;font-weight:600;color:${_ggColor(gg)}">${_ggLabel(gg)}${ggPct}</span></td>
              <td align="right" style="font-size:15px;font-weight:700;color:white;font-variant-numeric:tabular-nums">${price != null ? `$${price.toFixed(2)}` : "—"}${chgPct != null ? ` <span style="font-size:11px;font-weight:600;color:${_pctColor(chgPct)}">${chgPct >= 0 ? "+" : ""}${Number(chgPct).toFixed(2)}%</span>` : ""}</td>
            </tr>
            ${atr != null ? `<tr><td colspan="2" align="right" style="font-size:9px;color:${BRAND.textMuted};font-variant-numeric:tabular-nums">expected move today ±$${atr.toFixed(2)}</td></tr>` : ""}
            ${playsHtml ? `<tr><td colspan="2" style="padding-top:5px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${playsHtml}</table></td></tr>` : ""}
            ${weekHtml ? `<tr><td colspan="2" style="padding-top:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${weekHtml}</table></td></tr>` : ""}
          </table>
        </td>
      </tr>
      <tr><td style="height:6px;line-height:6px">&nbsp;</td></tr>`;
    }).join("");
    indicesHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
        <tr><td style="padding:0 0 4px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">Index playbook · today's plays</td></tr>
        ${rows}
      </table>`;
  }

  // ── Macro strip (with a plain-language "what it means for equities" tag) ──
  let macroHtml = "";
  if (macro.length > 0) {
    const cells = macro.slice(0, 5).map(m => {
      const color = m.bucket ? _vixColor(m.bucket) : _pctColor(m.chgPct);
      const read = _macroRead(m);
      return `<td style="padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:6px;min-width:80px" valign="top">
        <div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(m.label || m.sym)}</div>
        <div style="font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;margin-top:2px">${_esc(Number(m.value).toFixed(2))}${m.chgPct != null ? ` · ${m.chgPct >= 0 ? "+" : ""}${Number(m.chgPct).toFixed(1)}%` : ""}</div>
        ${read ? `<div style="font-size:8.5px;color:${BRAND.textMuted};margin-top:2px;line-height:1.3">${_esc(read)}</div>` : ""}
      </td>`;
    }).join("");
    macroHtml = `<table role="presentation" cellpadding="0" cellspacing="4" style="margin:0 0 14px"><tr>${cells}</tr></table>`;
  }

  // ── Sector tape read (breadth + leader/laggard + risk-on vs defensive tilt) ──
  let sectorsHtml = "";
  {
    const secs = (Array.isArray(infographic.sectors) ? infographic.sectors : []).filter(s => Number.isFinite(Number(s.chgPct)));
    if (secs.length > 0) {
      const greens = secs.filter(s => Number(s.chgPct) > 0).length;
      const total = secs.length;
      const sorted = [...secs].sort((a, b) => Number(b.chgPct) - Number(a.chgPct));
      const leader = sorted[0], laggard = sorted[sorted.length - 1];
      const avgOf = (syms) => { const xs = secs.filter(s => syms.includes(s.sym)); return xs.length ? xs.reduce((a, s) => a + Number(s.chgPct), 0) / xs.length : null; };
      const roAvg = avgOf(["XLK", "XLY", "XLC", "XLI"]);
      const defAvg = avgOf(["XLP", "XLU", "XLV", "XLRE"]);
      const breadth = total ? greens / total : 0;
      let tone = "Mixed tape", toneColor = "#9ca3af";
      if (breadth >= 0.6 && (roAvg ?? 0) >= (defAvg ?? 0)) { tone = "Risk-on tape"; toneColor = "#34d399"; }
      else if (breadth <= 0.4) { tone = "Risk-off tape"; toneColor = "#fb7185"; }
      else if ((defAvg ?? 0) > (roAvg ?? 0)) { tone = "Defensive tilt"; toneColor = "#fbbf24"; }
      const fp = (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`;
      const read = `${greens}/${total} sectors green`
        + (leader ? ` · ${_esc(leader.sym)} leads (${fp(leader.chgPct)})` : "")
        + (laggard && laggard !== leader ? `, ${_esc(laggard.sym)} lags (${fp(laggard.chgPct)})` : "");
      sectorsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
        <tr><td style="padding:0 0 3px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">Sectors today</td></tr>
        <tr><td style="font-size:12px;line-height:1.45"><span style="font-weight:700;color:${toneColor}">${tone}</span> <span style="color:${BRAND.textSecondary}">— ${read}</span></td></tr>
      </table>`;
    }
  }

  // ── Events (today's macro + earnings) ──
  let eventsHtml = "";
  if (events.length > 0) {
    const rows = events.slice(0, 6).map(e => {
      const severityColor = e.severity === "high" ? "#ef4444" : e.severity === "medium" ? "#fbbf24" : "#9ca3af";
      return `<tr>
        <td style="padding:4px 0;vertical-align:top">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${severityColor};margin-right:6px;vertical-align:middle"></span>
          <span style="font-size:12px;color:${BRAND.textPrimary}">${_esc(e.title)}</span>
          ${e.when ? `<span style="font-size:11px;color:${BRAND.textMuted};margin-left:6px">· ${_esc(e.when)}</span>` : ""}
        </td>
      </tr>`;
    }).join("");
    eventsHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
        <tr><td style="padding-bottom:4px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">Today's events</td></tr>
        ${rows}
      </table>`;
  }

  // ── Risks / Opportunities (compact pill list) ──
  const listBlock = (items, label, color) => {
    if (!items || items.length === 0) return "";
    const lis = items.slice(0, 4).map(r => `
      <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.4">
        <span style="color:${color};margin-right:6px">${label === "Risks" ? "⚠" : "↑"}</span>${_esc(r)}
      </td></tr>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">
      <tr><td style="padding:4px 0 2px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${color}">${_esc(label)}</td></tr>
      ${lis}
    </table>`;
  };
  const risksOppsHtml = listBlock(risks, "Risks", "#f59e0b") + listBlock(opps, "Opportunities", "#34d399");

  // ── Top broad-market headlines (Reuters / Bloomberg / WSJ etc.) ──
  // 2026-05-22 — Editorial context block. Cap at 4, each ~140 chars,
  // source attribution, links open in new tab. Hides when empty.
  let headlinesHtml = "";
  if (topHeadlines.length > 0) {
    const rows = topHeadlines.slice(0, 4).map(h => {
      const title = _esc(h.title || "");
      const source = _esc(h.source || "");
      const url = h.url || "";
      return `<tr><td style="padding:6px 0;font-size:12px;line-height:1.45;color:${BRAND.textPrimary}">
        ${url ? `<a href="${_esc(url)}" style="color:${BRAND.textPrimary};text-decoration:none">${title}</a>` : title}
        ${source ? `<span style="color:${BRAND.textMuted};font-size:10.5px;margin-left:4px">· ${source}</span>` : ""}
      </td></tr>`;
    }).join("");
    headlinesHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;background:rgba(255,255,255,0.015);border:1px solid ${BRAND.border};border-radius:8px">
      <tr><td style="padding:10px 14px 8px">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted};margin:0 0 4px">Top headlines</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr>
    </table>`;
  }

  // ── Closing line (if present) ──
  const closingHtml = closingLine
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0">
        <tr><td style="padding:12px 14px;background:rgba(139,92,246,0.06);border-left:3px solid rgba(139,92,246,0.5);border-radius:6px">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a78bfa;margin:0 0 4px">The bottom line</div>
          <p style="margin:0;font-size:13px;color:${BRAND.textPrimary};line-height:1.55">${_esc(closingLine)}</p>
        </td></tr>
      </table>`
    : "";

  const body = topThreeHtml + headlineHtml + indicesHtml + sectorsHtml + macroHtml + eventsHtml + headlinesHtml + risksOppsHtml + closingHtml;
  if (!body.trim()) return "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:rgba(255,255,255,0.015);border:1px solid ${BRAND.border};border-radius:10px">
    <tr><td style="padding:16px">
      ${body}
    </td></tr>
  </table>`;
}


// ═══════════════════════════════════════════════════════════════════════
// HMAC Unsubscribe Tokens
// ═══════════════════════════════════════════════════════════════════════

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacVerify(secret, data, token) {
  const expected = await hmacSign(secret, data);
  return expected === token;
}

export function buildUnsubscribeUrl(baseUrl, email, pref, secret) {
  if (!secret) return null;
  const data = `${email}:${pref}`;
  // Return a promise — caller must await
  return hmacSign(secret, data).then(token =>
    `${baseUrl}/timed/email/unsubscribe?email=${encodeURIComponent(email)}&pref=${encodeURIComponent(pref)}&token=${token}`
  );
}

export { hmacVerify };

// ═══════════════════════════════════════════════════════════════════════
// Core Send Function
// ═══════════════════════════════════════════════════════════════════════

/** Relay a single outbound message through the monolith when this worker lacks SendGrid. */
async function relayEmailViaMonolith(env, { to, subject, html, text, category }) {
  const base = String(env?.WORKER_URL || "https://timed-trading.com").replace(/\/$/, "");
  const relayKey = env?.TIMED_API_KEY || env?.API_KEY || env?.ADMIN_KEY;
  if (!relayKey) {
    console.warn("[EMAIL] relay skipped — no TIMED_API_KEY/API_KEY for monolith auth");
    return { ok: false, error: "no_relay_key" };
  }
  try {
    const resp = await fetch(`${base}/timed/internal/relay-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": relayKey,
      },
      body: JSON.stringify({ to, subject, html, text, category }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body?.ok) {
      console.log(`[EMAIL] relayed to ${to}: "${subject}"`);
      return { ok: true, relayed: true };
    }
    console.warn(`[EMAIL] relay failed ${resp.status}: ${String(body?.error || resp.statusText).slice(0, 200)}`);
    return { ok: false, error: body?.error || `relay_${resp.status}`, relayed: true };
  } catch (e) {
    console.warn("[EMAIL] relay exception:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: String(e?.message || e).slice(0, 200), relayed: true };
  }
}

export async function sendEmail(env, { to, subject, html, text, category }) {
  if (env?.EMAIL_ENABLED !== "true" && env?.EMAIL_ENABLED !== true) {
    console.log("[EMAIL] EMAIL_ENABLED is not true — skipping send");
    return { ok: false, error: "disabled" };
  }
  const apiKey = env?.SENDGRID_API_KEY;
  if (!apiKey) {
    // tt-engine / tt-research often carry DISCORD_* but not SENDGRID_*.
    // Relay through the monolith API worker which owns the SendGrid secret.
    if (String(env?.EMAIL_RELAY_ENABLED ?? "true").toLowerCase() !== "false") {
      return relayEmailViaMonolith(env, { to, subject, html, text, category });
    }
    console.warn("[EMAIL] No SENDGRID_API_KEY configured — skipping send");
    return { ok: false, error: "no_api_key" };
  }
  const fromEmail = env?.EMAIL_FROM || FROM_EMAIL;
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail, name: FROM_NAME },
    reply_to: { email: REPLY_TO_EMAIL, name: REPLY_TO_NAME },
    subject,
    content: [],
  };
  if (text) payload.content.push({ type: "text/plain", value: text });
  if (html) payload.content.push({ type: "text/html", value: html });
  if (!payload.content.length) {
    return { ok: false, error: "no_content" };
  }
  if (category) {
    payload.categories = Array.isArray(category) ? category : [category];
  }
  try {
    const resp = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 202 || resp.status === 200) {
      console.log(`[EMAIL] Sent to ${to}: "${subject}"`);
      return { ok: true };
    }
    const errText = await resp.text().catch(() => "");
    console.warn(`[EMAIL] SendGrid error ${resp.status}: ${errText.slice(0, 300)}`);
    return { ok: false, error: `sendgrid_${resp.status}`, details: errText.slice(0, 300) };
  } catch (e) {
    console.error("[EMAIL] Send failed:", String(e).slice(0, 200));
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Email Layout Wrapper
// ═══════════════════════════════════════════════════════════════════════

function emailLayout(bodyHtml, { unsubscribeUrl, preheader } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Timed Trading</title>
${preheader ? `<span style="display:none;font-size:1px;color:${BRAND.dark};max-height:0;overflow:hidden">${preheader}</span>` : ""}
</head>
<body style="margin:0;padding:0;background:${BRAND.dark};font-family:'Helvetica Neue',Arial,sans-serif;color:${BRAND.textPrimary};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.dark}">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <!-- Header -->
  <!-- 2026-05-28 — Swapped the CSS-painted green "TT" square for the
       real TT watch-face brand mark (logo-discord.png, 256x256, 50 KB).
       Now matches the favicon, Discord webhook avatar, and PWA icon. -->
  <tr><td style="padding:20px 24px;text-align:center">
    <img src="https://timed-trading.com/logo-discord.png" alt="TT" width="32" height="32" style="display:inline-block;width:32px;height:32px;border-radius:8px;vertical-align:middle;border:0">
    <span style="margin-left:8px;font-size:16px;font-weight:700;color:white;vertical-align:middle;letter-spacing:-0.03em">Timed Trading</span>
  </td></tr>
  <!-- Body -->
  <tr><td style="background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:12px;padding:32px 28px">
    ${bodyHtml}
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:24px;text-align:center">
    <p style="margin:0 0 8px;font-size:12px;color:${BRAND.textMuted}">
      Timed Trading &bull; <a href="https://timed-trading.com" style="color:${BRAND.textMuted};text-decoration:underline">timed-trading.com</a>
    </p>
    ${unsubscribeUrl ? `<p style="margin:0;font-size:11px;color:${BRAND.textMuted}"><a href="${unsubscribeUrl}" style="color:${BRAND.textMuted};text-decoration:underline">Unsubscribe</a> from these emails</p>` : ""}
    <p style="margin:8px 0 0;font-size:10px;color:${BRAND.textMuted}">This is not financial advice. For educational purposes only.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// Welcome Email
// ═══════════════════════════════════════════════════════════════════════

export async function sendWelcomeEmail(env, user) {
  const name = user.display_name || user.email.split("@")[0];
  const featureRow = (icon, color, title, desc) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px">
      <tr>
        <td width="36" style="vertical-align:top;padding-top:2px">
          <div style="width:28px;height:28px;border-radius:6px;background:${color}12;text-align:center;line-height:28px;font-size:14px">${icon}</div>
        </td>
        <td style="padding-left:10px;vertical-align:top">
          <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:white">${title}</p>
          <p style="margin:0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">${desc}</p>
        </td>
      </tr>
    </table>`;

  const stepRow = (num, title, desc) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
      <tr>
        <td width="28" style="vertical-align:top;padding-top:2px">
          <div style="width:24px;height:24px;border-radius:50%;background:${BRAND.green}20;text-align:center;line-height:24px;font-size:11px;font-weight:700;color:${BRAND.green}">${num}</div>
        </td>
        <td style="padding-left:10px;vertical-align:top">
          <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:white">${title}</p>
          <p style="margin:0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">${desc}</p>
        </td>
      </tr>
    </table>`;

  const html = emailLayout(`
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:white">Welcome${name ? `, ${name}` : ""}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      You're in. The system is already watching 229 tickers across 8 timeframes, scoring momentum shifts and surfacing setups in real time.
    </p>

    <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">How the model works</p>
    <p style="margin:0 0 18px;font-size:12px;color:${BRAND.textSecondary};line-height:1.6">
      Every 5 minutes, the system scores 229 tickers across 8 timeframes &mdash; from 5-minute bars to weekly candles. Higher timeframes set the direction, lower timeframes find the entry. When all timeframes align, the model surfaces the trade. Before any position is opened, an <strong style="color:white">AI Chief Investment Officer</strong> reviews the setup against a 7-layer memory system: ticker history, regime context, entry path performance, ticker personality, macro proximity, and recent trade outcomes. Setups that don't pass get rejected with a reason.
    </p>

    <div style="height:1px;background:${BRAND.border};margin:20px 0"></div>

    <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">What you get</p>
    ${featureRow("&#x1F30A;", "#00c853", "Bubble Map", "See the entire universe at a glance. Momentum vs trend strength. Click any bubble to drill into the detail.")}
    ${featureRow("&#x26A1;", "#3b82f6", "Trade Pipeline", "Tickers flow through lanes &mdash; Setup, Enter, Hold, Trim, Exit. Every trade has a grade, a plan, and a clear exit signal.")}
    ${featureRow("&#x1F4CB;", "#a78bfa", "Right Rail Detail", "Select any ticker to see levels, regime, entry quality, rank, and the AI CIO's most recent review.")}
    ${featureRow("&#x1F916;", "#f59e0b", "AI CIO Gate", "Every trade candidate is reviewed by the AI before execution. It remembers past outcomes and adapts with each market cycle.")}
    ${featureRow("&#x1F4AC;", "#14b8a6", "Ask AI", "A personalized assistant with full context of your portfolio and market conditions. Ask about any ticker, setup, or regime.")}
    ${featureRow("&#x1F4C8;", "#ef4444", "Investor Dashboard", "Portfolio health, sector heatmap, accumulation zones, and rebalance signals for long-term positions.")}
    ${featureRow("&#x1F4DD;", "#5865F2", "Daily Briefs &amp; Alerts", "Pre-market and post-market briefs, plus real-time notifications when the system enters, exits, or trims.")}

    <div style="height:1px;background:${BRAND.border};margin:20px 0"></div>

    <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">Quick start guide</p>
    ${stepRow("1", "Explore the Bubble Map", "Open your dashboard and scan the map. Larger, brighter bubbles have stronger momentum and trend alignment.")}
    ${stepRow("2", "Check the Trade Pipeline", "Switch to the Kanban view to see which tickers are in Setup, Enter, or Hold lanes. These are the model's active ideas.")}
    ${stepRow("3", "Set Your Saved Tickers", 'Click the star icon on any ticker to save it. Saved tickers appear first in the pipeline and you\'ll get priority alerts when they move.')}
    ${stepRow("4", "Ask the AI", "Use the Ask AI chat to get instant analysis on any ticker, regime, or trade idea. It has full context of the model's current state.")}

    <div style="height:1px;background:${BRAND.border};margin:20px 0"></div>

    <div style="background:${BRAND.green}12;border:1px solid ${BRAND.green}30;border-radius:8px;padding:14px 16px;margin:0 0 20px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${BRAND.green}">Set up your Saved Tickers</p>
      <p style="margin:0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
        Personalize your experience by saving the tickers you care about most. The pipeline, alerts, and daily briefs will prioritize them for you.
      </p>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/today.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Open Your Dashboard</a>
      </td></tr>
    </table>

    <div style="height:1px;background:${BRAND.border};margin:24px 0"></div>

    <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">Community Guidelines</p>
    <p style="margin:0 0 20px;font-size:12px;color:${BRAND.textSecondary};line-height:1.6">
      Our community is built on mutual respect. Be professional, be constructive, and treat every member the way you'd want to be treated. No spam, no personal attacks, no unsolicited promotions.
    </p>

    <p style="margin:0;font-size:12px;color:${BRAND.textMuted}">
      Questions? Reply to this email or reach us at <a href="mailto:support@timed-trading.com" style="color:${BRAND.textSecondary}">support@timed-trading.com</a>.
    </p>
  `, { preheader: "Your AI-powered trading intelligence platform is ready. Here is how to get started." });

  const text = `Welcome to Timed Trading, ${name}!\n\nYou're in. The system is already watching 229 tickers across 8 timeframes.\n\nHow the model works:\nEvery 5 minutes, the system scores 229 tickers across 8 timeframes. Higher timeframes set the direction, lower timeframes find the entry. Before any position is opened, an AI Chief Investment Officer reviews the setup against a 7-layer memory system.\n\nWhat you get:\n- Bubble Map: See the entire universe at a glance\n- Trade Pipeline: Tickers flow through Setup, Enter, Hold, Trim, Exit\n- Right Rail Detail: Levels, regime, entry quality, AI CIO review\n- AI CIO Gate: Every trade reviewed before execution\n- Ask AI: Personalized assistant with full portfolio context\n- Investor Dashboard: Portfolio health and rebalance signals\n- Daily Briefs & Alerts: Pre/post-market briefs and real-time notifications\n\nQuick start:\n1. Explore the Bubble Map\n2. Check the Trade Pipeline\n3. Set your Saved Tickers (star icon on any ticker)\n4. Ask the AI for instant analysis\n\nVisit https://timed-trading.com to get started.\n\nQuestions? Reply or email support@timed-trading.com.`;

  return sendEmail(env, {
    to: user.email,
    subject: "Welcome to Timed Trading",
    html,
    text,
    category: "welcome",
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Subscription Confirmed Email
// ═══════════════════════════════════════════════════════════════════════

export async function sendSubscriptionEmail(env, email, isTrial) {
  const featureItem = (icon, title) => `
    <tr>
      <td style="padding:4px 0">
        <span style="font-size:13px">${icon}</span>
        <span style="margin-left:6px;font-size:13px;color:${BRAND.textSecondary}">${title}</span>
      </td>
    </tr>`;

  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:white">${isTrial ? "Your Free Trial Has Started" : "Subscription Confirmed"}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      ${isTrial
        ? "You now have 14 days of full Pro access &mdash; no charge until the trial ends."
        : "Your Timed Trading Pro subscription is active. Thank you for subscribing."}
    </p>

    <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">Full access includes</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      ${featureItem("&#x1F4CA;", "Analysis Dashboard &mdash; multi-timeframe scoring &amp; sector rotation")}
      ${featureItem("&#x26A1;", "Active Trader Board &mdash; tickers sorted by trade lane")}
      ${featureItem("&#x1F4C8;", "Investor Dashboard &mdash; portfolio health &amp; market regime")}
      ${featureItem("&#x1F4DD;", "Daily Brief &mdash; pre-market &amp; post-market reports")}
      ${featureItem("&#x1F4BC;", "Trades &amp; Portfolio &mdash; live positions &amp; P&amp;L tracking")}
      ${featureItem("&#x1F514;", "Trade Alerts &mdash; real-time entry, exit &amp; trim notifications")}
      ${featureItem("&#x1F4AC;", "Discord Community &mdash; private server access")}
    </table>

    <p style="margin:0 0 24px;font-size:13px;color:${BRAND.textSecondary};line-height:1.6">
      Manage your subscription anytime from your account settings.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/today.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Go to Dashboard</a>
      </td></tr>
    </table>
  `, { preheader: isTrial ? "Your 14-day free trial is active." : "Your Pro subscription is confirmed." });

  const text = isTrial
    ? "Your 14-day free trial of Timed Trading Pro has started.\n\nFull access includes: Analysis Dashboard, Active Trader Board, Investor Dashboard, Daily Brief, Trades & Portfolio, Trade Alerts, and Discord Community.\n\nVisit https://timed-trading.com to get started."
    : "Your Timed Trading Pro subscription is active.\n\nFull access includes: Analysis Dashboard, Active Trader Board, Investor Dashboard, Daily Brief, Trades & Portfolio, Trade Alerts, and Discord Community.\n\nVisit https://timed-trading.com to continue.";

  return sendEmail(env, { to: email, subject: isTrial ? "Your Free Trial Has Started" : "Subscription Confirmed", html, text, category: "subscription" });
}

// ═══════════════════════════════════════════════════════════════════════
// VIP Welcome Email (admin-granted complimentary access)
// 2026-06-05 — Sent when an admin flips a user to the VIP tier. VIP is a
// comped grant (no billing), so the copy emphasizes complimentary full
// access rather than a purchase confirmation. Gold accent matches the VIP
// badge in admin-clients. House style: avoid "you/your" in user-facing copy.
// ═══════════════════════════════════════════════════════════════════════

export async function sendVipWelcomeEmail(env, email) {
  const GOLD = "#fbbf24";
  const featureItem = (icon, title) => `
    <tr>
      <td style="padding:4px 0">
        <span style="font-size:13px">${icon}</span>
        <span style="margin-left:6px;font-size:13px;color:${BRAND.textSecondary}">${title}</span>
      </td>
    </tr>`;

  const html = emailLayout(`
    <div style="display:inline-block;padding:3px 10px;margin:0 0 14px;border:1px solid rgba(251,191,36,0.30);background:rgba(251,191,36,0.10);border-radius:999px">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:${GOLD}">&#x2728; VIP Access</span>
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:white">Welcome to VIP</h1>
    <p style="margin:0 0 20px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      This account has been upgraded to <strong style="color:${GOLD}">VIP</strong> &mdash; complimentary, full access to everything Timed Trading offers, with no billing and nothing to manage.
    </p>

    <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">VIP access includes</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      ${featureItem("&#x1F4CA;", "Analysis Dashboard &mdash; multi-timeframe scoring &amp; sector rotation")}
      ${featureItem("&#x26A1;", "Active Trader Board &mdash; tickers sorted by trade lane")}
      ${featureItem("&#x1F4C8;", "Investor Dashboard &mdash; portfolio health &amp; market regime")}
      ${featureItem("&#x1F4DD;", "Daily Brief &mdash; pre-market &amp; post-market reports")}
      ${featureItem("&#x1F4BC;", "Trades &amp; Portfolio &mdash; live positions &amp; P&amp;L tracking")}
      ${featureItem("&#x1F514;", "Trade Alerts &mdash; real-time entry, exit &amp; trim notifications")}
      ${featureItem("&#x1F4AC;", "Discord Community &mdash; private server access")}
    </table>

    <p style="margin:0 0 24px;font-size:13px;color:${BRAND.textSecondary};line-height:1.6">
      If a paid subscription was active, it has been canceled so there will be no further charges &mdash; VIP access stays on regardless.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/today.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Go to Dashboard</a>
      </td></tr>
    </table>
  `, { preheader: "This account has been upgraded to complimentary VIP access." });

  const text = "Welcome to VIP.\n\nThis account has been upgraded to VIP — complimentary, full access to everything Timed Trading offers, with no billing and nothing to manage.\n\nVIP access includes: Analysis Dashboard, Active Trader Board, Investor Dashboard, Daily Brief, Trades & Portfolio, Trade Alerts, and Discord Community.\n\nIf a paid subscription was active, it has been canceled so there will be no further charges — VIP access stays on regardless.\n\nGo to the dashboard: https://timed-trading.com/today.html";

  return sendEmail(env, { to: email, subject: "Welcome to VIP — Complimentary Access", html, text, category: "subscription" });
}

// ═══════════════════════════════════════════════════════════════════════
// Farewell Email (subscription ended)
// ═══════════════════════════════════════════════════════════════════════

export async function sendFarewellEmail(env, email) {
  const html = emailLayout(`
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:white">We're Sorry to See You Go</h1>
    <p style="margin:0 0 16px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      Your Timed Trading Pro subscription has ended. We appreciate the time you spent with us.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      Your account is still active on the free tier, so you can browse the dashboard anytime.
      If you'd like to resubscribe, you can do so in one click from the app.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      If there's anything we could have done better, we'd love to hear from you — just reply to this email.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/splash.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Resubscribe</a>
      </td></tr>
    </table>
  `, { preheader: "Your Pro access has ended. We'd love to have you back." });

  const text = "Your Timed Trading Pro subscription has ended. Your free-tier account is still active. Resubscribe anytime at https://timed-trading.com/splash.html";
  return sendEmail(env, { to: email, subject: "Your Timed Trading Pro Subscription Has Ended", html, text, category: "subscription" });
}

// ═══════════════════════════════════════════════════════════════════════
// Discord Welcome Email
// ═══════════════════════════════════════════════════════════════════════

/* 2026-06-01 — Discord welcome email rewritten per operator request.

   Operator: "Open up Discord Access, so the UI should now say 'link
   Discord' and that should kick off the user add flow with the welcome
   email to discord. We should update the email to include
   straightforward rules around the community. People need to acknowledge
   that they will be good citizens, be respectful, not promote or spam,
   maintain integrity, not spew or hate or debate everything. Include a
   simple breakdown of the three channels that they can start with:
   general for just chit chat, respectful chit chat, trade signals for
   keeping up with what the model is firing off, and support for things
   that the user needs help with. Trade ideas is a place for people to
   share their ideas."

   Channels covered (all four — operator named three to start + trade
   ideas explicitly later):
     #general       — respectful chit chat
     #trade-signals — keeping up with what the model is firing
     #trade-ideas   — share your own setups
     #support       — questions, problems

   Community guidelines are EXPLICIT (not soft suggestions). The email
   asks users to acknowledge they'll be a good citizen — this is the
   contract. We can't enforce it programmatically but stating it up
   front sets the culture from day one. */
export async function sendDiscordWelcomeEmail(env, email, discordUsername) {
  const guildId = env.DISCORD_GUILD_ID || "";
  const openDiscordUrl = guildId ? `https://discord.com/channels/${guildId}` : "https://discord.com";
  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:white">Welcome to the TT Discord</h1>
    <p style="margin:0 0 20px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      Your Discord account <strong style="color:white">${discordUsername}</strong> has been linked and you've been added to the Timed Trading community server.
    </p>

    <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">Where to start &mdash; four channels</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};line-height:1.55">
        <strong style="color:white">#general</strong> &mdash; respectful chit chat. Say hi, share what you're watching, talk markets.
      </td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};line-height:1.55">
        <strong style="color:white">#trade-signals</strong> &mdash; keep up with what the model is firing off. Real-time entry / trim / exit alerts from the scoring engine. Read-only.
      </td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};line-height:1.55">
        <strong style="color:white">#trade-ideas</strong> &mdash; share your own setups. Post charts, talk thesis, debate entries. Constructive only.
      </td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};line-height:1.55">
        <strong style="color:white">#support</strong> &mdash; questions, problems, anything you need help with. Maintainers and other members will jump in.
      </td></tr>
    </table>

    <div style="padding:16px 18px;background:rgba(88,101,242,0.08);border:1px solid rgba(88,101,242,0.28);border-radius:10px;margin:0 0 22px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:white">Be a good citizen &mdash; the community contract</p>
      <p style="margin:0 0 10px;font-size:12px;color:${BRAND.textSecondary};line-height:1.65">
        We're keeping this server small, signal-dense, and worth opening every day. That only works if everyone shows up the right way. By joining, you agree to:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px">
        <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
          <span style="color:${BRAND.green};font-weight:700;margin-right:6px">&#10003;</span>
          <strong style="color:white">Be respectful.</strong> Treat every member the way you'd want to be treated. Disagreement is fine; personal attacks are not.
        </td></tr>
        <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
          <span style="color:${BRAND.green};font-weight:700;margin-right:6px">&#10003;</span>
          <strong style="color:white">No spam, no promotion.</strong> Don't pitch other paid services, courses, signals, affiliate links, or your trading group. This server is the product.
        </td></tr>
        <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
          <span style="color:${BRAND.green};font-weight:700;margin-right:6px">&#10003;</span>
          <strong style="color:white">Maintain integrity.</strong> If you call a trade, own the outcome. Don't fudge entries / exits after the fact. Don't paper-trade and claim P&amp;L.
        </td></tr>
        <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
          <span style="color:${BRAND.green};font-weight:700;margin-right:6px">&#10003;</span>
          <strong style="color:white">No hate, no rants, don't debate everything.</strong> Politics, religion, identity slurs, and contrarian-for-its-own-sake debate kill signal. Keep it about markets and the model.
        </td></tr>
        <tr><td style="padding:3px 0;font-size:12px;color:${BRAND.textSecondary};line-height:1.5">
          <span style="color:${BRAND.green};font-weight:700;margin-right:6px">&#10003;</span>
          <strong style="color:white">Help when you can.</strong> If a member asks a question in #support and you know the answer, jump in. This is a community, not a help desk.
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:11px;color:${BRAND.textMuted};line-height:1.6;font-style:italic">
        Violations may result in a warning, mute, or removal from the community at the maintainers' discretion. Repeat violations are zero-tolerance.
      </p>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:#5865F2;border-radius:8px;padding:12px 28px">
        <a href="${openDiscordUrl}" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Open Discord</a>
      </td></tr>
    </table>

    <p style="margin:18px 0 0;font-size:11px;color:${BRAND.textMuted};line-height:1.55">
      Questions about the community itself? Reply to this email or post in <strong style="color:${BRAND.textSecondary}">#support</strong>.
    </p>
  `, { preheader: "You've been added to the Timed Trading Discord community — here's how to use it." });

  const text = `Your Discord account (${discordUsername}) has been linked to Timed Trading.\n\n` +
    `Where to start — four channels:\n` +
    `  #general       — respectful chit chat. Say hi, share what you're watching, talk markets.\n` +
    `  #trade-signals — real-time entry / trim / exit alerts from the scoring engine. Read-only.\n` +
    `  #trade-ideas   — share your own setups. Post charts, talk thesis, constructive only.\n` +
    `  #support       — questions, problems, anything you need help with.\n\n` +
    `Be a good citizen — the community contract:\n` +
    `  ✓ Be respectful. Disagreement is fine; personal attacks are not.\n` +
    `  ✓ No spam, no promotion. Don't pitch other paid services / courses / affiliate links.\n` +
    `  ✓ Maintain integrity. Own your trade outcomes; no fudging entries/exits after the fact.\n` +
    `  ✓ No hate, no rants, don't debate everything. Politics / religion / identity slurs kill signal.\n` +
    `  ✓ Help when you can. If you know the answer to a #support question, jump in.\n\n` +
    `Violations may result in warning, mute, or removal. Repeat violations are zero-tolerance.\n\n` +
    `Open Discord: ${openDiscordUrl}\n\n` +
    `Questions? Reply to this email or post in #support.`;
  return sendEmail(env, { to: email, subject: "Welcome to the Timed Trading Discord — read me first", html, text, category: "discord" });
}

// ═══════════════════════════════════════════════════════════════════════
// Daily Brief Email
// ═══════════════════════════════════════════════════════════════════════

/** Strip markdown sections duplicated by infographic / structured blocks. */
export { stripBriefMarkdownForDisplay as stripBriefMarkdownForEmail } from "./daily-brief-markdown.js";

/** One row per investor holding for brief emails. */
export function buildEmailInvestorPortfolioBlock(holdings = []) {
  const rows = (Array.isArray(holdings) ? holdings : []).filter((p) => p?.ticker);
  if (!rows.length) return "";
  const fmtPct = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  };
  const lis = rows.map((p) => {
    const sym = String(p.ticker || "").toUpperCase();
    const day = fmtPct(p.dayPct);
    const ret = fmtPct(p.unrealPct);
    const stage = p.stage ? String(p.stage).replace(/_/g, " ") : "";
    const bits = [
      `<strong style="color:white">${_esc(sym)}</strong>`,
      `today ${day}`,
      `return ${ret}`,
      stage ? _esc(stage) : null,
    ].filter(Boolean).join(" · ");
    return `<tr><td style="padding:5px 0;font-size:13px;line-height:1.45;color:${BRAND.textSecondary};border-bottom:1px solid ${BRAND.border}">${bits}</td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
    <tr><td style="padding:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">Investor Portfolio</td></tr>
    ${lis}
  </table>`;
}

/** Evening brief — structured CRO Desk card (parity with daily-brief.html). */
export function buildEmailCRODeskBlock(croNote, accentColor) {
  if (!croNote || (!croNote.verdict && !(croNote.observations?.length > 0))) return "";
  const obs = (Array.isArray(croNote.observations) ? croNote.observations : []).slice(0, 4);
  const obsHtml = obs.map((o) => `
    <div style="margin:0 0 8px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid ${BRAND.border};border-radius:6px">
      ${o.section ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${accentColor};margin-bottom:4px">${_esc(o.section)}</div>` : ""}
      <div style="font-size:12px;line-height:1.5;color:${BRAND.textSecondary}">${_esc(o.text || "")}</div>
    </div>`).join("");
  const dateLine = croNote.asOfDate
    ? `<div style="font-size:10px;color:${BRAND.textMuted};margin:0 0 8px">Desk note · ${_esc(croNote.asOfDate)}</div>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
    <tr><td style="padding:0 0 8px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">CRO Research Desk — Day Wrap</td></tr>
    <tr><td>${dateLine}${croNote.verdict ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;color:${BRAND.textSecondary}">${_esc(croNote.verdict)}</p>` : ""}${obsHtml}
      <p style="margin:10px 0 0;font-size:12px"><a href="https://timed-trading.com/research-desk.html" style="color:${accentColor};text-decoration:none;font-weight:600">Open full Research Desk →</a></p>
    </td></tr>
  </table>`;
}

function markdownToEmailHtml(md) {
  if (!md) return "";
  // Extract blockquotes first (pull-quote editorial treatment).
  let html = md.replace(/(^|\n)>\s?(.+?)(\n\n|\n>|$)/gs, (_m, pre, body, tail) => {
    const esc = body.replace(/\n>\s?/g, " ");
    return `${pre}<blockquote style="margin:18px 0;padding:4px 0 4px 16px;border-left:3px solid ${BRAND.warning};font-family:${EMAIL_FONT_EDITORIAL};font-size:17px;line-height:1.45;font-style:italic;color:${BRAND.textPrimary}">${esc}</blockquote>${tail === "\n>" ? "\n>" : tail}`;
  });
  html = html
    // H3 becomes a tight uppercase tracking label
    .replace(/^### (.+)$/gm, `<div style="margin:22px 0 8px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.16em;font-family:${EMAIL_FONT_UI}">$1</div>`)
    // H2 is the editorial section head: Georgia serif, larger, hairline divider
    .replace(/^## (.+)$/gm, `<h2 style="margin:28px 0 10px;font-size:24px;font-weight:400;color:white;font-family:${EMAIL_FONT_EDITORIAL};letter-spacing:-0.01em;line-height:1.2;border-bottom:1px solid ${BRAND.border};padding-bottom:8px">$1</h2>`)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:white">$1</strong>`)
    .replace(/\*(.+?)\*/g, `<em>$1</em>`)
    .replace(/^- (.+)$/gm, `<li style="margin:3px 0;color:${BRAND.textSecondary}">$1</li>`)
    .replace(/\n\n/g, `</p><p style="margin:0 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6;font-family:${EMAIL_FONT_UI}">`)
    .replace(/\n/g, "<br>");
  // Wrap list items in <ul>
  html = html.replace(/(<li[^>]*>.*?<\/li>\s*)+/g, (match) =>
    `<ul style="margin:8px 0;padding:0 0 0 20px">${match}</ul>`
  );
  return `<p style="margin:0 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6;font-family:${EMAIL_FONT_UI}">${html}</p>`;
}

export async function sendDailyBriefEmail(env, userEmail, brief) {
  const { type, content, date, esPrediction, stats, infographic, spyPrediction, qqqPrediction, iwmPrediction, liveKeyLevels, croNote } = brief;
  // 2026-05-21 — support label / subject overrides for non-brief reuses of
  // this template (e.g. the Weekly Recap path in /timed/admin/weekly-retrospective).
  // Default labels: morning → "Morning Brief", anything else → "Evening Brief".
  // The weekly retro previously inherited "Evening Brief" which mislabeled the
  // subject and the masthead.
  const label = brief?._labelOverride
    || (type === "morning" ? "Morning Brief" : type === "retro" ? "Weekly Recap" : "Evening Brief");
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  // Map non-brief types onto a sensible unsubscribe pref so the link is valid.
  const _prefForUnsub = type === "morning" ? "daily_brief_morning"
    : type === "evening" ? "daily_brief_evening"
    : type === "retro" ? "weekly_digest"
    : `daily_brief_${type}`;
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, _prefForUnsub, env.EMAIL_HMAC_SECRET)
    : null;

  const strippedContent = stripBriefMarkdownForEmail(content);
  const briefHtml = markdownToEmailHtml(strippedContent);
  const investorPortfolioHtml = buildEmailInvestorPortfolioBlock(infographic?.investorHoldings);
  const accentColor = type === "morning" ? BRAND.warning : BRAND.editorial;

  // Index outlook cards — predictions + live key levels (parity with daily-brief.html).
  const indexOutlookHtml = (() => {
    const lvls = Array.isArray(liveKeyLevels) ? liveKeyLevels : [];
    const preds = [
      { label: "ES", body: esPrediction },
      { label: "SPY", body: spyPrediction },
      { label: "QQQ", body: qqqPrediction },
      { label: "IWM", body: iwmPrediction },
    ].filter((p) => p.body);
    if (!preds.length && !lvls.length) return "";
    const outlookTitle = type === "evening" ? "Index Outlook &amp; Scorecard" : "Index Outlook &amp; Game Plan";
    const predRows = preds.map((p) => `
      <div style="margin:0 0 10px;padding:10px 12px;background:rgba(255,255,255,0.03);border-left:3px solid ${accentColor};border-radius:6px">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${accentColor};margin-bottom:4px">${_esc(p.label)} Outlook</div>
        <div style="font-size:13px;line-height:1.5;color:${BRAND.textSecondary};white-space:pre-line">${_esc(String(p.body || ""))}</div>
      </div>`).join("");
    const lvlRows = lvls.map((e) => `
      <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${BRAND.textSecondary}">
        <strong style="color:white">${_esc(e.sym)}</strong> ${_esc(e.text || "")}
      </p>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
      <tr><td style="padding:0 0 8px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">${outlookTitle}</td></tr>
      <tr><td>${predRows}${lvlRows}</td></tr>
    </table>`;
  })();
  const croDeskHtml = type === "evening" ? buildEmailCRODeskBlock(croNote, accentColor) : "";
  // Cross-client-safe infographic — matches the web BriefInfographic treatment.
  // Renders "Today's Three" TOC, headline badges, index cards, macro strip,
  // events, risks/opportunities, closing line. Empty string if no data.
  const infographicHtml = buildEmailInfographic(infographic);

  // Evening brief: render a "What Happened Today" summary card if stats are provided
  let eveningSummaryHtml = "";
  if (type === "evening" && stats) {
    const { entries, exits, trims, wins, losses, totalPnl, regime } = stats;
    const hasTrades = (entries || 0) + (exits || 0) + (trims || 0) > 0;
    const pnlColor = Number(totalPnl || 0) >= 0 ? "#10b981" : "#f43f5e";
    if (hasTrades || regime) {
      eveningSummaryHtml = `<div style="padding:16px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.15);border-radius:8px;margin:0 0 20px">
        <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:white">What Happened Today</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${entries ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">New positions entered</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:#10b981;text-align:right">${entries}</td></tr>` : ""}
          ${trims ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">Positions trimmed</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:#f59e0b;text-align:right">${trims}</td></tr>` : ""}
          ${exits ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">Positions closed</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:#38bdf8;text-align:right">${exits}</td></tr>` : ""}
          ${wins != null && losses != null ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">Today's record</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:white;text-align:right">${wins}W / ${losses}L</td></tr>` : ""}
          ${totalPnl != null ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">Day P&amp;L</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:${pnlColor};text-align:right">${Number(totalPnl) >= 0 ? "+$" : "-$"}${Math.abs(Number(totalPnl)).toFixed(0)}</td></tr>` : ""}
          ${regime ? `<tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}">Market regime</td><td style="padding:4px 0;font-size:13px;font-weight:600;color:${BRAND.textSecondary};text-align:right">${regime}</td></tr>` : ""}
        </table>
      </div>`;
    }
  }

  const longDate = (() => {
    try {
      return new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    } catch { return date; }
  })();

  const html = emailLayout(`
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${accentColor};font-family:${EMAIL_FONT_UI};margin:0 0 6px">${label}</div>
    <h1 style="margin:0 0 18px;font-size:32px;font-weight:400;color:white;font-family:${EMAIL_FONT_EDITORIAL};letter-spacing:-0.015em;line-height:1.1">${longDate}</h1>
    ${infographicHtml}
    ${eveningSummaryHtml}
    ${briefHtml}
    ${croDeskHtml}
    ${indexOutlookHtml}
    ${investorPortfolioHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:10px 24px">
        <a href="https://timed-trading.com/daily-brief.html" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block">View Full Brief</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: esPrediction || `${label} for ${date}` });

  const textBody = strippedContent;
  const text = `${label} — ${date}\n\n${textBody}\n\nView online: https://timed-trading.com/daily-brief.html`;

  const subject = brief?._subjectOverride || `${label} — ${date}`;
  const category = type === "retro" ? "weekly_recap" : "daily_brief";
  return sendEmail(env, { to: userEmail, subject, html, text, category });
}

// ═══════════════════════════════════════════════════════════════════════
// Trade Alert Email
// ═══════════════════════════════════════════════════════════════════════

const EMAIL_EXIT_MAP = {
  sl_breached: "Safety exit hit", SL: "Safety exit hit",
  max_loss: "Max loss reached — protecting capital",
  TP_FULL: "All profit targets hit",
  HARD_FUSE_RSI_EXTREME: "Momentum extreme — exiting",
  SOFT_FUSE_RSI_CONFIRMED: "Momentum reversal confirmed",
  RUNNER_PEAK_TRAIL: "Trailed from peak — gains locked",
  RUNNER_MAX_DRAWDOWN_BREAKER: "Pulled back too far — gains protected",
  HARD_LOSS_CAP: "Hard safety limit hit",
  MFE_SAFETY_TRIM: "Profits locked in",
  PHASE_LEAVE_100: "Momentum fading — gains secured",
  STALL_BREAKEVEN: "Stalled — closed near breakeven",
  STALL_FORCE_CLOSE: "Stalled too long — capital freed",
  SMART_RUNNER_TD_EXHAUSTION_RUNNER: "Trend exhaustion — exited runner",
  SMART_RUNNER_SUPPORT_BREAK_CLOUD: "Support broke — exited",
  SMART_RUNNER_SQUEEZE_RELEASE_AGAINST: "Squeeze fired against us",
};
function humanizeEmailExitReason(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  return EMAIL_EXIT_MAP[s] || s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ──────────────────────────────────────────────────────────────────────────
// Trade Alert email — 2026-05-28 expanded to mirror the Discord embed.
//
// User report: "the Email should also mirror the Discord Alert, with the
// detail and AI CIO, esp if people are on the go." Old email was 3 rows
// (Direction / Price / Trimmed To). Replaced with a Discord-parity layout
// so the operator can act on alerts from mobile without bouncing to the
// dashboard.
//
// Layout (all sections optional — degrade gracefully if data missing):
//   - Headline (icon + type + ticker + direction + price)
//   - Position & P&L (entry, fill, exit, $ + % P&L, qty, value)
//   - Trim Status (trimmed % + shares remaining/trimmed) — TRIMs only
//   - Setup (setup name + grade + risk %)
//   - Why (exit/trim reason — same humanizer Discord uses)
//   - AI CIO (decision pill + confidence + edge + FULL reasoning)
//   - Chart link
//   - View in Dashboard CTA
// ──────────────────────────────────────────────────────────────────────────

// 2026-05-28 — Jargon scrub for email reasons (same logic as worker/index.js
// for Discord). Strips "ripster_" / "saty_" indicator-author tokens so the
// operator never sees raw author names in their inbox.
const _scrubEmailJargon = (s) => String(s || "")
  .replace(/ripster[_\s-]*/gi, "")
  .replace(/saty[_\s-]*/gi, "");

// Trim reason → plain English (subset of the Discord trimReasonMap so the
// most common trims read naturally in email too).
const EMAIL_TRIM_MAP = {
  PHASE_LEAVE_100: "Momentum peaked and faded — securing gains before reversal",
  RUNNER_PEAK_TRAIL: "Trailed up and trimmed after pullback from peak",
  BIG_MFE_PROGRESSIVE_TRIM: "Trade ran far in our favor — taking another chunk off",
  SOFT_FUSE_TRIM: "Momentum signals weakened — trimming defensively",
  SOFT_FUSE_CLOUD_TRIM: "Momentum weakened but EMA cloud still holds — partial trim",
  ATR_RANGE_EXHAUST: "Price stretched past normal daily range — trimming",
  PROFIT_PROTECT_TRIM: "Locking in unrealized gains while structure favorable",
  REFERENCE_TRIM: "Reference setup hit scheduled trim level",
  MFE_SAFETY_TRIM: "Locking in profits while trade is ahead",
  ripster_5_12_lost_confirmed: "10-min 5/12 EMA cloud cross confirmed against us — momentum flipped",
  ripster_5_12_lost: "10-min 5/12 EMA cloud crossed against us — momentum starting to flip",
  ripster_5_12_defend_trim: "10-min 5/12 EMA cloud lost — defensive partial trim",
  ripster_5_12_pending: "10-min 5/12 EMA cloud cross forming — pre-emptive trim",
};
function humanizeEmailTrimReason(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (EMAIL_TRIM_MAP[s]) return EMAIL_TRIM_MAP[s];
  return _scrubEmailJargon(s).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function _fmtCurrency(v) {
  if (!Number.isFinite(Number(v))) return null;
  return `$${Number(v).toFixed(2)}`;
}
function _fmtPnl(pnl, pnlPct) {
  const p = Number(pnl); const pp = Number(pnlPct);
  if (!Number.isFinite(p) && !Number.isFinite(pp)) return null;
  const dollar = Number.isFinite(p) ? `${p >= 0 ? "+" : "-"}$${Math.abs(p).toFixed(2)}` : null;
  const pct = Number.isFinite(pp) ? `${pp >= 0 ? "+" : ""}${pp.toFixed(2)}%` : null;
  return dollar && pct ? `${dollar} (${pct})` : dollar || pct;
}
function _fmtEtClock(ts) {
  if (!Number.isFinite(Number(ts))) return null;
  try {
    return new Date(Number(ts)).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }) + " ET";
  } catch (_) { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// Trim history for exit emails — 2026-06-05.
//
// User report: "Looking at this IWM Trade, it looks like a loss and questions
// our accuracy without seeing the TRIM as well." A LONG that trimmed into
// strength and then exited its final tranche below entry shows Exit < Entry
// in the headline, yet a POSITIVE blended P&L — which reads as a contradiction
// unless the trims that captured the gains are shown. This pulls the TRIM
// events recorded for the trade so the exit email can spell out each partial
// profit-take that fed into the realized P&L.
//
// Returns null when there is no DB binding, no trade_id, or no trims found.
async function _fetchTradeTrims(env, tradeId, direction, entry) {
  const db = env?.DB;
  if (!db || !tradeId) return null;
  let rows = [];
  try {
    const res = await db
      .prepare(
        `SELECT ts, price, qty_pct_delta, qty_pct_total, pnl_realized, reason
           FROM trade_events
          WHERE trade_id = ?1 AND type = 'TRIM'
          ORDER BY ts ASC`,
      )
      .bind(String(tradeId))
      .all();
    rows = (res && res.results) || [];
  } catch (_) {
    return null;
  }
  if (!rows.length) return null;

  const isLong = String(direction || "").toUpperCase() !== "SHORT";
  const entryPx = Number(entry);
  const hasEntry = Number.isFinite(entryPx) && entryPx > 0;
  let totalRealized = 0;
  let anyRealized = false;

  const trims = rows.map((r) => {
    const px = Number(r.price);
    const deltaPct = Number(r.qty_pct_delta);
    const totalPct = Number(r.qty_pct_total);
    const realized = Number(r.pnl_realized);
    if (Number.isFinite(realized)) {
      totalRealized += realized;
      anyRealized = true;
    }
    // Gain vs entry for this fill (direction-aware).
    let gainPct = null;
    if (hasEntry && Number.isFinite(px) && px > 0) {
      gainPct = ((px - entryPx) / entryPx) * 100 * (isLong ? 1 : -1);
    }
    return {
      ts: Number(r.ts),
      price: Number.isFinite(px) ? px : null,
      deltaPct: Number.isFinite(deltaPct) ? deltaPct : null,
      totalPct: Number.isFinite(totalPct) ? totalPct : null,
      realized: Number.isFinite(realized) ? realized : null,
      gainPct,
      reason: r.reason || null,
    };
  });

  return { trims, totalRealized: anyRealized ? totalRealized : null };
}

// Render a labelled section (DiscordEmbed-style: bold label, value beneath)
function _section(label, valueHtml) {
  if (!valueHtml) return "";
  return `
    <div style="margin:18px 0 0">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted};font-weight:600;margin:0 0 6px">${label}</div>
      <div style="font-size:13px;color:${BRAND.textSecondary};line-height:1.55">${valueHtml}</div>
    </div>`;
}

export async function sendTradeAlertEmail(env, userEmail, alert) {
  const {
    type, ticker, direction, price, rank, rr, pnlPct, exitReason, status, mode,
    // 2026-05-28 expanded payload:
    trade_id, entry, sl, tp, fillPrice, exit: exitPx, pnl,
    shares, notional, risk_budget, setup_name, setup_grade,
    trimmedPct, newTrimmedPct, trimDeltaPct, shares_trimmed, shares_remaining,
    trim_reason, action_ts, chart_url,
    momentum_elite, vwap_pct, cio,
    // 2026-06-15 — Discord parity fields (shared via buildTraderEntryAlertParityPayload)
    signal_quality_lines, signal_tags, why_entered, scale_hint, vehicle_pick,
    conviction_score, conviction_tier,
    // 2026-06-01 — recommended options play surfaced alongside the equity
    // entry. Compact representation built via compactOptionsPlay(); see
    // worker/options-plays.js for the shape. Trader entries surface a
    // short-dated long-call/spread; Investor entries surface a LEAP.
    options_play,
    // 2026-06-02 — Exhausted-momentum context. Stamped by worker/index.js
    // when the entry fired on a ticker flagged with >=2 of the 9
    // exhaustion signals (TD9 7+, Phase EXTREME, monthly/weekly RSI
    // overbought, RS deteriorating, bearish divergence). The engine
    // automatically tightened SL to 1.5×ATR + pulled TPs 25% closer; the
    // email renders an amber banner so the user sees the trade is on a
    // stretched setup and the SL/TP block is intentionally tighter.
    exhaustion,
  } = alert;
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, "trade_alerts", env.EMAIL_HMAC_SECRET)
    : null;

  const isEntry = type === "TRADE_ENTRY";
  const isExit = type === "TRADE_EXIT";
  const isTrim = type === "TRADE_TRIM";
  const isExitSignal = type === "TRADE_EXIT_SIGNAL";
  // 2026-06-11 — TP-level cross (MU incident): a profit tier was reached;
  // the model may trim, exit, or intentionally hold the runner. The alert
  // carries plan-aware commentary (alert.commentary) plus level/next/stop.
  const isCross = type === "TP_CROSS";

  const dir = String(direction || "").toUpperCase();
  const dirColor = dir === "LONG" ? "#10b981" : dir === "SHORT" ? "#f43f5e" : BRAND.textSecondary;
  const scopeLabel = String(mode || "").toLowerCase() === "investor" ? "Investor " : "";
  const typeIcon = isEntry ? (dir === "LONG" ? "🟢" : "🔴") : isExit ? (Number(pnlPct) >= 0 ? "🏆" : "🛑") : isExitSignal ? "🚪" : isCross ? "🎯" : "✂️";
  const typeLabel = `${scopeLabel}${isEntry ? "New Entry" : isExit ? "Position Closed" : isExitSignal ? "Exit Recommended (position open)" : isCross ? `Profit Target Reached${alert.tier_label ? ` — ${alert.tier_label}` : ""}` : "Position Trimmed"}`;
  const priceFmt = Number(price) > 0 ? `$${Number(price).toFixed(2)}` : "N/A";
  const _etTime = _fmtEtClock(action_ts);

  // ── Sections ──────────────────────────────────────────────────────────

  // POSITION & P&L (entry, fill, exit, P&L, qty, value)
  const posLines = [];
  if (isEntry) {
    if (Number.isFinite(Number(entry))) posLines.push(`Entry: <strong style="color:white">$${Number(entry).toFixed(2)}</strong>`);
    if (Number.isFinite(Number(sl))) posLines.push(`Stop Loss: <strong style="color:#f43f5e">$${Number(sl).toFixed(2)}</strong>`);
    if (Number.isFinite(Number(tp))) posLines.push(`Take Profit: <strong style="color:#10b981">$${Number(tp).toFixed(2)}</strong>`);
    if (Number.isFinite(Number(shares))) {
      const qtyLine = `Shares: <strong style="color:white">${Number(shares).toFixed(4).replace(/\.?0+$/, "")}</strong>`;
      const valLine = Number.isFinite(Number(notional)) ? ` &nbsp;|&nbsp; Notional: <strong style="color:white">$${Number(notional).toFixed(2)}</strong>` : "";
      posLines.push(qtyLine + valLine);
    }
    if (isEntry && scale_hint && Number(scale_hint.pct_of_account) > 0) {
      posLines.push(`Sizing: <strong style="color:white">${Number(scale_hint.pct_of_account).toFixed(1)}% of account</strong>`);
      if (Number(scale_hint.per_thousand) > 0) {
        posLines.push(`Scale to your own: <strong style="color:white">≈ $${Number(scale_hint.per_thousand).toFixed(0)} per $1k</strong> of your account`);
      }
    }
    if (Number.isFinite(Number(rr)) && Number(rr) > 0) posLines.push(`R:R: <strong style="color:${Number(rr) >= 2 ? '#10b981' : 'white'}">${Number(rr).toFixed(2)}:1</strong>`);
    if (Number.isFinite(Number(rank)) && Number(rank) > 0) posLines.push(`Rank: <strong style="color:white">${Math.round(Number(rank))}/100</strong>`);
  } else if (isExit) {
    if (Number.isFinite(Number(entry))) posLines.push(`Entry: <strong style="color:white">$${Number(entry).toFixed(2)}</strong> &nbsp;|&nbsp; Exit: <strong style="color:white">$${Number(exitPx ?? price).toFixed(2)}</strong>`);
    const _pnl = _fmtPnl(pnl, pnlPct);
    if (_pnl) {
      const _color = (Number(pnl ?? pnlPct) >= 0) ? "#10b981" : "#f43f5e";
      posLines.push(`P&amp;L: <strong style="color:${_color}">${_pnl}</strong>`);
    }
  } else if (isTrim) {
    if (Number.isFinite(Number(entry))) posLines.push(`Entry: <strong style="color:white">$${Number(entry).toFixed(2)}</strong>${Number.isFinite(Number(fillPrice)) ? ` &nbsp;|&nbsp; Filled: <strong style="color:white">$${Number(fillPrice).toFixed(2)}</strong>` : ""}`);
    const _pnl = _fmtPnl(pnl, pnlPct);
    if (_pnl) {
      const _color = (Number(pnl ?? pnlPct) >= 0) ? "#10b981" : "#f43f5e";
      posLines.push(`Realized P&amp;L: <strong style="color:${_color}">${_pnl}</strong>`);
    }
  } else if (isExitSignal) {
    if (Number.isFinite(Number(entry))) posLines.push(`Entry: <strong style="color:white">$${Number(entry).toFixed(2)}</strong>`);
    if (Number.isFinite(Number(price))) posLines.push(`Price now: <strong style="color:white">$${Number(price).toFixed(2)}</strong>`);
    if (Number.isFinite(Number(pnlPct))) {
      const _color = Number(pnlPct) >= 0 ? "#10b981" : "#f43f5e";
      posLines.push(`Unrealized P&amp;L: <strong style="color:${_color}">${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct).toFixed(2)}%</strong>`);
    }
    if (exitReason) {
      posLines.push(`Reason: <strong style="color:white">${String(exitReason).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong>`);
    }
    posLines.push(`<span style="color:${BRAND.textMuted}">Position is still open — the model recommends exiting when ready.</span>`);
  }
  if (isCross) {
    if (Number.isFinite(Number(alert.level))) posLines.push(`Target crossed: <strong style="color:#10b981">$${Number(alert.level).toFixed(2)}</strong>${alert.tier_label ? ` <span style="color:${BRAND.textSecondary}">(${alert.tier_label})</span>` : ""}`);
    if (Number.isFinite(Number(price))) posLines.push(`Price now: <strong style="color:white">$${Number(price).toFixed(2)}</strong>${Number.isFinite(Number(pnlPct)) ? ` &nbsp;·&nbsp; <span style="color:${Number(pnlPct) >= 0 ? "#10b981" : "#f43f5e"}">${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct).toFixed(1)}% from entry</span>` : ""}`);
    if (Number.isFinite(Number(entry))) posLines.push(`Entry: <strong style="color:white">$${Number(entry).toFixed(2)}</strong>${Number.isFinite(Number(alert.trimmed_pct)) ? ` &nbsp;·&nbsp; Trimmed so far: <strong style="color:white">${alert.trimmed_pct}%</strong>` : ""}`);
    if (alert.next_target) posLines.push(`Next target: <strong style="color:#10b981">${alert.next_target}</strong>`);
    if (alert.trailing_sl) posLines.push(`Trailing stop: <strong style="color:#f59e0b">${alert.trailing_sl}</strong>`);
    if (alert.commentary) posLines.push(`<span style="color:${BRAND.textSecondary}">${String(alert.commentary).slice(0, 400)}</span>`);
  }
  const posSection = posLines.length > 0
    ? _section(isExit ? "Trade Summary" : isCross ? "The Model's Plan" : "Position", posLines.join("<br>"))
    : "";

  // TRIMS ALONG THE WAY (exits only) — pulls the partial profit-takes that
  // fed into the blended P&L. Without this, a trade that trimmed into
  // strength then exited its final tranche below entry reads as a loss
  // even though the realized P&L is positive.
  let exitTrimsSection = "";
  let exitTrimData = null;
  if (isExit) {
    const trimData = await _fetchTradeTrims(env, trade_id, direction, entry);
    exitTrimData = trimData;
    if (trimData && trimData.trims.length > 0) {
      const rowsHtml = trimData.trims.map((t, i) => {
        const when = _fmtEtClock(t.ts);
        const pxStr = t.price != null ? `$${t.price.toFixed(2)}` : "—";
        const sizeStr = t.deltaPct != null
          ? `${Math.round(t.deltaPct)}%`
          : (t.totalPct != null ? `to ${Math.round(t.totalPct)}%` : "");
        const gainStr = t.gainPct != null
          ? `<span style="color:${t.gainPct >= 0 ? "#10b981" : "#f43f5e"}">${t.gainPct >= 0 ? "+" : ""}${t.gainPct.toFixed(2)}% vs entry</span>`
          : "";
        const realizedStr = t.realized != null
          ? ` &nbsp;·&nbsp; <span style="color:${t.realized >= 0 ? "#10b981" : "#f43f5e"}">${t.realized >= 0 ? "+" : "-"}$${Math.abs(t.realized).toFixed(2)}</span>`
          : "";
        return `<div style="margin:0 0 4px">
          <strong style="color:white">✂️ Trim ${i + 1}</strong>${sizeStr ? ` <span style="color:${BRAND.textMuted}">(${sizeStr})</span>` : ""}
          &nbsp;@&nbsp;<strong style="color:white">${pxStr}</strong>${gainStr ? ` &nbsp;·&nbsp; ${gainStr}` : ""}${realizedStr}
          ${when ? `<span style="color:${BRAND.textMuted};font-size:11px;margin-left:6px">${when}</span>` : ""}
        </div>`;
      }).join("");
      const totalLine = trimData.totalRealized != null
        ? `<div style="margin:8px 0 0;color:${BRAND.textSecondary};font-size:12px">Trims captured <strong style="color:${trimData.totalRealized >= 0 ? "#10b981" : "#f43f5e"}">${trimData.totalRealized >= 0 ? "+" : "-"}$${Math.abs(trimData.totalRealized).toFixed(2)}</strong> before this final exit — included in the P&amp;L above.</div>`
        : `<div style="margin:8px 0 0;color:${BRAND.textMuted};font-size:11px">Earlier trims are already included in the P&amp;L above.</div>`;
      exitTrimsSection = _section(`Trims Along The Way · ${trimData.trims.length}`, rowsHtml + totalLine);
    }
  }

  // TRIM STATUS (trimmed % + shares) — TRIMs only
  let trimSection = "";
  if (isTrim) {
    const lines = [];
    if (newTrimmedPct != null || trimmedPct != null) {
      const totalP = Number.isFinite(Number(newTrimmedPct)) ? Number(newTrimmedPct) : Number(trimmedPct);
      const remaining = Number.isFinite(totalP) ? Math.max(0, 100 - totalP) : null;
      lines.push(`Trimmed: <strong style="color:white">${Math.round(Number(totalP))}%</strong>${remaining != null ? ` &nbsp;|&nbsp; Remaining: <strong style="color:white">${Math.round(remaining)}%</strong>` : ""}`);
    }
    if (shares_trimmed != null && shares_remaining != null) {
      lines.push(`Shares trimmed: <strong style="color:white">${Number(shares_trimmed).toFixed(2).replace(/\.?0+$/, "")}</strong> &nbsp;|&nbsp; Remaining: <strong style="color:white">${Number(shares_remaining).toFixed(2).replace(/\.?0+$/, "")}</strong>`);
    }
    if (lines.length > 0) trimSection = _section("Trim Status", lines.join("<br>"));
  }

  // SETUP (name + grade + risk %)
  const setupLines = [];
  if (setup_name) {
    const _grade = setup_grade ? ` <span style="color:${BRAND.textMuted}">(${setup_grade})</span>` : "";
    const _name = String(setup_name).replace(/^TT[\s_]+/i, "").replace(/^tt_/i, "").replace(/^ripster_?/i, "").replace(/^saty_?/i, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    setupLines.push(`<strong style="color:white">${_name}</strong>${_grade}`);
  }
  if (risk_budget != null && Number(risk_budget) > 0) {
    const _r = Number(risk_budget);
    const _label = _r < 1 ? `${(_r * 100).toFixed(2)}%` : `$${_r.toFixed(0)}`;
    setupLines.push(`Risk: <strong style="color:white">${_label}</strong>`);
  }
  const setupSection = setupLines.length > 0 ? _section("Setup", setupLines.join("<br>")) : "";

  // OPTIONS PLAY (entry only) — compact card sitting between Setup and
  // Signals. 2026-06-01: Trader entries get a short-dated long-call /
  // spread; Investor entries get a LEAP. Section is suppressed for
  // exits/trims (where the options play has long since been chosen).
  let optionsPlaySection = "";
  if (isEntry && options_play) {
    const _html = optionsPlayEmailHtml(options_play);
    if (_html) {
      const _isLeap = options_play.archetype === "leap_call" || options_play.archetype === "leap_put";
      const _label = _isLeap ? "Options Play — LEAP (Investor)" : "Options Play (Trader)";
      optionsPlaySection = _section(_label, _html);
    }
  }

  // SIGNAL QUALITY (entry) — rank, conviction, R:R, full signal tag list
  let signalQualitySection = "";
  if (isEntry) {
    const sqLines = [];
    if (Array.isArray(signal_quality_lines) && signal_quality_lines.length > 0) {
      for (const line of signal_quality_lines) {
        const idx = String(line).indexOf(": ");
        if (idx > 0) {
          sqLines.push(`<strong style="color:white">${String(line).slice(0, idx)}</strong>: ${String(line).slice(idx + 2)}`);
        } else {
          sqLines.push(String(line));
        }
      }
    } else {
      if (Number.isFinite(Number(rank)) && Number(rank) > 0) {
        sqLines.push(`Signal Strength (Rank): <strong style="color:white">${Math.round(Number(rank))}/100</strong>`);
      }
      if (Number.isFinite(Number(conviction_score)) && Number(conviction_score) > 0) {
        sqLines.push(`Conviction: <strong style="color:white">${Number(conviction_score).toFixed(0)}</strong>${conviction_tier ? ` (${conviction_tier})` : ""}`);
      }
      if (Number.isFinite(Number(rr)) && Number(rr) > 0) {
        sqLines.push(`Risk/Reward: <strong style="color:white">${Number(rr).toFixed(1)}:1</strong>`);
      }
      if (momentum_elite) sqLines.push("Strong Momentum");
      if (Number.isFinite(Number(vwap_pct))) {
        const v = Number(vwap_pct);
        sqLines.push(`${v >= 0 ? "Above" : "Below"} 1H VWAP ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
      }
    }
    if (sqLines.length > 0) {
      signalQualitySection = _section("Signal Quality", sqLines.join("<br>"));
    }
  }

  // WHY WE ENTERED (entry only)
  let entryWhySection = "";
  if (isEntry && why_entered) {
    entryWhySection = _section("Why We Entered", `<strong style="color:white">${String(why_entered).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong>`);
  }

  // PLAY THE MOVE — engine vehicle pick (entry only)
  let vehiclePickSection = "";
  if (isEntry && vehicle_pick && vehicle_pick.vehicle) {
    const _veh = String(vehicle_pick.vehicle).toUpperCase();
    const _suit = vehicle_pick.suitability != null ? ` (suitability ${vehicle_pick.suitability})` : "";
    const _why = vehicle_pick.why
      ? `<div style="margin:8px 0 0;color:${BRAND.textSecondary};white-space:pre-wrap">${String(vehicle_pick.why).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
      : "";
    vehiclePickSection = _section(
      `Play the Move — engine pick: ${_veh}`,
      `<strong style="color:white">${String(vehicle_pick.label || _veh).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong>${_suit}${_why}`,
    );
  }

  // Legacy compact signals row (fallback when parity payload absent)
  const signalsParts = [];
  if (!signalQualitySection && momentum_elite) signalsParts.push("Strong Momentum");
  if (!signalQualitySection && Number.isFinite(Number(vwap_pct))) {
    const v = Number(vwap_pct);
    signalsParts.push(`${v >= 0 ? "Above" : "Below"} 1H VWAP ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  }
  const signalsSection = signalsParts.length > 0 ? _section("Signals", signalsParts.join(" &nbsp;·&nbsp; ")) : "";

  // WHY (trim reason or exit reason)
  let whySection = "";
  if (isExit && exitReason) {
    whySection = _section("Why We Exited", humanizeEmailExitReason(exitReason));
  } else if (isTrim && trim_reason) {
    whySection = _section("Why We Trimmed", humanizeEmailTrimReason(trim_reason));
  }

  // 2026-06-02 — EXHAUSTED MOMENTUM banner (entry alerts only).
  // Surfaces above the AI CIO section so the user sees the engine
  // auto-tightened SL/TP BEFORE they read the CIO reasoning. Amber
  // styling matches the Discord embed's ⚠️ field for parity.
  let exhaustionSection = "";
  if (isEntry && exhaustion && Array.isArray(exhaustion.warnings) && exhaustion.warnings.length > 0) {
    const _adjPieces = [];
    if (exhaustion.sl_tightened) _adjPieces.push("SL → 1.5× ATR cap");
    if (exhaustion.tps_tightened) _adjPieces.push("TPs pulled 25% closer");
    const _adjLine = _adjPieces.length
      ? `<div style="margin:0 0 8px;color:#f59e0b;font-size:13px;font-weight:600">Engine auto-adjusted: ${_adjPieces.join(" · ")}</div>`
      : "";
    const _warningList = exhaustion.warnings.slice(0, 9)
      .map(w => `<li style="margin:2px 0;font-family:'JetBrains Mono',monospace;font-size:11px;color:${BRAND.textSecondary}">${String(w).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</li>`)
      .join("");
    exhaustionSection = _section(`⚠️ Exhausted Momentum · ${exhaustion.warnings.length} warning${exhaustion.warnings.length === 1 ? "" : "s"}`, `
      <div style="border-left:3px solid #f59e0b;padding:4px 0 4px 12px;margin:0 0 4px">
        ${_adjLine}
        <div style="color:${BRAND.textSecondary};font-size:12px;margin:0 0 6px">
          This setup is firing on a stretched trend. The engine tightened the SL and pulled
          the take-profit targets closer than typical to lock in faster and stop out earlier
          if the move cracks.
        </div>
        <ul style="margin:6px 0 0;padding:0 0 0 18px;list-style:disc">${_warningList}</ul>
      </div>
    `);
  }

  // AI CIO (full reasoning, no truncation)
  let cioSection = "";
  if (cio && cio.decision) {
    const _icon = cio.decision === "APPROVE" ? "✅" : cio.decision === "ADJUST" ? "⚙️" : "🛑";
    const _color = cio.decision === "APPROVE" ? "#10b981" : cio.decision === "ADJUST" ? "#f59e0b" : "#f43f5e";
    const _confEdge = [
      Number.isFinite(Number(cio.confidence)) ? `${(Number(cio.confidence) * 100).toFixed(0)}% conf` : null,
      Number.isFinite(Number(cio.edge_score)) ? `edge ${(Number(cio.edge_score) * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join(" &nbsp;·&nbsp; ");
    const _flags = Array.isArray(cio.risk_flags) && cio.risk_flags.length > 0
      ? `<div style="margin:8px 0 0">${cio.risk_flags.map(f => `<span style="display:inline-block;padding:2px 8px;margin:2px 4px 2px 0;border:1px solid rgba(244,63,94,0.30);background:rgba(244,63,94,0.10);color:#f43f5e;font-size:10px;letter-spacing:0.02em;border-radius:4px">${f}</span>`).join("")}</div>`
      : "";
    const _shadow = cio.shadow ? ` <span style="display:inline-block;padding:1px 6px;margin-left:6px;border:1px solid ${BRAND.border};background:rgba(168,162,158,0.15);color:${BRAND.textMuted};font-size:9px;letter-spacing:0.12em;border-radius:4px">SHADOW</span>` : "";
    const _model = cio.model ? ` <span style="color:${BRAND.textMuted};font-size:10px;margin-left:4px">${cio.model}</span>` : "";
    cioSection = _section("AI CIO Verdict", `
      <div style="margin:0 0 8px">
        <strong style="color:${_color};font-size:14px">${_icon} ${cio.decision}</strong>${_shadow}
        ${_confEdge ? ` <span style="color:${BRAND.textMuted};font-size:11px;margin-left:6px">(${_confEdge})</span>` : ""}
        ${_model}
      </div>
      <div style="color:${BRAND.textSecondary};white-space:pre-wrap">${(cio.reasoning || "—").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      ${_flags}
    `);
  }

  // ── Compose ───────────────────────────────────────────────────────────

  const headlineColor = isEntry ? "#10b981" : isExit ? (Number(pnlPct) >= 0 ? "#10b981" : "#f43f5e") : "#f59e0b";
  const isTrader = String(mode || "").toLowerCase() !== "investor";
  const ctaUrl = isTrader && ticker
    ? `${baseUrl}/active-trader.html?ticker=${encodeURIComponent(String(ticker).toUpperCase())}`
    : `${baseUrl}/today.html?ticker=${encodeURIComponent(String(ticker || "").toUpperCase())}`;
  const chartLinkHtml = chart_url
    ? `<div style="margin:18px 0 0"><a href="${chart_url}" style="color:${BRAND.green};text-decoration:none;font-size:12px;font-weight:600">📊 View entry/trim/exit chart</a></div>`
    : "";

  // 2026-06-01 — Inline chart image. Embeds the worker's public SVG
  // chart endpoint as an <img>, so Gmail/Apple Mail/Outlook proxies
  // fetch + cache the rendered chart and surface it inline in the
  // email body. Default: 1H timeframe, 48 bars (~2 trading days),
  // with entry/SL/TP overlays when available. Skipped when
  // BRAND.workerUrl resolves to localhost (test sends).
  const _workerUrl = env?.WORKER_URL || "https://timed-trading.com";
  const _chartImageParams = (() => {
    const p = new URLSearchParams();
    p.set("ticker", String(ticker || "").toUpperCase());
    p.set("tf", "60");
    p.set("bars", "48");
    /* 2026-06-01 — Strict positive-price encode. Was passing
       sl=0 / tp=0 / entry=0 through to the chart endpoint when the
       trade record had a zero default; combined with the renderer's
       finite-but-zero acceptance bug, this rendered an empty chart with
       a flat y-axis range from $0 to actual price. Both layers now
       defensive: caller skips ≤0 values; renderer also skips them. */
    const _hasPositive = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
    if (_hasPositive(entry)) p.set("entry", String(Number(entry)));
    // 2026-06-01 — Exits have no live stop, so skip sl/tp entirely on
    // exits. The position is closed; drawing the original stop level
    // can dwarf the actual price action (e.g. SL was $440 on a trade
    // that ran to $510 then exited — including SL would expand the
    // y-axis far below the price band).
    if (_hasPositive(sl) && !isExit) p.set("sl", String(Number(sl)));
    if (_hasPositive(tp) && !isExit) p.set("tp", String(Number(tp)));
    // Subtitle gives the operator context inside the rendered image
    // itself (so the chart works as a standalone share-able snapshot).
    const _subtitleParts = [];
    if (isEntry) _subtitleParts.push("ENTRY");
    else if (isExit) _subtitleParts.push("EXIT");
    else if (isExitSignal) _subtitleParts.push("EXIT SIGNAL");
    else if (isTrim) _subtitleParts.push("TRIM");
    if (dir) _subtitleParts.push(dir);
    if (_etTime) _subtitleParts.push(_etTime);
    if (_subtitleParts.length) p.set("subtitle", _subtitleParts.join(" · "));
    return p.toString();
  })();
  const chartImgHtml = ticker
    ? `<div style="margin:14px 0 0">
         <a href="${chart_url || ctaUrl}" style="display:block;line-height:0;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.border}">
           <img
             src="${_workerUrl}/timed/chart-image?${_chartImageParams}"
             alt="${String(ticker).toUpperCase()} 1H chart with entry / stop / take-profit"
             width="600"
             style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px"
           />
         </a>
         <div style="margin:4px 2px 0;font-size:10px;color:${BRAND.textMuted}">
           1H chart · last ~2 trading days · refreshes every 5 min
         </div>
       </div>`
    : "";

  const html = emailLayout(`
    <div style="border-left:3px solid ${headlineColor};padding:0 0 0 14px;margin:0 0 8px">
      <h1 style="margin:0 0 4px;font-size:18px;font-weight:700;color:white">
        ${typeIcon} ${typeLabel}: ${ticker} <span style="color:${dirColor}">${dir}</span> @ ${priceFmt}
      </h1>
      <p style="margin:0;font-size:12px;color:${BRAND.textMuted}">
        ${_etTime || new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}
        ${trade_id ? ` &nbsp;·&nbsp; <span style="font-family:Menlo,Monaco,monospace;font-size:10px">${String(trade_id).slice(0, 24)}</span>` : ""}
      </p>
    </div>
    ${chartImgHtml}
    ${posSection}
    ${exitTrimsSection}
    ${trimSection}
    ${setupSection}
    ${optionsPlaySection}
    ${signalQualitySection}
    ${entryWhySection}
    ${vehiclePickSection}
    ${signalsSection}
    ${whySection}
    ${exhaustionSection}
    ${cioSection}
    ${chartLinkHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:10px 24px">
        <a href="${ctaUrl}" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block">${isTrader ? "Open in Active Trader" : "View in Dashboard"}</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: `${typeLabel}: ${ticker} ${dir} @ ${priceFmt}${cio ? ` — AI CIO ${cio.decision}` : ""}` });

  // Plain-text fallback (mirrors the html sections in order)
  const _txtParts = [`${typeLabel}: ${ticker} ${dir} @ ${priceFmt}`];
  if (_etTime) _txtParts.push(_etTime);
  if (posLines.length > 0) _txtParts.push("", "Position:", ...posLines.map(l => "  " + l.replace(/<[^>]+>/g, "")));
  if (isExit && exitTrimData && exitTrimData.trims.length > 0) {
    _txtParts.push("", "Trims along the way:");
    exitTrimData.trims.forEach((t, i) => {
      const pxStr = t.price != null ? `$${t.price.toFixed(2)}` : "—";
      const sizeStr = t.deltaPct != null ? ` (${Math.round(t.deltaPct)}%)` : (t.totalPct != null ? ` (to ${Math.round(t.totalPct)}%)` : "");
      const gainStr = t.gainPct != null ? ` · ${t.gainPct >= 0 ? "+" : ""}${t.gainPct.toFixed(2)}% vs entry` : "";
      const realizedStr = t.realized != null ? ` · ${t.realized >= 0 ? "+" : "-"}$${Math.abs(t.realized).toFixed(2)}` : "";
      _txtParts.push(`  Trim ${i + 1}${sizeStr} @ ${pxStr}${gainStr}${realizedStr}`);
    });
    if (exitTrimData.totalRealized != null) {
      _txtParts.push(`  Trims captured ${exitTrimData.totalRealized >= 0 ? "+" : "-"}$${Math.abs(exitTrimData.totalRealized).toFixed(2)} (included in P&L above).`);
    }
  }
  if (isExit && exitReason) _txtParts.push("", "Why: " + humanizeEmailExitReason(exitReason));
  if (isTrim && trim_reason) _txtParts.push("", "Why: " + humanizeEmailTrimReason(trim_reason));
  if (isEntry && why_entered) _txtParts.push("", "Why we entered: " + why_entered);
  if (isEntry && Array.isArray(signal_quality_lines) && signal_quality_lines.length > 0) {
    _txtParts.push("", "Signal quality:");
    for (const line of signal_quality_lines) _txtParts.push("  " + line);
  }
  if (isEntry && scale_hint && Number(scale_hint.pct_of_account) > 0) {
    _txtParts.push(`Sizing: ${Number(scale_hint.pct_of_account).toFixed(1)}% of account`);
    if (Number(scale_hint.per_thousand) > 0) {
      _txtParts.push(`Scale: ≈ $${Number(scale_hint.per_thousand).toFixed(0)} per $1k`);
    }
  }
  if (isEntry && vehicle_pick?.vehicle) {
    _txtParts.push("", `Play the Move: ${vehicle_pick.vehicle} — ${vehicle_pick.label || ""}${vehicle_pick.why ? "\n" + vehicle_pick.why : ""}`);
  }
  if (cio && cio.decision) {
    _txtParts.push("", `AI CIO: ${cio.decision} (${cio.confidence ? Math.round(cio.confidence * 100) + "% conf" : ""}${cio.edge_score ? ", edge " + Math.round(cio.edge_score * 100) + "%" : ""})`);
    if (cio.reasoning) _txtParts.push(cio.reasoning);
  }
  if (isEntry && options_play && Array.isArray(options_play.lines) && options_play.lines.length > 0) {
    const isLeap = options_play.archetype === "leap_call" || options_play.archetype === "leap_put";
    _txtParts.push("", `Options Play${isLeap ? " (LEAP)" : ""}: ${options_play.headline}`);
    for (const line of options_play.lines) _txtParts.push("  " + line);
    if (options_play.net_cost_usd != null) {
      const sign = options_play.net_side === "credit" ? "+" : "-";
      _txtParts.push(`  Net ${options_play.net_side}: ${sign}$${Math.abs(options_play.net_cost_usd).toLocaleString()}`);
    }
    if (options_play.max_loss_usd != null) _txtParts.push(`  Max loss: $${Math.abs(options_play.max_loss_usd).toLocaleString()}`);
    if (options_play.breakeven != null) _txtParts.push(`  Breakeven: $${options_play.breakeven.toFixed(2)}`);
  }
  _txtParts.push("", "View: " + ctaUrl);
  const text = _txtParts.join("\n");

  return sendEmail(env, { to: userEmail, subject: `${typeIcon} ${typeLabel}: ${ticker} ${dir}${cio ? ` — CIO ${cio.decision}` : ""}`, html, text, category: "trade_alert" });
}

// ═══════════════════════════════════════════════════════════════════════
// Re-Engagement Email
// ═══════════════════════════════════════════════════════════════════════

export async function sendReEngagementEmail(env, userEmail, stats) {
  const { daysSince, signalCount, tradeCount, briefCount, winRate, totalPnl, activePositions, recentTrades } = stats || {};
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, "re_engagement", env.EMAIL_HMAC_SECRET)
    : null;

  const pnlPositive = Number(totalPnl || 0) > 0;
  const pnlColor = pnlPositive ? "#10b981" : "#f43f5e";

  // Build trade table: show last 10 trades if net positive, otherwise last 3 wins
  let tradeTableHtml = "";
  if (Array.isArray(recentTrades) && recentTrades.length > 0) {
    const last10 = recentTrades.slice(0, 10);
    const netPnl = last10.reduce((s, t) => s + (Number(t.pnlPct || t.pnl_pct) || 0), 0);
    const tradesToShow = netPnl > 0
      ? last10
      : last10.filter(t => (t.status === "WIN" || Number(t.pnlPct || t.pnl_pct) > 0)).slice(0, 3);

    if (tradesToShow.length > 0) {
      const headerLabel = netPnl > 0 ? "Last 10 Trades" : "Recent Wins";
      const rows = tradesToShow.map(t => {
        const pnl = Number(t.pnlPct || t.pnl_pct) || 0;
        const pnlClr = pnl >= 0 ? "#10b981" : "#f43f5e";
        const dir = String(t.direction || "LONG").toUpperCase();
        const dirClr = dir === "LONG" ? "#22d3ee" : "#f472b6";
        const entryDate = t.entry_ts ? new Date(Number(t.entry_ts)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        const exitDate = t.exit_ts ? new Date(Number(t.exit_ts)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        const holdHrs = (t.entry_ts && t.exit_ts) ? Math.round((Number(t.exit_ts) - Number(t.entry_ts)) / 3600000) : null;
        const holdStr = holdHrs != null ? (holdHrs < 24 ? `${holdHrs}h` : `${Math.round(holdHrs / 24)}d`) : "";
        return `<tr>
          <td style="padding:6px 4px;font-size:12px;font-weight:600;color:white">${t.ticker || "?"}</td>
          <td style="padding:6px 4px;font-size:11px;color:${dirClr}">${dir}</td>
          <td style="padding:6px 4px;font-size:11px;color:${BRAND.textMuted}">${entryDate}${exitDate ? ` &rarr; ${exitDate}` : ""}</td>
          <td style="padding:6px 4px;font-size:11px;color:${BRAND.textMuted};text-align:center">${holdStr}</td>
          <td style="padding:6px 4px;font-size:12px;font-weight:600;color:${pnlClr};text-align:right">${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%</td>
        </tr>`;
      }).join("");
      tradeTableHtml = `<div style="padding:14px 16px;background:rgba(0,200,83,0.06);border:1px solid rgba(0,200,83,0.12);border-radius:8px;margin:0 0 20px">
        <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:white">${headerLabel}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:0 4px 4px;font-size:10px;color:${BRAND.textMuted};font-weight:600">TICKER</td>
            <td style="padding:0 4px 4px;font-size:10px;color:${BRAND.textMuted};font-weight:600">DIR</td>
            <td style="padding:0 4px 4px;font-size:10px;color:${BRAND.textMuted};font-weight:600">DATES</td>
            <td style="padding:0 4px 4px;font-size:10px;color:${BRAND.textMuted};font-weight:600;text-align:center">HOLD</td>
            <td style="padding:0 4px 4px;font-size:10px;color:${BRAND.textMuted};font-weight:600;text-align:right">P&amp;L</td>
          </tr>
          ${rows}
        </table>
      </div>`;
    }
  }

  const html = emailLayout(`
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:white">The System Has Been Working</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      It has been <strong style="color:white">${daysSince || "a while"} days</strong> since your last visit. While you were away, the model kept scoring, entering, managing, and exiting trades across 229 tickers. Here is what happened:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">
      ${tradeCount ? `<tr><td style="padding:10px 16px;background:rgba(56,189,248,0.06);border-radius:8px"><span style="font-size:24px;font-weight:700;color:#38bdf8">${tradeCount}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">trades managed</span></td></tr><tr><td style="height:6px"></td></tr>` : ""}
      ${winRate ? `<tr><td style="padding:10px 16px;background:rgba(0,200,83,0.06);border-radius:8px"><span style="font-size:24px;font-weight:700;color:${BRAND.green}">${Number(winRate).toFixed(0)}%</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">win rate</span></td></tr><tr><td style="height:6px"></td></tr>` : ""}
      ${pnlPositive ? `<tr><td style="padding:10px 16px;background:rgba(0,200,83,0.06);border-radius:8px"><span style="font-size:24px;font-weight:700;color:${pnlColor}">+$${Math.abs(Number(totalPnl)).toFixed(0)}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">total P&amp;L</span></td></tr><tr><td style="height:6px"></td></tr>` : ""}
      ${activePositions ? `<tr><td style="padding:10px 16px;background:rgba(99,102,241,0.06);border-radius:8px"><span style="font-size:24px;font-weight:700;color:#818cf8">${activePositions}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">active positions right now</span></td></tr><tr><td style="height:6px"></td></tr>` : ""}
      ${briefCount ? `<tr><td style="padding:10px 16px;background:rgba(245,158,11,0.06);border-radius:8px"><span style="font-size:24px;font-weight:700;color:#f59e0b">${briefCount}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">daily briefs published</span></td></tr>` : ""}
    </table>
    ${tradeTableHtml}
    <p style="margin:0 0 24px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      The market does not wait, and neither does the model. The AI CIO reviewed every trade candidate, and the pipeline is fully up to date.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/today.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">See What is Happening Now</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: `${tradeCount || "Several"} trades managed while you were away.${pnlPositive ? ` P&L: +$${Math.abs(Number(totalPnl)).toFixed(0)}` : ""}` });

  const text = `The system has been working while you were away (${daysSince || "?"} days):\n${tradeCount ? `- ${tradeCount} trades managed\n` : ""}${winRate ? `- ${Number(winRate).toFixed(0)}% win rate\n` : ""}${pnlPositive ? `- +$${Math.abs(Number(totalPnl)).toFixed(0)} total P&L\n` : ""}${activePositions ? `- ${activePositions} active positions right now\n` : ""}${briefCount ? `- ${briefCount} daily briefs published\n` : ""}\nSee what is happening: https://timed-trading.com/today.html`;

  return sendEmail(env, { to: userEmail, subject: "The system has been working while you were away", html, text, category: "re_engagement" });
}

// ═══════════════════════════════════════════════════════════════════════
// Unsubscribe Confirmation Page (HTML response)
// ═══════════════════════════════════════════════════════════════════════

export function unsubscribeConfirmationHtml(email, pref) {
  const prefLabel = {
    daily_brief_morning: "Morning Brief emails",
    daily_brief_evening: "Evening Brief emails",
    trade_alerts: "Trade Alert emails",
    re_engagement: "Re-engagement emails",
    weekly_digest: "Weekly Digest emails",
    investor_alerts: "Investor Signal emails",
    all: "all emails",
  }[pref] || pref;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Timed Trading</title>
<style>body{margin:0;background:${BRAND.dark};color:${BRAND.textPrimary};font-family:'Helvetica Neue',Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:12px;padding:40px;max-width:420px;text-align:center}
h1{font-size:20px;margin:0 0 12px}p{font-size:14px;color:${BRAND.textSecondary};line-height:1.6;margin:0 0 16px}
a{color:${BRAND.green};text-decoration:none}</style></head>
<body><div class="card">
<h1>Unsubscribed</h1>
<p>You have been unsubscribed from <strong>${prefLabel}</strong>.</p>
<p>You can re-enable email notifications anytime from your <a href="https://timed-trading.com/today.html">dashboard settings</a>.</p>
</div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// Email Preferences Helpers
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_PREFS_PAID = {
  daily_brief_morning: true,
  daily_brief_evening: true,
  trade_alerts: true,
  weekly_digest: true,
  re_engagement: true,
  // 2026-05-30 — Investor signal emails (accumulation zone entry,
  // RS breakout, thesis invalidation). Investor-mode users tend to
  // rely on email more than Discord for slower-cadence signals.
  investor_alerts: true,
};

const DEFAULT_PREFS_FREE = {
  daily_brief_morning: false,
  daily_brief_evening: false,
  trade_alerts: false,
  weekly_digest: false,
  re_engagement: true,
  investor_alerts: false,
};

export function getUserEmailPrefs(user) {
  const isPaid = user?.tier === "pro" || user?.tier === "vip" || user?.tier === "admin";
  const defaults = isPaid ? DEFAULT_PREFS_PAID : DEFAULT_PREFS_FREE;
  let stored = {};
  if (user?.email_preferences) {
    try {
      stored = typeof user.email_preferences === "string"
        ? JSON.parse(user.email_preferences)
        : user.email_preferences;
    } catch { /* use defaults */ }
  }
  return { ...defaults, ...stored };
}

/**
 * Send investor signal alert emails (accumulation zone, RS breakout,
 * thesis invalidation) to opted-in users.
 *
 * 2026-05-30 — Operator: 'We should also send out emails for Investor
 * related actions since those users rely more on email as a notification
 * signal.' Mirrors the Discord alert payload into an email layout.
 * Routed via SendGrid/Resend (whichever is configured); falls back to
 * a no-op if neither set.
 *
 * @param {object} env
 * @param {object} alert - { type: "accumulation_zone"|"rs_breakout"|"thesis_invalidation", data: {...} }
 */
export async function sendInvestorAlertEmails(env, alert) {
  const opted = await getEmailOptedInUsers(env, "investor_alerts").catch(() => []);
  if (!opted.length) return { sent: 0, recipients: 0 };
  const { type, data } = alert || {};
  if (!type || !data?.ticker) return { sent: 0, recipients: 0 };

  /* 2026-06-01 — Investor alert email rewrite per operator feedback:

     "Can we make them more apparent that it is an Investor Signal to
     accumulate or whichever signal it is. As you can tell, it seems
     vague on how one should react to these signals. Also the email
     does not include the chart."

     Three changes:
       1. Subject + masthead now prefixed `[INVESTOR · ACTION]` so the
          system + intent are visible at-a-glance in the inbox list.
       2. Large action badge ("ACCUMULATE", "WATCH", "ADD ON PULLBACK",
          "REDUCE / EXIT") at the top of the body with the
          deriveInvestorAlertAction() one-liner explaining what to do.
       3. Chart embedded via /timed/chart-image — Daily timeframe, 60
          bars (~3 months of context) since Investor signals are
          multi-week / multi-month horizon (vs the 1H/48-bar chart
          used by trade-exit emails which are a different time
          horizon entirely).

     deriveInvestorAlertAction lives in worker/alerts.js so the Discord
     embed and email stay in lockstep. */
  const { deriveInvestorAlertAction } = await import("./alerts.js");
  const action = deriveInvestorAlertAction(type, data);

  const TYPE_META = {
    accumulation_zone: {
      subjectBase: data.zoneType === "momentum_runner"
        ? `${data.ticker} — Momentum-Runner Zone Confirmed`
        : `${data.ticker} — Entered Accumulation Zone`,
      headline: data.zoneType === "momentum_runner" ? "Momentum-Runner Zone Confirmed" : "Entered Accumulation Zone",
      lede: data.zoneType === "momentum_runner"
        ? `<strong>${data.ticker}</strong> is in a confirmed momentum-runner zone — trend is healthy and intact, signals support adding on minor pullbacks.`
        : `<strong>${data.ticker}</strong> entered an accumulation zone in the TT Investor model — pullback context with monthly trend intact.`,
    },
    rs_breakout: {
      subjectBase: `${data.ticker} — RS Breakout (${data.period || "3-month"})`,
      headline: `Relative Strength Breakout`,
      lede: `<strong>${data.ticker}</strong> relative-strength line hit a new ${data.period || "3-month"} high vs SPY. Outperforming ${data.rsRank || "?"}% of the universe.`,
    },
    thesis_invalidation: {
      subjectBase: `${data.ticker} — Model Thesis Shift`,
      headline: `Model Thesis Shift`,
      lede: `The TT Investor model no longer sees valid supporting conditions for <strong>${data.ticker}</strong>: ${(data.reasons || []).join("; ")}.`,
    },
    position_trim: {
      subjectBase: `${data.ticker} — Investor Position Trimmed`,
      headline: `Investor Position Trimmed`,
      lede: `The Investor portfolio trimmed <strong>${data.ticker}</strong> (${Number(data.shares || 0).toFixed(2)} shares at $${Number(data.price || 0).toFixed(2)}).`,
    },
    position_close: {
      subjectBase: `${data.ticker} — Investor Position Closed`,
      headline: `Investor Position Closed`,
      lede: `The Investor portfolio closed the <strong>${data.ticker}</strong> position (${Number(data.shares || 0).toFixed(2)} shares at $${Number(data.price || 0).toFixed(2)}).`,
    },
  };
  const meta = TYPE_META[type];
  if (!meta) return { sent: 0, recipients: opted.length };
  const tone = action.color;

  const factsHtml = (() => {
    const rows = [];
    if (data.score != null) rows.push(["Investor Score", `${data.score} / 100`]);
    if (data.confidence != null) rows.push(["Confidence", `${data.confidence}%`]);
    if (data.rsRank != null) rows.push(["RS Rank", `${data.rsRank}th percentile`]);
    if (data.zoneType) rows.push(["Zone Type", String(data.zoneType).replace(/_/g, " ")]);
    if (Array.isArray(data.signals) && data.signals.length) rows.push(["Signals", data.signals.map((s) => String(s).replace(/_/g, " ")).join(", ")]);
    if (data.shares != null) rows.push(["Shares", `${Number(data.shares).toFixed(2)}`]);
    if (data.price != null) rows.push(["Price", `$${Number(data.price).toFixed(2)}`]);
    if (data.pnl != null) rows.push(["Realized P&L", `$${Number(data.pnl).toFixed(2)}`]);
    if (data.remaining != null) rows.push(["Remaining", `${Number(data.remaining).toFixed(2)} shares`]);
    if (data.reasonLabel || data.reason) rows.push(["Reason", String(data.reasonLabel || data.reason).replace(/_/g, " ")]);
    return rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#9ca3af;font-size:12px;vertical-align:top">${k}</td><td style="padding:6px 0;color:#e5e7eb;font-size:13px;font-weight:600">${v}</td></tr>`).join("");
  })();

  // Daily 60-bar chart for Investor horizon (~3 months of context).
  // The chart-image endpoint already accepts ticker/tf/bars; no
  // entry/sl/tp annotations needed for an informational signal.
  const _workerUrl = env?.WORKER_URL || "https://timed-trading.com";
  const _chartImgUrl = `${_workerUrl}/timed/chart-image?ticker=${encodeURIComponent(data.ticker)}&tf=D&bars=60`;
  const chartImgHtml = `
<div style="margin:18px 0 8px">
  <a href="https://timed-trading.com/today.html?ticker=${encodeURIComponent(data.ticker)}" style="display:block;line-height:0;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)">
    <img src="${_chartImgUrl}" alt="${data.ticker} daily chart (last ~3 months)" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:8px"/>
  </a>
  <div style="margin:4px 2px 0;font-size:10px;color:#6b7280">Daily chart · last 60 bars · refreshes every 5 min</div>
</div>`;

  const tickerUrl = `https://timed-trading.com/today.html?ticker=${encodeURIComponent(data.ticker)}`;
  const subject = `[INVESTOR · ${action.verb}] ${meta.subjectBase} — Timed Trading`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;background:#0a0a0f;color:#e5e7eb;font-family:'Inter',Helvetica,Arial,sans-serif">
<table width="100%" cellspacing="0" cellpadding="0" style="background:#0a0a0f;padding:24px 16px">
<tr><td align="center">
<table width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#141821;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:24px">
<tr><td>
<div style="font-size:10px;font-weight:700;letter-spacing:0.14em;color:#a78bfa;text-transform:uppercase;margin-bottom:6px">INVESTOR SIGNAL</div>
<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:${tone};text-transform:uppercase;margin-bottom:8px">${meta.headline}</div>
<h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#f0f6fc">${data.ticker}</h1>

<!-- Action badge — the single most important thing in this email -->
<div style="margin:0 0 14px;padding:14px 16px;border-radius:10px;background:${tone}1A;border:1px solid ${tone}55">
  <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:${tone};text-transform:uppercase;margin-bottom:4px">▶ TT Model signal</div>
  <div style="font-size:18px;font-weight:700;color:${tone};letter-spacing:0.02em;margin-bottom:6px">${action.verb}</div>
  <div style="font-size:13px;line-height:1.55;color:#e5e7eb">${action.one_liner}</div>
</div>

<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#cbd5e1">${meta.lede}</p>

${chartImgHtml}

<table cellspacing="0" cellpadding="0" style="margin:14px 0 18px">${factsHtml}</table>
${data.cio_reasoning ? `
<div style="margin:0 0 16px;padding:14px 16px;border-radius:10px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.25)">
  <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;color:#a78bfa;text-transform:uppercase;margin-bottom:6px">AI CIO guidance</div>
  <div style="font-size:13px;line-height:1.55;color:#e5e7eb;white-space:pre-wrap">${String(data.cio_reasoning).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
</div>` : ""}
<a href="${tickerUrl}" style="display:inline-block;padding:10px 18px;background:${tone};color:#0a0a0f;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none">View ${data.ticker} in TT →</a>
<div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#6b7280;line-height:1.6">
Informational model signal only — not investment advice. The TT Investor model portfolio tracks this in simulation; live broker mirroring requires the Phase 1 share-mirror config.<br>
You're receiving this because Investor Signal emails are enabled. <a href="https://timed-trading.com/today.html" style="color:${tone};text-decoration:none">Manage preferences</a>.
</div>
</td></tr></table></td></tr></table></body></html>`;
  let sent = 0, failed = 0;
  for (const u of opted) {
    try {
      const r = await sendEmail(env, {
        to: u.email,
        subject,
        html,
        text: `[INVESTOR · ${action.verb}] ${meta.headline}: ${data.ticker}\n\n` +
              `TT Model signal — ${action.verb}\n${action.one_liner}\n\n` +
              `${meta.lede.replace(/<[^>]+>/g, "")}\n\n` +
              (data.cio_reasoning ? `AI CIO guidance:\n${String(data.cio_reasoning).trim()}\n\n` : "") +
              `View: ${tickerUrl}\nChart: ${_chartImgUrl}\n\nManage email preferences at https://timed-trading.com/today.html.`,
      });
      if (r?.ok) sent++; else failed++;
    } catch (e) {
      failed++;
      console.warn(`[INVESTOR ALERT EMAIL] ${u.email} failed:`, String(e?.message || e).slice(0, 200));
    }
  }
  console.log(`[INVESTOR ALERT EMAIL] type=${type} ticker=${data.ticker} sent=${sent} failed=${failed} recipients=${opted.length}`);
  return { sent, failed, recipients: opted.length };
}

/**
 * Query all users who have a specific email preference enabled.
 * Returns array of { email, display_name, tier, email_preferences }.
 */
export async function getEmailOptedInUsers(env, prefKey) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT email, display_name, tier, email_preferences, last_login_at FROM users WHERE tier IN ('pro', 'vip', 'admin')`
    ).all();
    return (results || []).filter(u => {
      const prefs = getUserEmailPrefs(u);
      return prefs[prefKey] === true;
    });
  } catch (e) {
    console.warn("[EMAIL] Failed to query opted-in users:", String(e?.message || e).slice(0, 200));
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D5 (2026-06-11) — Weekly Investor Digest (operator-requested cadence:
// per-event alerts stay; this adds the Friday-close weekly summary).
//
// Deterministic, no LLM: open holdings with unrealized %, the week's
// actions (lots), the week's GRADED investor calls from the Signal Outcome
// Ledger, and current accumulate candidates. Sent Friday after the close
// to investor_alerts opted-in users — the weekend review, in one email.
// Compliance voice: "the portfolio / this position", never "you/your".
// ─────────────────────────────────────────────────────────────────────────────
export async function sendInvestorWeeklyDigest(env) {
  const db = env?.DB;
  const KV = env?.KV_TIMED || env?.KV;
  if (!db) return { ok: false, error: "no_db" };

  const opted = await getEmailOptedInUsers(env, "investor_alerts").catch(() => []);
  if (!opted.length) return { ok: true, sent: 0, recipients: 0 };

  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const fmtUsd = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : "—";
  const fmtPct = (n) => Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(1)}%` : "—";

  // ── Data: positions, week's lots, graded calls, accumulate candidates ──
  let positions = [];
  try {
    positions = (await db.prepare(
      `SELECT ticker, total_shares, avg_entry, cost_basis, first_entry_ts
         FROM investor_positions WHERE status = 'OPEN' ORDER BY cost_basis DESC LIMIT 25`
    ).all())?.results || [];
  } catch (_) {}

  let lots = [];
  try {
    lots = (await db.prepare(
      `SELECT l.ticker, l.action, l.shares, l.price, l.ts, l.reason
         FROM investor_lots l WHERE l.ts >= ?1 ORDER BY l.ts DESC LIMIT 30`
    ).bind(weekAgo).all())?.results || [];
  } catch (_) {}

  let gradedCalls = [];
  try {
    gradedCalls = (await db.prepare(
      `SELECT ticker, thesis, grade, outcome, outcome_pct, resolved_at
         FROM signal_outcomes
        WHERE source = 'investor_action' AND status = 'resolved' AND resolved_at >= ?1
        ORDER BY resolved_at DESC LIMIT 15`
    ).bind(weekAgo).all())?.results || [];
  } catch (_) {}

  let prices = {};
  try {
    const raw = KV ? JSON.parse((await KV.get("timed:prices")) || "{}") : {};
    prices = raw?.prices || raw || {};
  } catch (_) {}

  let accumulate = [];
  try {
    const scores = KV ? JSON.parse((await KV.get("timed:investor:scores")) || "{}") : {};
    accumulate = Object.entries(scores)
      .filter(([, v]) => v && Number(v.score) >= 70 && v.accumZone?.inZone)
      .sort((a, b) => Number(b[1].score) - Number(a[1].score))
      .slice(0, 5)
      .map(([t, v]) => ({ ticker: t, score: Number(v.score) }));
  } catch (_) {}

  // ── Compose ──────────────────────────────────────────────────────────────
  const posRows = positions.map((p) => {
    const sym = String(p.ticker || "").toUpperCase();
    const live = Number(prices?.[sym]?.p) || 0;
    const entry = Number(p.avg_entry) || 0;
    const pnlPct = live > 0 && entry > 0 ? ((live - entry) / entry) * 100 : null;
    const color = pnlPct == null ? BRAND.textMuted : pnlPct >= 0 ? BRAND.green : "#ef4444";
    return `<tr>
      <td style="padding:6px 10px;font-weight:700">${sym}</td>
      <td style="padding:6px 10px;text-align:right">${Number(p.total_shares || 0).toFixed(1)} sh</td>
      <td style="padding:6px 10px;text-align:right">${fmtUsd(entry)}</td>
      <td style="padding:6px 10px;text-align:right">${live > 0 ? fmtUsd(live) : "—"}</td>
      <td style="padding:6px 10px;text-align:right;color:${color};font-weight:700">${fmtPct(pnlPct)}</td>
    </tr>`;
  }).join("");

  const lotRows = lots.map((l) => {
    const action = String(l.action || "").toUpperCase();
    const color = action === "BUY" ? BRAND.green : BRAND.warning;
    const when = new Date(Number(l.ts)).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
    return `<tr>
      <td style="padding:5px 10px;color:${BRAND.textMuted}">${when}</td>
      <td style="padding:5px 10px;font-weight:700">${String(l.ticker || "").toUpperCase()}</td>
      <td style="padding:5px 10px;color:${color};font-weight:700">${action}</td>
      <td style="padding:5px 10px;text-align:right">${Number(l.shares || 0).toFixed(1)} sh @ ${fmtUsd(l.price)}</td>
      <td style="padding:5px 10px;color:${BRAND.textSecondary}">${String(l.reason || "").replace(/_/g, " ").slice(0, 40)}</td>
    </tr>`;
  }).join("");

  const gradeRows = gradedCalls.map((g) => {
    const grade = String(g.grade || "—").toUpperCase();
    const color = grade === "A" || grade === "B" ? BRAND.green : grade === "C" ? BRAND.textSecondary : "#ef4444";
    return `<tr>
      <td style="padding:5px 10px;font-weight:700">${String(g.ticker || "").toUpperCase()}</td>
      <td style="padding:5px 10px;color:${BRAND.textSecondary}">${String(g.thesis || "").slice(0, 60)}</td>
      <td style="padding:5px 10px;text-align:center;color:${color};font-weight:800">${grade}</td>
      <td style="padding:5px 10px;text-align:right;color:${Number(g.outcome_pct) >= 0 ? BRAND.green : "#ef4444"}">${fmtPct(g.outcome_pct)}</td>
    </tr>`;
  }).join("");

  const tableHead = (cols) =>
    `<tr>${cols.map((c) => `<th style="padding:6px 10px;text-align:${c.r ? "right" : c.c ? "center" : "left"};font-size:10px;letter-spacing:0.08em;color:${BRAND.textMuted};border-bottom:1px solid ${BRAND.border}">${c.t}</th>`).join("")}</tr>`;
  const section = (title, inner) =>
    `<div style="margin:18px 0">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:${BRAND.textSecondary};margin-bottom:8px">${title}</div>
      ${inner}
    </div>`;
  const table = (head, rows, empty) => rows
    ? `<table style="width:100%;border-collapse:collapse;background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:8px;font-size:13px">${head}${rows}</table>`
    : `<div style="color:${BRAND.textMuted};font-size:12px">${empty}</div>`;

  const weekLabel = new Date(now).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
  const bodyHtml = `
    <h2 style="margin:0 0 4px;font-size:20px;color:${BRAND.textPrimary}">Investor Week in Review</h2>
    <p style="margin:0 0 14px;color:${BRAND.textSecondary};font-size:13px">Week ending ${weekLabel} — the portfolio, the week's actions, and how the engine's investor calls graded.</p>
    ${section("CURRENT HOLDINGS", table(
      tableHead([{ t: "TICKER" }, { t: "SHARES", r: 1 }, { t: "AVG ENTRY", r: 1 }, { t: "CURRENT", r: 1 }, { t: "UNREALIZED", r: 1 }]),
      posRows, "No open investor positions."))}
    ${section("THIS WEEK'S ACTIONS", table(
      tableHead([{ t: "DAY" }, { t: "TICKER" }, { t: "ACTION" }, { t: "FILL", r: 1 }, { t: "REASON" }]),
      lotRows, "No investor transactions this week."))}
    ${section("THE WEEK'S CALLS, GRADED", table(
      tableHead([{ t: "TICKER" }, { t: "CALL" }, { t: "GRADE", c: 1 }, { t: "MOVE", r: 1 }]),
      gradeRows, "No investor calls resolved this week — grades land as horizons complete."))}
    ${accumulate.length > 0 ? section("ON THE ACCUMULATION RADAR",
      `<div style="font-size:13px;color:${BRAND.textPrimary}">${accumulate.map((a) => `<span style="display:inline-block;margin:0 8px 6px 0;padding:4px 10px;border:1px solid ${BRAND.border};border-radius:999px;background:${BRAND.cardBg}">${a.ticker} <span style="color:${BRAND.textMuted}">· ${a.score}</span></span>`).join("")}</div>
      <p style="margin:6px 0 0;font-size:11px;color:${BRAND.textMuted}">Names currently in confirmed accumulation zones with investor score ≥ 70. Not recommendations — what the model is watching.</p>`) : ""}
    <p style="margin:18px 0 0;font-size:12px"><a href="https://timed-trading.com/investor.html" style="color:${BRAND.green}">Open the Investor page →</a></p>
  `;

  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  let sent = 0;
  for (const user of opted) {
    try {
      const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
        ? await buildUnsubscribeUrl(baseUrl, user.email, "investor_alerts", env.EMAIL_HMAC_SECRET)
        : null;
      const html = emailLayout(bodyHtml, {
        unsubscribeUrl,
        preheader: `Investor week in review — ${positions.length} holdings, ${lots.length} actions, ${gradedCalls.length} graded calls.`,
      });
      const r = await sendEmail(env, {
        to: user.email,
        subject: `[INVESTOR · WEEKLY] Week in Review — ${weekLabel}`,
        html,
        category: "investor_weekly_digest",
      });
      if (r?.ok !== false) sent++;
    } catch (e) {
      console.warn(`[INVESTOR DIGEST] send failed for ${user.email}:`, String(e?.message || e).slice(0, 120));
    }
  }
  console.log(`[INVESTOR DIGEST] weekly digest sent=${sent}/${opted.length}`);
  return { ok: true, sent, recipients: opted.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Investor REBALANCE digest — ONE email per rebalance cycle, grouped by action.
// 2026-06-16 — Operator: the hourly rebalance fired 35+ individual emails (one
// per trim) ahead of FOMC. The Investor persona is low-cadence and felt spammed.
// Replace the per-lot blast with a single consolidated email that lists all
// tickers per action, clustered by reason (e.g. every name trimmed "ahead of
// FOMC" in one line). Sent to investor_alerts opted-in users.
// Compliance voice: "the portfolio / this position", never "you/your".
// ─────────────────────────────────────────────────────────────────────────────
function _reasonGroupLabel(item) {
  const ev = String(item?.event_label || item?.eventLabel || "").trim();
  if (ev) return ev;
  const r = String(item?.reason || "").toLowerCase();
  if (r.includes("exhaustion") || r.includes("lock_in")) return "Exhaustion / locking in gains";
  if (r.includes("event_risk") || r.includes("event-risk")) return "Event risk";
  if (r.includes("reduce_stage") || r.includes("auto_reduce")) return "Trend weakened (reduce signal)";
  return r ? r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Risk management";
}

export async function sendInvestorRebalanceDigest(env, summary) {
  const opted = await getEmailOptedInUsers(env, "investor_alerts").catch(() => []);
  const trims = Array.isArray(summary?.trims) ? summary.trims : [];
  const added = Array.isArray(summary?.added) ? summary.added : [];
  const opened = Array.isArray(summary?.opened) ? summary.opened : [];
  const totalActions = trims.length + added.length + opened.length;
  if (totalActions === 0) return { ok: true, sent: 0, recipients: 0, reason: "no_actions" };
  if (!opted.length) return { ok: true, sent: 0, recipients: 0, reason: "no_recipients" };

  const nowLabel = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const chip = (sym) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border:1px solid ${BRAND.border};border-radius:999px;background:${BRAND.cardBg};font-weight:700;font-size:12px">${_esc(String(sym || "").toUpperCase())}</span>`;
  const section = (title, color, inner) =>
    `<div style="margin:16px 0">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:${color};margin-bottom:8px">${_esc(title)}</div>
      ${inner}
    </div>`;

  const fmtUsd = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : null;
  const fmtPnl = (n) => Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? "+" : "-"}$${Math.abs(Number(n)).toFixed(2)}` : null;
  // Group trims by reason (so "ahead of FOMC" names cluster), and within each
  // group show one row per ticker WITH its AI CIO reasoning — parity with the
  // per-ticker Discord embed (operator: include CIO guidance per ticker).
  const trimGroups = new Map();
  for (const t of trims) {
    const key = _reasonGroupLabel(t);
    if (!trimGroups.has(key)) trimGroups.set(key, []);
    trimGroups.get(key).push(t);
  }
  const trimRow = (t) => {
    const sym = String(t?.ticker || "").toUpperCase();
    const closed = !!t?.closed;
    const detail = [
      closed ? "position closed" : (Number.isFinite(Number(t?.shares)) ? `trimmed ${Number(t.shares).toFixed(2)} sh` : "trimmed"),
      fmtUsd(t?.price) ? `@ ${fmtUsd(t.price)}` : null,
      fmtPnl(t?.pnl) ? `· P&L ${fmtPnl(t.pnl)}` : null,
    ].filter(Boolean).join(" ");
    const cio = String(t?.cio_reasoning || "").trim();
    return `<div style="margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid ${BRAND.border}">
      <div><span style="font-weight:800;font-size:13px">${_esc(sym)}</span> <span style="color:${BRAND.textMuted};font-size:11px">${_esc(detail)}</span></div>
      ${cio ? `<div style="font-size:12px;color:${BRAND.textSecondary};margin-top:3px;line-height:1.45"><span style="color:${BRAND.textMuted};font-weight:700">AI CIO:</span> ${_esc(cio)}</div>` : ""}
    </div>`;
  };
  const trimInner = [...trimGroups.entries()].map(([reason, items]) =>
    `<div style="margin-bottom:12px">
       <div style="font-size:12px;font-weight:700;color:${BRAND.textPrimary};margin-bottom:6px">${_esc(reason)} <span style="color:${BRAND.textMuted};font-weight:400">(${items.length})</span></div>
       ${items.map(trimRow).join("")}
     </div>`).join("");

  const addedSyms = added.map((x) => String(x?.ticker || "").toUpperCase());
  const openedSyms = opened.map((x) => String(x?.ticker || "").toUpperCase());

  const headlineBits = [];
  if (trims.length) headlineBits.push(`${trims.length} trimmed/reduced`);
  if (added.length) headlineBits.push(`${added.length} added`);
  if (opened.length) headlineBits.push(`${opened.length} opened`);

  const bodyHtml = `
    <h2 style="margin:0 0 4px;font-size:20px;color:${BRAND.textPrimary}">Investor Rebalance — ${_esc(nowLabel)} ET</h2>
    <p style="margin:0 0 14px;color:${BRAND.textSecondary};font-size:13px">The model's long-horizon portfolio cycle ran: ${_esc(headlineBits.join(" · "))}. One summary, grouped by action — no per-ticker blast.</p>
    ${trims.length ? section("TRIMMED / REDUCED", BRAND.warning || "#f59e0b", trimInner) : ""}
    ${added.length ? section("ADDED TO EXISTING", BRAND.green, `<div>${addedSyms.map(chip).join("")}</div>`) : ""}
    ${opened.length ? section("NEW STARTER POSITIONS", BRAND.green, `<div>${openedSyms.map(chip).join("")}</div>`) : ""}
    <p style="margin:16px 0 0;font-size:11px;color:${BRAND.textMuted}">Long-horizon portfolio actions — not short-term trade signals. The model phases in and out gradually.</p>
    <p style="margin:10px 0 0;font-size:12px"><a href="https://timed-trading.com/investor.html" style="color:${BRAND.green}">Open the Investor page →</a></p>
  `;

  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  let sent = 0;
  for (const user of opted) {
    try {
      const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
        ? await buildUnsubscribeUrl(baseUrl, user.email, "investor_alerts", env.EMAIL_HMAC_SECRET)
        : null;
      const html = emailLayout(bodyHtml, {
        unsubscribeUrl,
        preheader: `Investor rebalance — ${headlineBits.join(", ")}.`,
      });
      const r = await sendEmail(env, {
        to: user.email,
        subject: `[INVESTOR] Rebalance — ${headlineBits.join(", ")}`,
        html,
        category: "investor_rebalance_digest",
      });
      if (r?.ok !== false) sent++;
    } catch (e) {
      console.warn(`[INVESTOR REBALANCE DIGEST] send failed for ${user.email}:`, String(e?.message || e).slice(0, 120));
    }
  }
  console.log(`[INVESTOR REBALANCE DIGEST] sent=${sent}/${opted.length} (trims=${trims.length} added=${added.length} opened=${opened.length})`);
  return { ok: true, sent, recipients: opted.length };
}

/** Batched investor scoring alerts (accumulate / reduce signal / RS) — one email per cron tick. */
export async function sendInvestorSignalsDigest(env, alerts) {
  const list = Array.isArray(alerts) ? alerts.filter((a) => a?.type && a?.data?.ticker) : [];
  if (!list.length) return { ok: true, sent: 0, recipients: 0, reason: "no_alerts" };
  const opted = await getEmailOptedInUsers(env, "investor_alerts").catch(() => []);
  if (!opted.length) return { ok: true, sent: 0, recipients: 0, reason: "no_recipients" };

  const { deriveInvestorAlertAction } = await import("./alerts.js");
  const nowLabel = new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const rows = list.map((alert) => {
    const sym = String(alert.data.ticker || "").toUpperCase();
    const action = deriveInvestorAlertAction(alert.type, alert.data);
    const cio = String(alert.data?.cio_reasoning || "").trim();
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.border};vertical-align:top">
        <div style="font-size:14px;font-weight:700;color:white;margin-bottom:2px">${_esc(sym)}</div>
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;color:${action.color};text-transform:uppercase;margin-bottom:4px">${_esc(action.verb)}</div>
        <div style="font-size:12px;line-height:1.45;color:${BRAND.textSecondary}">${_esc(action.one_liner)}</div>
        ${cio ? `<div style="margin-top:8px;font-size:12px;line-height:1.45;color:${BRAND.editorial}"><strong style="color:#a78bfa">AI CIO:</strong> ${_esc(cio.slice(0, 360))}${cio.length > 360 ? "…" : ""}</div>` : ""}
      </td>
    </tr>`;
  }).join("");

  const bodyHtml = `
    <h2 style="margin:0 0 4px;font-size:20px;color:${BRAND.textPrimary}">Investor Signals — ${_esc(nowLabel)} ET</h2>
    <p style="margin:0 0 14px;color:${BRAND.textSecondary};font-size:13px">${list.length} portfolio signal${list.length === 1 ? "" : "s"} from the scoring pass — grouped in one summary (not one email per ticker).</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    <p style="margin:16px 0 0;font-size:12px"><a href="https://timed-trading.com/investor.html" style="color:${BRAND.green}">Open the Investor page →</a></p>
  `;

  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  let sent = 0;
  for (const user of opted) {
    try {
      const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
        ? await buildUnsubscribeUrl(baseUrl, user.email, "investor_alerts", env.EMAIL_HMAC_SECRET)
        : null;
      const html = emailLayout(bodyHtml, {
        unsubscribeUrl,
        preheader: `Investor signals — ${list.length} name${list.length === 1 ? "" : "s"}.`,
      });
      const r = await sendEmail(env, {
        to: user.email,
        subject: `[INVESTOR] Portfolio signals — ${list.length} update${list.length === 1 ? "" : "s"}`,
        html,
        category: "investor_signals_digest",
      });
      if (r?.ok !== false) sent++;
    } catch (e) {
      console.warn(`[INVESTOR SIGNALS DIGEST] send failed for ${user.email}:`, String(e?.message || e).slice(0, 120));
    }
  }
  console.log(`[INVESTOR SIGNALS DIGEST] sent=${sent}/${opted.length} alerts=${list.length}`);
  return { ok: true, sent, recipients: opted.length };
}

/** One consolidated Discord embed for the rebalance cycle (grouped by action,
 *  with per-ticker AI CIO guidance — parity with the old per-lot embeds). */
export function buildInvestorRebalanceDiscordEmbed(summary) {
  const trims = Array.isArray(summary?.trims) ? summary.trims : [];
  const added = Array.isArray(summary?.added) ? summary.added : [];
  const opened = Array.isArray(summary?.opened) ? summary.opened : [];
  if (trims.length + added.length + opened.length === 0) return null;
  const fields = [];
  if (trims.length) {
    // Reason overview (one line per reason group).
    const groups = new Map();
    for (const t of trims) {
      const key = _reasonGroupLabel(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(String(t?.ticker || "").toUpperCase());
    }
    const overview = [...groups.entries()].map(([r, syms]) => `**${r}** (${syms.length}): ${syms.join(", ")}`).join("\n").slice(0, 1020);
    fields.push({ name: `🔻 Trimmed / Reduced (${trims.length})`, value: overview || "—" });
    // Per-ticker AI CIO guidance (Discord embed = max 25 fields / ~6000 chars,
    // so cap and point overflow to the email digest which carries them all).
    const withCio = trims.filter((t) => String(t?.cio_reasoning || "").trim());
    const CAP = 18;
    for (const t of withCio.slice(0, CAP)) {
      const sym = String(t?.ticker || "").toUpperCase();
      fields.push({ name: `🔻 ${sym}`, value: String(t.cio_reasoning).trim().slice(0, 360) });
    }
    if (withCio.length > CAP) {
      fields.push({ name: "…", value: `+${withCio.length - CAP} more with AI CIO notes — see the email digest.` });
    }
  }
  if (added.length) fields.push({ name: `➕ Added (${added.length})`, value: added.map((x) => String(x?.ticker || "").toUpperCase()).join(", ").slice(0, 1020) || "—" });
  if (opened.length) fields.push({ name: `🟢 New positions (${opened.length})`, value: opened.map((x) => String(x?.ticker || "").toUpperCase()).join(", ").slice(0, 1020) || "—" });
  return {
    title: "Investor Rebalance — portfolio cycle",
    description: "Long-horizon portfolio actions, grouped by reason — with AI CIO guidance per name. One summary per cycle.",
    color: 0x8b5cf6,
    fields: fields.slice(0, 25),
    timestamp: new Date().toISOString(),
  };
}
