// AlpacaStream Durable Object — Phase 6 of Cloudflare Cost Optimization
//
// Replaces REST polling (alpacaFetchSnapshots + alpacaCronFetchLatest) with
// real-time Alpaca WebSocket streaming. Connects to Alpaca's SIP feed for
// stocks/ETFs and the crypto endpoint for BTC/ETH.
//
// Architecture:
//   Alpaca WS → AlpacaStream DO → PriceHub DO → Frontend WebSocket clients
//                                → KV (timed:prices)
//                                → D1 (ticker_candles) every 5 min
//
// Lifecycle:
//   Cron (every 1 min) → POST /start if market open → DO connects & streams
//   DO alarm (every 50s) → heartbeat, flush prices/bars, reconnect if needed
//   Cron (every 1 min) → POST /stop if market closed → DO disconnects

// Cloudflare Workers' fetch() requires https:// URLs for WebSocket upgrades;
// the Upgrade: websocket header handles the protocol switch.
const STOCKS_WS_URL = "https://stream.data.alpaca.markets/v2/sip";
const CRYPTO_WS_URL = "https://stream.data.alpaca.markets/v1beta3/crypto/us";

// Crypto symbol mapping: our internal symbols → Alpaca's format
const CRYPTO_MAP = { "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD" };
const CRYPTO_REVERSE = { "BTC/USD": "BTCUSD", "ETH/USD": "ETHUSD" };

// Tickers that are NOT available on Alpaca stocks WS (handled by TradingView)
const NON_ALPACA_TICKERS = new Set([
  "ES1!", "NQ1!", "YM1!", "RTY1!", "CL1!", "GC1!", "SI1!", "HG1!", "NG1!",
  "MES1!", "MNQ1!", "BTCUSD", "ETHUSD", "US500", "VIX", "SPX",
]);

