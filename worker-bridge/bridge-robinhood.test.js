import { describe, it, expect } from "vitest";
import {
  buildMcpHeaders,
  buildToolCallBody,
  parseMcpResponseText,
  extractToolResult,
} from "./bridge-robinhood.js";
import { brokerCapabilities, brokerMeta } from "./bridge-brokers.js";

describe("MCP transport headers", () => {
  it("2025-11-25: carries session id, no routing headers", () => {
    const h = buildMcpHeaders({ token: "tok", protocolVersion: "2025-11-25", toolName: "place_equity_order", sessionId: "sess-1" });
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["Mcp-Session-Id"]).toBe("sess-1");
    expect(h["MCP-Protocol-Version"]).toBe("2025-11-25");
    expect(h["Accept"]).toContain("text/event-stream");
    expect(h["Mcp-Method"]).toBeUndefined();
  });

  it("2026-07-28 stateless: routing headers, no session id", () => {
    const h = buildMcpHeaders({ token: "tok", protocolVersion: "2026-07-28", toolName: "place_equity_order", stateless: true });
    expect(h["Mcp-Method"]).toBe("tools/call");
    expect(h["Mcp-Name"]).toBe("place_equity_order");
    expect(h["Mcp-Session-Id"]).toBeUndefined();
  });
});

describe("MCP tools/call body", () => {
  it("wraps name+arguments as JSON-RPC", () => {
    const b = buildToolCallBody({ toolName: "review_equity_order", args: { symbol: "AMZN", qty: 3 }, protocolVersion: "2025-11-25" });
    expect(b.jsonrpc).toBe("2.0");
    expect(b.method).toBe("tools/call");
    expect(b.params.name).toBe("review_equity_order");
    expect(b.params.arguments.symbol).toBe("AMZN");
    expect(b.params._meta).toBeUndefined();
  });
  it("stateless carries clientInfo/version in _meta", () => {
    const b = buildToolCallBody({ toolName: "search", args: {}, protocolVersion: "2026-07-28", stateless: true });
    expect(b.params._meta.protocolVersion).toBe("2026-07-28");
    expect(b.params._meta.clientInfo.name).toBe("tt-broker-bridge");
  });
});

describe("MCP response parsing (JSON + SSE)", () => {
  it("parses a plain JSON-RPC response", () => {
    const rpc = parseMcpResponseText(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), "application/json");
    expect(rpc.result.ok).toBe(true);
  });
  it("parses the last data: frame of an SSE stream", () => {
    const sse = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"order_id":"rh_1","status":"queued"}}}',
      "",
    ].join("\n");
    const rpc = parseMcpResponseText(sse, "text/event-stream");
    expect(rpc.result.structuredContent.order_id).toBe("rh_1");
  });
  it("returns null on non-JSON body", () => {
    expect(parseMcpResponseText("Just a moment...", "text/html")).toBeNull();
  });
});

describe("extractToolResult", () => {
  it("surfaces structuredContent on success", () => {
    const r = extractToolResult({ result: { structuredContent: { order_id: "rh_9" }, isError: false } });
    expect(r.ok).toBe(true);
    expect(r.response.order_id).toBe("rh_9");
  });
  it("flags a JSON-RPC error", () => {
    const r = extractToolResult({ error: { code: -32000, message: "unauthorized" } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unauthorized");
  });
  it("flags an isError tool result", () => {
    const r = extractToolResult({ result: { isError: true, content: { message: "insufficient funds" } } });
    expect(r.ok).toBe(false);
  });
});

describe("Robinhood capability registry (post-launch)", () => {
  it("reflects the published Agentic MCP (native limit+fractional; options rolling out)", () => {
    const meta = brokerMeta("robinhood");
    expect(meta.status).toBe("api_published_pending_oauth");
    expect(meta.tradesRestrictedToDedicatedAccount).toBe(true);
    const nat = brokerCapabilities("robinhood", "native");
    expect(nat.equity.limit).toBe(true);
    expect(nat.fractional).toBe(true);
    expect(nat.read_fills).toBe(true);
  });
  it("adapter tier stays conservative (market-only) until arg schema verified", () => {
    const a = brokerCapabilities("robinhood", "adapter");
    expect(a.equity.market).toBe(true);
    expect(a.equity.limit).toBe(false);
    expect(a.read_fills).toBe(true); // get_equity_orders wired
  });
});
