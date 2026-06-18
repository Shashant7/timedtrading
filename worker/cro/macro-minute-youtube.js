// worker/cro/macro-minute-youtube.js
//
// Macro Minute (Tom Lee, Fundstrat) FULL-CONTENT ingestion via YouTube.
//
// WHY: the FSD fetch (worker/cro/fsd-client.js) already pulls each Macro Minute
// POST, but the body is just the ~1-paragraph blurb + a video embed (~1.7KB) —
// the substance lives in the video. Fundstrat mirrors every Macro Minute on its
// public YouTube channel, so we ingest the TRANSCRIPT (full spoken analysis)
// and feed it through the same CRO/FSD pipeline as the written notes.
//
// IMPORTANT — YouTube reality (verified 2026-06-18): from a server/datacenter
// context YouTube does NOT expose caption tracks in the watch-page HTML and the
// public `videos.xml` RSS is throttled to a single entry. So:
//   - Discovery prefers the YouTube Data API (env YOUTUBE_API_KEY); RSS is a
//     best-effort fallback.
//   - Transcripts come from a configurable provider (env YT_TRANSCRIPT_API_URL +
//     YT_TRANSCRIPT_API_KEY — Supadata-shaped by default). When no transcript
//     provider is set we fall back to the video DESCRIPTION (still richer than
//     the FSD blurb), then to nothing.
// Everything degrades gracefully and the lane is OFF until a key is configured.

export const FUNDSTRAT_CHANNEL_ID = "UCXKmQMS4TsR0fpviXJ17lRw"; // @fundstrat

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** True when a video title is a Macro Minute episode. */
export function isMacroMinuteTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  // "Macro Minute" is the series name; tolerate "macro-minute" / extra words.
  return /macro[\s\-]?minute/.test(t);
}

/** The uploads playlist id for a channel = channelId with the 2nd char UC→UU. */
export function uploadsPlaylistId(channelId) {
  const c = String(channelId || "");
  return /^UC/.test(c) ? "UU" + c.slice(2) : c;
}

/** Collapse whitespace / strip caption artifacts into clean prose. */
export function cleanTranscriptText(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/\[[^\]]*\]/g, " ")          // [Music], [Applause]
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse a YouTube Atom `videos.xml` feed → [{ videoId, title, published, description, link }]. */
export function parseYoutubeRss(xml) {
  const out = [];
  const str = String(xml || "");
  const entries = str.split(/<entry>/).slice(1);
  for (const raw of entries) {
    const seg = raw.split(/<\/entry>/)[0] || "";
    const videoId = (seg.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1] || null;
    const title = decodeXmlText((seg.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const published = (seg.match(/<published>([^<]+)<\/published>/) || [])[1] || null;
    const link = (seg.match(/<link[^>]*href="([^"]+)"/) || [])[1] || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
    const description = decodeXmlText((seg.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || "");
    if (videoId) out.push({ videoId, title, published, description, link });
  }
  return out;
}

function decodeXmlText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .trim();
}

/** Parse YouTube timedtext XML → plain text (best-effort fallback path). */
export function parseTimedTextXml(xml) {
  const str = String(xml || "");
  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(str)) !== null) parts.push(m[1]);
  return cleanTranscriptText(parts.join(" "));
}

/** Normalize a transcript-provider JSON response → plain text. Handles the
 *  common shapes (Supadata `content:[{text}]` or `{transcript}`/`{text}`). */
export function parseProviderTranscript(json) {
  if (!json) return "";
  if (typeof json === "string") return cleanTranscriptText(json);
  if (typeof json.transcript === "string") return cleanTranscriptText(json.transcript);
  if (typeof json.text === "string") return cleanTranscriptText(json.text);
  const segs = Array.isArray(json.content) ? json.content
    : Array.isArray(json.segments) ? json.segments
    : Array.isArray(json.transcript) ? json.transcript
    : null;
  if (segs) return cleanTranscriptText(segs.map((s) => (typeof s === "string" ? s : (s?.text || s?.content || ""))).join(" "));
  return "";
}

/** Build the canonical publication title for a Macro Minute YouTube ingest. */
export function macroMinuteTitle(videoTitle) {
  const t = String(videoTitle || "").trim();
  if (/macro[\s\-]?minute/i.test(t)) return `Video: ${t} (YouTube transcript)`;
  return `Video: Macro Minute: ${t} (YouTube transcript)`;
}

// ── Side-effecting (env-driven, best-effort) ────────────────────────────────

const YT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

/**
 * Discover recent Macro Minute videos for the Fundstrat channel.
 * Prefers the YouTube Data API (YOUTUBE_API_KEY); falls back to the public RSS
 * feed. Returns [{ videoId, title, published, description, link }].
 */
