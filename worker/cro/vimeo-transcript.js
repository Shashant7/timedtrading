// worker/cro/vimeo-transcript.js
//
// Tom Lee's Macro Minute lives on Vimeo inside the Fundstrat Direct post
// (members). The WP body we already ingest is a ~600 char blurb + an iframe;
// the substance is the spoken 5-minute take. Vimeo player config exposes
// auto-generated English captions (VTT). We fetch those and append
// `--- VIDEO TRANSCRIPT ---` onto the publication text so CRO / calendar
// extract / Daily Brief see the night take, not the teaser.
//
// Verified 2026-08-13: GET player.vimeo.com/video/{id}/config with
// Referer: https://fundstratdirect.com/ returns request.text_tracks[].

const FSD_REFERER = "https://fundstratdirect.com/";
const CONFIG_TIMEOUT_MS = 12_000;
const VTT_TIMEOUT_MS = 10_000;
const YT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * True when a publication's captions are worth fetching.
 *
 * A Vimeo embed on Fundstrat Direct is never decoration — it IS the note.
 * Newton's Daily Technical Strategy ("Technical Strategy 08/14/2026") ships
 * as video with a ~174 char body, and the old `^video:` title prefix meant it
 * was ingested as an empty post. Any embedded Vimeo player now qualifies, so
 * new video series are covered without another title rule. The transcript is
 * appended, never substituted, so a post with real prose loses nothing.
 */
export function shouldFetchVimeoTranscript(title, html) {
  const t = String(title || "");
  if (/macro[\s\-]?minute/i.test(t)) return true;
  return /(?:player\.)?vimeo\.com\/(?:video\/)?\d+/i.test(String(html || ""));
}

/** Parse player.vimeo.com / vimeo.com embeds from WP content.rendered. */
export function extractVimeoEmbeds(html) {
  const s = String(html || "");
  const out = [];
  const seen = new Set();
  const patterns = [
    /player\.vimeo\.com\/video\/(\d+)(?:\?([^"'<\s]*))?/gi,
    /vimeo\.com\/(?:video\/)?(\d+)(?:\?([^"'<\s]*))?/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const videoId = m[1];
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const qs = m[2] || "";
      const hash = (qs.match(/(?:^|&)h=([a-zA-Z0-9]+)/) || [])[1] || null;
      out.push({ videoId, hash });
    }
  }
  return out;
}

/** Pick the best English text track from a Vimeo player-config JSON. */
export function pickVimeoTextTrack(config) {
  const tracks = config?.request?.text_tracks || config?.request?.textTracks || [];
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const en = tracks.filter((t) => /^en/i.test(String(t?.lang || t?.language || "")));
  const pool = en.length ? en : tracks;
  const human = pool.find((t) => !/autogen|ai_generated/i.test(`${t?.lang || ""} ${t?.provenance || ""} ${t?.label || ""}`));
  return human || pool[0] || null;
}

/** WEBVTT → prose. Drops cue times, cue ids, and consecutive autogen dupes. */
export function parseVtt(vtt) {
  const lines = String(vtt || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const parts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^WEBVTT/i.test(t)) continue;
    if (/^NOTE\b/i.test(t) || /^STYLE\b/i.test(t) || /^REGION\b/i.test(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (/-->/.test(t)) continue;
    parts.push(t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (out[out.length - 1] === p) continue;
    out.push(p);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function absUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return "https://player.vimeo.com" + (s.startsWith("/") ? s : `/${s}`);
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/**
 * Fetch spoken transcript for a Vimeo embed. Best-effort; never throws.
 * Returns { ok, text, videoId, track_lang, chars, error_kind }.
 */
export async function fetchVimeoTranscript(embed, { userAgent = YT_UA, referer = FSD_REFERER } = {}) {
  const videoId = String(embed?.videoId || "").replace(/\D/g, "");
  if (!videoId) return { ok: false, error_kind: "no_video_id", text: "" };
  const qs = embed?.hash ? `?h=${encodeURIComponent(embed.hash)}` : "";
  const cfgUrl = `https://player.vimeo.com/video/${videoId}/config${qs}`;
  const headers = {
    "User-Agent": userAgent,
    Referer: referer,
    Accept: "application/json",
  };
  try {
    const { signal, done } = withTimeout(CONFIG_TIMEOUT_MS);
    const r = await fetch(cfgUrl, { method: "GET", headers, signal });
    done();
    if (!r.ok) return { ok: false, error_kind: `config_http_${r.status}`, text: "", videoId };
    const json = await r.json().catch(() => null);
    const track = pickVimeoTextTrack(json);
    const trackUrl = absUrl(track?.url);
    if (!trackUrl) return { ok: false, error_kind: "no_text_track", text: "", videoId };
    const { signal: s2, done: d2 } = withTimeout(VTT_TIMEOUT_MS);
    const vr = await fetch(trackUrl, {
      method: "GET",
      headers: { "User-Agent": userAgent, Referer: referer, Accept: "text/vtt,text/plain,*/*" },
      signal: s2,
    });
    d2();
    if (!vr.ok) return { ok: false, error_kind: `vtt_http_${vr.status}`, text: "", videoId };
    const vtt = await vr.text();
    const text = parseVtt(vtt);
    if (!text || text.length < 80) return { ok: false, error_kind: "transcript_too_short", text: text || "", videoId };
    return {
      ok: true,
      text,
      videoId,
      track_lang: track?.lang || track?.language || null,
      chars: text.length,
    };
  } catch (e) {
    return { ok: false, error_kind: "fetch_exception", hint: String(e?.message || e).slice(0, 160), text: "", videoId };
  }
}

/** Split a stored Macro Minute body into blurb vs spoken transcript. */
export function splitMacroMinuteBody(textFull) {
  const full = String(textFull || "");
  const m = full.match(/--- VIDEO TRANSCRIPT ---\s*([\s\S]*)$/i);
  if (!m) {
    return { has_transcript: false, transcript: "", blurb: full.trim() };
  }
  return {
    has_transcript: true,
    transcript: String(m[1] || "").trim(),
    blurb: full.slice(0, m.index).trim(),
  };
}
export function mergeTranscriptIntoText(bodyText, transcript) {
  const body = String(bodyText || "").trim();
  const tr = String(transcript || "").trim();
  if (!tr) return body;
  if (/--- VIDEO TRANSCRIPT ---/i.test(body)) {
    return body.replace(/--- VIDEO TRANSCRIPT ---[\s\S]*$/i, `--- VIDEO TRANSCRIPT ---\n${tr}`).trim();
  }
  if (!body) return `--- VIDEO TRANSCRIPT ---\n${tr}`;
  return `${body}\n\n--- VIDEO TRANSCRIPT ---\n${tr}`;
}
