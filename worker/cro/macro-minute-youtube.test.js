import { describe, it, expect } from "vitest";
import {
  isMacroMinuteTitle,
  uploadsPlaylistId,
  cleanTranscriptText,
  parseYoutubeRss,
  parseTimedTextXml,
  parseProviderTranscript,
  macroMinuteTitle,
  isMacroMinuteYtEnabled,
  sanitizeYtErrorText,
  discoveryEmptyNote,
  FUNDSTRAT_CHANNEL_ID,
} from "./macro-minute-youtube.js";

describe("isMacroMinuteTitle", () => {
  it("matches Macro Minute variants, rejects others", () => {
    expect(isMacroMinuteTitle("Macro Minute: April Core CPI on Tue")).toBe(true);
    expect(isMacroMinuteTitle("Video: Macro Minute: VIX below 20")).toBe(true);
    expect(isMacroMinuteTitle("macro-minute weekly recap")).toBe(true);
    expect(isMacroMinuteTitle("Daily Technical Strategy")).toBe(false);
    expect(isMacroMinuteTitle("")).toBe(false);
  });
});

describe("uploadsPlaylistId", () => {
  it("maps UC channel id to the UU uploads playlist", () => {
    expect(uploadsPlaylistId(FUNDSTRAT_CHANNEL_ID)).toBe("UU" + FUNDSTRAT_CHANNEL_ID.slice(2));
    expect(uploadsPlaylistId("UCabc")).toBe("UUabc");
    expect(uploadsPlaylistId("xyz")).toBe("xyz");
  });
});

describe("cleanTranscriptText", () => {
  it("strips caption artifacts, decodes entities, collapses whitespace", () => {
    expect(cleanTranscriptText("Hello   [Music]\n\n\n\nTom &amp; Mark say &#39;hi&#39;"))
      .toBe("Hello \n\nTom & Mark say 'hi'");
  });
});

describe("parseYoutubeRss", () => {
  const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <entry><yt:videoId>abc123</yt:videoId><title>Macro Minute: CPI day</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
      <published>2026-05-11T20:00:00+00:00</published>
      <media:group><media:description>We discuss April Core CPI and the Clarity Act.</media:description></media:group>
    </entry>
    <entry><yt:videoId>def456</yt:videoId><title>Some other clip</title>
      <published>2026-05-10T20:00:00+00:00</published>
      <media:group><media:description>Unrelated.</media:description></media:group>
    </entry>
  </feed>`;
  it("extracts videoId/title/description/link per entry", () => {
    const out = parseYoutubeRss(xml);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      videoId: "abc123",
      title: "Macro Minute: CPI day",
      link: "https://www.youtube.com/watch?v=abc123",
    });
    expect(out[0].description).toContain("April Core CPI");
  });
  it("returns [] on garbage", () => {
    expect(parseYoutubeRss("not xml")).toEqual([]);
    expect(parseYoutubeRss("")).toEqual([]);
  });
});

describe("parseTimedTextXml", () => {
  it("joins <text> nodes into clean prose", () => {
    const xml = `<transcript><text start="0" dur="2">Hello there</text><text start="2" dur="3">markets are healthy &amp; strong</text></transcript>`;
    expect(parseTimedTextXml(xml)).toBe("Hello there markets are healthy & strong");
  });
});

describe("parseProviderTranscript", () => {
  it("handles Supadata content[] shape", () => {
    expect(parseProviderTranscript({ content: [{ text: "alpha" }, { text: "beta" }] })).toBe("alpha beta");
  });
  it("handles {transcript} and {text} and string", () => {
    expect(parseProviderTranscript({ transcript: "hello world" })).toBe("hello world");
    expect(parseProviderTranscript({ text: "hi" })).toBe("hi");
    expect(parseProviderTranscript("plain")).toBe("plain");
  });
  it("returns '' on empty/unknown", () => {
    expect(parseProviderTranscript(null)).toBe("");
    expect(parseProviderTranscript({ foo: 1 })).toBe("");
  });
});

describe("macroMinuteTitle", () => {
  it("keeps existing Macro Minute titles, prefixes bare ones", () => {
    expect(macroMinuteTitle("Macro Minute: CPI day")).toBe("Video: Macro Minute: CPI day (YouTube transcript)");
    expect(macroMinuteTitle("CPI day")).toBe("Video: Macro Minute: CPI day (YouTube transcript)");
  });
});

describe("isMacroMinuteYtEnabled", () => {
  it("auto-enables when YOUTUBE_API_KEY is set, kill-switch off wins", () => {
    expect(isMacroMinuteYtEnabled({})).toBe(false);
    expect(isMacroMinuteYtEnabled({ YOUTUBE_API_KEY: "k" })).toBe(true);
    expect(isMacroMinuteYtEnabled({ YOUTUBE_API_KEY: "k", MACRO_MINUTE_YT_INGEST: "off" })).toBe(false);
    expect(isMacroMinuteYtEnabled({ MACRO_MINUTE_YT_INGEST: "on" })).toBe(true);
  });
});

describe("sanitizeYtErrorText", () => {
  it("redacts key query params and AIza-shaped tokens", () => {
    expect(sanitizeYtErrorText("bad key=abc123&other=1")).toBe("bad key=REDACTED&other=1");
    expect(sanitizeYtErrorText("token AIzaSyDummyKeyValue0123456789xxxx leaked")).toContain("REDACTED");
    expect(sanitizeYtErrorText("token AIzaSyDummyKeyValue0123456789xxxx leaked")).not.toMatch(/AIzaSy/);
  });
});

describe("discoveryEmptyNote", () => {
  it("tells the operator to configure a key when none is present", () => {
    expect(discoveryEmptyNote({ key_present: false })).toContain("configure YOUTUBE_API_KEY");
  });
  it("reports playlist HTTP failures instead of a missing-key hint", () => {
    expect(discoveryEmptyNote({ key_present: true, youtube_http: 403 })).toBe("youtube_playlist_http_403");
  });
  it("reports a title miss when the API returned uploads", () => {
    expect(discoveryEmptyNote({ key_present: true, youtube_http: 200, playlist_items: 50, playlist_matched: 0 })).toBe("no_macro_minute_title_in_recent_uploads");
  });
});