export class AlpacaStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // In-memory state (reset on DO eviction — acceptable since we reconnect)
    this.stocksWs = null;
    this.cryptoWs = null;
    this.prices = {};        // { SYM: { p, t, o, h, l, c, v, dp, pc } }
    this.barBuffer = [];     // accumulated bars for D1 flush: [{ ticker, ts, o, h, l, c, v, tf }]
    this.lastFlush = 0;      // epoch ms of last D1 bar flush
    this.lastPricePush = 0;  // epoch ms of last PriceHub push
    this.lastKvWrite = 0;    // epoch ms of last KV timed:prices write
    this.stockSymbols = [];  // symbols subscribed on stocks WS
    this.reconnectAttempts = 0;
    this.isRunning = false;
    this.startedAt = 0;
    this.barsReceived = 0;
    this.tradesReceived = 0;
  }

  // ── HTTP handler (called by Worker) ──────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);

    // POST /start — called by cron when market opens
    if (request.method === "POST" && url.pathname === "/start") {
      try {
        const body = await request.json().catch(() => ({}));
        const symbols = body.symbols || [];
        if (symbols.length > 0) this.stockSymbols = symbols;

        if (!this.isRunning) {
          this.isRunning = true;
          this.startedAt = Date.now();
          this.barsReceived = 0;
          this.tradesReceived = 0;
          await this._connectAll();
          // Schedule heartbeat alarm
          await this.state.storage.setAlarm(Date.now() + 50_000);
        }
        return _json({ ok: true, status: "running", symbols: this.stockSymbols.length });
      } catch (e) {
        return _json({ ok: false, error: String(e).slice(0, 300) }, 500);
      }
    }

    // POST /stop — called by cron when market closes
    if (request.method === "POST" && url.pathname === "/stop") {
      this._disconnectAll();
      this.isRunning = false;
      return _json({ ok: true, status: "stopped" });
    }

    // GET /status — diagnostics
    if (url.pathname === "/status") {
      return _json({
        ok: true,
        isRunning: this.isRunning,
        startedAt: this.startedAt,
        stocksConnected: this.stocksWs?.readyState === 1,
        cryptoConnected: this.cryptoWs?.readyState === 1,
        priceCount: Object.keys(this.prices).length,
        barBufferSize: this.barBuffer.length,
        barsReceived: this.barsReceived,
        tradesReceived: this.tradesReceived,
        lastFlush: this.lastFlush,
        lastPricePush: this.lastPricePush,
        lastKvWrite: this.lastKvWrite,
        subscribedSymbols: this.stockSymbols.length,
        uptime: this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      });
    }

    // GET /prices — return current in-memory prices (used by cron as data source)
    if (url.pathname === "/prices") {
      return _json({ ok: true, prices: this.prices, updated_at: Date.now() });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Alarm handler (heartbeat every ~50s) ─────────────────────────────────
  async alarm() {
    if (!this.isRunning) return;

    const now = Date.now();

    // Reconnect if WebSocket dropped
    if (!this.stocksWs || this.stocksWs.readyState !== 1) {
      console.log("[AlpacaStream] Stocks WS disconnected, reconnecting...");
      await this._connectStocks();
    }
    if (!this.cryptoWs || this.cryptoWs.readyState !== 1) {
      console.log("[AlpacaStream] Crypto WS disconnected, reconnecting...");
      await this._connectCrypto();
    }

    // Push prices to PriceHub every ~60 seconds
    if (now - this.lastPricePush >= 55_000) {
      await this._pushPricesToHub();
    }

    // Write prices to KV every ~60 seconds
    if (now - this.lastKvWrite >= 55_000) {
      await this._writePricesToKv();
    }

    // Flush bar buffer to D1 every ~5 minutes
    if (now - this.lastFlush >= 4.5 * 60_000 && this.barBuffer.length > 0) {
      await this._flushBarsToD1();
    }

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 50_000);
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
    try {
      this.stocksWs?.close();
    } catch (_) {}

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

      ws.addEventListener("message", (event) => {
        this._onStocksMessage(event.data);
      });
      ws.addEventListener("close", (event) => {
        console.log(`[AlpacaStream] Stocks WS closed: code=${event.code} reason=${event.reason}`);
        this.stocksWs = null;
      });
      ws.addEventListener("error", (event) => {
        console.error("[AlpacaStream] Stocks WS error:", event);
      });

      // Auth will happen after we receive the connected message
      console.log("[AlpacaStream] Stocks WS connected, awaiting auth...");
    } catch (e) {
      console.error("[AlpacaStream] Stocks WS connect failed:", String(e).slice(0, 200));
    }
  }

  async _connectCrypto() {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) return;
    try {
      this.cryptoWs?.close();
    } catch (_) {}

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

      ws.addEventListener("message", (event) => {
        this._onCryptoMessage(event.data);
      });
      ws.addEventListener("close", (event) => {
        console.log(`[AlpacaStream] Crypto WS closed: code=${event.code} reason=${event.reason}`);
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
  // Message Handlers
  // ══════════════════════════════════════════════════════════════════════════

  _onStocksMessage(raw) {
    let msgs;
    try {
      msgs = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch { return; }
    if (!Array.isArray(msgs)) return;

    for (const msg of msgs) {
      const T = msg.T;

      // Connection success → authenticate
      if (T === "success" && msg.msg === "connected") {
        this.stocksWs.send(JSON.stringify({
          action: "auth",
          key: this.env.ALPACA_API_KEY_ID,
          secret: this.env.ALPACA_API_SECRET_KEY,
        }));
        continue;
      }

      // Auth success → subscribe
      if (T === "success" && msg.msg === "authenticated") {
        console.log("[AlpacaStream] Stocks authenticated, subscribing to bars...");
        this.reconnectAttempts = 0;
        // Subscribe to minute bars for all stock symbols
        // Use wildcard if we have many symbols, or list them explicitly
        if (this.stockSymbols.length > 150) {
          // Wildcard subscription for bars (covers all symbols)
          this.stocksWs.send(JSON.stringify({
            action: "subscribe",
            bars: ["*"],
          }));
        } else {
          this.stocksWs.send(JSON.stringify({
            action: "subscribe",
            bars: this.stockSymbols,
          }));
        }
        continue;
      }

      // Subscription confirmation
      if (T === "subscription") {
        const barCount = Array.isArray(msg.bars) ? msg.bars.length : 0;
        const isWildcard = msg.bars?.includes("*");
        console.log(`[AlpacaStream] Stocks subscribed: bars=${isWildcard ? "*" : barCount}`);
        continue;
      }

      // Error
      if (T === "error") {
        console.error(`[AlpacaStream] Stocks error: code=${msg.code} msg=${msg.msg}`);
        continue;
      }

      // Bar message: T="b"
      if (T === "b") {
        this.barsReceived++;
        const sym = msg.S;
        if (!sym) continue;
        const close = Number(msg.c);
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();
        if (!Number.isFinite(close) || close <= 0) continue;

        // Update in-memory price
        this.prices[sym] = {
          p: close,
          t: ts,
          o: Number(msg.o) || close,
          h: Number(msg.h) || close,
          l: Number(msg.l) || close,
          c: close,
          v: Number(msg.v) || 0,
          src: "alpaca_ws",
        };

        // Buffer for D1 flush (5-minute candle aggregation will be done by existing cron)
        this.barBuffer.push({
          ticker: sym,
          ts: Math.floor(ts / 60000) * 60000, // floor to minute
          o: Number(msg.o) || close,
          h: Number(msg.h) || close,
          l: Number(msg.l) || close,
          c: close,
          v: Number(msg.v) || 0,
          tf: "1",
        });
        continue;
      }

      // Trade message: T="t" (for real-time price updates)
      if (T === "t") {
        this.tradesReceived++;
        const sym = msg.S;
        const price = Number(msg.p);
        if (!sym || !Number.isFinite(price) || price <= 0) continue;
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();

        // Update price only if newer
        if (!this.prices[sym] || ts >= (this.prices[sym].t || 0)) {
          if (this.prices[sym]) {
            this.prices[sym].p = price;
            this.prices[sym].t = ts;
          } else {
            this.prices[sym] = { p: price, t: ts, src: "alpaca_ws" };
          }
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
        console.log("[AlpacaStream] Crypto authenticated, subscribing...");
        this.cryptoWs.send(JSON.stringify({
          action: "subscribe",
          bars: Object.values(CRYPTO_MAP), // ["BTC/USD", "ETH/USD"]
        }));
        continue;
      }

      if (T === "subscription") {
        console.log(`[AlpacaStream] Crypto subscribed: bars=${JSON.stringify(msg.bars)}`);
        continue;
      }

      if (T === "error") {
        console.error(`[AlpacaStream] Crypto error: code=${msg.code} msg=${msg.msg}`);
        continue;
      }

      // Bar: T="b"
      if (T === "b") {
        this.barsReceived++;
        const alpacaSym = msg.S; // "BTC/USD"
        const sym = CRYPTO_REVERSE[alpacaSym] || alpacaSym?.replace("/", "");
        if (!sym) continue;
        const close = Number(msg.c);
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();
        if (!Number.isFinite(close) || close <= 0) continue;

        this.prices[sym] = {
          p: close, t: ts,
          o: Number(msg.o) || close,
          h: Number(msg.h) || close,
          l: Number(msg.l) || close,
          c: close,
          v: Number(msg.v) || 0,
          src: "alpaca_ws_crypto",
        };

        this.barBuffer.push({
          ticker: sym, ts: Math.floor(ts / 60000) * 60000,
          o: Number(msg.o) || close, h: Number(msg.h) || close,
          l: Number(msg.l) || close, c: close,
          v: Number(msg.v) || 0, tf: "1",
        });
        continue;
      }

      // Trade: T="t"
      if (T === "t") {
        this.tradesReceived++;
        const alpacaSym = msg.S;
        const sym = CRYPTO_REVERSE[alpacaSym] || alpacaSym?.replace("/", "");
        const price = Number(msg.p);
        if (!sym || !Number.isFinite(price) || price <= 0) continue;
        const ts = msg.t ? new Date(msg.t).getTime() : Date.now();
        if (this.prices[sym]) {
          this.prices[sym].p = price;
          this.prices[sym].t = ts;
        } else {
          this.prices[sym] = { p: price, t: ts, src: "alpaca_ws_crypto" };
        }
        continue;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Data Flush Operations
  // ══════════════════════════════════════════════════════════════════════════

  async _pushPricesToHub() {
    if (Object.keys(this.prices).length === 0) return;
    this.lastPricePush = Date.now();

    // Forward to PriceHub for WebSocket broadcast to clients
    if (!this.env.PRICE_HUB) return;
    try {
      const id = this.env.PRICE_HUB.idFromName("global");
      const hub = this.env.PRICE_HUB.get(id);
      await hub.fetch(new Request("https://internal/ws/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "prices",
          data: this.prices,
          updated_at: Date.now(),
          source: "alpaca_stream",
        }),
      }));
    } catch (e) {
      console.warn("[AlpacaStream] PriceHub push failed:", String(e).slice(0, 150));
    }
  }

  async _writePricesToKv() {
    if (Object.keys(this.prices).length === 0) return;
    this.lastKvWrite = Date.now();

    const KV = this.env.KV_TIMED;
    if (!KV) return;
    try {
      // Write intraday bar fields to KV. The price cron (every 1 min) sets the
      // authoritative `p` (current price) with sanity checks applied. We only merge
      // supplementary bar data (t, o, h, l, c, v) here to avoid overwriting
      // sanity-corrected prices with bad SIP prints.
      const pricePayload = {};
      for (const [sym, data] of Object.entries(this.prices)) {
        pricePayload[sym] = {
          t: data.t,
          o: data.o,
          h: data.h,
          l: data.l,
          c: data.c,
          v: data.v,
        };
      }
      // Deep-merge with existing prices: preserve p/pc/dc/dp fields that
      // the price feed cron sets (current price, prev_close, day_change, etc.)
      let existing = {};
      try {
        const raw = await KV.get("timed:prices", "json");
        existing = raw?.prices || {};
      } catch (_) {}

      const merged = { ...existing };
      for (const [sym, data] of Object.entries(pricePayload)) {
        merged[sym] = { ...(existing[sym] || {}), ...data };
      }
      await KV.put("timed:prices", JSON.stringify({
        prices: merged,
        updated_at: Date.now(),
        ticker_count: Object.keys(merged).length,
        _source: "alpaca_stream_merge",
      }));
    } catch (e) {
      console.warn("[AlpacaStream] KV write failed:", String(e).slice(0, 150));
    }
  }

  async _flushBarsToD1() {
    const db = this.env.DB;
    if (!db || this.barBuffer.length === 0) return;

    const bars = [...this.barBuffer];
    this.barBuffer = [];
    this.lastFlush = Date.now();

    // Batch insert bars into D1 ticker_candles
    // Use INSERT OR REPLACE to handle duplicates
    const BATCH_SIZE = 200;
    let total = 0;
    try {
      for (let i = 0; i < bars.length; i += BATCH_SIZE) {
        const chunk = bars.slice(i, i + BATCH_SIZE);
        const stmts = chunk.map(b =>
          db.prepare(
            `INSERT OR REPLACE INTO ticker_candles (ticker, tf, ts, o, h, l, c, v)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
          ).bind(b.ticker, b.tf, b.ts, b.o, b.h, b.l, b.c, b.v)
        );
        await db.batch(stmts);
        total += chunk.length;
      }
      console.log(`[AlpacaStream] Flushed ${total} bars to D1`);
    } catch (e) {
      console.error("[AlpacaStream] D1 flush failed:", String(e).slice(0, 200));
      // Put unflushed bars back for retry
      this.barBuffer = [...bars, ...this.barBuffer];
    }
  }
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
