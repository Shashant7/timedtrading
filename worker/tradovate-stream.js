// ═══════════════════════════════════════════════════════════════════════════════
// TradovateStream — TwelveData-grade WebSocket DO for futures via Tradovate
//
// Mirrors the worker/price-stream.js pattern (PriceStream DO for equities) but
// connects to Tradovate's market-data WebSocket and translates per-tick quotes
// into the same `timed:heartbeat:<TV_SYMBOL>` KV format the existing TV-webhook
// path already writes, so the rest of the system is a drop-in consumer.
//
// Replaces the fragile TradingView indicator → /timed/heartbeat webhook path
// for futures. The TV webhook stays available as a fallback during the
// parallel-feed period.
//
// Tradovate WS protocol (from docs/openapi.json + Tradovate WS docs):
//   - Connect to wss://md-live.tradovateapi.com/v1/websocket
//   - Server sends 'o' frame on open
//   - Client sends auth: `authorize\n0\n\n<mdAccessToken>`
//   - Server replies with `a[{i:0, s:200}]` on success
//   - Client sends heartbeat `[]` every 2.5 seconds
//   - Server sends 'h' or 'o' frames as its own heartbeat
//   - Subscribe: `md/subscribequote\n<reqId>\n\n{"symbol":"ESM6"}`
//   - Quote messages arrive as `a[{e:"md", d:{quotes:[...]}}]`
//
// Lifecycle log (same as PriceStream DO) lets us see how often CF cycles us.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  tradovateGetMdAccessToken,
  tradovateSymbolFor,
  tradovateTrackedTvSymbols,
  tvSymbolForTradovate,
  tradovateWsUrl,
} from "./tradovate.js";

const HEARTBEAT_INTERVAL_MS = 2500;       // client → server every 2.5s
const SERVER_TIMEOUT_MS = 10_000;          // dead connection if no server msg in 10s
const FLUSH_INTERVAL_MS = 1_000;           // batch quote writes to KV at 1s cadence
const HEARTBEAT_KV_TTL = 2 * 24 * 60 * 60; // 2 days, matches the TV path

