// worker/execution-review.js
//
// Weekly execution review (2026-09-04 NY). The self-grading loop from the
// execution-discipline plan, automated: every Friday 17:00 ET (the hourly
// cron slot, gated by ET day + hour) the system grades itself off the ledger (execution report card for the week, since
// the 2026-09-04 Cloud Pivot / execution-discipline cluster, and the 42-day
// pre-change baseline), the options desk report card, the broker intent
// ledger, live DA knobs, and the model-vs-broker coverage snapshot; judges
// the plan's pass condition; stores the result in KV; emails the operator
// on the shared dark emailLayout; posts a one-line Discord summary.
// GET /timed/admin/execution/review serves the latest to the Execution
// Review page.
//
// Cutoff is NY midnight 2026-09-04 (EDT = UTC-4), not UTC midnight Sep 5.
// The first cluster (ULTA/TJX/ETN/CAT) entered ~15:11 ET on Sep 4 — a
// UTC-midnight Sep 5 gate dropped them and the verdict card read n=0.
//
// Pure pieces (buildReviewFromInputs, judgePassCondition, renderReviewHtml)
// take data in; the I/O wrappers below load it.

import { gradeExecution } from "./execution-report-card.js";
import { convexityTicketReport } from "./convexity-tickets.js";
import { emailLayout } from "./email.js";
import {
  COVERAGE_SNAPSHOT_KEY,
  summarizeCoverageForDesk,
  coverageDeskHeadline,
  coverageDeskPlainLines,
  renderCoverageEmailBlock,
} from "./mirror-coverage.js";

// 2026-09-04 00:00 America/New_York (EDT, UTC-4).
export const EXECUTION_CHANGES_TS = Date.UTC(2026, 8, 4, 4, 0, 0);
export const REVIEW_KV_LATEST = "timed:execution:review:latest";
export const REVIEW_KV_HISTORY = "timed:execution:review:history";
export const REVIEW_HISTORY_MAX = 12;
const DAY_MS = 86400000;

export const PASS_CONDITION = Object.freeze({
  min_closed: 30,
  core_win_rate_pct: 40,
  core_sum_pct_gt: 0,
  family_long_win_rate_pct: 35,
});

/**
 * Pure. Judge the plan's pass condition against the since-changes grade.
 * @returns {{ status: "pass"|"fail"|"insufficient", checks: object[], closed_n: number }}
 */
export function judgePassCondition(sinceGrade) {
  const core = sinceGrade?.baseline?.core || { n: 0 };
  const famLong = sinceGrade?.family?.by_direction?.LONG || { n: 0 };
  const closedN = Number(sinceGrade?.trades?.closed) || 0;
  const afternoon = sinceGrade?.core?.by_entry_hour_et || {};
  const pmSum = ["12:00-14:00", "14:00-15:00", "15:00-16:00"]
    .reduce((a, k) => a + (Number(afternoon[k]?.sum_pct) || 0), 0);
  const amSum = ["09:30-10:30", "10:30-12:00"].reduce((a, k) => a + (Number(afternoon[k]?.sum_pct) || 0), 0);
  const rateOrEmpty = (slice) => (slice?.n ? (slice.win_rate_pct ?? null) : "n=0");
  const sumOrEmpty = (slice) => (slice?.n ? (slice.sum_pct ?? null) : "n=0");
  const checks = [
    { name: "closed trades since changes", value: closedN, target: `>= ${PASS_CONDITION.min_closed}`, ok: closedN >= PASS_CONDITION.min_closed },
    { name: "core win rate", value: rateOrEmpty(core), target: `>= ${PASS_CONDITION.core_win_rate_pct}%`, ok: (core.win_rate_pct ?? -1) >= PASS_CONDITION.core_win_rate_pct },
    { name: "core sum", value: sumOrEmpty(core), target: "> 0pp", ok: (core.sum_pct ?? -1) > PASS_CONDITION.core_sum_pct_gt },
    { name: "AM vs PM core sum", value: `am ${amSum}pp / pm ${pmSum}pp`, target: "pm >= am or pm >= 0", ok: pmSum >= 0 || pmSum >= amSum },
    { name: "family LONG win rate", value: rateOrEmpty(famLong), target: `>= ${PASS_CONDITION.family_long_win_rate_pct}%`, ok: famLong.n === 0 || (famLong.win_rate_pct ?? -1) >= PASS_CONDITION.family_long_win_rate_pct },
  ];
  const status = closedN < PASS_CONDITION.min_closed
    ? "insufficient"
    : (checks.every((c) => c.ok) ? "pass" : "fail");
  return { status, checks, closed_n: closedN };
}

