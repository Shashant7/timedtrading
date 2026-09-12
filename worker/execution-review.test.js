import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judgePassCondition,
  buildReviewFromInputs,
  renderReviewHtml,
  renderReviewText,
  runWeeklyExecutionReview,
  overlayLiveCoverage,
  PASS_CONDITION,
  EXECUTION_CHANGES_TS,
  REVIEW_KV_LATEST,
  REVIEW_KV_HISTORY,
} from "./execution-review.js";
import { COVERAGE_SNAPSHOT_KEY } from "./mirror-coverage.js";

const H = 3600000;
// 2026-09-08 14:00Z = 10:00 ET Monday, the first session after the changes.
const MON = Date.UTC(2026, 8, 8, 14, 0, 0);

function trade(i, { pnl, mfe = Math.max(pnl, 0), entry = MON + i * H, hold = 3 * H, path = null, dir = "LONG" }) {
  return {
    ticker: `T${i}`, direction: dir, status: "CLOSED", entry_ts: entry, exit_ts: entry + hold,
    pnl_pct: pnl, max_favorable_excursion: mfe, entry_path: path, exit_reason: "x", entry_price: 100,
  };
}

function coreSet(n, pnlFor) {
  return Array.from({ length: n }, (_, i) => trade(i, { pnl: pnlFor(i), entry: MON + (i % 3) * H + Math.floor(i / 3) * 24 * H }));
}

