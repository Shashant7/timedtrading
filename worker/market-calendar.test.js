// worker/market-calendar.test.js
//
// A2 (2026-07-03 stabilization plan): the dynamic Alpaca calendar fetch
// fell back to the static table silently for weeks. These tests pin the
// new behavior: fallback carries a reason, 401/403 retries the alternate
// Alpaca host (paper vs live keys), and a successful fetch caches to KV.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchAndCacheCalendar, resolveMarketOpenCached, _resetMarketOpenCacheForTests } from "./market-calendar.js";

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

// A4 (feed↔freshness same-calendar invariant): freshness stamping resolves
// market-open from THIS module's calendar, cached per isolate.
describe("resolveMarketOpenCached", () => {
  beforeEach(() => {
    _resetMarketOpenCacheForTests();
  });

  function kvWithCalendar(extraHolidays = []) {
    const blob = JSON.stringify({
      fetchedAt: Date.now(),
      source: "alpaca",
      equity: {},
      equityHolidays: ["2026-07-03", ...extraHolidays],
      equityEarlyClose: ["2026-11-27"],
      futuresEarlyClose: [],
      futuresFullClose: [],
    });
    return {
      get: vi.fn(async (k, type) => (type === "json" ? JSON.parse(blob) : blob)),
      put: vi.fn(async () => {}),
    };
  }

  it("holiday during would-be RTH hours → false (dynamic calendar wins)", async () => {
    const env = { KV_TIMED: kvWithCalendar() };
    // Fri 2026-07-03 11:00 ET = 15:00 UTC
    const open = await resolveMarketOpenCached(env, Date.parse("2026-07-03T15:00:00Z"));
    expect(open).toBe(false);
  });

  it("regular weekday RTH → true", async () => {
    const env = { KV_TIMED: kvWithCalendar() };
    // Mon 2026-07-06 11:00 ET = 15:00 UTC
    const open = await resolveMarketOpenCached(env, Date.parse("2026-07-06T15:00:00Z"));
    expect(open).toBe(true);
  });

  it("early-close afternoon → false", async () => {
    const env = { KV_TIMED: kvWithCalendar() };
    // Fri 2026-11-27 13:30 ET = 18:30 UTC (EST)
    const open = await resolveMarketOpenCached(env, Date.parse("2026-11-27T18:30:00Z"));
    expect(open).toBe(false);
  });

  it("caches the calendar — one KV read within 5 minutes", async () => {
    const kv = kvWithCalendar();
    const env = { KV_TIMED: kv };
    const t0 = Date.parse("2026-07-06T15:00:00Z");
    await resolveMarketOpenCached(env, t0);
    await resolveMarketOpenCached(env, t0 + 60 * 1000);
    expect(kv.get).toHaveBeenCalledTimes(1);
    // past the 5-min TTL → re-reads
    await resolveMarketOpenCached(env, t0 + 6 * 60 * 1000);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("no KV → static fallback still answers (holiday false)", async () => {
    const open = await resolveMarketOpenCached({}, Date.parse("2026-07-03T15:00:00Z"));
    expect(open).toBe(false);
  });
});

// B1 — env-less static session helpers + the canonical getMarketSession.
describe("isNyRegularMarketOpenStatic / getMarketSession", () => {
  beforeEach(() => {
    _resetMarketOpenCacheForTests();
  });

  it("static: holiday closed, weekday open, early-close afternoon closed", async () => {
    const { isNyRegularMarketOpenStatic } = await import("./market-calendar.js");
    expect(isNyRegularMarketOpenStatic(new Date("2026-07-03T15:00:00Z"))).toBe(false); // holiday
    expect(isNyRegularMarketOpenStatic(new Date("2026-07-06T15:00:00Z"))).toBe(true);  // Mon RTH
    expect(isNyRegularMarketOpenStatic(new Date("2026-11-27T18:30:00Z"))).toBe(false); // 13:30 EST early close
  });

  it("getMarketSession returns the full session object from the static fallback", async () => {
    const { getMarketSession } = await import("./market-calendar.js");
    const s = await getMarketSession({}, Date.parse("2026-07-03T15:00:00Z"));
    expect(s.et_date).toBe("2026-07-03");
    expect(s.market_open).toBe(false);
    expect(s.is_holiday).toBe(true);
    expect(s.holiday_name).toBe("Independence Day");
    expect(s.is_early_close).toBe(false);
    expect(s.source).toBe("static");
  });

  it("getMarketSession honors a KV-cached dynamic calendar", async () => {
    const { getMarketSession } = await import("./market-calendar.js");
    const blob = JSON.stringify({
      fetchedAt: Date.now(),
      source: "alpaca",
      equity: {},
      equityHolidays: ["2026-07-08"], // fake mid-week closure only the dynamic cal knows
      equityEarlyClose: [],
      futuresEarlyClose: [],
      futuresFullClose: [],
    });
    const env = { KV_TIMED: { get: async (k, t) => (t === "json" ? JSON.parse(blob) : blob), put: async () => {} } };
    const s = await getMarketSession(env, Date.parse("2026-07-08T15:00:00Z")); // Wed 11:00 ET
    expect(s.market_open).toBe(false);
    expect(s.is_holiday).toBe(true);
    expect(s.source).toBe("alpaca");
  });
});
