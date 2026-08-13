// worker/cro/macro-minute-youtube.js
//
// Macro Minute (Tom Lee, Fundstrat) FULL-CONTENT ingestion via YouTube.
//
// WHY: the FSD fetch (worker/cro/fsd-client.js) already pulls each Macro Minute
// POST, but the body is just the ~1-paragraph blurb + a video embed (~1.7KB) —
// the substance lives in the video. Fundstrat Direct hosts the clip on Vimeo
// (members). When they still mirror an episode to the public YouTube channel
// @Fundstrat_Direct we ingest the TRANSCRIPT (or description) into CRO/FSD.
//
// IMPORTANT — YouTube reality (verified 2026-06-18, rechecked 2026-08-13):
//   - @fundstrat (UCXKmQMS4TsR0fpviXJ17lRw) is a leftover personal channel
//     with ~1 public video. The live channel is @Fundstrat_Direct
//     (UCcBzKSM4A-pIHMJWSnxmi_g).
//   - Daily 2026 Macro Minutes are often Vimeo-only; YouTube search still
//     finds 2023-era "Tom Lee's Macro Minute" clips. Ingest skips videos
//     older than MACRO_MINUTE_MAX_AGE_DAYS so CRO does not eat stale notes.
//   - From a server/datacenter context YouTube does NOT expose caption tracks
//     in the watch-page HTML and public `videos.xml` RSS is throttled.
//   - Discovery prefers the YouTube Data API (env YOUTUBE_API_KEY).
//   - Transcripts come from a configurable provider (env YT_TRANSCRIPT_API_URL
//     + YT_TRANSCRIPT_API_KEY). Else video DESCRIPTION, then nothing.
// Nightly lane auto-runs when YOUTUBE_API_KEY is set; MACRO_MINUTE_YT_INGEST=off
// is the kill switch.

export const FUNDSTRAT_CHANNEL_ID = "UCcBzKSM4A-pIHMJWSnxmi_g"; // @Fundstrat_Direct
export const FUNDSTRAT_CHANNEL_HANDLE = "Fundstrat_Direct";
export const MACRO_MINUTE_MAX_AGE_DAYS = 21;

/** Nightly/manual lane: on when a Data API key is present, unless explicitly off. */
export function isMacroMinuteYtEnabled(env) {
  const flag = String(env?.MACRO_MINUTE_YT_INGEST || "").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  if (flag === "on" || flag === "true" || flag === "1") return true;
  return Boolean(env?.YOUTUBE_API_KEY);
}

