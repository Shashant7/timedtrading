import { describe, it, expect } from "vitest";
import { dedupeAndSortFeedItems, parsePublicationTs } from "./research-feed-kv.js";

describe("research-feed-kv", () => {
  it("parsePublicationTs prefers published_at over fetched_at", () => {
    const ts = parsePublicationTs({
      published_at: "2026-06-05T14:00:00",
      fetched_at: Date.parse("2026-06-06T10:00:00"),
    });
    expect(ts).toBe(Date.parse("2026-06-05T14:00:00"));
  });

  it("dedupeAndSortFeedItems keeps one row per pub_id and sorts newest first", () => {
    // 2026-06-10 TIME-BOMB FIX — this test hardcoded published_at
    // calendar dates ("2026-06-03T10:00:00") against the function's
    // `Date.now() - lookbackDays` cutoff. It passed until 10:00 UTC on
    // 2026-06-10, then the date aged out of the 7-day window and every
    // deploy on main started failing (PR #568's deploy died on it).
    // All timestamps are now RELATIVE to Date.now() so the test is
    // immortal. Never hardcode calendar dates against a now()-window.
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const items = dedupeAndSortFeedItems([
      { pub_id: "1", published_at: iso(now - 5 * 86400000), title: "old" },
      { pub_id: "1", published_at: iso(now - 3 * 86400000), title: "newer duplicate" },
      { pub_id: "2", fetched_at: now - 86400000, title: "yesterday" },
      { pub_id: "3", fetched_at: now, title: "today" },
    ], { lookbackDays: 7 });
    expect(items).toHaveLength(3);
    expect(items[0].pub_id).toBe("3");
    expect(items.find((it) => it.pub_id === "1")?.title).toBe("newer duplicate");
  });

  it("dedupeAndSortFeedItems drops items older than the lookback window", () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const items = dedupeAndSortFeedItems([
      { pub_id: "stale", published_at: iso(now - 9 * 86400000), title: "aged out" },
      { pub_id: "fresh", fetched_at: now, title: "kept" },
    ], { lookbackDays: 7 });
    expect(items).toHaveLength(1);
    expect(items[0].pub_id).toBe("fresh");
  });
});