describe("judgePassCondition", () => {
  it("is insufficient below the closed-trade floor", () => {
    const rows = coreSet(10, (i) => (i % 2 ? 1.2 : -0.8));
    const review = buildReviewFromInputs({ now: MON + 5 * 24 * H, sinceRows: rows });
    expect(review.verdict.status).toBe("insufficient");
    expect(review.verdict.closed_n).toBe(10);
    expect(review.verdict.checks[0].target).toBe(`>= ${PASS_CONDITION.min_closed}`);
  });

  it("passes when core is positive, win rate clears 40% and the afternoon is not the loss", () => {
    const rows = coreSet(36, (i) => (i % 2 ? 1.5 : -0.6));
    const review = buildReviewFromInputs({ now: MON + 12 * 24 * H, sinceRows: rows });
    expect(review.verdict.status).toBe("pass");
    expect(review.verdict.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails when the core sum is negative even with enough trades", () => {
    const rows = coreSet(36, (i) => (i % 4 === 0 ? 0.5 : -0.9));
    const g = buildReviewFromInputs({ now: MON + 12 * 24 * H, sinceRows: rows });
    expect(g.verdict.status).toBe("fail");
    const sum = g.verdict.checks.find((c) => c.name === "core sum");
    expect(sum.ok).toBe(false);
  });

  it("family LONG check is vacuous when there are no family trades", () => {
    const v = judgePassCondition({ trades: { closed: 40 }, baseline: { core: { n: 40, win_rate_pct: 55, sum_pct: 12 } }, core: { by_entry_hour_et: {} }, family: { by_direction: { LONG: { n: 0 } } } });
    expect(v.status).toBe("pass");
  });
});

describe("buildReviewFromInputs", () => {
  it("labels the week, stamps the change date and carries the options desk + knobs through", () => {
    const review = buildReviewFromInputs({
      now: MON,
      weekRows: coreSet(3, () => 1),
      tickets: { open: 1, closed_n: 2, win_rate_pct: 50, median_pnl_pct: 4, exit_reasons: { take_3x: 1 }, mirror: { enabled: false, reason: "graded_2_of_20" } },
      intents: { placed: 3, pending: 1 },
      knobs: { deep_audit_max_daily_entries: "6" },
    });
    expect(review.ok).toBe(true);
    expect(review.changes_since).toBe("2026-09-04");
    expect(review.label).toMatch(/^Week ending Sep 8, 2026$/);
    expect(review.week.trades.closed).toBe(3);
    expect(review.options_desk.mirror.reason).toBe("graded_2_of_20");
    expect(review.broker_intents.placed).toBe(3);
    expect(review.knobs.deep_audit_max_daily_entries).toBe("6");
    expect(review.broker_coverage).toBe(null);
    expect(EXECUTION_CHANGES_TS).toBe(Date.UTC(2026, 8, 4, 4, 0, 0));
  });

  it("carries the coverage desk snapshot through", () => {
    const review = buildReviewFromInputs({
      now: MON,
      broker_coverage: { actions: 4, mirrored: 4, unmatched: 0, pending_intent: 0, rejected_terminal: 0, fails: 0, healthy: true, quiet: false, sample: [] },
    });
    expect(review.broker_coverage.healthy).toBe(true);
    expect(review.broker_coverage.actions).toBe(4);
  });

  it("includes Sep 4 RTH entries in the since-changes cohort", () => {
    // 2026-09-04 15:11 ET (EDT) — first Cloud Pivot cluster (ULTA/TJX/ETN).
    const sep4Rth = Date.UTC(2026, 8, 4, 19, 11, 0);
    expect(sep4Rth).toBeGreaterThanOrEqual(EXECUTION_CHANGES_TS);
    const rows = [trade(0, { pnl: 1.2, entry: sep4Rth })];
    const review = buildReviewFromInputs({ now: MON, sinceRows: rows });
    expect(review.since_changes.trades.closed).toBe(1);
    expect(review.verdict.closed_n).toBe(1);
  });

  it("renders n=0 instead of a bare n/a when the since-changes core is empty", () => {
    const v = judgePassCondition({
      trades: { closed: 0 },
      baseline: { core: { n: 0 } },
      core: { by_entry_hour_et: {} },
      family: { by_direction: { LONG: { n: 0 } } },
    });
    expect(v.checks.find((c) => c.name === "core win rate").value).toBe("n=0");
    expect(v.checks.find((c) => c.name === "core sum").value).toBe("n=0");
    expect(v.checks.find((c) => c.name === "family LONG win rate").value).toBe("n=0");
    expect(v.checks.find((c) => c.name === "AM vs PM core sum").value).toBe("am 0pp / pm 0pp");
  });
});

describe("renderReviewHtml", () => {
  it("uses the dark branded emailLayout with coverage and no second person", () => {
    const review = buildReviewFromInputs({
      now: MON,
      sinceRows: coreSet(36, (i) => (i % 2 ? 1.5 : -0.6)),
      knobs: { k: "1" },
      broker_coverage: {
        actions: 3, mirrored: 2, unmatched: 1, pending_intent: 0, rejected_terminal: 0,
        fails: 1, healthy: false, quiet: false,
        sample: [{ ticker: "TWLO", lane: "trader", event: "ENTRY", reason: "never_attempted" }],
      },
    });
    const html = renderReviewHtml(review);
    expect(html).toContain("logo-discord.png");
    expect(html).toContain("#0b0e11");
    expect(html).toContain("Georgia");
    expect(html).toContain("PASS");
    expect(html).toContain("core win rate");
    expect(html).toContain("Model vs broker");
    expect(html).toContain("TWLO");
    expect(html).toContain("never_attempted");
    expect(html).toContain("Open Execution Review");
    expect(html).toContain("Market data powered by Twelve Data");
    expect(html).not.toContain("font-family:Inter,Arial");
    expect(html).not.toMatch(/\byou\b|\byour\b/i);
    const text = renderReviewText(review);
    expect(text).toContain("Broker coverage:");
    expect(text).toContain("TWLO");
  });
});

describe("runWeeklyExecutionReview", () => {
  function fakeEnv(rows) {
    const kv = new Map();
    const db = {
      prepare(sql) {
        return {
          bind: () => ({
            all: async () => {
              if (/FROM trades/.test(sql)) return { results: rows };
              return { results: [] };
            },
            run: async () => ({}),
          }),
          all: async () => ({ results: [] }),
          run: async () => ({}),
        };
      },
    };
    return {
      env: {
        DB: db,
        ADMIN_EMAIL: "ops@example.com",
        KV_TIMED: {
          put: async (k, v) => { kv.set(k, v); },
          get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
        },
      },
      kv,
    };
  }

  it("stores latest + history, emails the operator, and posts one Discord line", async () => {
    const { env, kv } = fakeEnv(coreSet(4, () => 1));
    const sent = [];
    const embeds = [];
    const out = await runWeeklyExecutionReview(env, {
      now: MON,
      sendEmail: async (_env, msg) => { sent.push(msg); return { ok: true }; },
      notify: async (e) => { embeds.push(e); },
    });
    expect(out.stored).toBe(true);
    expect(JSON.parse(kv.get(REVIEW_KV_LATEST)).label).toBe(out.review.label);
    const hist = JSON.parse(kv.get(REVIEW_KV_HISTORY));
    expect(hist).toHaveLength(1);
    expect(hist[0].status).toBe("insufficient");
    expect(out.email).toEqual({ sent: true, reason: null, to: "ops@example.com" });
    expect(sent[0].subject).toMatch(/^Execution review — Week ending Sep 8, 2026 — INSUFFICIENT$/);
    expect(sent[0].category).toBe("execution_review");
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toContain("EXECUTION REVIEW");
    expect(embeds[0].description).toMatch(/Broker:/);
    expect(sent[0].html).toContain("logo-discord.png");
    expect(sent[0].text).toContain("Broker coverage:");
  });

  it("overlayLiveCoverage stamps the latest snapshot onto a stored review", async () => {
    const { env } = fakeEnv([]);
    await env.KV_TIMED.put(COVERAGE_SNAPSHOT_KEY, JSON.stringify({
      ts: MON,
      summary: { actions: 2, mirrored: 2, unmatched: 0, pending_intent: 0, rejected_terminal: 0, fails: 0 },
      anomalies: [],
    }));
    const over = await overlayLiveCoverage(env, { ok: true, label: "stored" });
    expect(over.broker_coverage.healthy).toBe(true);
    expect(over.broker_coverage.actions).toBe(2);
  });

  it("reports a missing operator address instead of throwing", async () => {
    const { env } = fakeEnv([]);
    delete env.ADMIN_EMAIL;
    const out = await runWeeklyExecutionReview(env, { now: MON, sendEmail: async () => ({ ok: true }) });
    expect(out.email).toEqual({ sent: false, reason: "no_operator_email" });
  });

  it("keeps the history capped at 12 entries, newest first", async () => {
    const { env, kv } = fakeEnv([]);
    for (let i = 0; i < 14; i += 1) {
      await runWeeklyExecutionReview(env, { now: MON + i * 7 * 24 * H });
    }
    const hist = JSON.parse(kv.get(REVIEW_KV_HISTORY));
    expect(hist).toHaveLength(12);
    expect(hist[0].generated_at).toBeGreaterThan(hist[1].generated_at);
  });
});

describe("execution-review page", () => {
  it("renders a Model vs broker card from the live snapshot", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../react-app/execution-review.html"), "utf8");
    expect(src).toContain("Model vs broker");
    expect(src).toContain("broker_coverage");
    expect(src).toContain("one clean confirmation per NY day");
  });
});
