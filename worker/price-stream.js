// ═══════════════════════════════════════════════════════════════════════════════
// PriceStream Durable Object — TwelveData WebSocket Price Streaming
//
// Replacement for AlpacaStream that uses TwelveData's WebSocket API.
// Maintains the same external interface (POST /start, /stop, GET /status, /prices)
// so the rest of the codebase works without changes.
//
// TwelveData WS constraints:
//   - Max 3 concurrent connections per API key
//   - API key in connection URL (no separate auth message)
//   - Subscribe message: { action: "subscribe", params: { symbols: "AAPL,MSFT,..." } }
//   - 10-second heartbeat required to keep connection alive
//   - Price events: { event: "price", symbol, ..., timestamp }
// ═══════════════════════════════════════════════════════════════════════════════

import { tdFetchQuote, toTdSymbol, fromTdSymbol, SKIP_TICKERS } from "./twelvedata.js";

const TD_WS_BASE = "wss://ws.twelvedata.com/v1/quotes/price";
const MAX_CONNECTIONS = 3;
const HEARTBEAT_INTERVAL_MS = 10_000;

const CRYPTO_MAP = { BTCUSD: "BTC/USD", ETHUSD: "ETH/USD" };
const CRYPTO_REVERSE = { "BTC/USD": "BTCUSD", "ETH/USD": "ETHUSD" };

// ─────────────────────────────────────────────────────────────────────────────
// Vendor-value timestamp stamping (2026-07-07 MU/WDC/SOXL incident).
//
// Every freshness gate in the platform (isPriceValueFresh in
// feed/feed-outputs.js, quoteReceiptTs in react-app/tt-live-data.js) keys off
// `q_ts` / `p_ts` — NEVER the poll timestamp `t` (GS zombie doctrine). The
// stream flush used to write `p` + `t` only, so live WS ticks aged out of the
// 10-min RTH freshness window as soon as the last REST sweep stamp got old:
// /timed/all refused the overlay and served the scoring snapshot's prior-day
// close (MU shown at $984.75 = Monday's close, +0.94% = Monday's change,
// while the feed's own `p` was live at $925). Hard refresh didn't help
// because the client merge gate rejected the rows for the same reason.
//
// Rule: EVERY writer of timed:prices rows must stamp q_ts (vendor event /
// quote receipt time) and p_ts (last time `p` actually moved).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build one flush row from stream symState — always carries q_ts/p_ts.
 *
 * Outside RTH (PRE/AH/CLOSED) for equities: `p`/`dc`/`dp` stay on today's
 * RTH close; the live last print lands on `ahp`/`ahdc`/`ahdp`. Writing AH
 * into `p` (IBM Jul 14) made RTH movers / headline day% look like a session
 * crash when the move was extended-hours only.
 *
 * @param {object} s
 * @param {number} [now]
 * @param {{ session?: string, isCrypto?: boolean }} [opts]
 */
export function buildStreamFlushRow(s, now = Date.now(), opts = {}) {
  const pc = Number(s.prevClose) || 0;
  const last = Number(s.last) || 0;
  const rthClose = Number(s.dailyClose) || 0;
  const session = String(opts.session || "RTH").toUpperCase();
  const isCrypto = opts.isCrypto === true;
  const lastTs = Number(s.lastTs) || now;

  // Equities outside RTH: prefer RTH close for display `p`. Crypto is 24/7.
  const useAh = !isCrypto && session !== "RTH" && rthClose > 0 && last > 0;
  const displayP = useAh ? rthClose : last;

  let dayChg = null, dayChgPct = null;
  if (pc > 0 && displayP > 0) {
    dayChg = Math.round((displayP - pc) * 100) / 100;
    dayChgPct = Math.round(((displayP - pc) / pc) * 10000) / 100;
  }

  const row = {
    p: Math.round(displayP * 100) / 100,
    pc: Math.round(pc * 100) / 100,
    dc: dayChg,
    dp: dayChgPct,
    dh: Math.round((s.dayHigh || 0) * 100) / 100,
    dl: Math.round((s.dayLow || 0) * 100) / 100,
    dv: s.dayVol || 0,
    t: lastTs,
    q_ts: lastTs,
    p_ts: Number(s.lastChangeTs) || lastTs,
  };

  if (useAh && Math.abs(last - rthClose) / rthClose > 0.0005) {
    row.ahp = Math.round(last * 100) / 100;
    row.ahdc = Math.round((last - rthClose) * 100) / 100;
    row.ahdp = Math.round(((last - rthClose) / rthClose) * 10000) / 100;
  }

  return row;
}

