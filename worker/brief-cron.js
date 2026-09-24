// brief-cron.js — Daily Brief cron scheduling helpers.
//
// 2026-09-24: tt-research hourly ticks at 9 AM / 5 PM ET were dying with
// `exceededMemory` while learning-desk + Loop2 + portfolio-risk waitUntils
// competed with generateDailyBrief on the same isolate. Morning 2026-09-24
// never landed until a manual POST. Fix:
//   1. Fire the brief FIRST on exact-hour ticks (before heavy hourly work).
//   2. Catch up on later hourly ticks the same ET day if D1 has no row.
//   3. Skip non-essential hourly arms on exact brief hours to free memory.

import {
  generateDailyBrief,
  generateIntradayBrief,
  findExistingDailyBrief,
  getBriefEtDate,
} from "./daily-brief.js";
import { recordBriefCronOutcome } from "./alerts.js";
import { shouldScheduleBriefRetry, scheduleBriefCronRetry } from "./openai-spend.js";

/** Exact ET hour + same-day catch-up window for morning / evening briefs. */
export const BRIEF_CRON_WINDOWS = {
  morning: { exactEtHour: 9, catchUpThroughEtHour: 15, op: "daily_brief_morning" },
  evening: { exactEtHour: 17, catchUpThroughEtHour: 20, op: "daily_brief_evening" },
};

/**
 * Decide whether this hourly tick should run a morning/evening brief.
 * @returns {{ fire: boolean, catchUp: boolean, reason: string }}
 */
export function decideDailyBriefCronSlot(type, etHour, { weekday = true } = {}) {
  const win = BRIEF_CRON_WINDOWS[String(type || "").toLowerCase()];
  if (!win) return { fire: false, catchUp: false, reason: "unknown_type" };
  if (!weekday) return { fire: false, catchUp: false, reason: "weekend" };
  const h = Number(etHour);
  if (!Number.isFinite(h)) return { fire: false, catchUp: false, reason: "bad_hour" };
  if (h === win.exactEtHour) return { fire: true, catchUp: false, reason: "exact" };
  if (h > win.exactEtHour && h <= win.catchUpThroughEtHour) {
    return { fire: true, catchUp: true, reason: "catch_up_window" };
  }
  return { fire: false, catchUp: false, reason: "outside_window" };
}

/** True on Mon–Fri in America/New_York. */
export function isEtWeekday(now = new Date()) {
  const dow = new Date(now).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  return dow !== "Sat" && dow !== "Sun";
}

