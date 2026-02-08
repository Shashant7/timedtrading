/**
 * Execution Adapter — mirrors Alpaca Trading API v2
 *
 * Provides a clean swap path from simulation → paper → live trading.
 * All trade mutations (entry, trim, exit, SL updates) go through this adapter.
 *
 * Backends:
 *   SimulationBackend  — instant fill, KV+D1 state (default, current behavior)
 *   AlpacaPaperBackend — forwards to paper-api.alpaca.markets/v2/*
 *   AlpacaLiveBackend  — (future) forwards to api.alpaca.markets/v2/*
 *
 * Usage:
 *   const adapter = createExecutionAdapter(env);
 *   const order = await adapter.submitOrder({ symbol, qty, side, ... });
 */

// ─────────────────────────────────────────────────────────────────────────────
// Order / Position shapes (Alpaca-compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OrderParams
 * @property {string}  symbol
 * @property {number}  qty
 * @property {'buy'|'sell'} side
 * @property {'market'|'limit'|'stop'|'stop_limit'|'trailing_stop'} type
 * @property {'day'|'gtc'|'ioc'} [time_in_force='gtc']
 * @property {number}  [limit_price]
 * @property {number}  [stop_price]
 * @property {'simple'|'bracket'|'oco'|'oto'} [order_class='simple']
 * @property {{limit_price: number}} [take_profit]
 * @property {{stop_price: number, limit_price?: number}} [stop_loss]
 * @property {number}  [trail_price]
 * @property {number}  [trail_percent]
 * @property {string}  [client_order_id]
 * @property {Object}  [_meta]  — simulation-specific context (trade object, portfolio, etc.)
 */

/**
 * @typedef {Object} OrderResult
 * @property {string}  id
 * @property {string}  client_order_id
 * @property {string}  status  — 'new'|'filled'|'partially_filled'|'canceled'|'expired'
 * @property {string}  symbol
 * @property {number}  qty
 * @property {number}  [filled_qty]
 * @property {number}  [filled_avg_price]
 * @property {string}  side
 * @property {string}  type
 * @property {string}  order_class
 * @property {Array}   [legs]  — child orders for bracket/oco
 * @property {Object}  [_trade] — simulation: the trade object created/updated
 */

/**
 * @typedef {Object} PositionResult
 * @property {string}  symbol
 * @property {number}  qty
 * @property {string}  side  — 'long'|'short'
 * @property {number}  avg_entry_price
 * @property {number}  current_price
 * @property {number}  market_value
 * @property {number}  unrealized_pl
 * @property {number}  unrealized_plpc
 */

