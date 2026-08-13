import { describe, it, expect } from "vitest";
import {
  shouldFetchVimeoTranscript,
  extractVimeoEmbeds,
  pickVimeoTextTrack,
  parseVtt,
  mergeTranscriptIntoText,
} from "./vimeo-transcript.js";

describe("shouldFetchVimeoTranscript", () => {
  it("matches Macro Minute titles and Video: posts with a Vimeo embed", () => {
    expect(shouldFetchVimeoTranscript("Video: Macro Minute: CPI day", "")).toBe(true);
    expect(shouldFetchVimeoTranscript("Video: Some webinar", "https://player.vimeo.com/video/1")).toBe(true);
    expect(shouldFetchVimeoTranscript("Daily Technical Strategy", "https://player.vimeo.com/video/1")).toBe(false);
  });
});

describe("extractVimeoEmbeds", () => {
  it("pulls player and watch URLs, including privacy hashes, and dedupes", () => {
    const html = `
      <iframe src="https://player.vimeo.com/video/1216286825?h=abc123&amp;share=copy"></iframe>
      <a href="https://vimeo.com/1216286825?share=copy">click</a>
      <p>https://vimeo.com/999888777</p>
    `;
    const embeds = extractVimeoEmbeds(html);
    expect(embeds[0]).toEqual({ videoId: "1216286825", hash: "abc123" });
    expect(embeds.map((e) => e.videoId)).toEqual(["1216286825", "999888777"]);
  });
  it("returns [] on empty/garbage", () => {
    expect(extractVimeoEmbeds("")).toEqual([]);
    expect(extractVimeoEmbeds("<p>no video</p>")).toEqual([]);
  });
});

describe("pickVimeoTextTrack", () => {
  it("prefers English human captions over autogen", () => {
    const cfg = {
      request: {
        text_tracks: [
          { lang: "en-x-autogen", url: "/a.vtt", provenance: "ai_generated", label: "English (auto-generated)" },
          { lang: "en", url: "/b.vtt", provenance: "official", label: "English" },
          { lang: "es", url: "/c.vtt" },
        ],
      },
    };
    expect(pickVimeoTextTrack(cfg).url).toBe("/b.vtt");
  });
  it("falls back to autogen English when that is all there is", () => {
    const cfg = { request: { text_tracks: [{ lang: "en-x-autogen", url: "/a.vtt", provenance: "ai_generated" }] } };
    expect(pickVimeoTextTrack(cfg).url).toBe("/a.vtt");
  });
  it("returns null when no tracks", () => {
    expect(pickVimeoTextTrack({})).toBe(null);
    expect(pickVimeoTextTrack({ request: { text_tracks: [] } })).toBe(null);
  });
});

describe("parseVtt", () => {
  it("joins cue text and drops timestamps / duplicate autogen lines", () => {
    const vtt = `WEBVTT

1
00:00:03.820 --> 00:00:07.770
Good evening, Fundstrat Direct.

2
00:00:07.800 --> 00:00:11.560
this is our Macro Minute.
this is our Macro Minute.

3
00:00:11.800 --> 00:00:15.360
July CPI should quell some fears.
`;
    expect(parseVtt(vtt)).toBe(
      "Good evening, Fundstrat Direct. this is our Macro Minute. July CPI should quell some fears.",
    );
  });
});

describe("mergeTranscriptIntoText", () => {
  it("appends a transcript block and replaces an existing one", () => {
    expect(mergeTranscriptIntoText("blurb", "spoken take")).toContain("--- VIDEO TRANSCRIPT ---");
    expect(mergeTranscriptIntoText("blurb", "spoken take")).toContain("spoken take");
    const twice = mergeTranscriptIntoText("blurb\n\n--- VIDEO TRANSCRIPT ---\nold", "new spoken");
    expect(twice).toContain("new spoken");
    expect(twice).not.toContain("old");
  });
});
