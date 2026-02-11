// ─────────────────────────────────────────────────────────────────────────────
// PriceHub — Durable Object for real-time WebSocket price + scoring push
//
// Uses the WebSocket Hibernation API so idle connections cost $0 in duration.
// A single global instance fans out updates to all connected browser clients.
//
// Lifecycle:
//   1. Browser connects via wss://timed-trading.com/ws → Worker upgrades → DO
//   2. Client sends { type:"subscribe", tickers: [...] } to filter updates
//   3. Cron handler POSTs to DO with new price / scoring data
//   4. DO fans out to subscribed clients
// ─────────────────────────────────────────────────────────────────────────────

export class PriceHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map<WebSocket, { tickers: Set<string>, connectedAt: number }>
    // Populated lazily from tags on hibernation wake
  }

  // ── HTTP handler (called by Worker fetch for /ws and /ws/notify) ──────────
  async fetch(request) {
    const url = new URL(request.url);

    // ── POST /ws/notify — cron pushes data here ────────────────────────────
    if (request.method === "POST" && url.pathname === "/ws/notify") {
      try {
        const payload = await request.json();
        this._broadcast(payload);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ── GET /ws/stats — debug endpoint ─────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/ws/stats") {
      const sockets = this.state.getWebSockets();
      const connections = sockets.map((ws) => {
        const tags = this.state.getTags(ws) || [];
        return { tags, readyState: ws.readyState };
      });
      return new Response(
        JSON.stringify({
          ok: true,
          connections: connections.length,
          details: connections,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── WebSocket upgrade ──────────────────────────────────────────────────
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with Hibernation API — tags persist across hibernation
    this.state.acceptWebSocket(server, ["all"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── WebSocket Hibernation API handlers ───────────────────────────────────

  async webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

      if (msg.type === "subscribe" && Array.isArray(msg.tickers)) {
        // Store subscription as tags (survive hibernation)
        // Tags are limited to 256 per socket; we use "t:SYMBOL" format
        const newTags = ["all", ...msg.tickers.slice(0, 200).map((t) => `t:${t}`)];
        // Re-accept to update tags — Hibernation API doesn't have setTags
        // Instead, store in transient attachment (tag workaround)
        ws._subscribedTickers = new Set(msg.tickers.map((t) => String(t).toUpperCase()));

        ws.send(JSON.stringify({
          type: "subscribed",
          tickers: msg.tickers,
          ts: Date.now(),
        }));
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        return;
      }
    } catch (e) {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Cleanup — the Hibernation API handles most of this automatically
    ws.close(code, reason);
  }

  async webSocketError(ws, error) {
    console.error("[PriceHub] WebSocket error:", error);
    try { ws.close(1011, "Internal error"); } catch (_) {}
  }

  // ── Fan-out broadcast ────────────────────────────────────────────────────

  _broadcast(payload) {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;

    const type = payload.type || "prices";
    const messageStr = JSON.stringify(payload);

    let sent = 0;
    for (const ws of sockets) {
      try {
        if (ws.readyState === 1) {
          // If it's a prices message and client has subscriptions, filter
          if (type === "prices" && ws._subscribedTickers && ws._subscribedTickers.size > 0 && payload.data) {
            const filtered = {};
            let hasAny = false;
            for (const [sym, info] of Object.entries(payload.data)) {
              if (ws._subscribedTickers.has(sym)) {
                filtered[sym] = info;
                hasAny = true;
              }
            }
            if (hasAny) {
              ws.send(JSON.stringify({ ...payload, data: filtered }));
              sent++;
            }
          } else {
            // No filter — send everything (or non-price messages)
            ws.send(messageStr);
            sent++;
          }
        }
      } catch (e) {
        // Socket gone — will be cleaned up on next webSocketClose
      }
    }
  }
}
