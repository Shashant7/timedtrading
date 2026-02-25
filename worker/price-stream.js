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
    for (const [sym, data] of Object.entries(snaps)) {
      const existing = this.symState[sym];
      if (existing) {
        if (data.prevDailyClose > 0) existing.prevClose = data.prevDailyClose;
        if (data.dailyClose > 0) existing.dailyClose = data.dailyClose;
        if (data.dailyOpen > 0) existing.dayOpen = data.dailyOpen;
        if (data.dailyHigh > 0) existing.dayHigh = data.dailyHigh;
        if (data.dailyLow > 0) existing.dayLow = data.dailyLow;
        if (data.dailyVolume > 0) existing.dayVol = data.dailyVolume;
        if (data.trade_ts > (existing.lastTs || 0) && data.price > 0) {
          existing.last = data.price;
          existing.lastTs = data.trade_ts;
        }
        existing.dirty = true;
      } else {
        this.symState[sym] = {
          last: data.price || 0,
          lastTs: data.trade_ts || Date.now(),
          prevClose: data.prevDailyClose || 0,
          dailyClose: data.dailyClose || 0,
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

    const session = this._getSession();
    const now = Date.now();
    const pricesData = {};

    for (const sym of dirtySyms) {
      const s = this.symState[sym];
      const pc = s.prevClose || 0;
      const dc = s.dailyClose || 0;

      let dayChg = null, dayChgPct = null;
      let ahChg = null, ahChgPct = null;

      if (pc > 0) {
        dayChg = Math.round((s.last - pc) * 100) / 100;
        dayChgPct = Math.round(((s.last - pc) / pc) * 10000) / 100;
      }
      if ((session === "AH" || session === "PRE") && dc > 0) {
        ahChg = Math.round((s.last - dc) * 100) / 100;
        ahChgPct = Math.round(((s.last - dc) / dc) * 10000) / 100;
      }

      pricesData[sym] = {
        p: Math.round(s.last * 100) / 100,
        pc: Math.round(pc * 100) / 100,
        dc: dayChg,
        dp: dayChgPct,
        dh: Math.round((s.dayHigh || 0) * 100) / 100,
        dl: Math.round((s.dayLow || 0) * 100) / 100,
        dv: s.dayVol || 0,
        t: s.lastTs || now,
      };

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
        try {
          const raw = await this.env.KV_TIMED.get("timed:prices", "json");
          existing = raw?.prices || {};
          existingCount = Object.keys(existing).length;
        } catch (_) {}

        const merged = { ...existing };
        for (const [sym, data] of Object.entries(pricesData)) {
          const ex = existing[sym] || {};
          if (data.pc > 0) {
            merged[sym] = { ...ex, ...data };
          } else {
            merged[sym] = { ...ex, p: data.p, t: data.t, dh: data.dh || ex.dh, dl: data.dl || ex.dl, dv: data.dv || ex.dv };
          }
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
      await this._flushPrices();
      this._disconnectAll();
      this.isRunning = false;
      return _json({ ok: true, status: "stopped" });
    }

    if (url.pathname === "/status") {
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
        uptime: this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
        provider: "twelvedata",
      });
    }

    if (url.pathname === "/prices") {
      const prices = {};
      for (const [sym, s] of Object.entries(this.symState)) {
        if (s.last > 0) {
          const pc = s.prevClose || 0;
          prices[sym] = {
            p: s.last,
            t: s.lastTs,
            pc,
            dc: pc > 0 ? Math.round((s.last - pc) * 100) / 100 : 0,
            dp: pc > 0 ? Math.round(((s.last - pc) / pc) * 10000) / 100 : 0,
            o: s.dayOpen || 0,
            h: s.dayHigh || 0,
            l: s.dayLow || 0,
            c: s.dailyClose || 0,
            v: s.dayVol || 0,
            src: "twelvedata_ws",
          };
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

    try {
      const wsUrl = `${TD_WS_BASE}?apikey=${apiKey}`;
      const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) {
        console.error(`[PriceStream] Connection ${index}: no webSocket on response`);
        return;
      }
      ws.accept();
      this.connections[index] = ws;

      ws.addEventListener("message", (event) => this._onMessage(event.data));
      ws.addEventListener("close", (event) => {
        console.log(`[PriceStream] Connection ${index} closed: code=${event.code}`);
        this.connections[index] = null;
      });
      ws.addEventListener("error", (event) => {
        console.error(`[PriceStream] Connection ${index} error:`, event);
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

      console.log(`[PriceStream] Connection ${index}: subscribed to ${symbolsToSubscribe.length} symbols`);
    } catch (e) {
      console.error(`[PriceStream] Connection ${index} failed:`, String(e).slice(0, 200));
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
      const ts = msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now();

      const existing = this.symState[sym];
      if (existing) {
        if (ts >= (existing.lastTs || 0)) {
          existing.last = price;
          existing.lastTs = ts;
          if (price > (existing.dayHigh || 0)) existing.dayHigh = price;
          if (existing.dayLow <= 0 || price < existing.dayLow) existing.dayLow = price;
          existing.dirty = true;
        }
      } else {
        this.symState[sym] = {
          last: price, lastTs: ts,
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
