#!/usr/bin/env node
const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading.com";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const TICKER = (process.env.TICKER || "SLV").trim().toUpperCase();
const START_DATE = process.env.START_DATE || "2025-07-01";
const END_DATE = process.env.END_DATE || "2025-07-11";

function* iterDays(startDate, endDate) {
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur <= end) {
    const day = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) yield day;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function post(url) {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(`request_failed ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function main() {
  const lockResp = await post(`${API_BASE}/timed/admin/replay-lock?reason=soft_fuse_cloud_trace&key=${encodeURIComponent(API_KEY)}`);
  const lock = lockResp.lock;
  const merged = [];
  let first = true;

  try {
    for (const day of iterDays(START_DATE, END_DATE)) {
      const params = new URLSearchParams({
        key: API_KEY,
        date: day,
        ticker: TICKER,
        debug: "1",
      });
      if (first) {
        params.set("cleanSlate", "1");
        first = false;
      }
      const data = await post(`${API_BASE}/timed/admin/replay-ticker?${params.toString()}`);
      for (const row of data.timeline || []) {
        merged.push({ date: day, ...row });
      }
    }

    const focused = merged.filter((row) => {
      const cloud = row.cloud_debug || {};
      const c15 = cloud.m15_c34_50 || {};
      const c30 = cloud.m30_c34_50 || {};
      const h1 = cloud.h1_c34_50 || {};
      return row.kanban_stage === "defend"
        || row.kanban_stage === "trim"
        || row.kanban_stage === "exit"
        || c15.mode === "expanding"
        || c15.mode === "compressing"
        || c30.mode === "expanding"
        || c30.mode === "compressing"
        || h1.mode === "expanding"
        || h1.mode === "compressing";
    });

    const out = {
      ok: true,
      ticker: TICKER,
      start_date: START_DATE,
      end_date: END_DATE,
      trace_count: focused.length,
      trace: focused.map((row) => ({
        date: row.date,
        ts: row.ts,
        iso: new Date(Number(row.ts)).toISOString(),
        price: row.price,
        stage: row.kanban_stage,
        prev_stage: row.prev_stage,
        state: row.state,
        htf_score: row.htf_score,
        ltf_score: row.ltf_score,
        cloud_debug: row.cloud_debug || null,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await fetch(`${API_BASE}/timed/admin/replay-lock?key=${encodeURIComponent(API_KEY)}`, { method: "DELETE" }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