/**
 * Merge one stream flush row onto the existing KV row. Never regresses
 * q_ts/p_ts below what a REST path already stamped; preserves REST-written
 * extended-hours fields and other metadata the stream doesn't know about.
 *
 * Outside RTH: a stream row that still carries AH-as-`p` (legacy / missing
 * dailyClose) must not clobber a REST-correct RTH close already on the row.
 */
export function mergeStreamRowIntoKv(ex, row, opts = {}) {
  const base = ex || {};
  const session = String(opts.session || "RTH").toUpperCase();
  const isCrypto = opts.isCrypto === true;
  const outsideRth = !isCrypto && session !== "RTH";

  let next = row;
  if (outsideRth) {
    const baseP = Number(base.p) || 0;
    const rowP = Number(row?.p) || 0;
    const rowAhp = Number(row?.ahp) || 0;
    // Legacy stream shape: AH last written to `p` with no ahp, while REST
    // already has the correct RTH close on the row (IBM Jul 14).
    if (baseP > 0 && rowP > 0 && !(rowAhp > 0) && Math.abs(rowP - baseP) / baseP > 0.015) {
      next = {
        ...row,
        p: baseP,
        pc: base.pc,
        dc: base.dc,
        dp: base.dp,
        ahp: Math.round(rowP * 100) / 100,
        ahdc: Math.round((rowP - baseP) * 100) / 100,
        ahdp: Math.round(((rowP - baseP) / baseP) * 10000) / 100,
        p_ts: Number(base.p_ts) || row.p_ts,
      };
    }
  }

  const merged = next.pc > 0
    ? { ...base, ...next }
    : {
        ...base,
        p: next.p,
        t: next.t,
        dh: next.dh || base.dh,
        dl: next.dl || base.dl,
        dv: next.dv || base.dv,
      };
  merged.q_ts = Math.max(Number(base.q_ts) || 0, Number(next.q_ts) || 0);
  merged.p_ts = Math.max(Number(base.p_ts) || 0, Number(next.p_ts) || 0);
  return merged;
}

