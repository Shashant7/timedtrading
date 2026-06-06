// worker/discovery/screener-runner.js
//
// Worker-native screener runner + GitHub Actions dispatch for modes that
// still depend on tvscreener (daily momentum, top movers). Weekly scan
// runs inline via TwelveData daily bars (pool from Finnhub screener when
// available, else TwelveData /stocks) so admins can trigger it from the UI.

import { tdFetchTimeSeries } from "../twelvedata.js";

const FINNHUB_SCREENER = "https://finnhub.io/api/v1/stock/screener";
export const SCREENER_RUN_STATUS_KEY = "timed:screener:run_status";
const SCREENER_KV_KEY = "timed:screener:candidates";

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Actionable hint for common screener failure codes. */
export function screenerErrorHint(error) {
  const e = String(error || "");
  if (!e) return null;
  if (e === "finnhub_not_configured") {
    return "FINNHUB_API_KEY is not set on the production worker.";
  }
  if (e === "no_kv") {
    return "KV_TIMED binding is missing on the worker (cannot store candidates).";
  }
  if (e === "missing_credentials") {
    return "TwelveData API key is missing on the worker.";
  }
  if (e.startsWith("finnhub_http_")) {
    return `Finnhub screener returned ${e.replace("finnhub_http_", "HTTP ")}.`;
  }
  if (e === "finnhub_screener_unavailable" || e === "finnhub_screener_redirect") {
    return "Finnhub /stock/screener is unavailable (returns HTML). Weekly scan falls back to TwelveData /stocks.";
  }
  if (e === "pool_unavailable") {
    return "Could not build a candidate pool from Finnhub or TwelveData.";
  }
  if (e === "screener_timeout") {
    return "Screener scan timed out in the background. Retry with a smaller limit or try again later.";
  }
  if (e === "non_json_response" || e === "json_parse_failed" || e.includes("Unexpected token '<'")) {
    return "Upstream data provider returned HTML instead of JSON. Retry in a minute.";
  }
  if (e === "github_not_configured") {
    return "Set GITHUB_TOKEN (secret) and GITHUB_REPO on the production worker.";
  }
  if (e.startsWith("github_http_")) {
    return `GitHub workflow dispatch failed (${e}). Check PAT Actions permissions.`;
  }
  return null;
}

/** Lift nested weekly/github errors to top-level fields for the UI. */
export function normalizeScreenerResult(result) {
  if (!result) return { ok: false, error: "empty_result", hint: "Screener returned no result." };
  if (result.ok) return result;
  const error = result.error
    || result.weekly?.error
    || result.github?.error
    || "screener_failed";
  const hint = result.hint
    || result.weekly?.hint
    || result.github?.hint
    || result.github?.detail
    || result.weekly?.detail
    || screenerErrorHint(error)
    || error;
  return { ...result, ok: false, error, hint };
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

/** True when a UI-triggered scan is still in flight (KV status running + fresh). */
export function isScreenerRunActive(status, maxAgeMs = 5 * 60 * 1000) {
  if (!status || status.status !== "running") return false;
  const started = Number(status.started_at) || 0;
  if (!started) return true;
  return (Date.now() - started) < maxAgeMs;
}

/**
 * Background scan wrapper — updates KV status and optionally rebuilds
 * the promotion queue after weekly/all modes complete.
 */
export async function executeScreenerRun(env, mode, opts = {}) {
  const normalized = String(mode || "weekly").toLowerCase();
  await setScreenerRunStatus(env, {
    status: "running",
    mode: normalized,
    started_at: Date.now(),
  });
  const scanTimeoutMs = Math.max(60000, Math.min(240000, Number(opts.timeoutMs) || 150000));
  try {
    const result = await Promise.race([
      runScreenerScan(env, normalized, opts),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("screener_timeout")), scanTimeoutMs);
      }),
    ]);
    if (result?.ok && (normalized === "weekly" || normalized === "all")) {
      try {
        const PromotionQueue = await import("./promotion-queue.js");
        await PromotionQueue.rebuildPromotionQueue(env);
      } catch (pqErr) {
        result.promotion_queue_rebuild = {
          ok: false,
          error: String(pqErr?.message || pqErr).slice(0, 200),
        };
      }
    }
    await setScreenerRunStatus(env, {
      status: result?.ok ? "completed" : "failed",
      mode: normalized,
      result,
      finished_at: Date.now(),
    });
    return result;
  } catch (e) {
    await setScreenerRunStatus(env, {
      status: "failed",
      mode: normalized,
      error: String(e?.message || e).slice(0, 300),
      finished_at: Date.now(),
    });
    throw e;
  }
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