/** Strip key-shaped tokens from YouTube error bodies before returning them. */
export function sanitizeYtErrorText(s) {
  return String(s || "")
    .replace(/key=[^&\s"]+/gi, "key=REDACTED")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "REDACTED")
    .slice(0, 240);
}

/** Human note when discovery returned zero Macro Minute videos. */
export function discoveryEmptyNote(diag) {
  if (!diag?.key_present) {
    return "no_macro_minute_videos (configure YOUTUBE_API_KEY for reliable discovery)";
  }
  if (diag.youtube_http && diag.youtube_http !== 200) {
    return `youtube_playlist_http_${diag.youtube_http}`;
  }
  if (diag.search_http && diag.search_http !== 200 && !(diag.playlist_items > 0)) {
    return `youtube_search_http_${diag.search_http}`;
  }
  if ((diag.stale_matched || 0) > 0) {
    return "no_recent_macro_minute_on_youtube";
  }
  if ((diag.playlist_items || 0) > 0 || (diag.search_items || 0) > 0) {
    return "no_macro_minute_title_in_recent_uploads";
  }
  return "no_macro_minute_videos";
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** True when a video title is a Macro Minute episode. */
export function isMacroMinuteTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  return /macro[\s\-]?minute/.test(t);
}

/** True when publishedAt is within maxAgeDays (undated → not fresh). */
export function isFreshPublished(published, { now = Date.now(), maxAgeDays = MACRO_MINUTE_MAX_AGE_DAYS } = {}) {
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return false;
  const maxMs = Math.max(1, Number(maxAgeDays) || MACRO_MINUTE_MAX_AGE_DAYS) * 86400 * 1000;
  return (now - t) <= maxMs && t <= now + 86400 * 1000;
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
    .replace(/\[[^\]]*\]/g, " ")
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

function emptyDiag(keyPresent) {
  return {
    key_present: Boolean(keyPresent),
    youtube_http: null,
    youtube_error: null,
    playlist_items: 0,
    playlist_matched: 0,
    playlist_titles: [],
    search_http: null,
    search_error: null,
    search_items: 0,
    search_matched: 0,
    search_titles: [],
    rss_http: null,
    rss_items: 0,
    rss_matched: 0,
    stale_matched: 0,
    stale_titles: [],
  };
}

function ytErrorMessage(json, text) {
  const msg = json?.error?.message
    || json?.error?.errors?.[0]?.reason
    || json?.error?.status
    || String(text || "").slice(0, 200);
  return sanitizeYtErrorText(msg);
}

async function fetchYoutubeJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

function playlistItemToVideo(it) {
  const videoId = it?.snippet?.resourceId?.videoId || null;
  return {
    videoId,
    title: it?.snippet?.title || "",
    published: it?.snippet?.publishedAt || null,
    description: it?.snippet?.description || "",
    link: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
  };
}

function searchItemToVideo(it) {
  const videoId = it?.id?.videoId || null;
  return {
    videoId,
    title: it?.snippet?.title || "",
    published: it?.snippet?.publishedAt || null,
    description: it?.snippet?.description || "",
    link: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
  };
}

function mergeVideo(map, v) {
  if (!v?.videoId) return;
  const prev = map.get(v.videoId);
  if (!prev) {
    map.set(v.videoId, v);
    return;
  }
  const longerDesc = String(v.description || "").length > String(prev.description || "").length;
  map.set(v.videoId, {
    ...prev,
    ...v,
    description: longerDesc ? v.description : prev.description,
    title: v.title || prev.title,
  });
}

/**
 * Discover recent Macro Minute videos for the Fundstrat channel.
 * Prefers the YouTube Data API (YOUTUBE_API_KEY): uploads playlist (50) plus
 * channel search. RSS is a best-effort fallback. Returns videos + diag.
 */
export async function discoverMacroMinuteVideosDetailed(env, { limit = 10 } = {}) {
  const key = env?.YOUTUBE_API_KEY;
  const diag = emptyDiag(key);
  const matched = new Map();
  const cap = Math.min(15, Math.max(1, Number(limit) || 10));

  if (key) {
    try {
      const playlist = uploadsPlaylistId(FUNDSTRAT_CHANNEL_ID);
      const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlist}&key=${encodeURIComponent(key)}`;
      const pl = await fetchYoutubeJson(plUrl);
      diag.youtube_http = pl.status;
      if (pl.ok) {
        const items = Array.isArray(pl.json?.items) ? pl.json.items : [];
        diag.playlist_items = items.length;
        diag.playlist_titles = items.slice(0, 8).map((it) => String(it?.snippet?.title || "").slice(0, 80));
        const hits = items.map(playlistItemToVideo).filter((v) => v.videoId && isMacroMinuteTitle(v.title));
        diag.playlist_matched = hits.length;
        for (const v of hits) mergeVideo(matched, v);
      } else {
        diag.youtube_error = ytErrorMessage(pl.json, pl.text);
      }
    } catch (e) {
      diag.youtube_error = sanitizeYtErrorText(String(e?.message || e));
    }

    try {
      const q = encodeURIComponent("Macro Minute");
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${FUNDSTRAT_CHANNEL_ID}&q=${q}&type=video&order=date&maxResults=15&key=${encodeURIComponent(key)}`;
      const sr = await fetchYoutubeJson(searchUrl);
      diag.search_http = sr.status;
      if (sr.ok) {
        const items = Array.isArray(sr.json?.items) ? sr.json.items : [];
        diag.search_items = items.length;
        diag.search_titles = items.slice(0, 8).map((it) => String(it?.snippet?.title || "").slice(0, 80));
        const hits = items.map(searchItemToVideo).filter((v) => v.videoId && isMacroMinuteTitle(v.title));
        diag.search_matched = hits.length;
        for (const v of hits) mergeVideo(matched, v);
      } else {
        diag.search_error = ytErrorMessage(sr.json, sr.text);
      }
    } catch (e) {
      diag.search_error = sanitizeYtErrorText(String(e?.message || e));
    }

    const thin = [...matched.values()].filter((v) => isFreshPublished(v.published) && String(v.description || "").length < 80);
    if (thin.length && key) {
      try {
        const ids = thin.map((v) => v.videoId).slice(0, 15).join(",");
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids}&key=${encodeURIComponent(key)}`;
        const vr = await fetchYoutubeJson(vUrl);
        if (vr.ok) {
          for (const it of (vr.json?.items || [])) {
            mergeVideo(matched, {
              videoId: it?.id || null,
              title: it?.snippet?.title || "",
              published: it?.snippet?.publishedAt || null,
              description: it?.snippet?.description || "",
              link: it?.id ? `https://www.youtube.com/watch?v=${it.id}` : null,
            });
          }
        }
      } catch (_) { /* descriptions stay truncated */ }
    }

    const fresh = [...matched.values()].filter((v) => isFreshPublished(v.published));
    const stale = [...matched.values()].filter((v) => !isFreshPublished(v.published));
    diag.stale_matched = stale.length;
    diag.stale_titles = stale.slice(0, 5).map((v) => String(v.title || "").slice(0, 80));
    if (fresh.length) {
      const videos = fresh
        .sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")))
        .slice(0, cap);
      return { videos, diag };
    }
  }

  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${FUNDSTRAT_CHANNEL_ID}`, {
      headers: { "User-Agent": YT_UA, Accept: "application/atom+xml" },
    });
    diag.rss_http = r.status;
    if (r.ok) {
      const xml = await r.text();
      const parsed = parseYoutubeRss(xml);
      diag.rss_items = parsed.length;
      const vids = parsed.filter((v) => isMacroMinuteTitle(v.title));
      diag.rss_matched = vids.length;
      const fresh = vids.filter((v) => isFreshPublished(v.published));
      const stale = vids.filter((v) => !isFreshPublished(v.published));
      diag.stale_matched = Math.max(diag.stale_matched, stale.length);
      if (stale.length && !diag.stale_titles.length) {
        diag.stale_titles = stale.slice(0, 5).map((v) => String(v.title || "").slice(0, 80));
      }
      return { videos: fresh.slice(0, cap), diag };
    }
  } catch (_) { /* nothing */ }
  return { videos: [], diag };
}

/** Discover Macro Minute videos (videos array only). */
export async function discoverMacroMinuteVideos(env, opts = {}) {
  const { videos } = await discoverMacroMinuteVideosDetailed(env, opts);
  return videos;
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
  const { videos, diag } = await discoverMacroMinuteVideosDetailed(env, { limit });
  try {
    console.log("[mm-yt]", JSON.stringify({
      youtube_http: diag.youtube_http,
      search_http: diag.search_http,
      playlist_items: diag.playlist_items,
      playlist_matched: diag.playlist_matched,
      search_items: diag.search_items,
      search_matched: diag.search_matched,
      rss_http: diag.rss_http,
      rss_items: diag.rss_items,
    }));
  } catch (_) { /* ignore */ }
  if (!videos.length) {
    return {
      ok: true,
      discovered: 0,
      ingested: 0,
      note: discoveryEmptyNote(diag),
      diag,
    };
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
        source: "youtube",
      });
      if (res?.ok) {
        ingested++;
        if (KV) await KV.put(flagKey, JSON.stringify({ at: Date.now(), source }), { expirationTtl: 180 * 86400 }).catch(() => {});
      }
      results.push({ videoId: v.videoId, source, ok: !!res?.ok, chars: body.length, pub_id: res?.pub_id || null });
    } catch (e) {
      results.push({ videoId: v.videoId, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: true, discovered: videos.length, ingested, results, diag };
}
