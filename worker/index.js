// Timed Trading Worker — KV latest + trail + rank + top lists + Discord alerts (CORRIDOR-ONLY)
// Routes:
// POST /timed/ingest?key=...
// GET  /timed/all
// GET  /timed/latest?ticker=XYZ
// GET  /timed/tickers
// GET  /timed/trail?ticker=XYZ
// GET  /timed/top?bucket=long|short|setup&n=10
// GET  /timed/health

async function readBodyAsJSON(req) {
  const raw = await req.text();
  try { return { obj: JSON.parse(raw), raw, err: null }; }
  catch (e) { return { obj: null, raw, err: e }; }
}

const sendJSON = (obj, status=200, headers={}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type":"application/json", ...headers }
  });

function corsHeaders(env) {
  const origin = env.CORS_ALLOW_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function ackJSON(env, obj, fallbackStatus=200) {
  const always200 = (env.TV_ACK_ALWAYS_200 ?? "true") !== "false";
  return sendJSON(obj, always200 ? 200 : fallbackStatus, corsHeaders(env));
}

const normTicker = (t) => String(t||"").trim().toUpperCase();
const isNum = (x) => Number.isFinite(Number(x));

async function kvGetJSON(KV, key) {
  const t = await KV.get(key);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function kvPutJSON(KV, key, val, ttlSec=null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0) opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, JSON.stringify(val), opts);
}

async function kvPutText(KV, key, text, ttlSec=null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0) opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, text, opts);
}

function stableHash(str) {
  let h = 2166136261;
  for (let i=0;i<str.length;i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function ensureTickerIndex(KV, ticker) {
  const key = "timed:tickers";
  const cur = (await kvGetJSON(KV, key)) || [];
  if (!cur.includes(ticker)) {
    cur.push(ticker);
    cur.sort();
    await kvPutJSON(KV, key, cur);
  }
}

function marketType(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (t.endsWith("USDT") || t.endsWith("USD")) return "CRYPTO_24_7";
  if (t.endsWith("1!")) return "FUTURES_24_5";
  if (["DXY","US500","USOIL","GOLD","SILVER"].includes(t)) return "MACRO";
  return "EQUITY_RTH";
}

function minutesSince(ts) {
  if (!ts || typeof ts !== "number") return null;
  return (Date.now() - ts) / 60000;
}

function stalenessBucket(ticker, ts) {
  const mt = marketType(ticker);
  const age = minutesSince(ts);
  if (age == null) return { mt, bucket:"UNKNOWN", ageMin:null };

  const warn  = (mt === "EQUITY_RTH") ? 120 : (mt === "FUTURES_24_5") ? 60 : 30;
  const stale = (mt === "EQUITY_RTH") ? 480 : (mt === "FUTURES_24_5") ? 180 : 120;

  if (age <= warn) return { mt, bucket:"FRESH", ageMin:age };
  if (age <= stale) return { mt, bucket:"AGING", ageMin:age };
  return { mt, bucket:"STALE", ageMin:age };
}

function computeRR(d) {
  const price = Number(d.price);
  const sl = Number(d.sl);
  const tp = Number(d.tp);
  if (![price, sl, tp].every(Number.isFinite)) return null;
  const risk = Math.abs(price - sl);
  const gain = Math.abs(tp - price);
  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// ── Corridor helpers (must match UI corridors)
function inLongCorridor(d) {
  const h = Number(d.htf_score), l = Number(d.ltf_score);
  return Number.isFinite(h) && Number.isFinite(l) && (h > 0) && (l >= -8) && (l <= 12);
}
function inShortCorridor(d) {
  const h = Number(d.htf_score), l = Number(d.ltf_score);
  return Number.isFinite(h) && Number.isFinite(l) && (h < 0) && (l >= -12) && (l <= 8);
}
function corridorSide(d) {
  if (inLongCorridor(d)) return "LONG";
  if (inShortCorridor(d)) return "SHORT";
  return null;
}

function fmt2(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}
function pct01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `${Math.round(n*100)}%` : "—";
}

function computeRank(d) {
  const htf = Number(d.htf_score);
  const ltf = Number(d.ltf_score);
  const comp = Number(d.completion);
  const phase = Number(d.phase_pct);
  const rr = (d.rr != null) ? Number(d.rr) : computeRR(d);

  const flags = d.flags || {};
  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;

  const state = String(d.state || "");
  const aligned = (state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR");
  const setup = (state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK");

  let score = 50;

  if (aligned) score += 15;
  if (setup) score += 5;

  if (Number.isFinite(htf)) score += Math.min(10, Math.abs(htf) * 0.4);
  if (Number.isFinite(ltf)) score += Math.min(10, Math.abs(ltf) * 0.3);

  if (Number.isFinite(comp)) score += (1 - Math.min(1, comp)) * 20;

  if (Number.isFinite(phase)) score -= Math.max(0, phase - 0.6) * 25;

  if (sqRel) score += 15;
  else if (sqOn) score += 6;

  if (Number.isFinite(rr)) score += Math.min(10, rr * 2);

  score = Math.max(0, Math.min(100, score));
  return Math.round(score);
}

async function appendTrail(KV, ticker, point, maxN=8) {
  const key = `timed:trail:${ticker}`;
  const cur = (await kvGetJSON(KV, key)) || [];
  cur.push(point);
  const keep = cur.length > maxN ? cur.slice(cur.length - maxN) : cur;
  await kvPutJSON(KV, key, keep);
}

async function notifyDiscord(env, title, lines=[]) {
  if ((env.DISCORD_ENABLE || "false") !== "true") return;
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const content = `**${title}**\n` + lines.map(x => `• ${x}`).join("\n");
  await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ content })
  }).catch(()=>{});
}

