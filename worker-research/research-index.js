// ═══════════════════════════════════════════════════════════════════════════
// tt-research — standalone nightly research worker (P2 decomposition, Step 2 v1).
//
// Owns the 22:00 UTC research mega-batch (worker/research/nightly-batch.js):
// AI COO daily cycle, CRO/CTO full cycle, and the discovery batch — the
// heaviest CPU lanes in the system (the CRO full cycle alone is ~30-40
// CPU-seconds; calibration was once removed from the monolith for CPU
// overruns). On its own worker these lanes get their own CPU budget, so a
// research blowup can never starve scoring/stop-losses — and vice versa.
//
// CUTOVER CONTRACT (mirrors tt-feed):
//   1. Deploy this worker (cron fires but RESEARCH_ENABLED defaults "false"
//      → every tick no-ops in ~1ms).
//   2. Set secrets (see wrangler.toml header), then verify a manual run:
//      POST /research/run-once with X-API-Key.
//   3. Flip RESEARCH_ENABLED=true here, then RESEARCH_EXTERNAL=true on the
//      monolith (both envs). A one-night overlap = the same idempotent
//      daily jobs run twice (wasteful, not harmful); a gap = one missed
//      nightly batch. Rollback = unset both vars.
//
// Cross-worker calls: the COO calibration step dispatches admin routes via
// `env._selfDispatch` — here that maps onto the MAIN service binding
// (avoids the CF-1042 worker-to-worker loopback class entirely).
// ═══════════════════════════════════════════════════════════════════════════

import { runNightlyResearchBatch } from "../worker/research/nightly-batch.js";
import { kvGetJSON, kvPutJSON } from "../worker/storage.js";

function researchEnabled(env) {
  return String(env?.RESEARCH_ENABLED || "false").toLowerCase() === "true";
}

function installSelfDispatch(env) {
  const base = env.WORKER_URL || "https://timed-trading.com";
  env._selfDispatch = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (env.TIMED_API_KEY && !headers.has("X-API-Key")) headers.set("X-API-Key", env.TIMED_API_KEY);
    const req = new Request(`${base}${path}`, { ...init, headers });
    if (env.MAIN && typeof env.MAIN.fetch === "function") {
      return env.MAIN.fetch(req);
    }
    // Fallback (no service binding) — plain fetch through the custom domain.
    return fetch(req);
  };
}

async function runBatch(env, ctx) {
  if (env && !env.KV) env.KV = env.KV_TIMED;
  installSelfDispatch(env);
  runNightlyResearchBatch(env, ctx);
  try {
    await kvPutJSON(env.KV_TIMED, "timed:research:last_run", {
      ts: Date.now(),
      worker: "tt-research",
    });
  } catch (_) {}
}

export default {
  async scheduled(event, env, ctx) {
    if (!researchEnabled(env)) return; // cutover gate — see header runbook
    try {
      await runBatch(env, ctx);
    } catch (e) {
      console.error("[tt-research] nightly batch dispatch failed:", String(e?.message || e).slice(0, 300));
    }
  },

  async fetch(request, env, ctx) {
    if (env && !env.KV) env.KV = env.KV_TIMED;
    const url = new URL(request.url);

    if (url.pathname === "/research/health") {
      let lastRun = null;
      let croAgeHours = null;
      try {
        lastRun = await kvGetJSON(env.KV_TIMED, "timed:research:last_run");
      } catch (_) {}
      try {
        const cro = await kvGetJSON(env.KV_TIMED, "cro:daily_note:latest");
        const ts = Number(cro?.produced_at || cro?.generated_at);
        if (Number.isFinite(ts) && ts > 0) croAgeHours = Math.round((Date.now() - ts) / 3600000 * 10) / 10;
      } catch (_) {}
      return new Response(JSON.stringify({
        ok: true,
        worker: "tt-research",
        research_enabled: researchEnabled(env),
        last_run_ts: lastRun?.ts ?? null,
        last_run_age_hours: lastRun?.ts ? Math.round((Date.now() - lastRun.ts) / 3600000 * 10) / 10 : null,
        cro_note_age_hours: croAgeHours,
        main_binding: !!env.MAIN,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Manual one-shot batch for cutover verification — works while
    // RESEARCH_ENABLED=false by design (verify before flipping).
    if (url.pathname === "/research/run-once" && request.method === "POST") {
      const key = request.headers.get("X-API-Key") || "";
      if (!env.TIMED_API_KEY || key !== env.TIMED_API_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      try {
        await runBatch(env, ctx);
        return new Response(JSON.stringify({
          ok: true,
          dispatched: true,
          note: "Lanes run in waitUntil — watch wrangler tail / cron tombstones for per-lane results.",
        }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  },
};