export class PriceStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.connections = []; // up to 3 WebSocket connections
    this.heartbeatTimers = [];
    this.isRunning = false;
    this.startedAt = 0;
    this.allSymbols = [];

    // Per-symbol price state (same shape as AlpacaStream for compatibility)
    this.symState = {};

    this.lastFlush = 0;
    this.lastKvWrite = 0;
    this.lastSnapshotRefresh = 0;
    this.lastBoundaryKey = "";

    this.pricesReceived = 0;
    this.snapshotSeeds = 0;
    this.flushCount = 0;

    /* P0.7.130 — Lifecycle log. The DO's in-memory state is reset
       every time CF evicts the instance and a new request causes a
       re-instantiation. Every constructor invocation is a "cold
       start". We persist a rolling log of the last 30 lifecycle
       events to `state.storage` so we can answer "how often does
       CF cycle this DO?" via /status. blockConcurrencyWhile defers
       the first request handler until the log write completes. */
    this.state.blockConcurrencyWhile(async () => {
      try {
        await this._recordLifecycleEvent("instantiated", {});
      } catch { /* never block startup on logging */ }
    });
  }

  /** Append a lifecycle event to durable storage. Keeps the last 30. */
  async _recordLifecycleEvent(event, meta = {}) {
    try {
      const existing = (await this.state.storage.get("lifecycle:history")) || [];
      const entry = { ts: Date.now(), event, ...meta };
      const next = [entry, ...existing].slice(0, 30);
      await this.state.storage.put("lifecycle:history", next);
    } catch (e) {
      // Logging must never throw — it would crash the constructor.
      console.warn("[PriceStream] lifecycle log write failed:", String(e).slice(0, 120));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ET Time + Session State Machine (same as AlpacaStream)
  // ══════════════════════════════════════════════════════════════════════════

  _nowET() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "numeric", hour12: false,
      weekday: "short",
    }).formatToParts(new Date());
    let h = 0, m = 0, wd = "";
    for (const p of parts) {
      if (p.type === "hour") h = Number(p.value);
      if (p.type === "minute") m = Number(p.value);
      if (p.type === "weekday") wd = p.value;
    }
    if (h === 24) h = 0;
    return { h, m, wd, mins: h * 60 + m };
  }

  _getSession() {
    const { mins, wd } = this._nowET();
    if (["Sat", "Sun"].includes(wd)) return "CLOSED";
    if (mins >= 570 && mins < 960) return "RTH";
    if (mins >= 960 && mins < 1200) return "AH";
    if (mins >= 240 && mins < 570) return "PRE";
    return "CLOSED";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REST Snapshot Seeding (via TwelveData /quote)
  // ══════════════════════════════════════════════════════════════════════════

  async _seedFromSnapshots() {
    if (this.allSymbols.length === 0) return;
    console.log(`[PriceStream] Seeding ${this.allSymbols.length} symbols from TwelveData quotes...`);
    const { snapshots } = await tdFetchQuote(this.env, this.allSymbols);
    const count = this._applySnapshots(snapshots || {});
    this.snapshotSeeds = count;
    this.lastSnapshotRefresh = Date.now();
    console.log(`[PriceStream] Seeded ${count} symbols from quotes`);
  }

  async _refreshSnapshots() {
    const { snapshots } = await tdFetchQuote(this.env, this.allSymbols);
    const count = this._applySnapshots(snapshots || {});
    this.lastSnapshotRefresh = Date.now();
    console.log(`[PriceStream] Refreshed ${count} symbols from quotes`);
  }

  _applySnapshots(snaps) {
    let count = 0;
    const session = this._getSession();
    const outsideRth = session !== "RTH";
    for (const [sym, data] of Object.entries(snaps)) {
      const existing = this.symState[sym];
      const isCrypto = sym === "BTCUSD" || sym === "ETHUSD";
      // Outside RTH: live print prefers extended_price; dailyClose holds RTH close.
      const extP = Number(data.extendedPrice) || 0;
      const rthP = Number(data.dailyClose) || Number(data.price) || 0;
      const liveP = (!isCrypto && outsideRth && extP > 0) ? extP : (Number(data.price) || rthP || 0);
      if (existing) {
        if (data.prevDailyClose > 0) existing.prevClose = data.prevDailyClose;
        if (rthP > 0) existing.dailyClose = rthP;
        if (data.dailyOpen > 0) existing.dayOpen = data.dailyOpen;
        if (data.dailyHigh > 0) existing.dayHigh = data.dailyHigh;
        if (data.dailyLow > 0) existing.dayLow = data.dailyLow;
        if (data.dailyVolume > 0) existing.dayVol = data.dailyVolume;
        const nextTs = Number(data.trade_ts) || 0;
        const priceChanged = liveP > 0 && Math.abs(liveP - (existing.last || 0)) > 0.0001;
        if (liveP > 0 && (nextTs > (existing.lastTs || 0) || priceChanged)) {
          existing.last = liveP;
          existing.lastTs = priceChanged ? Math.max(nextTs, Date.now()) : nextTs;
          if (priceChanged) existing.lastChangeTs = existing.lastTs;
        }
        existing.dirty = true;
      } else {
        this.symState[sym] = {
          last: liveP || 0,
          lastTs: data.trade_ts || Date.now(),
          lastChangeTs: data.trade_ts || Date.now(),
          prevClose: data.prevDailyClose || 0,
          dailyClose: rthP || 0,
          dayOpen: data.dailyOpen || 0,
          dayHigh: data.dailyHigh || 0,
          dayLow: data.dailyLow || 0,
          dayVol: data.dailyVolume || 0,
          dirty: true,
        };
      }
      count++;
    }
    return count;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Change Computation + Batch Flush (same logic as AlpacaStream)
  // ══════════════════════════════════════════════════════════════════════════

  async _flushPrices() {
    const dirtySyms = [];
    for (const [sym, s] of Object.entries(this.symState)) {
      if (s.dirty && s.last > 0) dirtySyms.push(sym);
    }
    if (dirtySyms.length === 0) return;

    const now = Date.now();
    const pricesData = {};

    const session = this._getSession();
    for (const sym of dirtySyms) {
      const s = this.symState[sym];
      // Rows always carry q_ts/p_ts — every downstream freshness gate keys
      // off these, and a bare p+t row reads as a zombie (MU/WDC/SOXL 2026-07-07).
      const isCrypto = sym === "BTCUSD" || sym === "ETHUSD";
      pricesData[sym] = buildStreamFlushRow(s, now, { session, isCrypto });
      s.dirty = false;
    }

    // Push to PriceHub DO
    const seededPricesData = {};
    for (const [sym, data] of Object.entries(pricesData)) {
      if (data.pc > 0) seededPricesData[sym] = data;
    }
    if (this.env.PRICE_HUB && Object.keys(seededPricesData).length > 0) {
      try {
        const id = this.env.PRICE_HUB.idFromName("global");
        const hub = this.env.PRICE_HUB.get(id);
        await hub.fetch(new Request("https://internal/ws/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "prices",
            data: seededPricesData,
            updated_at: now,
            source: "twelvedata_stream",
          }),
        }));
      } catch (e) {
        console.warn("[PriceStream] PriceHub push failed:", String(e).slice(0, 150));
      }
    }

    // KV write (throttled to every 10s)
    if (this.env.KV_TIMED && (now - this.lastKvWrite) > 10_000) {
      try {
        let existing = {};
        let existingCount = 0;
        let existingBlob = null;
        try {
          existingBlob = await this.env.KV_TIMED.get("timed:prices", "json");
          existing = existingBlob?.prices || {};
          existingCount = Object.keys(existing).length;
        } catch (_) {}

        const merged = { ...existing };
        for (const [sym, data] of Object.entries(pricesData)) {
          const isCrypto = sym === "BTCUSD" || sym === "ETHUSD";
          merged[sym] = mergeStreamRowIntoKv(existing[sym], data, { session, isCrypto });
        }

        const mergedCount = Object.keys(merged).length;
        if (existingCount > 50 && mergedCount < existingCount * 0.8) {
          console.warn(`[PriceStream] KV write aborted: would shrink from ${existingCount} to ${mergedCount}`);
        } else {
          await this.env.KV_TIMED.put("timed:prices", JSON.stringify({
            prices: merged,
            updated_at: now,
            ticker_count: mergedCount,
            _source: "twelvedata_stream",
            // Preserve the cron sweep's stale accounting — dropping these
            // blinded /timed/health (staleSymbolCount read null) whenever
            // the stream was the last writer.
            ...(existingBlob?.stale_symbols !== undefined ? { stale_symbols: existingBlob.stale_symbols } : {}),
            ...(existingBlob?.stale_symbol_count !== undefined ? { stale_symbol_count: existingBlob.stale_symbol_count } : {}),
            ...(existingBlob?.market_open !== undefined ? { market_open: existingBlob.market_open } : {}),
          }));
          this.lastKvWrite = now;
        }
      } catch (e) {
        console.warn("[PriceStream] KV write failed:", String(e).slice(0, 150));
      }
    }

    this.lastFlush = now;
    this.flushCount++;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HTTP Handler (same interface as AlpacaStream)
  // ══════════════════════════════════════════════════════════════════════════

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      try {
        const body = await request.json().catch(() => ({}));
        const symbols = body.symbols || [];
        if (symbols.length > 0) this.allSymbols = symbols.filter(s => !SKIP_TICKERS.has(s));

        if (!this.isRunning) {
          this.isRunning = true;
          this.startedAt = Date.now();
          this.pricesReceived = 0;
          await this._seedFromSnapshots();
          await this._connectAll();
          await this.state.storage.setAlarm(Date.now() + 1000);
          // P0.7.130 — log the start (paired with the constructor's
          // 'instantiated' log; together they tell us if the DO was
          // re-instantiated by CF or whether the caller is just
          // re-issuing /start).
          await this._recordLifecycleEvent("started", {
            symbolCount: this.allSymbols.length,
          });
        } else if (symbols.length > 0) {
          await this._seedFromSnapshots();
        }
        return _json({
          ok: true, status: "running",
          symbols: this.allSymbols.length,
          seeded: this.snapshotSeeds,
          connections: this.connections.filter(ws => ws?.readyState === 1).length,
        });
      } catch (e) {
        return _json({ ok: false, error: String(e).slice(0, 300) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      const _uptime = this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
      await this._flushPrices();
      this._disconnectAll();
      this.isRunning = false;
      await this._recordLifecycleEvent("stopped", { uptime: _uptime, prices: this.pricesReceived });
      return _json({ ok: true, status: "stopped" });
    }

    if (url.pathname === "/status") {
      // P0.7.130 — include the lifecycle history so callers can see
      // how often the DO has been restarted recently.
      let lifecycle = [];
      try {
        lifecycle = (await this.state.storage.get("lifecycle:history")) || [];
      } catch { /* status must never fail */ }
      const now = Date.now();
      const last24h = lifecycle.filter(e => (now - e.ts) < 86400000);
      const instantiations24h = last24h.filter(e => e.event === "instantiated").length;
      const starts24h = last24h.filter(e => e.event === "started").length;
      const stops24h = last24h.filter(e => e.event === "stopped").length;
      return _json({
        ok: true,
        isRunning: this.isRunning,
        startedAt: this.startedAt,
        session: this._getSession(),
        connectionsActive: this.connections.filter(ws => ws?.readyState === 1).length,
        connectionsTotal: MAX_CONNECTIONS,
        symbolCount: Object.keys(this.symState).length,
        subscribedSymbols: this.allSymbols.length,
        pricesReceived: this.pricesReceived,
        snapshotSeeds: this.snapshotSeeds,
        flushCount: this.flushCount,
        lastFlush: this.lastFlush,
        lastKvWrite: this.lastKvWrite,
        lastSnapshotRefresh: this.lastSnapshotRefresh,
        uptime: this.startedAt > 0 ? Math.round((now - this.startedAt) / 1000) : 0,
        provider: "twelvedata",
        lifecycle: {
          last24h: { instantiations: instantiations24h, starts: starts24h, stops: stops24h },
          recent: lifecycle.slice(0, 10),
        },
      });
    }

    if (url.pathname === "/prices") {
      const prices = {};
      const session = this._getSession();
      for (const [sym, s] of Object.entries(this.symState)) {
        if (s.last > 0) {
          const isCrypto = sym === "BTCUSD" || sym === "ETHUSD";
          prices[sym] = buildStreamFlushRow(s, Date.now(), { session, isCrypto });
          prices[sym].o = s.dayOpen || 0;
          prices[sym].h = s.dayHigh || 0;
          prices[sym].l = s.dayLow || 0;
          prices[sym].c = s.dailyClose || 0;
          prices[sym].v = s.dayVol || 0;
          prices[sym].src = "twelvedata_ws";
        }
      }
      return _json({ ok: true, prices, updated_at: Date.now() });
    }

    return new Response("Not found", { status: 404 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Alarm Handler
  // ══════════════════════════════════════════════════════════════════════════

  async alarm() {
    if (!this.isRunning) return;

    await this._flushPrices();

    // Reconnect dropped connections
    for (let i = 0; i < this.connections.length; i++) {
      if (!this.connections[i] || this.connections[i].readyState !== 1) {
        console.log(`[PriceStream] Connection ${i} dropped, reconnecting...`);
        await this._connectOne(i);
      }
    }

    // Periodic snapshot refresh
    const secSinceRefresh = (Date.now() - this.lastSnapshotRefresh) / 1000;
    const { mins, wd } = this._nowET();
    const isWeekday = !["Sat", "Sun"].includes(wd);
    let needsRefresh = false;

    if (isWeekday) {
      if (mins >= 565 && mins <= 566) {
        const key = `open-${wd}-${mins}`;
        if (this.lastBoundaryKey !== key) { needsRefresh = true; this.lastBoundaryKey = key; }
      }
      if (mins >= 965 && mins <= 966) {
        const key = `close-${wd}-${mins}`;
        if (this.lastBoundaryKey !== key) { needsRefresh = true; this.lastBoundaryKey = key; }
      }
    }
    if (secSinceRefresh > 60) needsRefresh = true;

    if (needsRefresh) {
      try { await this._refreshSnapshots(); }
      catch (e) { console.warn("[PriceStream] Snapshot refresh failed:", String(e).slice(0, 200)); }
    }

    const session = this._getSession();
    const interval = (session === "RTH" || session === "AH" || session === "PRE") ? 5000 : 10_000;
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket Connection Management
  // ══════════════════════════════════════════════════════════════════════════

  async _connectAll() {
    const apiKey = this.env.TWELVEDATA_API_KEY;
    if (!apiKey) {
      console.warn("[PriceStream] Missing TWELVEDATA_API_KEY");
      return;
    }

    // Split symbols across MAX_CONNECTIONS connections
    const tdSyms = this.allSymbols.map(toTdSymbol);
    const perConn = Math.ceil(tdSyms.length / MAX_CONNECTIONS);

    for (let i = 0; i < MAX_CONNECTIONS; i++) {
      const slice = tdSyms.slice(i * perConn, (i + 1) * perConn);
      if (slice.length === 0) break;
      await this._connectOne(i, slice);
    }
  }

  async _connectOne(index, symbolsToSubscribe = null) {
    const apiKey = this.env.TWELVEDATA_API_KEY;
    if (!apiKey) return;

    // Close existing connection for this slot
    try { this.connections[index]?.close(); } catch (_) {}
    if (this.heartbeatTimers[index]) {
      clearInterval(this.heartbeatTimers[index]);
      this.heartbeatTimers[index] = null;
    }

    // Determine symbols for this connection slot
    if (!symbolsToSubscribe) {
      const tdSyms = this.allSymbols.map(toTdSymbol);
      const perConn = Math.ceil(tdSyms.length / MAX_CONNECTIONS);
      symbolsToSubscribe = tdSyms.slice(index * perConn, (index + 1) * perConn);
      if (symbolsToSubscribe.length === 0) return;
    }

    const wsUrl = `${TD_WS_BASE}?apikey=${apiKey}`;

    // Try fetch-upgrade first (Cloudflare native), fall back to standard WebSocket
    try {
      let ws = null;
      try {
        const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
        if (resp.webSocket) {
          ws = resp.webSocket;
          ws.accept();
        } else {
          console.warn(`[PriceStream] Connection ${index}: fetch upgrade returned HTTP ${resp.status}, trying new WebSocket()`);
        }
      } catch (fetchErr) {
        console.warn(`[PriceStream] Connection ${index}: fetch upgrade failed (${String(fetchErr).slice(0, 100)}), trying new WebSocket()`);
      }

      if (!ws) {
        ws = new WebSocket(wsUrl);
        // Standard WebSocket starts in CONNECTING state; wait for open
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout (10s)")), 10_000);
          ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); });
          ws.addEventListener("error", (e) => { clearTimeout(timeout); reject(e); });
        });
      }

      this.connections[index] = ws;

      ws.addEventListener("message", (event) => this._onMessage(event.data));
      ws.addEventListener("close", (event) => {
        console.log(`[PriceStream] Connection ${index} closed: code=${event.code} reason=${event.reason || ""}`);
        this.connections[index] = null;
      });
      ws.addEventListener("error", (event) => {
        console.error(`[PriceStream] Connection ${index} error:`, String(event?.message || event).slice(0, 200));
      });

      // Subscribe to symbols
      ws.send(JSON.stringify({
        action: "subscribe",
        params: { symbols: symbolsToSubscribe.join(",") },
      }));

      // Start heartbeat (TwelveData requires ping every 10s)
      this.heartbeatTimers[index] = setInterval(() => {
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ action: "heartbeat" }));
          }
        } catch (_) {}
      }, HEARTBEAT_INTERVAL_MS);

      console.log(`[PriceStream] Connection ${index}: subscribed to ${symbolsToSubscribe.length} symbols (readyState=${ws.readyState})`);
    } catch (e) {
      console.error(`[PriceStream] Connection ${index} failed:`, String(e).slice(0, 300));
      this.connections[index] = null;
    }
  }

  _disconnectAll() {
    for (let i = 0; i < this.connections.length; i++) {
      try { this.connections[i]?.close(); } catch (_) {}
      this.connections[i] = null;
      if (this.heartbeatTimers[i]) {
        clearInterval(this.heartbeatTimers[i]);
        this.heartbeatTimers[i] = null;
      }
    }
    console.log("[PriceStream] Disconnected all WebSockets");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WS Message Handler
  // ══════════════════════════════════════════════════════════════════════════

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch { return; }

    // Subscribe status confirmation
    if (msg.event === "subscribe-status") {
      console.log(`[PriceStream] Subscribe status: ${msg.status}`);
      return;
    }

    // Heartbeat response
    if (msg.event === "heartbeat" || msg.status === "ok") return;

    // Price event
    if (msg.event === "price") {
      this.pricesReceived++;
      const tdSym = msg.symbol;
      const sym = fromTdSymbol(tdSym);
      const price = Number(msg.price);
      if (!sym || !Number.isFinite(price) || price <= 0) return;

      const existing = this.symState[sym];
      const eventTs = msg.timestamp ? Number(msg.timestamp) * 1000 : 0;
      // Bar timestamps from TD WS can lag; during live sessions prefer wall clock
      // when the event timestamp is more than 2 minutes stale.
      const ts = (eventTs > 0 && (Date.now() - eventTs) < 120000) ? eventTs : Date.now();
      if (existing) {
        const priceMoved = Math.abs(price - (existing.last || 0)) > 0.0001;
        if (ts >= (existing.lastTs || 0) || priceMoved) {
          existing.last = price;
          existing.lastTs = Math.max(ts, existing.lastTs || 0);
          if (priceMoved) existing.lastChangeTs = existing.lastTs;
          if (price > (existing.dayHigh || 0)) existing.dayHigh = price;
          if (existing.dayLow <= 0 || price < existing.dayLow) existing.dayLow = price;
          existing.dirty = true;
        }
      } else {
        this.symState[sym] = {
          last: price, lastTs: ts, lastChangeTs: ts,
          prevClose: 0, dailyClose: 0,
          dayOpen: 0, dayHigh: price, dayLow: price, dayVol: 0,
          dirty: true,
        };
      }

      // Update volume if provided
      if (msg.day_volume && existing) {
        existing.dayVol = Number(msg.day_volume) || existing.dayVol;
      }
      return;
    }
  }
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
