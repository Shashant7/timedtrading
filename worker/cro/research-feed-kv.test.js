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
    const now = Date.now();
    const items = dedupeAndSortFeedItems([
      { pub_id: "1", published_at: "2026-06-01T10:00:00", title: "old" },
      { pub_id: "1", published_at: "2026-06-03T10:00:00", title: "newer duplicate" },
      { pub_id: "2", fetched_at: now - 86400000, title: "yesterday" },
      { pub_id: "3", fetched_at: now, title: "today" },
    ], { lookbackDays: 7 });
    expect(items).toHaveLength(3);
    expect(items[0].pub_id).toBe("3");
    expect(items.find((it) => it.pub_id === "1")?.title).toBe("newer duplicate");
  });
});
