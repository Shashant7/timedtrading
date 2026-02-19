// AlpacaStream Durable Object — Phase 2: Smart, Session-Aware Price Server
//
// Redesigned from a passive WS cache into an authoritative real-time price
// source with snapshot seeding, session awareness, and batched broadcasting.
//
// Architecture:
//   Startup: REST snapshot seed (prevDailyBar.c + dailyBar.c)
//   Alpaca WS: trade events → update last_trade_price in memory
//   Session Machine: isRTH / isAH / isClosed (ET-based)
//   Alarm (1s): batch flush dirty prices → PriceHub DO + KV
//   Periodic: snapshot refresh at 09:25 ET, 16:05 ET, and every 60s
//
// Lifecycle:
//   Cron → POST /start (symbols) → seed + connect + alarm loop
//   Cron → POST /stop → final flush + disconnect

const STOCKS_WS_URL = "https://stream.data.alpaca.markets/v2/sip";
const CRYPTO_WS_URL = "https://stream.data.alpaca.markets/v1beta3/crypto/us";
const ALPACA_STOCKS_BASE = "https://data.alpaca.markets/v2";
const ALPACA_CRYPTO_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

const CRYPTO_MAP = { "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD" };
const CRYPTO_REVERSE = { "BTC/USD": "BTCUSD", "ETH/USD": "ETHUSD" };

const ALPACA_SYM_MAP = { "BRK-B": "BRK.B" };
const ALPACA_SYM_REVERSE = { "BRK.B": "BRK-B" };