async function parseResponseJson(resp) {
  const text = await resp.text().catch(() => "");
  if (!text || String(text).trim().startsWith("<")) {
    return {
      _parseError: "non_json_response",
      _detail: String(text).slice(0, 200),
    };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      _parseError: "json_parse_failed",
      _detail: String(e?.message || e).slice(0, 200),
    };
  }
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
    const resp = await fetch(`${FINNHUB_SCREENER}?${params}`, {
      signal: AbortSignal.timeout(20000),
      redirect: "manual",
    });
    if (resp.status >= 300 && resp.status < 400) {
      return { ok: false, error: "finnhub_screener_redirect", rows: [] };
    }
    if (!resp.ok) {
      return { ok: false, error: `finnhub_http_${resp.status}`, rows: [] };
    }
    const data = await parseResponseJson(resp);
    if (data._parseError) {
      return { ok: false, error: "finnhub_screener_unavailable", detail: data._detail, rows: [] };
    }
    const rows = Array.isArray(data?.data) ? data.data : [];
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), rows: [] };
  }
}

/** Reuse recent screener KV candidates as a fast pool for week-change refresh. */
export async function poolFromExistingCandidates(env, inUniverse, limit = 100) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { ok: false, error: "no_kv", rows: [] };
  try {
    const raw = await KV.get(SCREENER_KV_KEY);
    if (!raw) return { ok: false, error: "no_candidates", rows: [] };
    const parsed = JSON.parse(raw);
    const rows = (parsed?.candidates || [])
      .map((c) => ({
        symbol: String(c?.ticker || "").toUpperCase(),
        ticker: String(c?.ticker || "").toUpperCase(),
        name: c?.name || null,
        sector: c?.sector || null,
        market_cap: c?.market_cap || null,
        price: c?.price || null,
        volume: c?.volume || null,
      }))
      .filter((r) => r.ticker && !inUniverse.has(r.ticker))
      .slice(0, Math.min(80, Math.max(10, limit)));
    return { ok: rows.length > 0, rows, source: "kv_candidates" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), rows: [] };
  }
}