/** Pure. Assemble the review from already-loaded inputs. */
export function buildReviewFromInputs({
  now = Date.now(),
  weekRows = [], sinceRows = [], baselineRows = [], candles = {},
  tickets = null, intents = null, knobs = {},
  broker_coverage = null,
} = {}) {
  const week = gradeExecution(weekRows, candles, { days: 7 });
  const since = gradeExecution(sinceRows, candles, { days: Math.max(1, Math.round((now - EXECUTION_CHANGES_TS) / DAY_MS)) });
  const baseline = gradeExecution(baselineRows, candles, { days: 42 });
  const verdict = judgePassCondition(since);
  const weekEnd = new Date(now);
  const label = `Week ending ${weekEnd.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })}`;
  return {
    ok: true,
    generated_at: now,
    label,
    changes_since: new Date(EXECUTION_CHANGES_TS).toISOString().slice(0, 10),
    verdict,
    week,
    since_changes: since,
    baseline_42d_pre_change: baseline,
    options_desk: tickets ? {
      open: tickets.open, closed_n: tickets.closed_n, win_rate_pct: tickets.win_rate_pct,
      median_pnl_pct: tickets.median_pnl_pct, exit_reasons: tickets.exit_reasons, mirror: tickets.mirror,
    } : null,
    broker_intents: intents,
    knobs,
    broker_coverage,
  };
}

function fmt(v, suffix = "") {
  if (v === null || v === undefined) return "n/a";
  return `${v}${suffix}`;
}

const FONT_UI = "'Helvetica Neue',Arial,sans-serif";
const FONT_EDITORIAL = "Georgia,'Iowan Old Style','Palatino Linotype',Palatino,serif";
const FONT_MONO = "'SF Mono',Menlo,Consolas,'Courier New',monospace";
const C_TEXT = "#e5e7eb";
const C_SECONDARY = "#9ca3af";
const C_MUTED = "#6b7280";
const C_BORDER = "#1e2128";
const C_GREEN = "#00c853";
const C_RED = "#ef4444";
const C_AMBER = "#f59e0b";
const REVIEW_PAGE_URL = "https://timed-trading.com/execution-review.html";

function summaryRow(label, s) {
  if (!s || !s.n) {
    return `<tr><td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};color:${C_SECONDARY};font-size:12px">${label}</td><td colspan="4" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};color:${C_MUTED};font-size:12px">n=0</td></tr>`;
  }
  const color = (s.sum_pct || 0) >= 0 ? C_GREEN : C_RED;
  return `<tr>
    <td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};color:${C_SECONDARY};font-size:12px">${label}</td>
    <td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-family:${FONT_MONO};font-size:12px;color:${C_TEXT}">${s.n}</td>
    <td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-family:${FONT_MONO};font-size:12px;color:${C_TEXT}">${fmt(s.win_rate_pct, "%")}</td>
    <td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-family:${FONT_MONO};font-size:12px;color:${color}">${fmt(s.sum_pct, "pp")}</td>
    <td style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-family:${FONT_MONO};font-size:12px;color:${C_TEXT}">${fmt(s.median_pct, "pp")}</td>
  </tr>`;
}

const TABLE_HEAD = `<tr>
  <th align="left" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C_MUTED}">slice</th>
  <th align="left" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C_MUTED}">n</th>
  <th align="left" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C_MUTED}">win</th>
  <th align="left" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C_MUTED}">sum</th>
  <th align="left" style="padding:6px 4px;border-bottom:1px solid ${C_BORDER};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C_MUTED}">median</th>
</tr>`;

