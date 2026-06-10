// ═══════════════════════════════════════════════════════════════════════════
// worker/feed/feed-window.js — session-window decision for the price feed.
//
// Pure replication of the virtual-cron registration the monolith uses in
// scheduled() (worker/index.js ~86784-86792) to decide whether the */1 tick
// should run the price feed, and in which mode:
//
//   FULL feed (every minute):
//     - weekday, UTC 8-23           ("*/1 9-23 * * 1-5" — covers EDT + EST)
//     - UTC day Tue-Sat, hour <= 1  ("*/1 0-1 * * 2-6"  — ET evening spillover)
//   LIGHTWEIGHT feed (TV futures + crypto overlay only):
//     - Sunday, UTC >= 22           ("*/5 22-23 * * 7"  — Sunday evening)
//     - UTC 2-8, minute % 5 === 0   ("*/5 2-8 * * *"    — overnight crypto)
//
// The standalone tt-feed worker uses this instead of the monolith's `vc`
// Set. Keep BOTH in sync — if the monolith's registration windows change,
// change this too (and vice versa).
// ═══════════════════════════════════════════════════════════════════════════

export function computeFeedWindow(now = new Date()) {
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0=Sun … 6=Sat
  const isWeekday = utcDay >= 1 && utcDay <= 5;

  const fullWeekday = isWeekday && utcH >= 8 && utcH <= 23;
  const fullSpillover = utcDay >= 2 && utcDay <= 6 && utcH <= 1;
  const lightSunday = utcDay === 0 && utcH >= 22;
  const lightOvernight = utcH >= 2 && utcH <= 8 && utcM % 5 === 0;

  const isPriceFeedCron = fullWeekday || fullSpillover || lightSunday || lightOvernight;
  const isLightweight = isPriceFeedCron && !fullWeekday && !fullSpillover;

  return { isPriceFeedCron, isLightweight, utcMinute: utcM };
}