/**
 * @typedef {Object} AccountResult
 * @property {number}  buying_power
 * @property {number}  portfolio_value
 * @property {number}  cash
 * @property {number}  positions_count
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base class: ExecutionAdapter interface
// ─────────────────────────────────────────────────────────────────────────────

class ExecutionAdapter {
  constructor(env) {
    this.env = env;
    this.mode = "base";
  }

  /** @returns {string} */
  get name() { return this.mode; }

  /** POST /v2/orders — Place a new order. */
  async submitOrder(/** @type {OrderParams} */ _params) {
    throw new Error("submitOrder() not implemented");
  }

  /** GET /v2/orders/{id} — Get an order by ID. */
  async getOrder(_orderId) {
    throw new Error("getOrder() not implemented");
  }

  /** GET /v2/orders — List orders. */
  async getOrders(_params) {
    throw new Error("getOrders() not implemented");
  }

  /** PATCH /v2/orders/{id} — Replace/update an order. */
  async replaceOrder(_orderId, _params) {
    throw new Error("replaceOrder() not implemented");
  }

  /** DELETE /v2/orders/{id} — Cancel an order. */
  async cancelOrder(_orderId) {
    throw new Error("cancelOrder() not implemented");
  }

  /** DELETE /v2/positions/{symbol} — Close a position (full or partial). */
  async closePosition(_symbol, _params) {
    throw new Error("closePosition() not implemented");
  }

  /** GET /v2/positions — List all open positions. */
  async getPositions() {
    throw new Error("getPositions() not implemented");
  }

  /** GET /v2/positions/{symbol} — Get a single position. */
  async getPosition(_symbol) {
    throw new Error("getPosition() not implemented");
  }

  /** GET /v2/account — Get account info. */
  async getAccount() {
    throw new Error("getAccount() not implemented");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SimulationBackend — wraps current KV+D1 behavior
// ─────────────────────────────────────────────────────────────────────────────

class SimulationBackend extends ExecutionAdapter {
  /**
   * @param {Object} env   — Cloudflare Worker env (KV, D1, secrets)
   * @param {Object} [deps] — injected D1 helper functions from index.js
   */
  constructor(env, deps = {}) {
    super(env);
    this.mode = "simulation";
    this.KV = env.KV_TIMED || env.KV;
    this.DB = env.DB;
    // D1 helpers injected from index.js (keeps them as single source of truth)
    this.d1UpsertTrade = deps.d1UpsertTrade || (async () => {});
    this.d1InsertTradeEvent = deps.d1InsertTradeEvent || (async () => {});
    this.d1InsertPosition = deps.d1InsertPosition || (async () => {});
    this.d1UpdatePosition = deps.d1UpdatePosition || (async () => {});
    this.d1UpdatePositionSL = deps.d1UpdatePositionSL || (async () => {});
    this.d1InsertExecutionAction = deps.d1InsertExecutionAction || (async () => {});
    this.d1InsertLot = deps.d1InsertLot || (async () => {});
  }

  /**
   * submitOrder — Simulation: instant fill at current price.
   *
   * For simulation, the caller (index.js) builds the trade object and passes
   * it via _meta.trade. This method persists it to D1 and returns an
   * Alpaca-compatible order result.
   *
   * For bracket orders, the take_profit and stop_loss are stored on the
   * trade object's tpArray and sl fields.
   */
  async submitOrder(params) {
    const trade = params._meta?.trade;
    const position = params._meta?.position;
    if (!trade) {
      return { id: null, status: "rejected", error: "No _meta.trade provided" };
    }

    // Persist trade to D1
    try {
      await this.d1UpsertTrade(this.env, trade);
    } catch (e) {
      console.error("[EXEC SIM] d1UpsertTrade failed:", e);
    }

    // Persist entry event
    if (trade.id && trade.history?.length > 0) {
      const entryEvent = trade.history.find(ev => ev.type === "ENTRY");
      if (entryEvent) {
        try {
          await this.d1InsertTradeEvent(this.env, trade.id, entryEvent);
        } catch (e) {
          console.error("[EXEC SIM] d1InsertTradeEvent failed:", e);
        }
      }
    }

    // Persist position
    if (position) {
      try {
        await this.d1InsertPosition(this.env, position);
      } catch (e) {
        console.error("[EXEC SIM] d1InsertPosition failed:", e);
      }
    }

    // Persist entry execution action
    if (trade.id) {
      try {
        const tsEntry = trade.entry_ts || Date.now();
        await this.d1InsertExecutionAction(this.env, {
          action_id: `${trade.id}-ENTRY-${tsEntry}`,
          position_id: trade.id,
          action_type: "ENTRY",
          qty: trade.shares,
          price: trade.entryPrice,
          ts: tsEntry,
          meta_json: JSON.stringify({
            direction: trade.direction,
            sl: trade.sl,
            tp: trade.tp,
            order_class: params.order_class || "bracket",
          }),
        });
      } catch (e) {
        console.error("[EXEC SIM] d1InsertExecutionAction failed:", e);
      }
    }

    // Persist initial lot
    if (trade.id) {
      try {
        await this.d1InsertLot(this.env, {
          lot_id: `${trade.id}-LOT-0`,
          position_id: trade.id,
          qty: trade.shares,
          entry_price: trade.entryPrice,
          entry_ts: trade.entry_ts || Date.now(),
          status: "OPEN",
        });
      } catch (e) {
        console.error("[EXEC SIM] d1InsertLot failed:", e);
      }
    }

    // Return Alpaca-compatible order result
    return {
      id: trade.id,
      client_order_id: params.client_order_id || trade.id,
      status: "filled",
      symbol: params.symbol,
      qty: trade.shares,
      filled_qty: trade.shares,
      filled_avg_price: trade.entryPrice,
      side: params.side,
      type: params.type || "market",
      order_class: params.order_class || "simple",
      legs: params.order_class === "bracket" ? [
        { id: `${trade.id}-TP`, type: "limit", side: params.side === "buy" ? "sell" : "buy", limit_price: params.take_profit?.limit_price, status: "held" },
        { id: `${trade.id}-SL`, type: "stop", side: params.side === "buy" ? "sell" : "buy", stop_price: params.stop_loss?.stop_price, status: "held" },
      ] : undefined,
      _trade: trade,
    };
  }

  /**
   * closePosition — Simulation: instant close at given price.
   *
   * Full close: params = { _price, _reason, _trade, _remainingShares, _pnl, _event }
   * Partial close (trim): params = { percentage, _price, _reason, _trade,
   *   _trimShares, _pnl, _event, _exitEvent, _isFullClose, _positionUpdates }
   *
   * D1 persistence extracted from closeTradeAtPrice/trimTradeToPct closures.
   * Caller (index.js) still handles: trade state mutation, portfolio cash, KV, Discord.
   */
  async closePosition(symbol, params = {}) {
    const trade = params._trade;
    if (!trade?.id) {
      return { ok: false, error: "No _trade with id provided" };
    }

    const price = Number(params._price);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, error: "Invalid _price" };
    }

    const isPartial = params._isPartialClose === true;

    if (isPartial) {
      // ── TRIM: partial close ──
      const event = params._event;
      const exitEvent = params._exitEvent;
      const isFullClose = params._isFullClose === true;
      const trimShares = Number(params._trimShares) || 0;
      const pnlRealized = Number(params._pnl) || 0;
      const positionUpdates = params._positionUpdates || {};

      // 1. Persist trade
      try {
        await this.d1UpsertTrade(this.env, trade);
      } catch (e) {
        console.error("[EXEC SIM] closePosition TRIM upsert failed:", e);
      }

      // 2. Persist TRIM event
      if (event) {
        try {
          await this.d1InsertTradeEvent(this.env, trade.id, event);
        } catch (e) {
          console.error("[EXEC SIM] closePosition TRIM event failed:", e);
        }
      }

      // 3. Persist EXIT event if this trim completes the position
      if (isFullClose && exitEvent) {
        try {
          await this.d1InsertTradeEvent(this.env, trade.id, exitEvent);
        } catch (e) {
          console.error("[EXEC SIM] closePosition TRIM EXIT event failed:", e);
        }
      }

      // 4. Execution action
      const tsTrim = event?.timestamp ? new Date(event.timestamp).getTime() : Date.now();
      try {
        await this.d1InsertExecutionAction(this.env, {
          action_id: `${trade.id}-TRIM-${tsTrim}`,
          position_id: trade.id,
          ts: tsTrim,
          action_type: isFullClose ? "EXIT" : "TRIM",
          qty: trimShares,
          price: price,
          value: price * trimShares,
          pnl_realized: pnlRealized,
          reason: isFullClose ? "TP_FULL" : (params._reason || "TRIM"),
        });
      } catch (e) {
        console.error("[EXEC SIM] closePosition TRIM action failed:", e);
      }

      // 5. Update position
      try {
        await this.d1UpdatePosition(this.env, trade.id, positionUpdates);
      } catch (e) {
        console.error("[EXEC SIM] closePosition TRIM position update failed:", e);
      }

      return { ok: true, symbol, price, partial: true, isFullClose, _trade: trade };

    } else {
      // ── EXIT: full close ──
      const event = params._event;
      const remainingShares = Number(params._remainingShares) || 0;
      const pnlRemaining = Number(params._pnl) || 0;

      // 1. Persist trade
      try {
        await this.d1UpsertTrade(this.env, trade);
      } catch (e) {
        console.error("[EXEC SIM] closePosition EXIT upsert failed:", e);
      }

      // 2. Persist EXIT event
      if (event) {
        try {
          await this.d1InsertTradeEvent(this.env, trade.id, event);
        } catch (e) {
          console.error("[EXEC SIM] closePosition EXIT event failed:", e);
        }
      }

      // 3. Execution action
      const tsExit = event?.timestamp ? new Date(event.timestamp).getTime() : Date.now();
      try {
        await this.d1InsertExecutionAction(this.env, {
          action_id: `${trade.id}-EXIT-${tsExit}`,
          position_id: trade.id,
          ts: tsExit,
          action_type: "EXIT",
          qty: remainingShares,
          price: price,
          value: price * remainingShares,
          pnl_realized: pnlRemaining,
          reason: params._reason || "EXIT",
        });
      } catch (e) {
        console.error("[EXEC SIM] closePosition EXIT action failed:", e);
      }

      // 4. Close position in D1
      try {
        await this.d1UpdatePosition(this.env, trade.id, {
          total_qty: 0,
          cost_basis: 0,
          updated_at: tsExit,
          status: "CLOSED",
          closed_at: tsExit,
        });
      } catch (e) {
        console.error("[EXEC SIM] closePosition EXIT position close failed:", e);
      }

      return { ok: true, symbol, price, partial: false, _trade: trade };
    }
  }

  /**
   * replaceOrder — Simulation: update SL (or TP) on the trade object.
   *
   * orderId = trade.id + "-SL" (the stop-loss leg)
   * params = { stop_price, _trade, _event, _reason }
   *
   * Handles D1 persistence: d1UpsertTrade, d1InsertTradeEvent, d1UpdatePositionSL.
   * Caller handles: KV exec state, Discord.
   */
  async replaceOrder(orderId, params = {}) {
    const trade = params._trade;
    if (!trade?.id) {
      return { ok: false, error: "No _trade with id provided" };
    }

    const newSL = Number(params.stop_price);
    if (!Number.isFinite(newSL) || newSL <= 0) {
      return { ok: false, error: "Invalid stop_price" };
    }

    const oldSL = Number(trade.sl);
    const ticker = String(trade.ticker || "").toUpperCase();

    // 1. Persist trade (caller already mutated trade.sl)
    try {
      await this.d1UpsertTrade(this.env, trade);
    } catch (e) {
      console.error("[EXEC SIM] replaceOrder d1UpsertTrade failed:", e);
    }

    // 2. Persist SL_TIGHTEN event if provided
    const event = params._event;
    if (event) {
      try {
        await this.d1InsertTradeEvent(this.env, trade.id, event);
      } catch (e) {
        console.error("[EXEC SIM] replaceOrder d1InsertTradeEvent failed:", e);
      }
    }

    // 3. Update position SL in D1
    if (ticker) {
      try {
        await this.d1UpdatePositionSL(this.env, ticker, newSL);
      } catch (e) {
        console.error("[EXEC SIM] replaceOrder d1UpdatePositionSL failed:", e);
      }
    }

    return {
      id: orderId,
      status: "replaced",
      stop_price: newSL,
      _old_stop_price: oldSL,
      _trade: trade,
    };
  }

  /** getPositions — List all open simulation positions from KV. */
  async getPositions() {
    if (!this.KV) return [];
    try {
      const raw = await this.KV.get("timed:trades:all", "json");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(t => t.status === "OPEN" || t.status === "TP_HIT_TRIM")
        .map(t => ({
          symbol: t.ticker,
          qty: Number(t.shares) || 0,
          side: String(t.direction || "").toLowerCase() === "short" ? "short" : "long",
          avg_entry_price: Number(t.entryPrice) || 0,
          current_price: Number(t.currentPrice) || 0,
          market_value: (Number(t.shares) || 0) * (Number(t.currentPrice) || 0),
          unrealized_pl: Number(t.unrealizedPnl) || 0,
          unrealized_plpc: Number(t.unrealizedPnlPct) || 0,
          _trade: t,
        }));
    } catch (e) {
      console.error("[EXEC SIM] getPositions failed:", e);
      return [];
    }
  }

  /** getPosition — Get a single position by symbol. */
  async getPosition(symbol) {
    const positions = await this.getPositions();
    return positions.find(p => p.symbol === symbol.toUpperCase()) || null;
  }

  /** getAccount — Return simulated account info. */
  async getAccount() {
    if (!this.KV) return { buying_power: 0, portfolio_value: 0, cash: 0, positions_count: 0 };
    try {
      const portfolio = await this.KV.get("timed:portfolio", "json") || {};
      const positions = await this.getPositions();
      const posValue = positions.reduce((sum, p) => sum + (p.market_value || 0), 0);
      const cash = Number(portfolio.cash) || 100000;
      return {
        buying_power: cash,
        portfolio_value: cash + posValue,
        cash: cash,
        positions_count: positions.length,
        _portfolio: portfolio,
      };
    } catch (e) {
      console.error("[EXEC SIM] getAccount failed:", e);
      return { buying_power: 0, portfolio_value: 0, cash: 0, positions_count: 0 };
    }
  }

  /** getOrders — Simulation has no pending orders (instant fill). */
  async getOrders(_params) {
    return [];
  }

  /** getOrder — Simulation: look up a completed order by trade ID. */
  async getOrder(orderId) {
    return { id: orderId, status: "filled" };
  }

  /** cancelOrder — No-op in simulation (orders fill instantly). */
  async cancelOrder(_orderId) {
    return { id: _orderId, status: "canceled" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AlpacaPaperBackend — forwards to paper-api.alpaca.markets
// ─────────────────────────────────────────────────────────────────────────────

class AlpacaPaperBackend extends ExecutionAdapter {
  constructor(env) {
    super(env);
    this.mode = "paper";
    this.baseUrl = env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
    this.apiKeyId = env.ALPACA_API_KEY_ID;
    this.apiSecretKey = env.ALPACA_API_SECRET_KEY;
    this.DB = env.DB;
  }

  /** Build auth headers for Alpaca API. */
  _headers() {
    return {
      "APCA-API-KEY-ID": this.apiKeyId,
      "APCA-API-SECRET-KEY": this.apiSecretKey,
      "Content-Type": "application/json",
    };
  }

  /** Make an authenticated request to Alpaca API. */
  async _fetch(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const opts = { method, headers: this._headers() };
    if (body) opts.body = JSON.stringify(body);

    console.log(`[EXEC ALPACA] ${method} ${path}`);
    const resp = await fetch(url, opts);
    const text = await resp.text();

    if (!resp.ok) {
      console.error(`[EXEC ALPACA] ${resp.status} ${resp.statusText}: ${text.substring(0, 500)}`);
      throw new Error(`Alpaca API ${resp.status}: ${text.substring(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** POST /v2/orders */
  async submitOrder(params) {
    const body = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type || "market",
      time_in_force: params.time_in_force || "gtc",
    };

    if (params.limit_price) body.limit_price = String(params.limit_price);
    if (params.stop_price) body.stop_price = String(params.stop_price);
    if (params.trail_price) body.trail_price = String(params.trail_price);
    if (params.trail_percent) body.trail_percent = String(params.trail_percent);
    if (params.client_order_id) body.client_order_id = params.client_order_id;

    if (params.order_class && params.order_class !== "simple") {
      body.order_class = params.order_class;
      if (params.take_profit) {
        body.take_profit = { limit_price: String(params.take_profit.limit_price) };
      }
      if (params.stop_loss) {
        body.stop_loss = { stop_price: String(params.stop_loss.stop_price) };
        if (params.stop_loss.limit_price) {
          body.stop_loss.limit_price = String(params.stop_loss.limit_price);
        }
      }
    }

    const result = await this._fetch("POST", "/v2/orders", body);
    console.log(`[EXEC ALPACA] Order placed: ${result.id} ${result.status} ${result.symbol} ${result.side} ${result.qty}`);
    return result;
  }

  /** PATCH /v2/orders/{id} */
  async replaceOrder(orderId, params = {}) {
    const body = {};
    if (params.stop_price) body.stop_price = String(params.stop_price);
    if (params.limit_price) body.limit_price = String(params.limit_price);
    if (params.trail) body.trail = String(params.trail);
    if (params.qty) body.qty = String(params.qty);

    const result = await this._fetch("PATCH", `/v2/orders/${orderId}`, body);
    console.log(`[EXEC ALPACA] Order replaced: ${result.id} ${result.status}`);
    return result;
  }

  /** DELETE /v2/orders/{id} */
  async cancelOrder(orderId) {
    await this._fetch("DELETE", `/v2/orders/${orderId}`);
    return { id: orderId, status: "canceled" };
  }

  /** GET /v2/orders */
  async getOrders(params = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.nested) qs.set("nested", "true");
    return this._fetch("GET", `/v2/orders?${qs}`);
  }

  /** GET /v2/orders/{id} */
  async getOrder(orderId) {
    return this._fetch("GET", `/v2/orders/${orderId}`);
  }

  /** DELETE /v2/positions/{symbol} */
  async closePosition(symbol, params = {}) {
    const qs = new URLSearchParams();
    if (params.percentage) qs.set("percentage", String(params.percentage));
    if (params.qty) qs.set("qty", String(params.qty));

    const path = `/v2/positions/${encodeURIComponent(symbol)}${qs.toString() ? "?" + qs : ""}`;
    const result = await this._fetch("DELETE", path);
    console.log(`[EXEC ALPACA] Position closed: ${symbol}`, result);
    return result;
  }

  /** GET /v2/positions */
  async getPositions() {
    return this._fetch("GET", "/v2/positions");
  }

  /** GET /v2/positions/{symbol} */
  async getPosition(symbol) {
    return this._fetch("GET", `/v2/positions/${encodeURIComponent(symbol)}`);
  }

  /** GET /v2/account */
  async getAccount() {
    return this._fetch("GET", "/v2/account");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: create the right backend based on EXECUTION_MODE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an execution adapter based on the EXECUTION_MODE env var.
 *
 * @param {Object} env   — Cloudflare Worker env
 * @param {Object} [deps] — D1 helper functions (for SimulationBackend)
 * @returns {ExecutionAdapter}
 */
export function createExecutionAdapter(env, deps = {}) {
  const mode = String(env.EXECUTION_MODE || "simulation").toLowerCase().trim();

  if (mode === "paper") {
    if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
      console.warn("[EXEC] Paper mode requested but Alpaca credentials missing, falling back to simulation");
      return new SimulationBackend(env, deps);
    }
    console.log("[EXEC] Using AlpacaPaperBackend");
    return new AlpacaPaperBackend(env);
  }

  if (mode === "live") {
    // Future: AlpacaLiveBackend with additional safety checks
    console.warn("[EXEC] Live mode not yet implemented, falling back to simulation");
    return new SimulationBackend(env, deps);
  }

  // Default: simulation
  return new SimulationBackend(env, deps);
}

// Named exports for testing and direct use
export { ExecutionAdapter, SimulationBackend, AlpacaPaperBackend };