function gradeBlock(grade, title) {
  const b = grade?.baseline || {};
  const hours = grade?.core?.by_entry_hour_et || {};
  return `
    <p style="margin:18px 0 8px;font-size:11px;font-weight:700;color:${C_MUTED};letter-spacing:0.08em;text-transform:uppercase;font-family:${FONT_UI}">${title}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${TABLE_HEAD}
      ${summaryRow("all", b.all)}${summaryRow("core", b.core)}${summaryRow("paper family", b.family)}
      ${Object.entries(hours).map(([k, s]) => summaryRow(`core ${k} ET`, s)).join("")}
      ${summaryRow("family LONG", grade?.family?.by_direction?.LONG)}${summaryRow("family SHORT", grade?.family?.by_direction?.SHORT)}
    </table>
    <p style="margin:8px 0 0;font-size:12px;color:${C_MUTED};line-height:1.5">MFE: ${grade?.mfe?.corrupt_n ?? 0} impossible peaks flagged; core winners closing under 40% of peak ${grade?.mfe?.giveback?.core?.closed_below_40pct ?? 0}/${grade?.mfe?.giveback?.core?.armed ?? 0}, family ${grade?.mfe?.giveback?.family?.closed_below_40pct ?? 0}/${grade?.mfe?.giveback?.family?.armed ?? 0}.</p>`;
}

/** Pure. Operator email via the shared dark emailLayout. No second person. */
export function renderReviewHtml(review, { baseUrl } = {}) {
  const v = review.verdict || {};
  const badge = v.status === "pass" ? C_GREEN : v.status === "fail" ? C_RED : C_AMBER;
  const badgeText = v.status === "pass" ? "PASS" : v.status === "fail" ? "FAIL" : `INSUFFICIENT (${v.closed_n} closed)`;
  const checks = (v.checks || []).map((c) =>
    `<tr>
      <td style="padding:4px 0;font-size:13px;color:${c.ok ? C_GREEN : C_RED};font-family:${FONT_UI}">${c.ok ? "ok" : "miss"}</td>
      <td style="padding:4px 8px;font-size:13px;color:${C_TEXT};font-family:${FONT_UI}">${c.name}: ${fmt(c.value)}</td>
      <td style="padding:4px 0;font-size:11px;color:${C_MUTED};font-family:${FONT_MONO};text-align:right">${c.target}</td>
    </tr>`).join("");
  const od = review.options_desk;
  const bi = review.broker_intents || {};
  const knobRows = Object.entries(review.knobs || {}).map(([k, val]) =>
    `<tr>
      <td style="padding:4px 0;font-size:12px;color:${C_SECONDARY};font-family:${FONT_MONO}">${k}</td>
      <td style="padding:4px 0;font-size:12px;color:${C_TEXT};font-family:${FONT_MONO};text-align:right">${fmt(val)}</td>
    </tr>`).join("");
  const pageUrl = `${String(baseUrl || "https://timed-trading.com").replace(/\/$/, "")}/execution-review.html`;
  const bodyHtml = `
    <h2 style="margin:0 0 4px;font-size:20px;color:${C_TEXT};font-family:${FONT_EDITORIAL}">Execution review</h2>
    <p style="margin:0 0 16px;color:${C_SECONDARY};font-size:13px;line-height:1.5">${review.label}. Model truth from the ledger. Changes graded from ${review.changes_since}.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">
      <tr><td style="padding:6px 12px;border-radius:6px;background:${badge};color:#fff;font-weight:700;font-size:12px;letter-spacing:0.06em;font-family:${FONT_UI}">${badgeText}</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">${checks}</table>
    ${renderCoverageEmailBlock(review.broker_coverage, { href: pageUrl, linkLabel: "Open Execution Review →" })}
    ${gradeBlock(review.week, "This week")}
    ${gradeBlock(review.since_changes, `Since changes (${review.changes_since})`)}
    ${gradeBlock(review.baseline_42d_pre_change, "Baseline: 42 days before the changes")}
    <p style="margin:18px 0 8px;font-size:11px;font-weight:700;color:${C_MUTED};letter-spacing:0.08em;text-transform:uppercase;font-family:${FONT_UI}">Options desk</p>
    <p style="margin:0;font-size:13px;color:${C_TEXT};line-height:1.5">${od ? `open ${od.open}, closed ${od.closed_n}, win ${fmt(od.win_rate_pct, "%")}, median ${fmt(od.median_pnl_pct, "%")}; broker mirror ${od.mirror?.enabled ? "ON" : "off"} (${od.mirror?.reason || ""})` : "no data"}</p>
    <p style="margin:18px 0 8px;font-size:11px;font-weight:700;color:${C_MUTED};letter-spacing:0.08em;text-transform:uppercase;font-family:${FONT_UI}">Broker intents (7d)</p>
    <p style="margin:0;font-size:13px;color:${C_TEXT};font-family:${FONT_MONO}">${Object.entries(bi).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}</p>
    <p style="margin:18px 0 8px;font-size:11px;font-weight:700;color:${C_MUTED};letter-spacing:0.08em;text-transform:uppercase;font-family:${FONT_UI}">Live knobs</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${knobRows || `<tr><td style="font-size:12px;color:${C_MUTED}">defaults in force</td></tr>`}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${C_GREEN};border-radius:8px;padding:10px 24px">
        <a href="${pageUrl}" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block;font-family:${FONT_UI}">Open Execution Review</a>
      </td></tr>
    </table>
  `;
  return emailLayout(bodyHtml, {
    preheader: `Execution review — ${review.label} — ${badgeText}`,
  });
}

