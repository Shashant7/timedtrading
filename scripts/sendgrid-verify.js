#!/usr/bin/env node
/**
 * One-time script to satisfy SendGrid "Send your first email" verification.
 * Run: SENDGRID_API_KEY=your_key node scripts/sendgrid-verify.js your@email.com
 * Uses the same From address as the worker: notifications@timed-trading.com
 */
const apiKey = process.env.SENDGRID_API_KEY;
const to = process.argv[2] || process.env.TO_EMAIL || "test@example.com";

if (!apiKey) {
  console.error("Set SENDGRID_API_KEY and run: node scripts/sendgrid-verify.js your@email.com");
  process.exit(1);
}

const body = {
  personalizations: [{ to: [{ email: to }] }],
  from: { email: "notifications@timed-trading.com", name: "Timed Trading" },
  reply_to: { email: "support@timed-trading.com", name: "Timed Trading Support" },
  subject: "SendGrid verification — Timed Trading",
  content: [
    { type: "text/plain", value: "If you got this, SendGrid is working. You can click Next in the verification wizard." },
    { type: "text/html", value: "<p>If you got this, SendGrid is working. You can click <strong>Next</strong> in the verification wizard.</p>" },
  ],
};

fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
})
  .then((res) => {
    if (res.ok) {
      console.log("Email sent to", to, "- check your inbox and click Next in SendGrid.");
      return;
    }
    return res.text().then((t) => {
      console.error("SendGrid error:", res.status, t);
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