export class AlpacaStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.stocksWs = null;
    this.cryptoWs = null;
    this.isRunning = false;
    this.startedAt = 0;
    this.stockSymbols = [];
    this.reconnectAttempts = 0;

    // Per-symbol price state
    // { SYM: { last, lastTs, prevClose, dailyClose, dayOpen, dayHigh, dayLow, dayVol, dirty } }
    this.symState = {};

    this.lastFlush = 0;
    this.lastKvWrite = 0;
    this.lastSnapshotRefresh = 0;
    this.lastBoundaryKey = "";

    this.tradesReceived = 0;
    this.barsReceived = 0;
    this.snapshotSeeds = 0;
    this.flushCount = 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ET Time + Session State Machine
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
    if (mins >= 570 && mins < 960) return "RTH";    // 9:30 – 16:00
    if (mins >= 960 && mins < 1200) return "AH";    // 16:00 – 20:00
    if (mins >= 240 && mins < 570) return "PRE";     // 4:00 – 9:30
    return "CLOSED";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REST Snapshot Fetching (Seed + Refresh)
  // ══════════════════════════════════════════════════════════════════════════

  _alpacaHeaders() {
    return {
      "APCA-API-KEY-ID": this.env.ALPACA_API_KEY_ID,
      "APCA-API-SECRET-KEY": this.env.ALPACA_API_SECRET_KEY,
      "Accept": "application/json",
    };
  }

  async _fetchStockSnapshots(symbols) {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) return {};
    if (!symbols || symbols.length === 0) return {};
    const headers = this._alpacaHeaders();
    const result = {};
    const BATCH = 100;
    const alpacaSyms = symbols.map(s => ALPACA_SYM_MAP[s] || s);

    for (let i = 0; i < alpacaSyms.length; i += BATCH) {
      const batch = alpacaSyms.slice(i, i + BATCH);
      try {
        const params = new URLSearchParams({ symbols: batch.join(","), feed: "sip" });
        const resp = await fetch(`${ALPACA_STOCKS_BASE}/stocks/snapshots?${params}`, { headers });
        if (!resp.ok) {
          console.error(`[AlpacaStream] Snapshot batch ${i} HTTP ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        for (const [sym, snap] of Object.entries(data)) {
          const ourSym = ALPACA_SYM_REVERSE[sym] || sym;
          const lt = snap.latestTrade;
          const db = snap.dailyBar;
          const pdb = snap.prevDailyBar;
          const mb = snap.minuteBar;
          let price = Number(lt?.p) || 0;
          if (!(price > 0)) price = Number(mb?.c) || Number(db?.c) || 0;
          result[ourSym] = {
            price,
            tradeTs: lt?.t ? new Date(lt.t).getTime() : 0,
            prevClose: Number(pdb?.c) || 0,
            dailyClose: Number(db?.c) || 0,
            dailyOpen: Number(db?.o) || 0,
            dailyHigh: Number(db?.h) || 0,
            dailyLow: Number(db?.l) || 0,
            dailyVolume: Number(db?.v) || 0,
          };
        }
      } catch (e) {
        console.error(`[AlpacaStream] Snapshot batch ${i} error:`, String(e).slice(0, 200));
      }
    }
    return result;
  }

  async _fetchCryptoSnapshots() {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) return {};
    const headers = this._alpacaHeaders();
    const result = {};
    try {
      const params = new URLSearchParams({ symbols: Object.values(CRYPTO_MAP).join(",") });
      const resp = await fetch(`${ALPACA_CRYPTO_BASE}/snapshots?${params}`, { headers });
      if (!resp.ok) return result;
      const data = await resp.json();
      const snaps = data.snapshots || data;
      for (const [alpacaSym, snap] of Object.entries(snaps)) {
        const ourSym = CRYPTO_REVERSE[alpacaSym] || alpacaSym.replace("/", "");
        const lt = snap.latestTrade;
        const db = snap.dailyBar;
        const pdb = snap.prevDailyBar;
        let price = Number(lt?.p) || Number(db?.c) || 0;
        result[ourSym] = {
          price,
          tradeTs: lt?.t ? new Date(lt.t).getTime() : 0,
          prevClose: Number(pdb?.c) || 0,
          dailyClose: Number(db?.c) || 0,
          dailyOpen: Number(db?.o) || 0,
          dailyHigh: Number(db?.h) || 0,
          dailyLow: Number(db?.l) || 0,
          dailyVolume: Number(db?.v) || 0,
        };
      }
    } catch (e) {
      console.warn("[AlpacaStream] Crypto snapshot error:", String(e).slice(0, 200));
    }
    return result;
  }

  _applySnapshots(snaps) {
    let count = 0;
    for (const [sym, data] of Object.entries(snaps)) {
      const existing = this.symState[sym];
      if (existing) {
        if (data.prevClose > 0) existing.prevClose = data.prevClose;
        if (data.dailyClose > 0) existing.dailyClose = data.dailyClose;
        if (data.dailyOpen > 0) existing.dayOpen = data.dailyOpen;
        if (data.dailyHigh > 0) existing.dayHigh = data.dailyHigh;
        if (data.dailyLow > 0) existing.dayLow = data.dailyLow;
        if (data.dailyVolume > 0) existing.dayVol = data.dailyVolume;
        if (data.tradeTs > (existing.lastTs || 0) && data.price > 0) {
          existing.last = data.price;
          existing.lastTs = data.tradeTs;
        }
        existing.dirty = true;
      } else {
        this.symState[sym] = {
          last: data.price,
          lastTs: data.tradeTs || Date.now(),
          prevClose: data.prevClose,
          dailyClose: data.dailyClose,
          dayOpen: data.dailyOpen,
          dayHigh: data.dailyHigh,
          dayLow: data.dailyLow,
          dayVol: data.dailyVolume,
          dirty: true,
        };
      }
      count++;
    }
    return count;
  }

  async _seedFromSnapshots() {
    if (this.stockSymbols.length === 0) return;
    console.log(`[AlpacaStream] Seeding ${this.stockSymbols.length} symbols from REST snapshots...`);
    const [stockSnaps, cryptoSnaps] = await Promise.all([
      this._fetchStockSnapshots(this.stockSymbols),
      this._fetchCryptoSnapshots(),
    ]);
    const stockCount = this._applySnapshots(stockSnaps);
    const cryptoCount = this._applySnapshots(cryptoSnaps);
    this.snapshotSeeds = stockCount + cryptoCount;
    this.lastSnapshotRefresh = Date.now();
    console.log(`[AlpacaStream] Seeded ${stockCount} stocks + ${cryptoCount} crypto from snapshots`);
  }

  async _refreshSnapshots() {
    const [stockSnaps, cryptoSnaps] = await Promise.all([
      this._fetchStockSnapshots(this.stockSymbols),
      this._fetchCryptoSnapshots(),
    ]);
    const sc = this._applySnapshots(stockSnaps);
    const cc = this._applySnapshots(cryptoSnaps);
    this.lastSnapshotRefresh = Date.now();
    console.log(`[AlpacaStream] Refreshed ${sc} stocks + ${cc} crypto from snapshots`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Change Computation + Batch Flush
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
    const tickBatchUpdates = [];

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

      tickBatchUpdates.push({
        s: sym,
        last: Math.round(s.last * 100) / 100,
        lastTs: s.lastTs,
        dayChg, dayChgPct,
        ahChg, ahChgPct,
        session,
      });

      s.dirty = false;
    }

    // Push to PriceHub (backward-compat "prices" format)
    // Only push symbols with valid prevClose to avoid overwriting good frontend
    // data with pc=0/dc=null from wildcard-subscribed non-seeded symbols.
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
            source: "alpaca_stream_v2",
          }),
        }));
      } catch (e) {
        console.warn("[AlpacaStream] PriceHub push failed:", String(e).slice(0, 150));
      }
    }

    // KV write (throttled to every 10s to control cost)
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
            // Full update: symbol has valid prevClose from snapshot seeding
            merged[sym] = { ...ex, ...data };
          } else {
            // Partial update: only overwrite price + OHLCV, preserve existing
            // daily change data that may have been set by prior runs or the cron
            merged[sym] = {
              ...ex,
              p: data.p,
              t: data.t,
              dh: data.dh || ex.dh,
              dl: data.dl || ex.dl,
              dv: data.dv || ex.dv,
            };
          }
        }

        // Guard: don't write if merged set shrank significantly (KV stale-read protection)
        const mergedCount = Object.keys(merged).length;
        if (existingCount > 50 && mergedCount < existingCount * 0.8) {
          console.warn(`[AlpacaStream] KV write aborted: would shrink from ${existingCount} to ${mergedCount} symbols`);
        } else {
          await this.env.KV_TIMED.put("timed:prices", JSON.stringify({
            prices: merged,
            updated_at: now,
            ticker_count: mergedCount,
            _source: "alpaca_stream_v2",
          }));
          this.lastKvWrite = now;
        }
      } catch (e) {
        console.warn("[AlpacaStream] KV write failed:", String(e).slice(0, 150));
      }
    }

    this.lastFlush = now;
    this.flushCount++;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HTTP Handler
  // ══════════════════════════════════════════════════════════════════════════

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      try {
        const body = await request.json().catch(() => ({}));
        const symbols = body.symbols || [];
        if (symbols.length > 0) this.stockSymbols = symbols;

        if (!this.isRunning) {
          this.isRunning = true;
          this.startedAt = Date.now();
          this.tradesReceived = 0;
          this.barsReceived = 0;
          await this._seedFromSnapshots();
          await this._connectAll();
          await this.state.storage.setAlarm(Date.now() + 1000);
        } else if (symbols.length > 0) {
          await this._seedFromSnapshots();
        }
        return _json({
          ok: true, status: "running",
          symbols: this.stockSymbols.length,
          seeded: this.snapshotSeeds,
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
        stocksConnected: this.stocksWs?.readyState === 1,
        cryptoConnected: this.cryptoWs?.readyState === 1,
        symbolCount: Object.keys(this.symState).length,
        subscribedSymbols: this.stockSymbols.length,
        tradesReceived: this.tradesReceived,
        barsReceived: this.barsReceived,
        snapshotSeeds: this.snapshotSeeds,
        flushCount: this.flushCount,
        lastFlush: this.lastFlush,
        lastKvWrite: this.lastKvWrite,
        lastSnapshotRefresh: this.lastSnapshotRefresh,
        uptime: this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      });
    }

    // Backward-compat: GET /prices (used by cron as fallback data source)
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
            src: "alpaca_ws_v2",
          };
        }
      }
      return _json({ ok: true, prices, updated_at: Date.now() });
    }

    return new Response("Not found", { status: 404 });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Alarm Handler (batch flush + health check + snapshot refresh)
  // ══════════════════════════════════════════════════════════════════════════

  async alarm() {
    if (!this.isRunning) return;
    const now = Date.now();

    // 1. Flush dirty prices to PriceHub + KV
    await this._flushPrices();

    // 2. WS health check — reconnect if dropped
    if (!this.stocksWs || this.stocksWs.readyState !== 1) {
      console.log("[AlpacaStream] Stocks WS disconnected, reconnecting...");
      await this._connectStocks();
    }
    if (!this.cryptoWs || this.cryptoWs.readyState !== 1) {
      console.log("[AlpacaStream] Crypto WS disconnected, reconnecting...");
      await this._connectCrypto();
    }

    // 3. Periodic snapshot refresh
    const secSinceRefresh = (now - this.lastSnapshotRefresh) / 1000;
    const { mins, wd } = this._nowET();
    const isWeekday = !["Sat", "Sun"].includes(wd);
    let needsRefresh = false;

    if (isWeekday) {
      // 09:25 ET pre-open seed
      if (mins >= 565 && mins <= 566) {
        const key = `open-${wd}-${mins}`;
        if (this.lastBoundaryKey !== key) {
          needsRefresh = true;
          this.lastBoundaryKey = key;
          console.log("[AlpacaStream] Pre-open snapshot refresh (09:25 ET)");
        }
      }
      // 16:05 ET lock close anchor
      if (mins >= 965 && mins <= 966) {
        const key = `close-${wd}-${mins}`;
        if (this.lastBoundaryKey !== key) {
          needsRefresh = true;
          this.lastBoundaryKey = key;
          console.log("[AlpacaStream] Post-close snapshot refresh (16:05 ET)");
        }
      }
    }

    // Safety net: refresh every 60s
    if (secSinceRefresh > 60) needsRefresh = true;

    if (needsRefresh) {
      try {
        await this._refreshSnapshots();
      } catch (e) {
        console.warn("[AlpacaStream] Snapshot refresh failed:", String(e).slice(0, 200));
      }
    }

    // 4. Schedule next alarm
    const session = this._getSession();
    const interval = (session === "RTH" || session === "AH" || session === "PRE") ? 1000 : 10_000;
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket Connection Management
  // ══════════════════════════════════════════════════════════════════════════

  async _connectAll() {
    await Promise.allSettled([
      this._connectStocks(),
      this._connectCrypto(),
    ]);
  }

  async _connectStocks() {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) {
      console.warn("[AlpacaStream] Missing Alpaca credentials");
      return;
    }
    try { this.stocksWs?.close(); } catch (_) {}

    try {
      const resp = await fetch(STOCKS_WS_URL, {
        headers: { "Upgrade": "websocket" },
      });
      const ws = resp.webSocket;
      if (!ws) {
        console.error("[AlpacaStream] Stocks WS: no webSocket on response");
        return;
      }
      ws.accept();
      this.stocksWs = ws;

      ws.addEventListener("message", (event) => this._onStocksMessage(event.data));
      ws.addEventListener("close", (event) => {
        console.log(`[AlpacaStream] Stocks WS closed: code=${event.code}`);
        this.stocksWs = null;
      });
      ws.addEventListener("error", (event) => {
        console.error("[AlpacaStream] Stocks WS error:", event);
      });
      console.log("[AlpacaStream] Stocks WS connected, awaiting auth...");
    } catch (e) {
      console.error("[AlpacaStream] Stocks WS connect failed:", String(e).slice(0, 200));
    }
  }

  async _connectCrypto() {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) return;
    try { this.cryptoWs?.close(); } catch (_) {}

    try {
      const resp = await fetch(CRYPTO_WS_URL, {
        headers: { "Upgrade": "websocket" },
      });
      const ws = resp.webSocket;
      if (!ws) {
        console.error("[AlpacaStream] Crypto WS: no webSocket on response");
        return;
      }
      ws.accept();
      this.cryptoWs = ws;

      ws.addEventListener("message", (event) => this._onCryptoMessage(event.data));
      ws.addEventListener("close", (event) => {
        console.log(`[AlpacaStream] Crypto WS closed: code=${event.code}`);
        this.cryptoWs = null;
      });
      ws.addEventListener("error", (event) => {
        console.error("[AlpacaStream] Crypto WS error:", event);
      });
      console.log("[AlpacaStream] Crypto WS connected, awaiting auth...");
    } catch (e) {
      console.error("[AlpacaStream] Crypto WS connect failed:", String(e).slice(0, 200));
    }
  }

  _disconnectAll() {
    try { this.stocksWs?.close(); } catch (_) {}
    try { this.cryptoWs?.close(); } catch (_) {}
    this.stocksWs = null;
    this.cryptoWs = null;
    console.log("[AlpacaStream] Disconnected all WebSockets");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WS Message Handlers
  // ══════════════════════════════════════════════════════════════════════════

  _onStocksMessage(raw) {
    let msgs;
    try {
      msgs = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch { return; }
    if (!Array.isArray(msgs)) return;

    for (const msg of msgs) {
      const T = msg.T;

      if (T === "success" && msg.msg === "connected") {
        this.stocksWs.send(JSON.stringify({
          action: "auth",
          key: this.env.ALPACA_API_KEY_ID,
          secret: this.env.ALPACA_API_SECRET_KEY,
        }));
        continue;
      }

      if (T === "success" && msg.msg === "authenticated") {
        console.log("[AlpacaStream] Stocks authenticated, subscribing to trades...");
        this.reconnectAttempts = 0;
        if (this.stockSymbols.length > 150) {
          this.stocksWs.send(JSON.stringify({ action: "subscribe", trades: ["*"] }));
        } else {
          this.stocksWs.send(JSON.stringify({ action: "subscribe", trades: this.stockSymbols }));
        }
        continue;
      }

      if (T === "subscription") {
        const ct = Array.isArray(msg.trades) ? msg.trades.length : 0;
        const wild = msg.trades?.includes("*");
        console.log(`[AlpacaStream] Stocks subscribed: trades=${wild ? "*" : ct}`);
        continue;
      }

      if (T === "error") {
        console.error(`[AlpacaStream] Stocks error: code=${msg.code} msg=${msg.msg}`);
        continue;
      }

      // Trade event — primary price source
      if (T === "t") {
        this.tradesReceived++;
        const sym = msg.S;
        const price = Number(msg.p);
        if (!sym || !Number.isFinite(price) || price <= 0) continue;
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();

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
        continue;
      }

      // Bar event — supplementary OHLCV
      if (T === "b") {
        this.barsReceived++;
        const sym = msg.S;
        if (!sym) continue;
        const close = Number(msg.c);
        if (!Number.isFinite(close) || close <= 0) continue;
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();

        const existing = this.symState[sym];
        if (existing) {
          if (ts >= (existing.lastTs || 0)) {
            existing.last = close;
            existing.lastTs = ts;
          }
          if (Number(msg.h) > (existing.dayHigh || 0)) existing.dayHigh = Number(msg.h);
          if (existing.dayLow <= 0 || (Number(msg.l) > 0 && Number(msg.l) < existing.dayLow)) {
            existing.dayLow = Number(msg.l);
          }
          if (Number(msg.v) > 0) existing.dayVol = (existing.dayVol || 0) + Number(msg.v);
          existing.dirty = true;
        }
        continue;
      }
    }
  }

  _onCryptoMessage(raw) {
    let msgs;
    try {
      msgs = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch { return; }
    if (!Array.isArray(msgs)) return;

    for (const msg of msgs) {
      const T = msg.T;

      if (T === "success" && msg.msg === "connected") {
        this.cryptoWs.send(JSON.stringify({
          action: "auth",
          key: this.env.ALPACA_API_KEY_ID,
          secret: this.env.ALPACA_API_SECRET_KEY,
        }));
        continue;
      }

      if (T === "success" && msg.msg === "authenticated") {
        console.log("[AlpacaStream] Crypto authenticated, subscribing to trades...");
        this.cryptoWs.send(JSON.stringify({
          action: "subscribe",
          trades: Object.values(CRYPTO_MAP),
        }));
        continue;
      }

      if (T === "subscription") {
        console.log(`[AlpacaStream] Crypto subscribed: trades=${JSON.stringify(msg.trades)}`);
        continue;
      }

      if (T === "error") {
        console.error(`[AlpacaStream] Crypto error: code=${msg.code} msg=${msg.msg}`);
        continue;
      }

      if (T === "t") {
        this.tradesReceived++;
        const alpacaSym = msg.S;
        const sym = CRYPTO_REVERSE[alpacaSym] || alpacaSym?.replace("/", "");
        const price = Number(msg.p);
        if (!sym || !Number.isFinite(price) || price <= 0) continue;
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();

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
        continue;
      }

      if (T === "b") {
        this.barsReceived++;
        const alpacaSym = msg.S;
        const sym = CRYPTO_REVERSE[alpacaSym] || alpacaSym?.replace("/", "");
        if (!sym) continue;
        const close = Number(msg.c);
        if (!Number.isFinite(close) || close <= 0) continue;
        const existing = this.symState[sym];
        if (existing) {
          existing.last = close;
          existing.lastTs = msg.t ? new Date(msg.t).getTime() : Date.now();
          existing.dirty = true;
        }
        continue;
      }
    }
  }
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
