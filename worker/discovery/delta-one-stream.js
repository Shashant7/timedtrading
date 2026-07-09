// worker/discovery/delta-one-stream.js
//
// Durable Object — holds X Filtered Stream connection for @DeItaone.
// Cron pings /start (idempotent); alarm reconnects on disconnect.
// Requires env secret: X_API_BEARER_TOKEN

import {
  connectFilteredStream,
  parseStreamLine,
} from "./x-wire-stream.js";
import { ingestDeltaOneStreamPosts } from "./x-wire-tracker.js";

const STATUS_KV = "timed:x:delta-one-stream:status";
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const ALARM_INTERVAL_MS = 30_000;
const STREAM_READ_TIMEOUT_MS = 900_000;

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearerToken(env) {
  return String(env?.X_API_BEARER_TOKEN || "").trim() || null;
}

function streamEnabled(env) {
  if (!bearerToken(env)) return false;
  const v = String(env?.X_DELTA_ONE_STREAM_ENABLED ?? "true").toLowerCase();
  return v === "true" || v === "1";
}

export class DeltaOneStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.isRunning = false;
    this.isStreaming = false;
    this.startedAt = null;
    this.connectedAt = null;
    this.postsReceived = 0;
    this.lastPostAt = null;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.abortController = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      if (!streamEnabled(this.env)) {
        return _json({ ok: false, error: "stream_disabled_or_no_token" });
      }
      if (!this.isRunning) {
        this.isRunning = true;
        this.startedAt = Date.now();
        this.reconnectAttempts = 0;
        this.state.waitUntil(this._runStreamLoop());
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
      return _json({
        ok: true,
        status: "running",
        isStreaming: this.isStreaming,
        startedAt: this.startedAt,
      });
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      this._abortStream();
      this.isRunning = false;
      await this._persistStatus();
      return _json({ ok: true, status: "stopped" });
    }

    if (url.pathname === "/status") {
      return _json(this._statusPayload());
    }

    return _json({ ok: false, error: "not_found" }, 404);
  }

  async alarm() {
    if (!this.isRunning || !streamEnabled(this.env)) {
      await this._persistStatus();
      return;
    }
    if (!this.isStreaming) {
      this.state.waitUntil(this._runStreamLoop());
    }
    await this._persistStatus();
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  _statusPayload() {
    return {
      ok: true,
      isRunning: this.isRunning,
      isStreaming: this.isStreaming,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      postsReceived: this.postsReceived,
      lastPostAt: this.lastPostAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      updatedAt: Date.now(),
    };
  }

  _abortStream() {
    try {
      this.abortController?.abort();
    } catch (_) { /* ignore */ }
    this.abortController = null;
    this.isStreaming = false;
  }

  async _persistStatus() {
    const kv = this.env?.KV_TIMED || this.env?.KV;
    if (!kv) return;
    try {
      await kv.put(STATUS_KV, JSON.stringify(this._statusPayload()), { expirationTtl: 3600 });
    } catch (_) { /* best-effort */ }
  }

  _backoffMs() {
    const ms = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * (2 ** Math.min(this.reconnectAttempts, 5)),
    );
    return ms;
  }

  async _runStreamLoop() {
    if (this.isStreaming || !this.isRunning) return;
    const token = bearerToken(this.env);
    if (!token) {
      this.lastError = "no_x_api_bearer_token";
      return;
    }

    this.isStreaming = true;
    this.abortController = new AbortController();
    const readDeadline = Date.now() + STREAM_READ_TIMEOUT_MS;

    try {
      const conn = await connectFilteredStream(token, this.abortController.signal);
      if (!conn.ok) {
        this.lastError = conn.error || "connect_failed";
        this.reconnectAttempts += 1;
        return;
      }

      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.lastError = null;

      const reader = conn.response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.isRunning && Date.now() < readDeadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          await this._handleLine(line);
        }
      }
    } catch (e) {
      if (this.abortController?.signal?.aborted) {
        /* intentional stop */
      } else {
        this.lastError = String(e?.message || e).slice(0, 200);
        this.reconnectAttempts += 1;
        console.warn("[DELTA_ONE_STREAM] read error:", this.lastError);
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      await this._persistStatus();
      if (this.isRunning) {
        const delay = this._backoffMs();
        await this.state.storage.setAlarm(Date.now() + delay);
      }
    }
  }

  async _handleLine(line) {
    const parsed = parseStreamLine(line);
    if (!parsed) return;
    if (parsed.type === "error") {
      this.lastError = String(parsed.errors?.[0]?.message || "stream_error").slice(0, 200);
      return;
    }
    if (parsed.type !== "tweet") return;

    this.postsReceived += 1;
    this.lastPostAt = Date.now();

    try {
      await ingestDeltaOneStreamPosts(this.env, [parsed.tweet], {
        classifyMacroWire: true,
      });
    } catch (e) {
      console.warn("[DELTA_ONE_STREAM] ingest failed:", String(e?.message || e).slice(0, 150));
    }
  }
}
