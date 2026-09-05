// worker/execution-review.js
//
// Weekly execution review (2026-09-05). The self-grading loop from the
// execution-discipline plan, automated: every Friday 17:00 ET (the hourly
// cron slot, gated by ET day + hour) the system grades itself off the ledger (execution report card for the week, since
// the 2026-09-05 changes, and the 42-day pre-change baseline), the options
// desk report card, the broker intent ledger, and the live DA knobs; judges
// the plan's pass condition; stores the result in KV; emails the operator;
// posts a one-line Discord summary. GET /timed/admin/execution/review serves
// the latest to the Execution Review page.
//
// Pure pieces (buildReviewFromInputs, judgePassCondition, renderReviewHtml)
// take data in; the I/O wrappers below load it.

import { gradeExecution } from "./execution-report-card.js";
import { convexityTicketReport } from "./convexity-tickets.js";

export const EXECUTION_CHANGES_TS = Date.UTC(2026, 8, 5); // 2026-09-05T00:00Z
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
  const checks = [
    { name: "closed trades since changes", value: closedN, target: `>= ${PASS_CONDITION.min_closed}`, ok: closedN >= PASS_CONDITION.min_closed },
    { name: "core win rate", value: core.win_rate_pct ?? null, target: `>= ${PASS_CONDITION.core_win_rate_pct}%`, ok: (core.win_rate_pct ?? -1) >= PASS_CONDITION.core_win_rate_pct },
    { name: "core sum", value: core.sum_pct ?? null, target: "> 0pp", ok: (core.sum_pct ?? -1) > PASS_CONDITION.core_sum_pct_gt },
    { name: "afternoon (12:00+) not the dominant loss", value: `am ${amSum}pp / pm ${pmSum}pp`, target: "pm >= am or pm >= 0", ok: pmSum >= 0 || pmSum >= amSum },
    { name: "family LONG win rate", value: famLong.win_rate_pct ?? null, target: `>= ${PASS_CONDITION.family_long_win_rate_pct}%`, ok: famLong.n === 0 || (famLong.win_rate_pct ?? -1) >= PASS_CONDITION.family_long_win_rate_pct },
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
  };
}

function fmt(v, suffix = "") {
  if (v === null || v === undefined) return "n/a";
  return `${v}${suffix}`;
}

function summaryRow(label, s) {
  if (!s || !s.n) return `<tr><td>${label}</td><td colspan="4" style="color:#888">n=0</td></tr>`;
  const color = (s.sum_pct || 0) >= 0 ? "#1f8f5f" : "#c0392b";
  return `<tr><td>${label}</td><td>${s.n}</td><td>${fmt(s.win_rate_pct, "%")}</td><td style="color:${color}">${fmt(s.sum_pct, "pp")}</td><td>${fmt(s.median_pct, "pp")}</td></tr>`;
}

const TABLE_HEAD = `<tr><th align="left">slice</th><th align="left">n</th><th align="left">win</th><th align="left">sum</th><th align="left">median</th></tr>`;