export function renderReviewText(review) {
  const v = review.verdict || {};
  const c = review.since_changes?.baseline?.core || {};
  return [
    `Execution review ${review.label}: ${String(v.status || "").toUpperCase()}`,
    `Since ${review.changes_since}: core n=${c.n ?? 0} win=${fmt(c.win_rate_pct, "%")} sum=${fmt(c.sum_pct, "pp")}`,
    coverageDeskPlainLines(review.broker_coverage),
    `Open Execution Review: ${REVIEW_PAGE_URL}`,
  ].join("\n");
}

// ─── I/O ────────────────────────────────────────────────────────────────

const TRADE_SELECT = `SELECT ticker, direction, status, entry_ts, exit_ts, pnl_pct, max_favorable_excursion,
  entry_path, exit_reason, entry_price FROM trades WHERE entry_ts >= ?1 AND entry_ts < ?2
  AND (run_id IS NULL OR run_id = '') ORDER BY entry_ts LIMIT 3000`;

export async function loadExecutionRows(env, fromTs, toTs = Number.MAX_SAFE_INTEGER) {
  const res = await env.DB.prepare(TRADE_SELECT).bind(fromTs, toTs).all();
  return res?.results || [];
}

export async function loadDailyCandles(env, tickers, sinceTs) {
  const list = [...new Set(tickers.map((t) => String(t || "").toUpperCase()))].filter(Boolean).slice(0, 400);
  const out = {};
  if (!list.length) return out;
  // D1 caps bound parameters per statement; chunk the IN list.
  for (let i = 0; i < list.length; i += 80) {
    const chunk = list.slice(i, i + 80);
    const marks = chunk.map(() => "?").join(",");
    const rows = (await env.DB.prepare(
      `SELECT ticker, ts, h, l FROM ticker_candles WHERE tf = 'D' AND ts >= ? AND ticker IN (${marks})`,
    ).bind(sinceTs - 3 * DAY_MS, ...chunk).all())?.results || [];
    for (const c of rows) (out[String(c.ticker).toUpperCase()] = out[String(c.ticker).toUpperCase()] || []).push(c);
  }
  return out;
}

const KNOB_KEYS = [
  "deep_audit_max_daily_entries",
  "deep_audit_late_day_entry_block_min",
  "deep_audit_mfe_ratchet_activation_pct",
  "deep_audit_mfe_ratchet_lock_frac",
  "deep_audit_paper_family_max_open",
  "deep_audit_paper_family_max_daily",
];

async function loadKnobs(env) {
  const out = {};
  try {
    const marks = KNOB_KEYS.map(() => "?").join(",");
    const rows = (await env.DB.prepare(
      `SELECT config_key, config_value FROM model_config WHERE config_key IN (${marks})`,
    ).bind(...KNOB_KEYS).all())?.results || [];
    for (const r of rows) out[r.config_key] = r.config_value;
  } catch (_) { /* best effort */ }
  return out;
}

