// worker/discovery/screener-runner.js
//
// Worker-native screener runner + GitHub Actions dispatch for modes that
// still depend on tvscreener (daily momentum, top movers). Weekly scan
// runs inline via Finnhub screener + TwelveData daily bars so admins can
// trigger it from the Screener UI without a terminal.

import { tdFetchTimeSeries } from "../twelvedata.js";

const FINNHUB_SCREENER = "https://finnhub.io/api/v1/stock/screener";
export const SCREENER_RUN_STATUS_KEY = "timed:screener:run_status";
const SCREENER_KV_KEY = "timed:screener:candidates";

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getScreenerRunStatus(env) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return null;
  try {
    const raw = await KV.get(SCREENER_RUN_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setScreenerRunStatus(env, status) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return;
  await KV.put(SCREENER_RUN_STATUS_KEY, JSON.stringify({
    ...status,
    updated_at: new Date().toISOString(),
  }), { expirationTtl: 86400 });
}

/**
 * Merge new candidates into KV using the same 7-day dedup rules as
 * POST /timed/screener/candidates.
 */
export async function mergeScreenerCandidates(env, newCandidates, scanTs = null) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { ok: false, error: "no_kv" };
  if (!Array.isArray(newCandidates)) return { ok: false, error: "candidates_required" };

  const existing = await KV.get(SCREENER_KV_KEY);
  const prev = existing ? JSON.parse(existing) : { candidates: [] };
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const seen = new Set();
  const merged = [];

  for (const c of [...newCandidates, ...(prev.candidates || [])]) {
    const ticker = String(c?.ticker || "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    if (c.discovered_at && c.discovered_at < sevenDaysAgo) continue;
    seen.add(ticker);
    merged.push({ ...c, ticker });
  }

  const payload = {
    candidates: merged.slice(0, 500),
    scan_ts: scanTs || new Date().toISOString(),
    count: merged.length,
    last_updated: new Date().toISOString(),
  };

  await KV.put(SCREENER_KV_KEY, JSON.stringify(payload), { expirationTtl: 7 * 86400 });
  return {
    ok: true,
    stored: payload.candidates.length,
    new: newCandidates.length,
    scan_ts: payload.scan_ts,
  };
}

async function loadInUniverseSet() {
  const SectorMap = await import("../sector-mapping.js");
  return new Set(Object.keys(SectorMap.SECTOR_MAP).map((s) => s.toUpperCase()));
}

async function finnhubScreener(env, opts = {}) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return { ok: false, error: "finnhub_not_configured", rows: [] };

  const params = new URLSearchParams({
    exchange: "US",
    market_cap_more_than: String(opts.marketCapMin || 2_000_000_000),
    price_more_than: String(opts.priceMin || 10),
    volume_more_than: String(opts.volumeMin || 300_000),
    token,
  });

  try {
    const resp = await fetch(`${FINNHUB_SCREENER}?${params}`, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) {
      return { ok: false, error: `finnhub_http_${resp.status}`, rows: [] };
    }
    const data = await resp.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), rows: [] };
  }
}

function weekChangeFromDailyBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const sorted = [...bars].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  const last = sorted[sorted.length - 1];
  const refIdx = Math.max(0, sorted.length - 6);
  const ref = sorted[refIdx];
  const lastClose = num(last?.c);
  const refClose = num(ref?.c);
  if (!lastClose || !refClose || refClose <= 0) return null;
  return Math.round(((lastClose - refClose) / refClose) * 10000) / 100;
}

/**
 * Worker-native weekly momentum scan (8%+ over ~5 sessions).
 * Mirrors scripts/discover-tickers.py --weekly scan_type.
 */
export async function runWeeklyScreenerScan(env, opts = {}) {
  const t0 = Date.now();
  const minWeekChange = num(opts.minWeekChange, 8);
  const limit = Math.max(10, Math.min(100, num(opts.limit, 100) || 100));

  const inUniverse = await loadInUniverseSet();
  const screen = await finnhubScreener(env, opts);
  if (!screen.ok) return { ok: false, error: screen.error || "finnhub_screener_failed" };

  let pool = (screen.rows || [])
    .map((r) => ({
      ticker: String(r.symbol || r.ticker || "").toUpperCase(),
      market_cap: num(r.marketCapitalization) || num(r.market_cap),
      price: num(r.price) || num(r.lastPrice),
      volume: num(r.volume),
      name: r.name || r.description || null,
      sector: r.finnhubIndustry || r.sector || null,
    }))
    .filter((r) => r.ticker && !inUniverse.has(r.ticker));

  pool.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
  pool = pool.slice(0, limit);

  if (pool.length === 0) {
    return { ok: true, mode: "weekly", candidates: 0, elapsed_ms: Date.now() - t0, message: "no_pool" };
  }

  const symbols = pool.map((p) => p.ticker);
  const tsRes = await tdFetchTimeSeries(env, symbols, "1day", null, null, 8);
  const barsBySym = tsRes?.bars || {};

  const candidates = [];
  for (const row of pool) {
    const weekPct = weekChangeFromDailyBars(barsBySym[row.ticker]);
    if (weekPct == null || weekPct < minWeekChange) continue;
    const bars = barsBySym[row.ticker] || [];
    const lastBar = bars.length ? [...bars].sort((a, b) => new Date(a.t) - new Date(b.t)).at(-1) : null;
    candidates.push({
      ticker: row.ticker,
      scan_type: "weekly_momentum",
      discovered_at: new Date().toISOString(),
      price: num(lastBar?.c, row.price) || row.price || null,
      change_pct: weekPct,
      week_change_pct: weekPct,
      volume: num(lastBar?.v, row.volume) || row.volume || null,
      market_cap: row.market_cap || null,
      sector: row.sector || null,
      name: row.name || row.ticker,
    });
  }

  candidates.sort((a, b) => (b.week_change_pct || 0) - (a.week_change_pct || 0));

  const scanTs = new Date().toISOString();
  const mergeRes = await mergeScreenerCandidates(env, candidates, scanTs);

  return {
    ok: mergeRes.ok,
    mode: "weekly",
    candidates: candidates.length,
    stored: mergeRes.stored,
    scan_ts: scanTs,
    elapsed_ms: Date.now() - t0,
    error: mergeRes.error,
  };
}

