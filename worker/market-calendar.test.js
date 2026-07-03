// worker/market-calendar.test.js
//
// A2 (2026-07-03 stabilization plan): the dynamic Alpaca calendar fetch
// fell back to the static table silently for weeks. These tests pin the
// new behavior: fallback carries a reason, 401/403 retries the alternate
// Alpaca host (paper vs live keys), and a successful fetch caches to KV.

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAndCacheCalendar } from "./market-calendar.js";

const CREDS = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" };

function alpacaDays() {
  return [
    { date: "2026-07-06", open: "09:30", close: "16:00" },
    { date: "2026-07-07", open: "09:30", close: "16:00" },
    { date: "2026-11-27", open: "09:30", close: "13:00" },
  ];
}

function mockKV() {
  const store = new Map();
  return {
    store,
    put: vi.fn(async (k, v) => { store.set(k, v); }),
    get: vi.fn(async (k) => store.get(k) ?? null),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAndCacheCalendar fallback reasons", () => {
  it("no credentials → static with fallback_reason", async () => {
    const cal = await fetchAndCacheCalendar({});
    expect(cal.source).toBe("static");
    expect(cal.fallback_reason).toBe("missing_credentials");
  });

  it("non-auth HTTP error → static with http_<status> reason (no alt-host retry)", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const cal = await fetchAndCacheCalendar({ ...CREDS });
    expect(cal.source).toBe("static");
    expect(cal.fallback_reason).toMatch(/^http_500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("network error → static with fetch_error reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("dns fail"); }));
    const cal = await fetchAndCacheCalendar({ ...CREDS });
    expect(cal.source).toBe("static");
    expect(cal.fallback_reason).toMatch(/^fetch_error:/);
  });
});

describe("fetchAndCacheCalendar alt-host retry (paper vs live keys)", () => {
  it("401 on paper-api retries api.alpaca.markets and succeeds", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).startsWith("https://paper-api.alpaca.markets")) {
        return new Response("{\"message\":\"forbidden\"}", { status: 401 });
      }
      return new Response(JSON.stringify(alpacaDays()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const kv = mockKV();
    const cal = await fetchAndCacheCalendar({ ...CREDS, KV_TIMED: kv });

    expect(cal.source).toBe("alpaca");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("https://api.alpaca.markets/v2/calendar");
    // Early close derived from close !== 16:00
    expect(cal.equityEarlyClose.has("2026-11-27")).toBe(true);
    // Successful fetch caches to KV
    expect(kv.put).toHaveBeenCalledTimes(1);
    const cached = JSON.parse(kv.store.get("timed:market-calendar"));
    expect(cached.source).toBe("alpaca");
  });

  it("success on the configured host does not touch the alternate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(alpacaDays()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cal = await fetchAndCacheCalendar({ ...CREDS });
    expect(cal.source).toBe("alpaca");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://paper-api.alpaca.markets");
  });
});
