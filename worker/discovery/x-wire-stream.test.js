import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  DELTA_ONE_STREAM_RULE,
  DELTA_ONE_STREAM_TAG,
  buildFilteredStreamUrl,
} from "./x-wire-stream.js";

describe("x-wire-stream", () => {
  it("defines Delta One filtered stream rule", () => {
    expect(DELTA_ONE_STREAM_RULE).toContain("DeItaone");
    expect(DELTA_ONE_STREAM_RULE).toContain("-is:retweet");
    expect(DELTA_ONE_STREAM_TAG).toBe("delta_one");
  });

  it("builds filtered stream URL with tweet fields", () => {
    const url = buildFilteredStreamUrl();
    expect(url).toContain("/tweets/search/stream");
    expect(url).toContain("tweet.fields");
  });

  it("parses NDJSON tweet line", () => {
    const line = JSON.stringify({
      data: {
        id: "1234567890",
        text: "US MAY JOB OPENINGS 7.594M; EST. 7.296M",
        author_id: "33104659",
        created_at: "2026-07-09T16:00:00.000Z",
      },
      matching_rules: [{ tag: "delta_one" }],
    });
    const parsed = parseStreamLine(line);
    expect(parsed.type).toBe("tweet");
    expect(parsed.tweet.id).toBe("1234567890");
    expect(parsed.tweet.text).toMatch(/JOB OPENINGS/);
  });

  it("ignores empty lines and keep-alives", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
  });

  it("surfaces stream error payloads", () => {
    const line = JSON.stringify({
      errors: [{ message: "Rate limit exceeded" }],
    });
    const parsed = parseStreamLine(line);
    expect(parsed.type).toBe("error");
    expect(parsed.errors[0].message).toMatch(/Rate limit/);
  });
});
