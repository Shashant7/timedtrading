// Email module — SendGrid integration for outbound emails
// Handles: welcome, daily brief digest, trade alerts, re-engagement, unsubscribe tokens.

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
};

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
  return gg === "OPEN_UP" ? "#34d399" : gg === "OPEN_DOWN" ? "#ef4444" : "#9ca3af";
}

function _pctColor(p) {
  if (p == null) return "#9ca3af";
  return p > 0 ? "#34d399" : p < 0 ? "#ef4444" : "#9ca3af";
}

function _ggLabel(gg) {
  return gg === "OPEN_UP" ? "▲ GG Up" : gg === "OPEN_DOWN" ? "▼ GG Down" : "◆ Neutral";
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

  // ── Index rows (SPY/QQQ/IWM with price + GG) ──
  let indicesHtml = "";
  if (indices.length > 0) {
    const rows = indices.map(idx => {
      const lvls = idx.levels || {};
      const gg = lvls.goldenGate || "NEUTRAL";
      const price = idx.price ?? lvls.currentPrice;
      const chgPct = idx.chgPct;
      return `<tr>
        <td style="padding:10px 12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);border-radius:6px" valign="top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;font-weight:700;color:white">${_esc(idx.sym)}</td>
              <td align="right" style="font-size:11px;font-weight:600;color:${_ggColor(gg)}">${_ggLabel(gg)}</td>
            </tr>
            <tr>
              <td colspan="2" style="padding-top:4px">
                <span style="font-size:16px;font-weight:700;color:white;font-variant-numeric:tabular-nums">${price != null ? `$${Number(price).toFixed(2)}` : "—"}</span>
                ${chgPct != null ? `<span style="margin-left:8px;font-size:12px;font-weight:600;color:${_pctColor(chgPct)};font-variant-numeric:tabular-nums">${chgPct >= 0 ? "+" : ""}${Number(chgPct).toFixed(2)}%</span>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="height:6px;line-height:6px">&nbsp;</td></tr>`;
    }).join("");
    indicesHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px">
        ${rows}
      </table>`;
  }

  // ── Macro strip ──
  let macroHtml = "";
  if (macro.length > 0) {
    const cells = macro.slice(0, 5).map(m => {
      const color = m.bucket ? _vixColor(m.bucket) : _pctColor(m.chgPct);
      return `<td style="padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:6px;min-width:80px">
        <div style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(m.label || m.sym)}</div>
        <div style="font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;margin-top:2px">${_esc(Number(m.value).toFixed(2))}${m.chgPct != null ? ` · ${m.chgPct >= 0 ? "+" : ""}${Number(m.chgPct).toFixed(1)}%` : ""}</div>
      </td>`;
    }).join("");
    macroHtml = `<table role="presentation" cellpadding="0" cellspacing="4" style="margin:0 0 14px"><tr>${cells}</tr></table>`;
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

  // ── Closing line (if present) ──
  const closingHtml = closingLine
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0">
        <tr><td style="padding:12px 14px;background:rgba(139,92,246,0.06);border-left:3px solid rgba(139,92,246,0.5);border-radius:6px">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#a78bfa;margin:0 0 4px">The bottom line</div>
          <p style="margin:0;font-size:13px;color:${BRAND.textPrimary};line-height:1.55">${_esc(closingLine)}</p>
        </td></tr>
      </table>`
    : "";

  const body = topThreeHtml + headlineHtml + indicesHtml + macroHtml + eventsHtml + risksOppsHtml + closingHtml;
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

export async function sendEmail(env, { to, subject, html, text, category }) {
  const apiKey = env?.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn("[EMAIL] No SENDGRID_API_KEY configured — skipping send");
    return { ok: false, error: "no_api_key" };
  }
  if (env?.EMAIL_ENABLED !== "true" && env?.EMAIL_ENABLED !== true) {
    console.log("[EMAIL] EMAIL_ENABLED is not true — skipping send");
    return { ok: false, error: "disabled" };
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
  <tr><td style="padding:20px 24px;text-align:center">
    <div style="display:inline-block;width:32px;height:32px;background:${BRAND.green};border-radius:8px;vertical-align:middle;text-align:center;line-height:32px">
      <span style="color:white;font-size:14px;font-weight:bold;letter-spacing:-0.5px">TT</span>
    </div>
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
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Open Your Dashboard</a>
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
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Go to Dashboard</a>
      </td></tr>
    </table>
  `, { preheader: isTrial ? "Your 14-day free trial is active." : "Your Pro subscription is confirmed." });

  const text = isTrial
    ? "Your 14-day free trial of Timed Trading Pro has started.\n\nFull access includes: Analysis Dashboard, Active Trader Board, Investor Dashboard, Daily Brief, Trades & Portfolio, Trade Alerts, and Discord Community.\n\nVisit https://timed-trading.com to get started."
    : "Your Timed Trading Pro subscription is active.\n\nFull access includes: Analysis Dashboard, Active Trader Board, Investor Dashboard, Daily Brief, Trades & Portfolio, Trade Alerts, and Discord Community.\n\nVisit https://timed-trading.com to continue.";

  return sendEmail(env, { to: email, subject: isTrial ? "Your Free Trial Has Started" : "Subscription Confirmed", html, text, category: "subscription" });
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

export async function sendDiscordWelcomeEmail(env, email, discordUsername) {
  const html = emailLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:white">Welcome to the TT Discord</h1>
    <p style="margin:0 0 20px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      Your Discord account <strong style="color:white">${discordUsername}</strong> has been linked and you've been added to the Timed Trading community server.
    </p>

    <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.08em">Channels to explore</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      <tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}"><strong style="color:white">#general</strong> &mdash; introduce yourself and chat with the community</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}"><strong style="color:white">#trade-signals</strong> &mdash; real-time alerts from the scoring engine</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}"><strong style="color:white">#trade-ideas</strong> &mdash; share your setups and discuss plays</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:${BRAND.textSecondary}"><strong style="color:white">#support</strong> &mdash; questions, feedback, or bug reports</td></tr>
    </table>

    <div style="padding:14px 16px;background:rgba(88,101,242,0.06);border:1px solid rgba(88,101,242,0.15);border-radius:8px;margin:0 0 24px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:white">Community Rules</p>
      <p style="margin:0;font-size:12px;color:${BRAND.textSecondary};line-height:1.6">
        Be professional and respectful. No personal attacks, spam, or unsolicited promotions.
        Share constructively, support fellow traders, and keep discussions on topic.
        Violations may result in removal from the community.
      </p>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:#5865F2;border-radius:8px;padding:12px 28px">
        <a href="https://discord.com/channels/${env.DISCORD_GUILD_ID || ''}" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Open Discord</a>
      </td></tr>
    </table>
  `, { preheader: "You've been added to the Timed Trading Discord community." });

  const text = `Your Discord account (${discordUsername}) has been linked to Timed Trading.\n\nChannels:\n- #general — introduce yourself\n- #trade-signals — real-time alerts\n- #trade-ideas — share setups\n- #support — questions & feedback\n\nCommunity Rules: Be professional and respectful. No personal attacks, spam, or unsolicited promotions. Violations may result in removal.\n\nOpen Discord to get started.`;
  return sendEmail(env, { to: email, subject: "Welcome to the Timed Trading Discord", html, text, category: "discord" });
}

// ═══════════════════════════════════════════════════════════════════════
// Daily Brief Email
// ═══════════════════════════════════════════════════════════════════════

function markdownToEmailHtml(md) {
  if (!md) return "";
  let html = md
    .replace(/^### (.+)$/gm, `<h3 style="margin:18px 0 8px;font-size:15px;font-weight:600;color:white">$1</h3>`)
    .replace(/^## (.+)$/gm, `<h2 style="margin:24px 0 10px;font-size:17px;font-weight:700;color:white;border-bottom:1px solid ${BRAND.border};padding-bottom:6px">$1</h2>`)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:white">$1</strong>`)
    .replace(/\*(.+?)\*/g, `<em>$1</em>`)
    .replace(/^- (.+)$/gm, `<li style="margin:3px 0;color:${BRAND.textSecondary}">$1</li>`)
    .replace(/\n\n/g, `</p><p style="margin:0 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">`)
    .replace(/\n/g, "<br>");
  // Wrap list items in <ul>
  html = html.replace(/(<li[^>]*>.*?<\/li>\s*)+/g, (match) =>
    `<ul style="margin:8px 0;padding:0 0 0 20px">${match}</ul>`
  );
  return `<p style="margin:0 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">${html}</p>`;
}

export async function sendDailyBriefEmail(env, userEmail, brief) {
  const { type, content, date, esPrediction, stats, infographic } = brief;
  const label = type === "morning" ? "Morning Brief" : "Evening Brief";
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, `daily_brief_${type}`, env.EMAIL_HMAC_SECRET)
    : null;

  const briefHtml = markdownToEmailHtml(content);
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

  const html = emailLayout(`
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:white">${label}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:${BRAND.textMuted}">${date}</p>
    ${esPrediction ? `<div style="padding:10px 14px;background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;border-radius:6px;margin:0 0 20px"><p style="margin:0;font-size:13px;color:#fcd34d;font-weight:600">ES Prediction</p><p style="margin:4px 0 0;font-size:13px;color:${BRAND.textSecondary}">${esPrediction}</p></div>` : ""}
    ${infographicHtml}
    ${eveningSummaryHtml}
    ${briefHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:10px 24px">
        <a href="https://timed-trading.com/daily-brief.html" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block">View Full Brief</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: esPrediction || `${label} for ${date}` });

  const text = `${label} — ${date}\n\n${esPrediction ? `ES Prediction: ${esPrediction}\n\n` : ""}${content}\n\nView online: https://timed-trading.com/daily-brief.html`;

  return sendEmail(env, { to: userEmail, subject: `${label} — ${date}`, html, text, category: "daily_brief" });
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

export async function sendTradeAlertEmail(env, userEmail, alert) {
  const { type, ticker, direction, price, rank, rr, pnlPct, exitReason, status, mode } = alert;
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, "trade_alerts", env.EMAIL_HMAC_SECRET)
    : null;

  const isEntry = type === "TRADE_ENTRY";
  const isExit = type === "TRADE_EXIT";
  const isTrim = type === "TRADE_TRIM";

  const dir = String(direction || "").toUpperCase();
  const dirColor = dir === "LONG" ? "#10b981" : dir === "SHORT" ? "#f43f5e" : BRAND.textSecondary;
  const scopeLabel = String(mode || "").toLowerCase() === "investor" ? "Investor " : "";
  const typeLabel = `${scopeLabel}${isEntry ? "New Entry" : isExit ? "Position Closed" : "Position Trimmed"}`;
  const priceFmt = Number(price) > 0 ? `$${Number(price).toFixed(2)}` : "N/A";

  let detailRows = "";
  if (isEntry) {
    detailRows = `
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Direction</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:${dirColor};text-align:right">${dir}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Entry Price</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${priceFmt}</td></tr>
      ${rank ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Rank</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${rank}</td></tr>` : ""}
      ${rr ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Risk:Reward</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${Number(rr).toFixed(1)}</td></tr>` : ""}
    `;
  } else if (isExit) {
    const pnlColor = Number(pnlPct) >= 0 ? "#10b981" : "#f43f5e";
    detailRows = `
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Direction</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:${dirColor};text-align:right">${dir}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Exit Price</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${priceFmt}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">P&amp;L</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:${pnlColor};text-align:right">${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct || 0).toFixed(1)}%</td></tr>
      ${exitReason ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Reason</td><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};text-align:right">${humanizeEmailExitReason(exitReason)}</td></tr>` : ""}
    `;
  } else if (isTrim) {
    detailRows = `
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Direction</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:${dirColor};text-align:right">${dir}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Price</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${priceFmt}</td></tr>
      ${alert.trimmedPct != null ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Trimmed To</td><td style="padding:6px 0;font-size:13px;color:white;text-align:right">${alert.trimmedPct}%</td></tr>` : ""}
    `;
  }

  const html = emailLayout(`
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:white">${typeLabel}: ${ticker}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:${BRAND.textMuted}">${new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND.border}">
      ${detailRows}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:10px 24px">
        <a href="https://timed-trading.com/index-react.html?ticker=${ticker}" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block">View in Dashboard</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: `${typeLabel}: ${ticker} ${dir} @ ${priceFmt}` });

  const text = `${typeLabel}: ${ticker}\n${dir} @ ${priceFmt}${isExit && pnlPct != null ? ` (P&L: ${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct).toFixed(1)}%)` : ""}\n\nView: https://timed-trading.com/index-react.html?ticker=${ticker}`;

  return sendEmail(env, { to: userEmail, subject: `${typeLabel}: ${ticker} ${dir}`, html, text, category: "trade_alert" });
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
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">See What is Happening Now</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: `${tradeCount || "Several"} trades managed while you were away.${pnlPositive ? ` P&L: +$${Math.abs(Number(totalPnl)).toFixed(0)}` : ""}` });

  const text = `The system has been working while you were away (${daysSince || "?"} days):\n${tradeCount ? `- ${tradeCount} trades managed\n` : ""}${winRate ? `- ${Number(winRate).toFixed(0)}% win rate\n` : ""}${pnlPositive ? `- +$${Math.abs(Number(totalPnl)).toFixed(0)} total P&L\n` : ""}${activePositions ? `- ${activePositions} active positions right now\n` : ""}${briefCount ? `- ${briefCount} daily briefs published\n` : ""}\nSee what is happening: https://timed-trading.com/index-react.html`;

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
<p>You can re-enable email notifications anytime from your <a href="https://timed-trading.com/index-react.html">dashboard settings</a>.</p>
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
};

const DEFAULT_PREFS_FREE = {
  daily_brief_morning: false,
  daily_brief_evening: false,
  trade_alerts: false,
  weekly_digest: false,
  re_engagement: true,
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