function requireKeyOr401(req, env) {
  const expected = env.TIMED_API_KEY;
  if (!expected) return null; // open if unset (not recommended)
  const url = new URL(req.url);
  const qKey = url.searchParams.get("key");
  if (qKey && qKey === expected) return null;
  return sendJSON({ ok:false, error:"unauthorized" }, 401, corsHeaders(env));
}

function validateTimedPayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok:false, error:"missing ticker" };

  const ts = Number(body?.ts);
  const htf = Number(body?.htf_score);
  const ltf = Number(body?.ltf_score);

  if (!isNum(ts))  return { ok:false, error:"missing/invalid ts" };
  if (!isNum(htf)) return { ok:false, error:"missing/invalid htf_score" };
  if (!isNum(ltf)) return { ok:false, error:"missing/invalid ltf_score" };

  return {
    ok:true,
    ticker,
    payload: { ...body, ticker, ts, htf_score: htf, ltf_score: ltf }
  };
}

export default {
  async fetch(req, env) {
    const KV = env.KV_TIMED;
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders(env) });
    }

    // POST /timed/ingest
    if (url.pathname === "/timed/ingest" && req.method === "POST") {
      const authFail = requireKeyOr401(req, env);
      if (authFail) return authFail;

      const { obj: body, raw, err } = await readBodyAsJSON(req);
      if (!body) return ackJSON(env, { ok:false, error:"bad_json", sample: String(raw||"").slice(0,200), parseError: String(err||"") }, 400);

      const v = validateTimedPayload(body);
      if (!v.ok) return ackJSON(env, v, 400);

      const ticker = v.ticker;
      const payload = v.payload;

      // Dedupe rapid repeats
      const basis = JSON.stringify({
        ts: payload.ts,
        htf: payload.htf_score,
        ltf: payload.ltf_score,
        state: payload.state || "",
        completion: payload.completion,
        phase_pct: payload.phase_pct,
        rr: payload.rr,
        trigger_ts: payload.trigger_ts
      });

      const hash = stableHash(basis);
      const dedupeKey = `timed:dedupe:${ticker}:${hash}`;
      if (await KV.get(dedupeKey)) return ackJSON(env, { ok:true, deduped:true, ticker });
      await kvPutText(KV, dedupeKey, "1", 60);

      // Derived: staleness
      const stale = stalenessBucket(ticker, payload.ts);
      payload.market_type = stale.mt;
      payload.age_min = stale.ageMin;
      payload.staleness = stale.bucket;

      // Derived: rr/rank
      payload.rr = payload.rr ?? computeRR(payload);
      // (optional clamp to prevent any bizarre edge cases)
      if (payload.rr != null && Number(payload.rr) > 25) payload.rr = 25;

      payload.rank = computeRank(payload);

      // Detect state transition into aligned (enter Q2/Q3)
      const prevKey = `timed:prevstate:${ticker}`;
      const prevState = await KV.get(prevKey);
      await kvPutText(KV, prevKey, String(payload.state || ""), 7*24*60*60);

      const state = String(payload.state || "");
      const alignedLong  = (state === "HTF_BULL_LTF_BULL");
      const alignedShort = (state === "HTF_BEAR_LTF_BEAR");
      const aligned = alignedLong || alignedShort;
      const enteredAligned = aligned && (prevState !== state);

      const trigReason = String(payload.trigger_reason || "");
      const trigOk = (trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE");

      const flags = payload.flags || {};
      const sqRel = !!flags.sq30_release;

      // Corridor-only logic (must match UI)
      const side = corridorSide(payload); // LONG/SHORT/null
      const inCorridor = !!side;

      // corridor must match alignment
      const corridorAlignedOK =
        (side === "LONG" && alignedLong) ||
        (side === "SHORT" && alignedShort);

      // Must be: in corridor + corridor aligns + (entered aligned OR trigger OR squeeze release)
      const shouldConsiderAlert =
        inCorridor &&
        corridorAlignedOK &&
        (enteredAligned || trigOk || sqRel);

      // Store latest (do this BEFORE alert so UI has it)
      await kvPutJSON(KV, `timed:latest:${ticker}`, payload);

      // Trail (light)
      await appendTrail(KV, ticker, {
        ts: payload.ts,
        htf_score: payload.htf_score,
        ltf_score: payload.ltf_score,
        completion: payload.completion,
        phase_pct: payload.phase_pct,
        state: payload.state,
        rank: payload.rank
      }, 8);

      await ensureTickerIndex(KV, ticker);
      await kvPutText(KV, "timed:last_ingest_ms", String(Date.now()));

      // Threshold gates
      const minRR = Number(env.ALERT_MIN_RR || "1.5");
      const maxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
      const maxPhase = Number(env.ALERT_MAX_PHASE || "0.6");
      const minRank = Number(env.ALERT_MIN_RANK || "70");

      const rrOk   = (payload.rr != null) && (Number(payload.rr) >= minRR);
      const compOk = payload.completion == null ? true : Number(payload.completion) <= maxComp;
      const phaseOk= payload.phase_pct == null ? true : Number(payload.phase_pct) <= maxPhase;
      const rankOk = Number(payload.rank || 0) >= minRank;

      if (shouldConsiderAlert && rrOk && compOk && phaseOk && rankOk) {
        // Dedup alert by trigger_ts if present (best), else ts
        const keyTs = (payload.trigger_ts != null) ? String(payload.trigger_ts) : String(payload.ts);
        const akey = `timed:alerted:${ticker}:${keyTs}`;

        if (!(await KV.get(akey))) {
          await kvPutText(KV, akey, "1", 24*60*60);

          const why =
            (side === "LONG" ? "Entry corridor Q1→Q2" : "Entry corridor Q4→Q3") +
            (enteredAligned ? " | Entered aligned" : "") +
            (trigReason ? ` | ${trigReason}${payload.trigger_dir ? " ("+payload.trigger_dir+")" : ""}` : "") +
            (sqRel ? " | ⚡ squeeze release" : "");

          const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`;

          await notifyDiscord(env, `TimedTrading 🎯 ${ticker} — ${side} (Rank ${payload.rank})`, [
            `Why: ${why}`,
            `State: ${payload.state}`,
            `HTF/LTF: ${fmt2(payload.htf_score)} / ${fmt2(payload.ltf_score)}`,
            `Trigger: ${fmt2(payload.trigger_price)} | Price: ${fmt2(payload.price)}`,
            `SL: ${fmt2(payload.sl)} | TP: ${fmt2(payload.tp)} | ETA: ${payload.eta_days != null ? Number(payload.eta_days).toFixed(1)+"d" : "—"}`,
            `RR: ${payload.rr != null ? Number(payload.rr).toFixed(2) : "—"} | Rank: ${payload.rank}`,
            `Completion: ${pct01(payload.completion)} | Phase: ${pct01(payload.phase_pct)}`,
            `Link: ${tv}`
          ]);
        }
      }

      return ackJSON(env, { ok:true, ticker });
    }

    // GET /timed/latest?ticker=
    if (url.pathname === "/timed/latest" && req.method === "GET") {
      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker) return sendJSON({ ok:false, error:"missing ticker" }, 400, corsHeaders(env));
      const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
      return sendJSON({ ok:true, ticker, data }, 200, corsHeaders(env));
    }

    // GET /timed/tickers
    if (url.pathname === "/timed/tickers" && req.method === "GET") {
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      return sendJSON({ ok:true, tickers, count: tickers.length }, 200, corsHeaders(env));
    }

    // GET /timed/all
    if (url.pathname === "/timed/all" && req.method === "GET") {
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const data = {};
      for (const t of tickers) data[t] = await kvGetJSON(KV, `timed:latest:${t}`);
      return sendJSON({ ok:true, count: tickers.length, data }, 200, corsHeaders(env));
    }

    // GET /timed/trail?ticker=
    if (url.pathname === "/timed/trail" && req.method === "GET") {
      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker) return sendJSON({ ok:false, error:"missing ticker" }, 400, corsHeaders(env));
      const trail = (await kvGetJSON(KV, `timed:trail:${ticker}`)) || [];
      return sendJSON({ ok:true, ticker, trail }, 200, corsHeaders(env));
    }

    // GET /timed/top?bucket=long|short|setup&n=10
    if (url.pathname === "/timed/top" && req.method === "GET") {
      const n = Math.max(1, Math.min(50, Number(url.searchParams.get("n") || "10")));
      const bucket = String(url.searchParams.get("bucket") || "long").toLowerCase();
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];

      const items = [];
      for (const t of tickers) {
        const d = await kvGetJSON(KV, `timed:latest:${t}`);
        if (d) items.push(d);
      }

      // IMPORTANT: Top lists should favor corridor relevance for "long/short" tabs.
      // long bucket shows Q2 (bull aligned), short shows Q3 (bear aligned), setup shows Q1/Q4.
      const isLongAligned  = (d)=> d.state === "HTF_BULL_LTF_BULL";
      const isShortAligned = (d)=> d.state === "HTF_BEAR_LTF_BEAR";
      const isSetup = (d)=> d.state === "HTF_BULL_LTF_PULLBACK" || d.state === "HTF_BEAR_LTF_PULLBACK";

      let filtered =
        bucket === "long" ? items.filter(isLongAligned) :
        bucket === "short" ? items.filter(isShortAligned) :
        items.filter(isSetup);

      filtered.sort((a,b)=> (Number(b.rank||0) - Number(a.rank||0)));
      filtered = filtered.slice(0, n);

      return sendJSON({ ok:true, bucket, n: filtered.length, data: filtered }, 200, corsHeaders(env));
    }

    // GET /timed/health
    if (url.pathname === "/timed/health" && req.method === "GET") {
      const last = Number(await KV.get("timed:last_ingest_ms")) || 0;
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      return sendJSON({
        ok:true,
        now: Date.now(),
        lastIngestMs: last,
        minutesSinceLast: last ? ((Date.now()-last)/60000) : null,
        tickers: tickers.length
      }, 200, corsHeaders(env));
    }

    return sendJSON({ ok:false, error:"not_found" }, 404, corsHeaders(env));
  }
};