/** Normalize owner/repo from GITHUB_REPO (accepts URL or bare slug). */
export function normalizeGithubRepo(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function githubActionsHint(status) {
  if (status === 403) {
    return "GitHub PAT needs Actions: Read and write on the repo (fine-grained token: Repository permissions → Actions). "
      + "Authorize SSO if the repo is org-owned. Set secrets on the production worker: "
      + "wrangler secret put GITHUB_TOKEN --env production";
  }
  if (status === 404) {
    return "Workflow screener-daily.yml not found on main, or GITHUB_REPO is wrong (use owner/repo, e.g. Shashant7/timedtrading).";
  }
  return null;
}

async function parseGithubErrorBody(text, status) {
  let message = String(text || "").slice(0, 300) || `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    message = j.message || j.error || message;
  } catch (_) { /* plain text */ }
  return message;
}

/**
 * Resolve workflow dispatch URL — try filename first, then list workflows.
 */
async function resolveWorkflowDispatchUrl(token, owner, name) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const filePath = "screener-daily.yml";
  const direct = `https://api.github.com/repos/${owner}/${name}/actions/workflows/${filePath}/dispatches`;

  try {
    const probe = await fetch(direct.replace("/dispatches", ""), {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (probe.ok) return direct;
  } catch (_) { /* fall through */ }

  try {
    const listUrl = `https://api.github.com/repos/${owner}/${name}/actions/workflows?per_page=100`;
    const listResp = await fetch(listUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (!listResp.ok) return direct;
    const data = await listResp.json();
    const workflows = Array.isArray(data?.workflows) ? data.workflows : [];
    const match = workflows.find((w) => (
      String(w.path || "").endsWith(filePath)
      || String(w.name || "").toLowerCase() === "screener daily scan"
    ));
    if (match?.id) {
      return `https://api.github.com/repos/${owner}/${name}/actions/workflows/${match.id}/dispatches`;
    }
  } catch (_) { /* use direct */ }

  return direct;
}

/**
 * Dispatch the GitHub Actions screener workflow (tvscreener path).
 * Requires GITHUB_TOKEN + GITHUB_REPO env vars on the worker.
 */
export async function triggerGithubScreenerWorkflow(env, mode = "all") {
  const token = env?.GITHUB_TOKEN || env?.GITHUB_PAT;
  const repo = normalizeGithubRepo(env?.GITHUB_REPO);
  if (!token || !repo) {
    return {
      ok: false,
      error: "github_not_configured",
      hint: "Set GITHUB_TOKEN (secret) and GITHUB_REPO (owner/repo) on the production worker",
    };
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return { ok: false, error: "invalid_github_repo", hint: "GITHUB_REPO must be owner/repo (e.g. Shashant7/timedtrading)" };
  }

  const url = await resolveWorkflowDispatchUrl(token, owner, name);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { mode: String(mode || "all") },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 204) {
      return { ok: true, dispatched: true, mode, repo };
    }
    const text = await resp.text().catch(() => "");
    const detail = await parseGithubErrorBody(text, resp.status);
    return {
      ok: false,
      error: `github_http_${resp.status}`,
      detail,
      repo,
      hint: githubActionsHint(resp.status),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Run a screener scan by mode.
 *   weekly       — inline worker scan (Finnhub + TwelveData)
 *   daily        — GitHub workflow (tvscreener)
 *   top_movers   — GitHub workflow
 *   all          — weekly inline + GitHub all (daily + movers + weekly backup)
 */
export async function runScreenerScan(env, mode = "weekly", opts = {}) {
  const normalized = String(mode || "weekly").toLowerCase();

  if (normalized === "weekly") {
    return runWeeklyScreenerScan(env, opts);
  }

  if (normalized === "all") {
    const weekly = await runWeeklyScreenerScan(env, opts);
    const gh = await triggerGithubScreenerWorkflow(env, "all");
    // Weekly scan runs inline and is the primary path; GitHub dispatch is
    // the tvscreener backup. Do not fail the whole scan when GitHub rejects.
    return {
      ok: weekly.ok,
      mode: "all",
      weekly,
      github: gh,
      github_warning: gh.ok ? null : (gh.hint || gh.detail || gh.error),
      candidates: weekly.candidates,
      stored: weekly.stored,
      scan_ts: weekly.scan_ts,
    };
  }

  return triggerGithubScreenerWorkflow(env, normalized);
}
