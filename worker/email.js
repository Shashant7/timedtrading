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
      <span style="color:white;font-size:16px;font-weight:bold">T</span>
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
  const html = emailLayout(`
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:white">Welcome to Timed Trading${name ? `, ${name}` : ""}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      You now have access to a professional-grade trading intelligence platform.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
      <tr>
        <td style="padding:12px 16px;background:rgba(0,200,83,0.08);border-left:3px solid ${BRAND.green};border-radius:6px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:white">Here is what is ready for you:</p>
          <ul style="margin:0;padding:0 0 0 20px;font-size:13px;color:${BRAND.textSecondary};line-height:1.8">
            <li><strong style="color:white">Active Trader Dashboard</strong> — Real-time signals, Kanban board, and trade management</li>
            <li><strong style="color:white">Daily Brief</strong> — AI-generated morning and evening market analysis</li>
            <li><strong style="color:white">Investor Dashboard</strong> — Long-term position management with DCA automation</li>
            <li><strong style="color:white">System Intelligence</strong> — Calibration, model health, and performance tracking</li>
          </ul>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 24px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      Your Daily Brief emails will arrive each morning and evening on market days. Trade alerts notify you when the system enters, trims, or exits positions.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Open Dashboard</a>
      </td></tr>
    </table>
    <p style="margin:24px 0 0;font-size:13px;color:${BRAND.textMuted}">
      Questions? Reply to this email or reach us at <a href="mailto:support@timed-trading.com" style="color:${BRAND.textSecondary}">support@timed-trading.com</a>.
    </p>
  `, { preheader: "Welcome to Timed Trading — your trading intelligence platform is ready." });

  const text = `Welcome to Timed Trading, ${name}!\n\nYour account is set up and ready. Visit https://timed-trading.com/index-react.html to get started.\n\nYour Daily Brief emails arrive each market day morning and evening. Trade alerts notify you on entries, trims, and exits.\n\nQuestions? Reply to this email or contact support@timed-trading.com.`;

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
  const html = emailLayout(`
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:white">${isTrial ? "Your Free Trial Has Started" : "Subscription Confirmed"}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6">
      ${isTrial
        ? "You now have 30 days of full Pro access — no charge until the trial ends."
        : "Your Timed Trading Pro subscription is active. Thank you for subscribing."}
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      You have full access to all dashboards, the Daily Brief, trade alerts, and AI features.
      Manage your subscription anytime from your account settings.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Go to Dashboard</a>
      </td></tr>
    </table>
  `, { preheader: isTrial ? "Your 30-day free trial is active." : "Your Pro subscription is confirmed." });

  const text = isTrial
    ? "Your 30-day free trial of Timed Trading Pro has started. Visit https://timed-trading.com to get started."
    : "Your Timed Trading Pro subscription is active. Visit https://timed-trading.com to continue.";

  return sendEmail(env, { to: email, subject: isTrial ? "Your Free Trial Has Started" : "Subscription Confirmed", html, text, category: "subscription" });
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
  const { type, content, date, esPrediction } = brief;
  const label = type === "morning" ? "Morning Brief" : "Evening Brief";
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, `daily_brief_${type}`, env.EMAIL_HMAC_SECRET)
    : null;

  const briefHtml = markdownToEmailHtml(content);

  const html = emailLayout(`
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:white">${label}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:${BRAND.textMuted}">${date}</p>
    ${esPrediction ? `<div style="padding:10px 14px;background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;border-radius:6px;margin:0 0 20px"><p style="margin:0;font-size:13px;color:#fcd34d;font-weight:600">ES Prediction</p><p style="margin:4px 0 0;font-size:13px;color:${BRAND.textSecondary}">${esPrediction}</p></div>` : ""}
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

export async function sendTradeAlertEmail(env, userEmail, alert) {
  const { type, ticker, direction, price, rank, rr, pnlPct, exitReason, status } = alert;
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, "trade_alerts", env.EMAIL_HMAC_SECRET)
    : null;

  const isEntry = type === "TRADE_ENTRY";
  const isExit = type === "TRADE_EXIT";
  const isTrim = type === "TRADE_TRIM";

  const dir = String(direction || "").toUpperCase();
  const dirColor = dir === "LONG" ? "#10b981" : dir === "SHORT" ? "#f43f5e" : BRAND.textSecondary;
  const typeLabel = isEntry ? "New Entry" : isExit ? "Position Closed" : "Position Trimmed";
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
      ${exitReason ? `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textMuted}">Reason</td><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary};text-align:right">${exitReason}</td></tr>` : ""}
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
  const { daysSince, signalCount, tradeCount, briefCount } = stats || {};
  const baseUrl = env?.WORKER_URL || "https://timed-trading.com";
  const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
    ? await buildUnsubscribeUrl(baseUrl, userEmail, "re_engagement", env.EMAIL_HMAC_SECRET)
    : null;

  const html = emailLayout(`
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:white">Here is What You Missed</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textSecondary};line-height:1.6">
      It has been ${daysSince || "a while"} days since your last visit. The market does not sleep — here is a quick snapshot:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      ${signalCount ? `<tr><td style="padding:10px 16px;background:rgba(0,200,83,0.06);border-radius:8px;margin-bottom:8px"><span style="font-size:24px;font-weight:700;color:${BRAND.green}">${signalCount}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">trade signals fired</span></td></tr>` : ""}
      ${tradeCount ? `<tr><td style="padding:10px 16px;background:rgba(56,189,248,0.06);border-radius:8px;margin-top:8px"><span style="font-size:24px;font-weight:700;color:#38bdf8">${tradeCount}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">trades executed</span></td></tr>` : ""}
      ${briefCount ? `<tr><td style="padding:10px 16px;background:rgba(245,158,11,0.06);border-radius:8px;margin-top:8px"><span style="font-size:24px;font-weight:700;color:#f59e0b">${briefCount}</span><span style="font-size:13px;color:${BRAND.textSecondary};margin-left:8px">daily briefs published</span></td></tr>` : ""}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:12px 28px">
        <a href="https://timed-trading.com/index-react.html" style="color:white;font-size:14px;font-weight:600;text-decoration:none;display:inline-block">Catch Up Now</a>
      </td></tr>
    </table>
  `, { unsubscribeUrl, preheader: `${signalCount || "Several"} signals fired while you were away.` });

  const text = `Here is what you missed (${daysSince || "?"} days):\n${signalCount ? `- ${signalCount} trade signals\n` : ""}${tradeCount ? `- ${tradeCount} trades executed\n` : ""}${briefCount ? `- ${briefCount} daily briefs\n` : ""}\nCatch up: https://timed-trading.com/index-react.html`;

  return sendEmail(env, { to: userEmail, subject: "Here is what you missed on Timed Trading", html, text, category: "re_engagement" });
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