/** Fallback pool when Finnhub /stock/screener is unavailable. */
export async function poolFromFinnhubSymbols(env, inUniverse, limit = 100) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return { ok: false, error: "finnhub_not_configured", rows: [] };
  try {
    const resp = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${token}`, {
      signal: AbortSignal.timeout(25000),
      redirect: "follow",
    });
    if (!resp.ok) return { ok: false, error: `finnhub_http_${resp.status}`, rows: [] };
    const data = await parseResponseJson(resp);
    if (data._parseError || !Array.isArray(data)) {
      return { ok: false, error: "finnhub_symbol_list_failed", rows: [] };
    }
    const rows = [];
    for (const s of data) {
      if (rows.length >= Math.min(120, limit * 2)) break;
      const sym = String(s?.symbol || "").toUpperCase();
      if (!sym || sym.includes("/") || inUniverse.has(sym)) continue;
      if (String(s?.type || "") !== "Common Stock") continue;
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) continue;
      rows.push({
        symbol: sym,
        ticker: sym,
        name: s?.description || null,
        sector: null,
        market_cap: null,
        price: null,
        volume: null,
      });
    }
    return { ok: rows.length > 0, rows: rows.slice(0, limit), source: "finnhub_symbols" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), rows: [] };
  }
}

/** Resolve the weekly scan pool — Finnhub first, TwelveData /stocks fallback. */
export async function resolveWeeklyPool(env, opts = {}, inUniverse, limit = 100) {
  const fh = await finnhubScreener(env, opts);
  if (fh.ok && fh.rows?.length) {
    return { ok: true, rows: fh.rows, source: "finnhub" };
  }

  const kv = await poolFromExistingCandidates(env, inUniverse, limit);
  if (kv.ok && kv.rows?.length) {
    return {
      ok: true,
      rows: kv.rows,
      source: kv.source,
      fallback_reason: fh.error || "finnhub_empty",
    };
  }

  const sym = await poolFromFinnhubSymbols(env, inUniverse, limit);
  if (sym.ok && sym.rows?.length) {
    return {
      ok: true,
      rows: sym.rows,
      source: sym.source,
      fallback_reason: fh.error || kv.error || "finnhub_empty",
    };
  }

  return {
    ok: false,
    error: "pool_unavailable",
    hint: screenerErrorHint("pool_unavailable"),
    finnhub_error: fh.error || null,
    kv_error: kv.error || null,
    finnhub_symbols_error: sym.error || null,
    rows: [],
  };
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
  const screen = await resolveWeeklyPool(env, opts, inUniverse, limit);
  if (!screen.ok) {
    const error = screen.error || "pool_unavailable";
    return {
      ok: false,
      mode: "weekly",
      error,
      hint: screen.hint || screenerErrorHint(error),
      finnhub_error: screen.finnhub_error,
      kv_error: screen.kv_error,
      finnhub_symbols_error: screen.finnhub_symbols_error,
    };
  }

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
  const tsRes = await tdFetchTimeSeries(env, symbols, "1day", null, null, 8, {
    batchDelayMs: 2500,
    fetchTimeoutMs: 20000,
  });
  if (tsRes?.error) {
    const error = String(tsRes.error);
    return { ok: false, mode: "weekly", error, hint: screenerErrorHint(error) };
  }
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
  if (!mergeRes.ok) {
    const error = mergeRes.error || "kv_merge_failed";
    return {
      ok: false,
      mode: "weekly",
      candidates: candidates.length,
      error,
      hint: screenerErrorHint(error),
      elapsed_ms: Date.now() - t0,
    };
  }

  return normalizeScreenerResult({
    ok: true,
    mode: "weekly",
    candidates: candidates.length,
    stored: mergeRes.stored,
    scan_ts: scanTs,
    pool_source: screen.source || "unknown",
    pool_fallback_reason: screen.fallback_reason || null,
    elapsed_ms: Date.now() - t0,
  });
}

const GITHUB_USER_AGENT = "TimedTrading-Screener/1.0 (+https://timed-trading.com)";

function githubApiHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": GITHUB_USER_AGENT,
    ...extra,
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
  const headers = githubApiHeaders(token);
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
      headers: githubApiHeaders(token),
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
    return normalizeScreenerResult(await runWeeklyScreenerScan(env, opts));
  }

  if (normalized === "all") {
    const weekly = await runWeeklyScreenerScan(env, opts);
    const gh = await triggerGithubScreenerWorkflow(env, "all");
    // Weekly scan runs inline and is the primary path; GitHub dispatch is
    // the tvscreener backup. Do not fail the whole scan when GitHub rejects.
    return normalizeScreenerResult({
      ok: !!weekly.ok,
      mode: "all",
      weekly,
      github: gh,
      github_warning: gh.ok ? null : (gh.hint || gh.detail || gh.error),
      candidates: weekly.candidates,
      stored: weekly.stored,
      scan_ts: weekly.scan_ts,
      error: weekly.ok ? undefined : (weekly.error || "weekly_scan_failed"),
      hint: weekly.ok ? undefined : (weekly.hint || screenerErrorHint(weekly.error)),
    });
  }

  return normalizeScreenerResult(await triggerGithubScreenerWorkflow(env, normalized));
}