export class TradovateStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.ws = null;
    this.isAuthenticated = false;
    this.authenticationSent = false;
    this.isRunning = false;
    this.startedAt = 0;
    this.lastServerMessageAt = 0;
    this.heartbeatsSent = 0;
    this.requestIdCounter = 2; // 0=auth, 1=reserved
    this.subscribedTvSymbols = new Set();
    this.subscribedContractSymbols = new Set(); // Tradovate-format e.g. "ESM6"
    this.symbolsRoll = new Map(); // tvSym → tradovate contract for current cycle
    this.symState = {};           // per-tv-symbol latest tick
    this.pricesReceived = 0;
    this.flushCount = 0;
    this.lastFlush = 0;

    // Lifecycle log — same pattern as PriceStream DO
    this.state.blockConcurrencyWhile(async () => {
      try { await this._recordLifecycleEvent("instantiated", {}); } catch {}
    });
  }

  async _recordLifecycleEvent(event, meta = {}) {
    try {
      const existing = (await this.state.storage.get("lifecycle:history")) || [];
      const entry = { ts: Date.now(), event, ...meta };
      const next = [entry, ...existing].slice(0, 30);
      await this.state.storage.put("lifecycle:history", next);
    } catch (e) {
      console.warn("[TradovateStream] lifecycle log write failed:", String(e).slice(0, 120));
    }
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async _connect() {
    if (this.ws) {
      try { this.ws.close(1000, "reconnect"); } catch {}
      this.ws = null;
    }
    const wsUrl = tradovateWsUrl(this.env);
    let ws;
    // CF-native fetch upgrade first, fall back to standard WebSocket.
    try {
      const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
      if (resp.status === 101 && resp.webSocket) {
        ws = resp.webSocket;
        ws.accept();
      } else {
        throw new Error(`fetch_upgrade_status_${resp.status}`);
      }
    } catch (fetchErr) {
      console.warn("[TradovateStream] fetch upgrade failed, trying standard WebSocket:", String(fetchErr).slice(0, 120));
      ws = new WebSocket(wsUrl);
      // Wait for open
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws_open_timeout")), 10_000);
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
        ws.addEventListener("error", (e) => { clearTimeout(t); reject(e); });
      });
    }
    this.ws = ws;
    this.lastServerMessageAt = Date.now();
    this.isAuthenticated = false;
    this.authenticationSent = false;
    ws.addEventListener("message", (event) => this._onMessage(event.data));
    ws.addEventListener("close", (event) => {
      console.log(`[TradovateStream] WS closed: code=${event.code} reason=${event.reason}`);
      this.isAuthenticated = false;
      this.authenticationSent = false;
    });
    ws.addEventListener("error", (event) => {
      console.warn("[TradovateStream] WS error:", String(event.message || event).slice(0, 200));
    });
  }

  async _onMessage(raw) {
    this.lastServerMessageAt = Date.now();
    const msg = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

    // Single-character frames: 'o' = open/heartbeat, 'h' = heartbeat, 'c' = close
    if (msg.length === 1) {
      if (msg === "o" && !this.authenticationSent) {
        await this._sendAuth();
      }
      return;
    }

    // Array messages: 'a[...]'
    if (msg.startsWith("a[")) {
      let arr;
      try {
        arr = JSON.parse(msg.substring(1));
      } catch (e) {
        console.warn("[TradovateStream] bad array frame:", msg.slice(0, 200));
        return;
      }
      for (const m of arr) this._handleEnvelope(m);
      return;
    }
    // Anything else — log lightly
    if (msg.length < 500) {
      console.log("[TradovateStream] unexpected frame:", msg.slice(0, 200));
    }
  }

  _handleEnvelope(m) {
    // Auth response: { i: 0, s: 200, d: {...} }
    if (m.i === 0 && !this.isAuthenticated) {
      if (m.s === 200) {
        this.isAuthenticated = true;
        console.log("[TradovateStream] authenticated.");
        // Re-subscribe to all symbols on (re)connect
        this._resubscribeAll();
      } else {
        console.error("[TradovateStream] auth FAILED:", JSON.stringify(m).slice(0, 300));
      }
      return;
    }

    // Subscribe response: { i: <reqId>, s: 200, d: {...} } — ignore
    if (m.s != null && m.i != null && m.i > 0) return;

    // Quote stream: { e: "md", d: { quotes: [{ contractId, timestamp, bid, ask, last, ... }] } }
    if (m.e === "md" && m.d) {
      // Two payload styles:
      //   d.quotes = [...]                 (per-quote frame)
      //   d = { quotes: { ESM6: {...} } }  (alt shape)
      const quotes = Array.isArray(m.d.quotes) ? m.d.quotes
                   : (m.d.quotes && typeof m.d.quotes === "object" ? Object.entries(m.d.quotes).map(([k, v]) => ({ ...v, contractName: k })) : null);
      if (!quotes) return;
      for (const q of quotes) {
        this._ingestQuote(q);
      }
    }
  }

  _ingestQuote(q) {
    // q = { contractId, contractName?, timestamp, bid, ask, last, totalVolume, ... }
    // For "Last" trades: q.entries.Trade.price OR q.last (depends on format).
    // We accept several shapes for robustness — Tradovate has a few formats.
    const tdSym = String(q.contractName || q.symbol || "").toUpperCase();
    if (!tdSym) return;
    const tvSym = tvSymbolForTradovate(tdSym, new Date());
    if (!tvSym) return;

    const last = Number(
      q.last ??
      (q.entries?.Trade?.price) ??
      (q.entries?.LowPrice?.price) ?? // Tradovate sometimes uses entries object
      q.bid ?? q.ask ?? 0
    );
    if (!Number.isFinite(last) || last <= 0) return;

    const high = Number(q.entries?.HighPrice?.price ?? q.high ?? 0) || undefined;
    const low  = Number(q.entries?.LowPrice?.price ?? q.low ?? 0)  || undefined;
    const open = Number(q.entries?.OpeningPrice?.price ?? q.open ?? 0) || undefined;
    const vol  = Number(q.totalVolume ?? q.volume ?? 0) || undefined;
    const tsRaw = q.timestamp ? new Date(q.timestamp).getTime() : Date.now();

    // Maintain per-symbol state for batched flush + day-change overlay
    const prev = this.symState[tvSym] || {};
    this.symState[tvSym] = {
      last, high: high ?? prev.high, low: low ?? prev.low,
      open: open ?? prev.open, vol: vol ?? prev.vol,
      ts: tsRaw,
      tdSym,
    };
    this.pricesReceived++;
  }

  async _sendAuth() {
    let token;
    try { token = await tradovateGetMdAccessToken(this.env); }
    catch (e) {
      console.error("[TradovateStream] auth token fetch failed:", String(e).slice(0, 200));
      return;
    }
    const frame = `authorize\n0\n\n${token}`;
    try {
      this.ws.send(frame);
      this.authenticationSent = true;
    } catch (e) {
      console.warn("[TradovateStream] auth send failed:", String(e).slice(0, 150));
    }
  }

  _sendSubscribe(contractSymbol) {
    if (!this.ws || !this.isAuthenticated) return;
    const reqId = this.requestIdCounter++;
    const frame = `md/subscribequote\n${reqId}\n\n${JSON.stringify({ symbol: contractSymbol })}`;
    try {
      this.ws.send(frame);
      this.subscribedContractSymbols.add(contractSymbol);
    } catch (e) {
      console.warn("[TradovateStream] subscribe send failed:", String(e).slice(0, 150));
    }
  }

  _resubscribeAll() {
    this.subscribedContractSymbols.clear();
    for (const tvSym of this.subscribedTvSymbols) {
      const td = tradovateSymbolFor(tvSym, new Date());
      if (td) {
        this.symbolsRoll.set(tvSym, td);
        this._sendSubscribe(td);
      }
    }
  }

  _sendHeartbeat() {
    if (!this.ws) return;
    try {
      this.ws.send("[]");
      this.heartbeatsSent++;
    } catch (e) {
      console.warn("[TradovateStream] heartbeat send failed:", String(e).slice(0, 150));
    }
  }

  // ── KV flush — write per-symbol ticks to timed:heartbeat:<TV_SYM> ──────────
  async _flush() {
    const KV = this.env?.KV_TIMED;
    if (!KV) return;
    const writes = [];
    for (const [tvSym, s] of Object.entries(this.symState)) {
      // Reuse the SAME shape the TV /timed/heartbeat endpoint writes
      const payload = {
        ticker: tvSym,
        ts: s.ts,
        price: s.last,
        prev_close: s.prevClose || undefined, // not provided by ticks; comes from end-of-day cache
        day_change: undefined,
        day_change_pct: undefined,
        session: undefined,
        is_rth: undefined,
        ingest_ts: Date.now(),
        ingest_kind: "tradovate_ws",
        // Higher priority than the TV heartbeat for the merge logic in /timed/all.
        src: "tradovate_ws",
      };
      writes.push(KV.put(`timed:heartbeat:${tvSym}`, JSON.stringify(payload), {
        expirationTtl: HEARTBEAT_KV_TTL,
      }));
    }
    if (writes.length === 0) return;
    try {
      await Promise.all(writes);
      this.lastFlush = Date.now();
      this.flushCount++;
    } catch (e) {
      console.warn("[TradovateStream] KV flush failed:", String(e).slice(0, 150));
    }
  }

  // ── Alarm-driven event loop (same self-heal pattern as PriceStream) ────────
  async alarm() {
    if (!this.isRunning) return;

    // Reconnect if WS dropped
    if (!this.ws) {
      try { await this._connect(); }
      catch (e) { console.warn("[TradovateStream] reconnect failed:", String(e).slice(0, 200)); }
    }

    // Send heartbeat (TX side)
    if (this.isAuthenticated) this._sendHeartbeat();

    // Server timeout check
    const sinceServer = Date.now() - this.lastServerMessageAt;
    if (this.ws && sinceServer > SERVER_TIMEOUT_MS) {
      console.warn(`[TradovateStream] no server msg in ${sinceServer}ms — reconnecting.`);
      try { this.ws.close(4000, "server_timeout"); } catch {}
      this.ws = null;
    }

    // Flush prices to KV at the configured cadence
    if (Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS) {
      await this._flush();
    }

    // Re-arm alarm — heartbeat cadence drives the loop
    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // ── HTTP interface (matches the PriceStream DO surface) ────────────────────
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      try {
        const body = await request.json().catch(() => ({}));
        const tvSyms = Array.isArray(body.tvSymbols) && body.tvSymbols.length > 0
          ? body.tvSymbols
          : tradovateTrackedTvSymbols();

        // Update subscription list
        this.subscribedTvSymbols = new Set(tvSyms.filter(s => tradovateSymbolFor(s, new Date()) != null));

        if (!this.isRunning) {
          this.isRunning = true;
          this.startedAt = Date.now();
          this.pricesReceived = 0;
          await this._connect();
          await this.state.storage.setAlarm(Date.now() + 1000);
          await this._recordLifecycleEvent("started", { symbolCount: this.subscribedTvSymbols.size });
        } else if (tvSyms.length > 0) {
          // Already running — subscribe to any new symbols
          this._resubscribeAll();
        }
        return _json({
          ok: true, status: "running",
          tvSymbols: this.subscribedTvSymbols.size,
          contractSymbols: this.subscribedContractSymbols.size,
        });
      } catch (e) {
        return _json({ ok: false, error: String(e).slice(0, 300) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      const _uptime = this.startedAt > 0 ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
      await this._flush();
      try { if (this.ws) this.ws.close(1000, "stop"); } catch {}
      this.ws = null;
      this.isRunning = false;
      this.isAuthenticated = false;
      this.authenticationSent = false;
      await this._recordLifecycleEvent("stopped", { uptime: _uptime, prices: this.pricesReceived });
      return _json({ ok: true, status: "stopped" });
    }

    if (url.pathname === "/status") {
      let lifecycle = [];
      try { lifecycle = (await this.state.storage.get("lifecycle:history")) || []; } catch {}
      const now = Date.now();
      const last24h = lifecycle.filter(e => (now - e.ts) < 86400000);
      const subscriptions = [];
      for (const tvSym of this.subscribedTvSymbols) {
        subscriptions.push({
          tv: tvSym,
          contract: this.symbolsRoll.get(tvSym) || tradovateSymbolFor(tvSym, new Date()),
          lastPrice: this.symState[tvSym]?.last || null,
          lastTs: this.symState[tvSym]?.ts || null,
        });
      }
      return _json({
        ok: true,
        isRunning: this.isRunning,
        isAuthenticated: this.isAuthenticated,
        startedAt: this.startedAt,
        uptime: this.startedAt > 0 ? Math.round((now - this.startedAt) / 1000) : 0,
        pricesReceived: this.pricesReceived,
        flushCount: this.flushCount,
        lastFlush: this.lastFlush,
        heartbeatsSent: this.heartbeatsSent,
        lastServerMessageAt: this.lastServerMessageAt,
        sinceLastServerMessageMs: this.lastServerMessageAt ? now - this.lastServerMessageAt : null,
        tvSymbolCount: this.subscribedTvSymbols.size,
        contractSymbolCount: this.subscribedContractSymbols.size,
        subscriptions,
        provider: "tradovate",
        lifecycle: {
          last24h: {
            instantiations: last24h.filter(e => e.event === "instantiated").length,
            starts: last24h.filter(e => e.event === "started").length,
            stops: last24h.filter(e => e.event === "stopped").length,
          },
          recent: lifecycle.slice(0, 10),
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