export async function discoverMacroMinuteVideos(env, { limit = 10 } = {}) {
  const key = env?.YOUTUBE_API_KEY;
  // 1. YouTube Data API — reliable, returns full snippet.description.
  if (key) {
    try {
      const playlist = uploadsPlaylistId(FUNDSTRAT_CHANNEL_ID);
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${Math.min(50, Math.max(limit * 3, 15))}&playlistId=${playlist}&key=${encodeURIComponent(key)}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const items = Array.isArray(j?.items) ? j.items : [];
        const vids = items.map((it) => ({
          videoId: it?.snippet?.resourceId?.videoId || null,
          title: it?.snippet?.title || "",
          published: it?.snippet?.publishedAt || null,
          description: it?.snippet?.description || "",
          link: it?.snippet?.resourceId?.videoId ? `https://www.youtube.com/watch?v=${it.snippet.resourceId.videoId}` : null,
        })).filter((v) => v.videoId && isMacroMinuteTitle(v.title));
        if (vids.length) return vids.slice(0, limit);
      }
    } catch (_) { /* fall through to RSS */ }
  }
  // 2. RSS fallback (often throttled from datacenter IPs — best-effort).
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${FUNDSTRAT_CHANNEL_ID}`, {
      headers: { "User-Agent": YT_UA, Accept: "application/atom+xml" },
    });
    if (r.ok) {
      const xml = await r.text();
      return parseYoutubeRss(xml).filter((v) => isMacroMinuteTitle(v.title)).slice(0, limit);
    }
  } catch (_) { /* nothing */ }
  return [];
}

/**
 * Fetch the full transcript for a video via a configurable provider.
 * Provider contract (Supadata-shaped by default):
 *   GET {YT_TRANSCRIPT_API_URL}?url=<watch>&text=true  with x-api-key header
 * Returns clean text or "" when unavailable.
 */
export async function fetchTranscript(env, videoId) {
  const base = env?.YT_TRANSCRIPT_API_URL;
  const key = env?.YT_TRANSCRIPT_API_KEY;
  if (base && key) {
    try {
      const watch = `https://www.youtube.com/watch?v=${videoId}`;
      const sep = base.includes("?") ? "&" : "?";
      const url = `${base}${sep}url=${encodeURIComponent(watch)}&text=true&lang=en`;
      const r = await fetch(url, { headers: { "x-api-key": key, Authorization: `Bearer ${key}`, Accept: "application/json" } });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const text = parseProviderTranscript(j);
        if (text && text.length > 80) return text;
      }
    } catch (_) { /* fall through */ }
  }
  // Best-effort timedtext (usually empty from servers, but free when it works).
  try {
    const r = await fetch(`https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`, { headers: { "User-Agent": YT_UA } });
    if (r.ok) {
      const xml = await r.text();
      const text = parseTimedTextXml(xml);
      if (text && text.length > 80) return text;
    }
  } catch (_) { /* nothing */ }
  return "";
}

/**
 * Ingest recent Macro Minute videos' full content into the CRO/FSD pipeline.
 * content = transcript (preferred) || video description (fallback). Each video
 * is ingested once (KV dedup flag). Returns a summary.
 */
export async function ingestMacroMinuteFromYoutube(env, { limit = 5, force = false, ingestFromBlob } = {}) {
  if (typeof ingestFromBlob !== "function") {
    return { ok: false, error_kind: "no_ingest_fn" };
  }
  const KV = env?.KV_TIMED;
  const videos = await discoverMacroMinuteVideos(env, { limit });
  if (!videos.length) {
    return { ok: true, discovered: 0, ingested: 0, note: "no_macro_minute_videos (configure YOUTUBE_API_KEY for reliable discovery)" };
  }
  const results = [];
  let ingested = 0;
  for (const v of videos) {
    const flagKey = `timed:cro:mm-yt:ingested:${v.videoId}`;
    try {
      if (!force && KV && (await KV.get(flagKey))) { results.push({ videoId: v.videoId, skipped: "already_ingested" }); continue; }
      const transcript = await fetchTranscript(env, v.videoId);
      const source = transcript ? "transcript" : (v.description ? "description" : null);
      const body = transcript || v.description || "";
      if (!body || body.length < 80) { results.push({ videoId: v.videoId, skipped: "no_content" }); continue; }
      const res = await ingestFromBlob(env, {
        title: macroMinuteTitle(v.title),
        source_url: v.link || `https://www.youtube.com/watch?v=${v.videoId}`,
        content_type: "text/plain",
        body_text: `${v.title}\n\n${body}`,
      });
      if (res?.ok) {
        ingested++;
        if (KV) await KV.put(flagKey, JSON.stringify({ at: Date.now(), source }), { expirationTtl: 180 * 86400 }).catch(() => {});
      }
      results.push({ videoId: v.videoId, source, ok: !!res?.ok, chars: body.length });
    } catch (e) {
      results.push({ videoId: v.videoId, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: true, discovered: videos.length, ingested, results };
}