/** Pure. Operator email body. No second person (compliance copy rule). */
export function renderReviewHtml(review) {
  const v = review.verdict || {};
  const badge = v.status === "pass" ? "#1f8f5f" : v.status === "fail" ? "#c0392b" : "#b7791f";
  const badgeText = v.status === "pass" ? "PASS" : v.status === "fail" ? "FAIL" : `INSUFFICIENT (${v.closed_n} closed)`;
  const g = (grade, title) => {
    const b = grade?.baseline || {};
    const hours = grade?.core?.by_entry_hour_et || {};
    return `
      <h3 style="margin:18px 0 6px">${title}</h3>
      <table cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%">${TABLE_HEAD}
        ${summaryRow("all", b.all)}${summaryRow("core", b.core)}${summaryRow("paper family", b.family)}
        ${Object.entries(hours).map(([k, s]) => summaryRow(`core ${k} ET`, s)).join("")}
        ${summaryRow("family LONG", grade?.family?.by_direction?.LONG)}${summaryRow("family SHORT", grade?.family?.by_direction?.SHORT)}
      </table>
      <p style="font-size:12px;color:#666">MFE: ${grade?.mfe?.corrupt_n ?? 0} impossible peaks flagged; core winners closing under 40% of peak ${grade?.mfe?.giveback?.core?.closed_below_40pct ?? 0}/${grade?.mfe?.giveback?.core?.armed ?? 0}, family ${grade?.mfe?.giveback?.family?.closed_below_40pct ?? 0}/${grade?.mfe?.giveback?.family?.armed ?? 0}.</p>`;
  };
  const checks = (v.checks || []).map((c) =>
    `<li style="color:${c.ok ? "#1f8f5f" : "#c0392b"}">${c.ok ? "ok" : "miss"} — ${c.name}: ${fmt(c.value)} (target ${c.target})</li>`).join("");
  const od = review.options_desk;
  const bi = review.broker_intents || {};
  const knobs = Object.entries(review.knobs || {}).map(([k, val]) => `<li><code>${k}</code> = ${fmt(val)}</li>`).join("");
  return `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;color:#111;max-width:760px;margin:0 auto;padding:16px">
    <h2 style="margin:0 0 4px">Execution review — ${review.label}</h2>
    <p style="margin:0 0 12px;color:#555">Model truth from the ledger. Changes graded from ${review.changes_since}.</p>
    <div style="display:inline-block;padding:6px 12px;border-radius:6px;background:${badge};color:#fff;font-weight:700">${badgeText}</div>
    <ul style="font-size:13px">${checks}</ul>
    ${g(review.week, "This week")}
    ${g(review.since_changes, `Since changes (${review.changes_since})`)}
    ${g(review.baseline_42d_pre_change, "Baseline: 42 days before the changes")}
    <h3 style="margin:18px 0 6px">Options desk</h3>
    <p style="font-size:13px">${od ? `open ${od.open}, closed ${od.closed_n}, win ${fmt(od.win_rate_pct, "%")}, median ${fmt(od.median_pnl_pct, "%")}; broker mirror ${od.mirror?.enabled ? "ON" : "off"} (${od.mirror?.reason || ""})` : "no data"}</p>
    <h3 style="margin:18px 0 6px">Broker intents (7d)</h3>
    <p style="font-size:13px">${Object.entries(bi).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}</p>
    <h3 style="margin:18px 0 6px">Live knobs</h3>
    <ul style="font-size:13px">${knobs}</ul>
    <p style="font-size:11px;color:#888;margin-top:24px">Full detail: /execution-review.html. Market data powered by Twelve Data.</p>
  </body></html>`;
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

export async function buildWeeklyExecutionReview(env, { now = Date.now() } = {}) {
  const baselineFrom = EXECUTION_CHANGES_TS - 42 * DAY_MS;
  const [weekRows, sinceRows, baselineRows, tickets, intents, knobs] = await Promise.all([
    loadExecutionRows(env, now - 7 * DAY_MS),
    loadExecutionRows(env, EXECUTION_CHANGES_TS),
    loadExecutionRows(env, baselineFrom, EXECUTION_CHANGES_TS),
    convexityTicketReport(env, { days: 90, now }).catch(() => null),
    loadIntentSummary(env, now - 7 * DAY_MS),
    loadKnobs(env),
  ]);
  const tickers = [...weekRows, ...sinceRows, ...baselineRows].map((r) => r.ticker);
  const candles = await loadDailyCandles(env, tickers, baselineFrom).catch(() => ({}));
  return buildReviewFromInputs({ now, weekRows, sinceRows, baselineRows, candles, tickets, intents, knobs });
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
          text: `Execution review ${review.label}: ${review.verdict.status}; core since changes n=${review.since_changes?.baseline?.core?.n ?? 0}.`,
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
          email.sent ? `Email sent to operator` : `Email: ${email.reason}`,
        ].join("\n"),
        color: review.verdict.status === "pass" ? 0x30a46c : review.verdict.status === "fail" ? 0xe5484d : 0xf0a020,
      });
    } catch (_) { /* best effort */ }
  }
  return { review, email, stored };
}
