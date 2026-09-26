/**
 * Open-trade broker-mirror status for Portfolio (and any surface that
 * shows model books next to live broker follow-through).
 *
 * Equity ST/LT: `mirror_trade_manifest` sleeves via loadBrokerSleeves.
 * Paper DT / Index Swings: latest BUY decision in the lane mirror log.
 *
 * Status vocabulary (chip-friendly):
 *   mirrored | pending | rejected | skipped | not_mirrored | unknown
 */

import { loadBrokerSleeves, sleeveFor } from "./broker-held-equity.js";
import { applyPaperMirrorLog, paperMirrorLogSide } from "./broker-day-actions-join.js";
import { OPT_DT_MIRROR_LOG_KEY } from "./options-auto-mirror.js";
import { INDEX_TREND_MIRROR_LOG_KEY } from "./index-trend-auto-mirror.js";

const OPEN_MIRROR_FROM_PAPER = {
  mirrored: "mirrored",
  forwarded: "mirrored",
  pending: "pending",
  rejected: "rejected",
  skipped: "skipped",
};

export function classifyEquitySleeveMirror(sleeve) {
  if (sleeve == null) return { status: "unknown", reason: null };
  const remaining = Math.max(0, Number(sleeve.remaining) || 0);
  const filled = Math.max(0, Number(sleeve.filled) || 0);
  if (remaining > 0) {
    return { status: "mirrored", reason: null, remaining, filled };
  }
  if (filled > 0) {
    // Manifest remembers a fill but remaining is 0 while the model book
    // is still OPEN — broker was flat (or fully trimmed) relative to this
    // sleeve. Surface as not_mirrored for the open-book question "does
    // this trade still have a broker mirror?".
    return { status: "not_mirrored", reason: "sleeve_flat", remaining, filled };
  }
  return { status: "not_mirrored", reason: "no_sleeve", remaining: 0, filled: 0 };
}

export function classifyPaperOpenMirror(logHit) {
  const applied = applyPaperMirrorLog(logHit);
  if (!applied) return { status: "not_mirrored", reason: "no_mirror_log" };
  const status = OPEN_MIRROR_FROM_PAPER[applied.mirror] || "skipped";
  return {
    status,
    reason: applied.mirrorReason || null,
    note: applied.mirrorNote || null,
  };
}

/** Latest BUY-side mirror-log row for a signal (ENTRY / DCA). */
export function latestOpenMirrorLog(logRows, signalId) {
  const sid = String(signalId || "").trim().toLowerCase();
  if (!sid || !Array.isArray(logRows)) return null;
  let best = null;
  for (const row of logRows) {
    const rowSid = String(row?.signal_id || row?.trade_id || "").trim().toLowerCase();
    if (rowSid !== sid) continue;
    if (paperMirrorLogSide(row) !== "buy") continue;
    if (!best || Number(row.ts) > Number(best.ts)) best = row;
  }
  return best;
}

async function readKvJsonArray(env, key) {
  try {
    const raw = await env?.KV_TIMED?.get(key);
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Attach broker_mirror + broker_mirror_reason onto open trade-shaped rows.
 * Best-effort: bridge/KV failures leave status "unknown" rather than hiding
 * the book.
 */
export async function attachOpenTradeBrokerMirror(env, trades, { lane = "equity" } = {}) {
  if (!Array.isArray(trades) || !trades.length) return trades || [];

  if (lane === "index_day_trade" || lane === "index_swing") {
    const key = lane === "index_day_trade" ? OPT_DT_MIRROR_LOG_KEY : INDEX_TREND_MIRROR_LOG_KEY;
    const log = await readKvJsonArray(env, key);
    return trades.map((t) => {
      const sid = t?.trade_id || t?.signal_id || t?.id;
      const hit = latestOpenMirrorLog(log, sid);
      const info = classifyPaperOpenMirror(hit);
      return {
        ...t,
        broker_mirror: info.status,
        broker_mirror_reason: info.reason,
      };
    });
  }

  // Equity ST + LT — one manifest fetch for the whole batch.
  let sleeves = null;
  try {
    sleeves = await loadBrokerSleeves(env);
  } catch (_) {
    sleeves = null;
  }
  return trades.map((t) => {
    const tid = t?.trade_id || t?.position_id || t?.id;
    const sleeve = sleeveFor(sleeves, tid);
    // Investor rows sometimes carry id without the inv- prefix the
    // manifest used; try both when the first miss looks empty.
    let info = classifyEquitySleeveMirror(sleeve);
    if (info.status === "not_mirrored" && tid && !String(tid).startsWith("inv-")) {
      const alt = sleeveFor(sleeves, `inv-${tid}`);
      const altInfo = classifyEquitySleeveMirror(alt);
      if (altInfo.status === "mirrored") info = altInfo;
    }
    if (sleeves == null) {
      info = { status: "unknown", reason: "manifest_unavailable" };
    }
    return {
      ...t,
      broker_mirror: info.status,
      broker_mirror_reason: info.reason || null,
    };
  });
}