async function loadIntentSummary(env, sinceTs) {
  try {
    const rows = (await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM broker_intents WHERE created_ts >= ? GROUP BY status`,
    ).bind(sinceTs).all())?.results || [];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n) || 0]));
  } catch (_) { return {}; }
}

async function loadCoverageDesk(env) {
  try {
    const snap = await env?.KV_TIMED?.get(COVERAGE_SNAPSHOT_KEY, "json");
    return summarizeCoverageForDesk(snap);
  } catch (_) {
    return summarizeCoverageForDesk(null);
  }
}

/** Overlay the live coverage snapshot onto a stored or freshly built review. */
export async function overlayLiveCoverage(env, review) {
  if (!review || typeof review !== "object") return review;
  return { ...review, broker_coverage: await loadCoverageDesk(env) };
}

export async function buildWeeklyExecutionReview(env, { now = Date.now() } = {}) {
  const baselineFrom = EXECUTION_CHANGES_TS - 42 * DAY_MS;
  const [weekRows, sinceRows, baselineRows, tickets, intents, knobs, broker_coverage] = await Promise.all([
    loadExecutionRows(env, now - 7 * DAY_MS),
    loadExecutionRows(env, EXECUTION_CHANGES_TS),
    loadExecutionRows(env, baselineFrom, EXECUTION_CHANGES_TS),
    convexityTicketReport(env, { days: 90, now }).catch(() => null),
    loadIntentSummary(env, now - 7 * DAY_MS),
    loadKnobs(env),
    loadCoverageDesk(env),
  ]);
  const tickers = [...weekRows, ...sinceRows, ...baselineRows].map((r) => r.ticker);
  const candles = await loadDailyCandles(env, tickers, baselineFrom).catch(() => ({}));
  return buildReviewFromInputs({ now, weekRows, sinceRows, baselineRows, candles, tickets, intents, knobs, broker_coverage });
}

/**
 * Build, persist, email, announce. Returns { review, email, stored }.
 * @param opts.sendEmail  function(env, {to, subject, html, text, category}) — injected
 * @param opts.notify     function(embed) — injected
 */
export async function runWeeklyExecutionReview(env, { now = Date.now(), sendEmail = null, notify = null, emailTo = null } = {}) {
  const review = await buildWeeklyExecutionReview(env, { now });
  let stored = false;
  try {
    await env.KV_TIMED.put(REVIEW_KV_LATEST, JSON.stringify(review));
    const prev = await env.KV_TIMED.get(REVIEW_KV_HISTORY, "json").catch(() => null);
    const hist = Array.isArray(prev) ? prev : [];
    hist.unshift({
      generated_at: review.generated_at, label: review.label, status: review.verdict.status,
      closed_n: review.verdict.closed_n,
      core_since: review.since_changes?.baseline?.core || null,
      week_all: review.week?.baseline?.all || null,
    });
    await env.KV_TIMED.put(REVIEW_KV_HISTORY, JSON.stringify(hist.slice(0, REVIEW_HISTORY_MAX)));
    stored = true;
  } catch (e) {
    console.warn("[EXEC REVIEW] store failed:", String(e?.message || e).slice(0, 160));
  }
  let email = { sent: false, reason: "not_requested" };
  const to = emailTo || env?.ADMIN_EMAIL || null;
  if (typeof sendEmail === "function") {
    if (!to) email = { sent: false, reason: "no_operator_email" };
    else {
      try {
        const r = await sendEmail(env, {
          to,
          subject: `Execution review — ${review.label} — ${review.verdict.status.toUpperCase()}`,
          html: renderReviewHtml(review),
          text: renderReviewText(review),
          category: "execution_review",
        });
        email = { sent: r?.ok === true, reason: r?.ok ? null : (r?.error || "send_failed"), to };
      } catch (e) {
        email = { sent: false, reason: String(e?.message || e).slice(0, 120), to };
      }
    }
  }
  if (typeof notify === "function") {
    const c = review.since_changes?.baseline?.core || {};
    try {
      await notify({
        title: `EXECUTION REVIEW · ${review.label} · ${review.verdict.status.toUpperCase()}`,
        description: [
          `Since ${review.changes_since}: core n=${c.n ?? 0} win=${fmt(c.win_rate_pct, "%")} sum=${fmt(c.sum_pct, "pp")}`,
          `This week: all n=${review.week?.baseline?.all?.n ?? 0} sum=${fmt(review.week?.baseline?.all?.sum_pct, "pp")}`,
          `Options desk: ${review.options_desk?.closed_n ?? 0} graded, mirror ${review.options_desk?.mirror?.enabled ? "ON" : "off"}`,
          `Broker: ${coverageDeskHeadline(review.broker_coverage)}`,
          email.sent ? `Email sent to operator` : `Email: ${email.reason}`,
        ].join("\n"),
        color: review.verdict.status === "pass" ? 0x30a46c : review.verdict.status === "fail" ? 0xe5484d : 0xf0a020,
      });
    } catch (_) { /* best effort */ }
  }
  return { review, email, stored };
}
