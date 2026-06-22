#!/usr/bin/env node
/**
 * Send the Webull Connect API partner registration email from partners@timed-trading.com.
 *
 * Prerequisites (see skills/partners-email.md):
 *   1. Cloudflare Email Routing: partners@ → operator inbox (for Webull replies)
 *   2. SendGrid domain auth verified for timed-trading.com
 *
 * Usage:
 *   SENDGRID_API_KEY=... node scripts/send-webull-registration.mjs
 *   SENDGRID_API_KEY=... node scripts/send-webull-registration.mjs --dry-run
 *   SENDGRID_API_KEY=... REDIRECT_URI=https://... node scripts/send-webull-registration.mjs
 */
const FROM_EMAIL = "partners@timed-trading.com";
const FROM_NAME = "Timed Trading Partnerships";
const REPLY_TO = FROM_EMAIL;
const TO_DEFAULT = "connect.api@webull-us.com";
const REDIRECT_DEFAULT =
  "https://tt-broker-bridge.shashant.workers.dev/bridge/webull/oauth/callback";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const apiKey = process.env.SENDGRID_API_KEY;
const to = process.env.TO_EMAIL || TO_DEFAULT;
const redirectUri = process.env.REDIRECT_URI || REDIRECT_DEFAULT;
const company = process.env.COMPANY_NAME || "Timed Trading";
const scope = process.env.WEBULL_SCOPE || "user:trade:wr";
const siteUrl = process.env.SITE_URL || "https://timed-trading.com";

if (!apiKey && !dryRun) {
  console.error(
    "Set SENDGRID_API_KEY, then run: node scripts/send-webull-registration.mjs\n" +
      "Use --dry-run to print the payload without sending."
  );
  process.exit(1);
}

const subject = `Webull Connect API registration — ${company}`;

const text = [
  "Hello Webull Connect API team,",
  "",
  `${company} is requesting Webull Connect API credentials for broker integration.`,
  "",
  "Company: Timed Trading",
  `Website: ${siteUrl}`,
  `OAuth redirect URI: ${redirectUri}`,
  `Requested scope: ${scope}`,
  "",
  "Use case:",
  "Timed Trading is an automated trading and portfolio platform. The integration will",
  "allow authorized operators to connect a Webull account via OAuth and mirror approved",
  "trade instructions through the Timed Trading broker bridge (review-before-place flow).",
  "",
  "Please reply to this address with UAT credentials and any onboarding steps.",
  "",
  "Thank you,",
  "Timed Trading",
  FROM_EMAIL,
].join("\n");

const html = `<!DOCTYPE html>
<html><body style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p>Hello Webull Connect API team,</p>
<p><strong>${company}</strong> is requesting Webull Connect API credentials for broker integration.</p>
<ul>
  <li><strong>Company:</strong> Timed Trading</li>
  <li><strong>Website:</strong> <a href="${siteUrl}">${siteUrl}</a></li>
  <li><strong>OAuth redirect URI:</strong> <code>${redirectUri}</code></li>
  <li><strong>Requested scope:</strong> <code>${scope}</code></li>
</ul>
<p><strong>Use case:</strong> Timed Trading is an automated trading and portfolio platform. The integration will allow authorized operators to connect a Webull account via OAuth and mirror approved trade instructions through the Timed Trading broker bridge (review-before-place flow).</p>
<p>Please reply to this address with UAT credentials and any onboarding steps.</p>
<p>Thank you,<br>Timed Trading<br><a href="mailto:${FROM_EMAIL}">${FROM_EMAIL}</a></p>
</body></html>`;

const body = {
  personalizations: [{ to: [{ email: to }] }],
  from: { email: FROM_EMAIL, name: FROM_NAME },
  reply_to: { email: REPLY_TO, name: FROM_NAME },
  subject,
  content: [
    { type: "text/plain", value: text },
    { type: "text/html", value: html },
  ],
  categories: ["webull-registration"],
};

if (dryRun) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    if (res.ok) {
      console.log(`Sent Webull registration email:`);
      console.log(`  From: ${FROM_EMAIL}`);
      console.log(`  To:   ${to}`);
      console.log(`  Reply-To: ${REPLY_TO} (Webull replies land here via Email Routing)`);
      return;
    }
    const errText = await res.text();
    console.error("SendGrid error:", res.status, errText);
    process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