export function etHourNow(now = new Date()) {
  return parseInt(
    new Date(now).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
}

/**
 * Exact brief hour → suppress competing hourly waitUntils so the isolate
 * has headroom for OpenAI + candle gather.
 */
export function shouldDeferHeavyHourlyWorkForBrief(etHour, { weekday = true } = {}) {
  if (!weekday) return false;
  const h = Number(etHour);
  return h === BRIEF_CRON_WINDOWS.morning.exactEtHour
    || h === BRIEF_CRON_WINDOWS.evening.exactEtHour;
}

/**
 * Intraday flash: exact 11 / 14 ET, plus +1h catch-up if the slot is empty.
 */
export function decideIntradayFlashCronSlot(etHour, { weekday = true } = {}) {
  if (!weekday) return { fire: false, catchUp: false, slotHour: null, reason: "weekend" };
  const h = Number(etHour);
  if (h === 11 || h === 14) return { fire: true, catchUp: false, slotHour: h, reason: "exact" };
  if (h === 12) return { fire: true, catchUp: true, slotHour: 11, reason: "catch_up_11" };
  if (h === 15) return { fire: true, catchUp: true, slotHour: 14, reason: "catch_up_14" };
  return { fire: false, catchUp: false, slotHour: null, reason: "outside_window" };
}

/**
 * Schedule morning or evening brief generation on this cron tick.
 * Returns true when a waitUntil was queued.
 */
export function scheduleDailyBriefCron(env, ctx, {
  type,
  etHour,
  weekday = true,
  SECTOR_MAP,
  d1GetCandles,
  notifyDiscord,
  d1InsertNotification,
  now = new Date(),
} = {}) {
  const decision = decideDailyBriefCronSlot(type, etHour, { weekday });
  if (!decision.fire || !ctx?.waitUntil) return false;

  const win = BRIEF_CRON_WINDOWS[type];
  const dateEt = getBriefEtDate(now);
  const briefType = String(type).toLowerCase();

  ctx.waitUntil((async () => {
    try {
      if (decision.catchUp) {
        const existing = await findExistingDailyBrief(env, briefType, dateEt);
        if (existing) {
          console.log(`[DAILY BRIEF CRON] Catch-up skip ${briefType} — already have ${existing.id}`);
          return;
        }
        console.log(`[DAILY BRIEF CRON] Catch-up ${briefType} at ${etHour}:00 ET (missed ${win.exactEtHour}:00 slot)`);
      } else {
        console.log(`[DAILY BRIEF CRON] Generating ${briefType} brief...`);
      }

      const opts = {
        SECTOR_MAP,
        d1GetCandles,
        notifyDiscord,
        d1InsertNotification,
        skipIfExists: true,
        dateEt,
      };
      let result;
      try {
        result = await generateDailyBrief(env, briefType, opts);
        console.log(`[DAILY BRIEF CRON] ${briefType}: ${result.ok ? (result.skipped || "OK") : result.error} (${result.elapsed || 0}ms)`);
      } catch (e) {
        console.error(`[DAILY BRIEF CRON] ${briefType} failed:`, String(e).slice(0, 300));
        result = { ok: false, error: String(e?.message || e) };
      }

      if (decision.catchUp && result?.ok && !result?.skipped && typeof notifyDiscord === "function") {
        try {
          await notifyDiscord(env, {
            title: `Daily Brief ${briefType} catch-up`,
            description:
              `The ${win.exactEtHour}:00 ET cron missed today's ${briefType} brief ` +
              `(often \`exceededMemory\` on tt-research). Catch-up at ${etHour}:00 ET wrote \`${result.id || dateEt}\`.`,
            color: 0xf59e0b,
          }, "system");
        } catch (_) { /* best-effort */ }
      }

      await recordBriefCronOutcome(env, win.op, result);
      try {
        if (shouldScheduleBriefRetry(result)) {
          scheduleBriefCronRetry(ctx, env, win.op, () => generateDailyBrief(env, briefType, opts));
        }
      } catch (_) { /* retry optional */ }
    } catch (e) {
      console.error(`[DAILY BRIEF CRON] ${briefType} outer failed:`, String(e).slice(0, 300));
      await recordBriefCronOutcome(env, win.op, { ok: false, error: String(e?.message || e) });
    }
  })());

  return true;
}

/**
 * Schedule intraday flash with optional +1h catch-up.
 */
export function scheduleIntradayFlashCron(env, ctx, {
  etHour,
  weekday = true,
  SECTOR_MAP,
  d1GetCandles,
  notifyDiscord,
} = {}) {
  const decision = decideIntradayFlashCronSlot(etHour, { weekday });
  if (!decision.fire || !ctx?.waitUntil) return false;

  const slotHour = decision.slotHour;
  ctx.waitUntil((async () => {
    try {
      console.log(`[INTRADAY FLASH CRON] Generating flash at slot ${slotHour}:00 ET` +
        (decision.catchUp ? ` (catch-up from ${etHour}:00)` : "") + "...");
      const flashOpts = {
        SECTOR_MAP,
        d1GetCandles,
        notifyDiscord,
        skipIfExists: true,
        intradayEtHour: slotHour,
      };
      let result;
      try {
        result = await generateIntradayBrief(env, flashOpts);
        console.log(`[INTRADAY FLASH CRON] ${result.ok ? (result.skipped || "OK") : result.error} (${result.elapsed || 0}ms)`);
      } catch (e) {
        console.error("[INTRADAY FLASH CRON] Failed:", String(e).slice(0, 300));
        result = { ok: false, error: String(e?.message || e) };
      }
      await recordBriefCronOutcome(env, "intraday_flash", result);
      try {
        if (shouldScheduleBriefRetry(result)) {
          scheduleBriefCronRetry(ctx, env, "intraday_flash", () =>
            generateIntradayBrief(env, flashOpts));
        }
      } catch (_) { /* optional */ }
    } catch (e) {
      console.error("[INTRADAY FLASH CRON] Outer failed:", String(e).slice(0, 300));
      await recordBriefCronOutcome(env, "intraday_flash", { ok: false, error: String(e?.message || e) });
    }
  })());

  return true;
}
