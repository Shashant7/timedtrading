// option-day-trade-alerts.js
//
// Paper BUY / TRIM / EXIT / STOP → Discord #trade-signals.
// KV book is the position; the clock is the tape. Only the Today
// default profile (speculator) notifies so the */5 pre-warm of
// moderate/aggressive does not triple-post.

import { notifyDiscord } from "./alerts.js";
import {
  buildSatyDayTradePlan,
  sizeDayTradePlay,
  classifyPaperEvent,
  buildDayTradeSignalEmbed,
} from "./option-day-trade-plan.js";

const BOOK_TTL = 3 * 86400;
const DEFAULT_PROFILE = "speculator";

function stWithPlay(execution, flavor) {
  const dir = Number(execution?.indicators?.st_dir);
  if (!Number.isFinite(dir)) return false;
  const isPut = String(flavor || "").toLowerCase() === "put";
  return isPut ? dir > 0 : dir < 0;
}

export function assembleDayTradePlan(payload = {}) {
  const exec = payload.execution || {};
  const gp = payload.gamePlan || payload.game_plan || {};
  const flavor = payload.flavor || exec.contract?.flavor;
  const size = sizeDayTradePlay({
    leanConviction: gp.lean_conviction || payload.day_lean_conviction,
    premiumBand: exec.premium_band?.band,
    stWith: stWithPlay(exec, flavor),
    honestyVeto: !!payload.honesty_gate_veto,
    premium: payload.premium ?? exec.premium_band?.premium,
  });
  const plan = buildSatyDayTradePlan({
    ticker: payload.ticker,
    flavor,
    strike: payload.strike ?? exec.contract?.strike,
    expiration: payload.expiration || exec.contract?.expiration,
    spot: payload.spot,
    premium: payload.premium,
    execution: exec,
    gamePlan: gp,
    management: payload.management,
    size,
    now: payload.now,
  });
  return { plan, size };
}

export async function maybeNotifyDayTradePaperEvent(env, payload = {}) {
  const profile = String(payload.profile || DEFAULT_PROFILE).toLowerCase();
  if (profile && profile !== DEFAULT_PROFILE) {
    return { skipped: true, reason: "non_default_profile" };
  }
  const KV = env?.KV_TIMED;
  const signalId = String(payload.signal_id || "").trim();
  if (!KV || !signalId) return { skipped: true, reason: !KV ? "no_kv" : "no_signal" };
  if (!payload.execution) return { skipped: true, reason: "no_clock" };

  const { plan, size } = assembleDayTradePlan(payload);
  const bookKey = `timed:opt-dt-book:${signalId}`;
  let book = null;
  try {
    const raw = await KV.get(bookKey);
    book = raw ? JSON.parse(raw) : null;
  } catch {
    book = null;
  }

  const decision = classifyPaperEvent({
    clock: payload.execution,
    book,
    premium: payload.premium ?? payload.execution?.premium_band?.premium,
    now: payload.now || Date.now(),
    size,
  });

  if (decision.nextBook) {
    await KV.put(bookKey, JSON.stringify(decision.nextBook), { expirationTtl: BOOK_TTL }).catch(() => {});
  }
  if (!decision.event) {
    return { ok: true, event: null, plan, size, book: decision.nextBook || book };
  }

  const embed = buildDayTradeSignalEmbed({
    event: decision.event,
    ticker: payload.ticker,
    plan,
    size,
    execution: payload.execution,
    premium: payload.premium,
    spot: payload.spot,
    reason: decision.reason,
    now: payload.now || Date.now(),
  });

  const discord = await notifyDiscord(env, embed, "trade").catch((err) => ({
    ok: false,
    error: String(err?.message || err).slice(0, 160),
  }));

  return {
    ok: !!discord?.ok,
    event: decision.event,
    reason: decision.reason || null,
    plan,
    size,
    embed,
    discord,
  };
}
