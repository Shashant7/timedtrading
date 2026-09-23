// worker/engine-oom-mirror-loss-2026-09-22.test.js
//
// 2026-09-22 — DDOG opened a 0.1x Cloud Pivot paper-family ticket, the
// Discord card went out, and the broker order never happened. Coverage could
// say nothing more than `never_attempted`, because nothing was attempted.
//
// The tt-engine `*/5` invocation was killed mid-tick:
//
//   17:55:47.???  [PAPER_FAMILY_ENTRY] DDOG tt_cloud_pivot LONG 0.1x
//   17:56:04.???  [ENTRY_CREATED] DDOG dir=LONG vehicle=shares shares=6.28
//   17:56:16.???  [DISCORD lane=trade] Notification sent: Enter: DDOG LONG
//   17:56:17.797  error | */5 * * * *  outcome=exceededMemory wall=322748ms
//
// Grouping every scheduled tt-engine invocation between 14:00 and 18:00Z by
// `$workers.outcome` (sampleInterval 1, so these are counts and not
// estimates) says this was the ordinary state of a trading day:
//
//   2026-09-16   exceededMemory 49
//   2026-09-17   exceededMemory 48
//   2026-09-18   exceededMemory 48, canceled 1
//   2026-09-19   ok 47                        <- Saturday
//   2026-09-21   exceededMemory 46, canceled 1
//   2026-09-22   exceededMemory 46, canceled 1
//
// Two things were wrong and both are fixed here:
//
//  1. The bridge forward sat ~360 lines BELOW the Discord/email/activity
//     tail inside the same `if (!dedupe.deduped)` block, so an isolate kill
//     between the card and the forward loses the order silently. The one
//     step that moves money now runs first.
//  2. `cron_tick_alive` read healthy through all of it, because
//     `cron:last_5min_tick` is stamped at the TOP of the handler. A tick
//     that fires and never finishes now reports as the outage it is.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  diagnoseCronTick,
  CRON_COMPLETION_WARN_MIN,
  CRON_COMPLETION_FAIL_MIN,
} from "./sanity-sweep.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("the money-moving step runs before the notifications", () => {
  // Asserted on source order rather than behaviour: the failure mode is an
  // isolate that is killed outright, which no test harness can stage — the
  // runtime runs no `catch` and awaits no promise. Ordering is the whole fix,
  // so ordering is what is pinned.
  // Sliced to the ENTRY dedupe block up front. Never assert with
  // `expect(wholeFile).toMatch(...)`: index.js is ~4MB and a miss prints it.
  const src = readFileSync(join(root, "index.js"), "utf8");
  const blockStart = src.indexOf('type: "TRADE_ENTRY",');
  const block = src.slice(blockStart, blockStart + 40_000);

  const bridge = block.indexOf("forwardOrderToBridge");
  const embed = block.indexOf("createTradeEntryEmbed");
  const emails = block.indexOf("dispatchTradeAlertEmails");

  it("finds the trader ENTRY dispatch block", () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(-1);
    expect(embed).toBeGreaterThan(-1);
    expect(emails).toBeGreaterThan(-1);
  });

  it("puts the bridge forward ahead of the entry Discord card", () => {
    expect(bridge).toBeLessThan(embed);
  });

  it("puts the bridge forward ahead of the entry emails", () => {
    expect(bridge).toBeLessThan(emails);
  });

  it("stamps the pending ring row before the fetch, so a kill still leaves a breadcrumb", () => {
    // The `never_attempted` reason is only reachable when `pushRing` never
    // ran. Keeping the stamp ahead of the fetch is what makes the difference
    // between "WORKING" and a blank row.
    const client = readFileSync(join(root, "broker-bridge-client.js"), "utf8");
    const forward = client.slice(client.indexOf("export async function forwardOrderToBridge"));
    const stamp = forward.indexOf("await pushRing(env, ringEntry)");
    const fetched = forward.search(/await (bridgeFetch|fetch|svc\.fetch)/);
    expect(stamp).toBeGreaterThan(-1);
    expect(fetched).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(fetched);
  });
});

describe("a cron tick that fires and never finishes", () => {
  // 2026-09-23 02:37Z, read straight out of production KV:
  //   cron:last_5min_tick      45s old
  //   timed:scoring:last_run   {"ts":1790121615272,"scored":34,"skipped":295,
  //                             "errors":0,"total":329,"elapsedMs":257692}
  const LIVE_SCORING = {
    ts: 1790121615272,
    scored: 34,
    skipped: 295,
    errors: 0,
    total: 329,
    elapsedMs: 257692,
  };

  const midSession = (mins) => ({
    // 2026-09-22 17:56Z — a Tuesday, one minute before the DDOG tick died.
    nowMs: Date.parse("2026-09-22T17:56:00Z"),
    lastTickMs: Date.parse("2026-09-22T17:56:00Z") - 60_000,
    lastScoringMs: Date.parse("2026-09-22T17:56:00Z") - mins * 60_000,
    scoringMeta: LIVE_SCORING,
  });

  it("reported ok before this check existed, which is the bug", () => {
    // The heartbeat alone. 60s old, therefore healthy, therefore silent —
    // through 46 consecutive OOM kills.
    expect(diagnoseCronTick({
      nowMs: Date.parse("2026-09-22T17:56:00Z"),
      lastTickMs: Date.parse("2026-09-22T17:56:00Z") - 60_000,
      lastScoringMs: Date.parse("2026-09-22T17:56:00Z") - 4 * 60_000,
    })).toEqual([]);
  });

  it("warns when the tick is firing but the pass has not landed in 25min", () => {
    const out = diagnoseCronTick(midSession(25));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warn");
    expect(out[0].detail).toContain("tick fired 1min ago");
    expect(out[0].detail).toContain("last completed scoring pass was 25min ago");
    expect(out[0].detail).toContain("(MARKET HOURS)");
  });

  it("fails once the gap is beyond an hour, and says what the last pass did", () => {
    const out = diagnoseCronTick(midSession(70));
    expect(out[0].severity).toBe("fail");
    expect(out[0].detail).toContain("scored 34/329");
    expect(out[0].detail).toContain("took 258s");
  });

  it("holds its thresholds at the boundary", () => {
    expect(diagnoseCronTick(midSession(CRON_COMPLETION_WARN_MIN - 1))).toEqual([]);
    expect(diagnoseCronTick(midSession(CRON_COMPLETION_WARN_MIN + 1))[0].severity).toBe("warn");
    expect(diagnoseCronTick(midSession(CRON_COMPLETION_FAIL_MIN - 1))[0].severity).toBe("warn");
    expect(diagnoseCronTick(midSession(CRON_COMPLETION_FAIL_MIN + 1))[0].severity).toBe("fail");
  });

  it("still reports a cron that is not firing at all, and only that", () => {
    const now = Date.parse("2026-09-22T17:56:00Z");
    const out = diagnoseCronTick({
      nowMs: now,
      lastTickMs: now - 40 * 60_000,
      lastScoringMs: now - 40 * 60_000,
      scoringMeta: LIVE_SCORING,
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("fail");
    expect(out[0].detail).toContain("last */5 cron tick 40min ago");
    expect(out[0].detail).not.toContain("scoring pass");
  });

  it("keeps quiet overnight, when the lane is meant to be idle", () => {
    // The 02:37Z read above: the heartbeat is 45s old and the last completed
    // pass is 177min old, which is 22:37 ET and entirely normal.
    const now = 1790132250000; // 2026-09-23T02:37:30Z
    expect(diagnoseCronTick({
      nowMs: now,
      lastTickMs: now - 45_000,
      lastScoringMs: LIVE_SCORING.ts,
      scoringMeta: LIVE_SCORING,
    })).toEqual([]);
  });

  it("escalates overnight only at extreme staleness", () => {
    const now = Date.parse("2026-09-23T02:37:30Z");
    const out = diagnoseCronTick({
      nowMs: now,
      lastTickMs: now - 45_000,
      lastScoringMs: now - 300 * 60_000,
      scoringMeta: LIVE_SCORING,
    });
    expect(out[0].severity).toBe("warn");
    expect(out[0].detail).toContain("(off-hours)");
  });

  it("keeps the missing-heartbeat case unchanged", () => {
    const out = diagnoseCronTick({ nowMs: Date.now(), lastTickMs: 0 });
    expect(out[0].severity).toBe("warn");
    expect(out[0].detail).toContain("cron:last_5min_tick KV key missing");
  });

  it("notices during a session when the completion stamp has never been written", () => {
    const now = Date.parse("2026-09-22T17:56:00Z");
    const out = diagnoseCronTick({ nowMs: now, lastTickMs: now - 60_000, lastScoringMs: 0 });
    expect(out[0].severity).toBe("warn");
    expect(out[0].detail).toContain("timed:scoring:last_run has never been written");
  });

  it("is wired into the check and names the mechanism in its remediation", () => {
    const sweep = readFileSync(join(root, "sanity-sweep.js"), "utf8");
    expect(sweep).toMatch(/env\.KV_TIMED\.get\("timed:scoring:last_run"\)/);
    expect(sweep).toMatch(/anomalies\.push\(\.\.\.diagnoseCronTick\(/);
    const remediation = sweep.slice(sweep.indexOf('"cron_tick_alive"'));
    expect(remediation).toMatch(/exceededMemory/);
  });
});

describe("only one heavy phase of the tick at a time", () => {
  // 2026-09-23. Slimming the snapshot, capping the KV puts and shortlisting
  // the kanban pass each removed real allocation and the `*/5` engine tick
  // still died on every consecutive pass — 08:40, 08:45 and 08:50 all
  // exceededMemory at wall 149-156s and cpu ~48s, so nowhere near the CPU
  // budget. What was left was not a single allocation but an overlap: the
  // scoring tail went into `ctx.waitUntil` the instant scoring finished, so
  // it ran alongside the execution pass. One tick's logs, interleaved:
  //
  //   08:41:42  [PAPER_FAMILY_ENTRY] RIOT ...   <- execution pass running
  //   08:41:43  [SCORING] Cloud Pivot desk: 28 watching of 329 scanned
  //   08:41:44  [SCORING] KV universe index built: 329 tickers
  //   08:42:22  [SCORING] D1 ticker_latest batch sync: 106 written
  //   08:42:30  [PAPER_FAMILY_ENTRY] IESC ...
  //   08:42:30  exceededMemory
  //
  // Two phases alive in one isolate is a sum, not a max. Like the ordering
  // fix above, this is pinned on source position: an isolate that is killed
  // outright runs no `catch` and awaits no promise, so there is no
  // behaviour for a harness to observe.
  const src = readFileSync(join(root, "index.js"), "utf8");

  const stash = src.indexOf("_deferredScoringTail = async () => {");
  const kanban = src.indexOf("[KANBAN CRON] Processed");
  const reconcile = src.indexOf('console.error("[POSITION RECONCILE] Error:"');
  const drain = src.indexOf("await _tailFn();");

  it("finds all four landmarks exactly once", () => {
    for (const at of [stash, kanban, reconcile, drain]) expect(at).toBeGreaterThan(-1);
    expect(src.indexOf("_deferredScoringTail = async () => {", stash + 1)).toBe(-1);
    expect(src.indexOf("await _tailFn();", drain + 1)).toBe(-1);
  });

  it("stashes the three heavy phases, not an empty thunk", () => {
    // The invariant is worth nothing if the expensive work drifts back out
    // of the deferred body and into the concurrent part of the tick.
    const body = src.slice(stash, kanban);
    expect(body).toContain('KV.put("timed:cloud-pivot:desk"');
    expect(body).toContain("const _built = await buildAllSnapshot(");
    expect(body).toContain("[SCORING] D1 ticker_latest batch sync:");
  });

  it("drains the tail only after the execution phases have let go", () => {
    expect(stash).toBeLessThan(kanban);
    expect(kanban).toBeLessThan(reconcile);
    expect(reconcile).toBeLessThan(drain);
  });

  it("drains the tail before the handler can return early", () => {
    // `if (!isAITime) return;` sits a few hundred lines further down and
    // fires on all but three ticks a day. A tail parked after it would
    // simply never run.
    const earlyReturn = src.indexOf("return; // Only do AI updates at specific times");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(earlyReturn);
  });

  it("deadlines the ranked entry pass against the tick, not against itself", () => {
    // Fixing the memory turned the failure into a wall-clock one: at market
    // ramp the pass went from ~200s to ~480s on top of ~220s of scoring and
    // the invocation hit Cloudflare's 900s limit, which kills the deferred
    // tail and position reconcile with it.
    const decl = src.match(/const KANBAN_ENTRY_BUDGET_MS = (\d+) \* 1000;/);
    expect(decl).not.toBeNull();
    expect(Number(decl[1])).toBeLessThanOrEqual(660);
    // Measured from the tick's claim, not from the pass's own start, or a
    // slow scoring phase ahead of it buys the pass nothing.
    expect(src).toContain("(_tickClaimedAt || _kanbanStart) + KANBAN_ENTRY_BUDGET_MS");
    expect(src).toContain("deadlineAt: _kanbanDeadline,");
  });

  it("budgets off the claim time, not off the lease it releases early", () => {
    // The lease answers "is another pass running", and it is cleared before
    // the monitoring passes run. The wall keeps counting until the invocation
    // ends, so the budget needs its own clock.
    expect(src).toContain("_tickClaimedAt = _fiveMinHeavyPassSince;");
    expect(src).toContain("const _tickTimeLeftMs = () => (_tickClaimedAt");
    expect(src).toContain("? _tickClaimedAt + TICK_WALL_MS - TICK_SAFETY_MS - Date.now()");
    // Infinity, not 0, when nothing claimed: the monolith and the non-*/5
    // schedules share this handler and must not be budgeted off a stale claim.
    expect(src).toContain("      : Infinity);");
  });

  it("keeps the ingest-coverage sweep off the engine entirely", () => {
    // `ctx.waitUntil` in a cron handler defers nothing — there is no response
    // to return early, so the invocation stays alive until it settles. The
    // sweep measured 138s behind a tail that had finished at 728s, which is
    // what carried the 15:10 tick to 866s of a 900s wall. It watches the
    // INGEST feed's `ingest_ts`, which is the monolith's job, and its
    // suppression key is global, so both roles were racing the same KV keys.
    expect(src).toContain([
      "    if (_isDedicatedEngine) {",
      "      // Nothing to log: the monolith's pass covers the same universe.",
      "    } else if (_tickTimeLeftMs() >= 60 * 1000) {",
      "      ctx.waitUntil(",
      "        checkIngestCoverage(KV, now).catch((err) =>",
    ].join("\n"));
  });

  it("skips the remaining monitoring pass on a tick that has spent its wall", () => {
    expect(src).toContain("} else if (_tickTimeLeftMs() >= 60 * 1000) {");
    expect(src).toContain("[INGEST COVERAGE] skipped:");
    expect(src).toContain("if (isProactiveAlertTime && _tickTimeLeftMs() < 90 * 1000) {");
    expect(src).toContain("[PROACTIVE ALERTS] skipped:");
  });

  it("keeps the D1 sync chunk small enough that three sets of it fit", () => {
    // A chunk holds the hydrated payload, the enriched copy and the
    // previous payload parsed back out of D1 — three graphs per ticker,
    // each from ~165 KB of JSON.
    const decl = src.match(/const _D1_CHUNK = (\d+);/);
    expect(decl).not.toBeNull();
    expect(Number(decl[1])).toBeLessThanOrEqual(15);
  });

  it("bounds the tail's D1 sync instead of trusting the changed-set to be small", () => {
    // The sync was written for "~30-80 changed tickers a tick". During RTH
    // every price moves every tick, so the changed set is the whole universe:
    // the pass went from 73-132s before the open to 280s+ after it, and being
    // the last phase it is what Cloudflare's 900s kill landed on. `[SCORING]
    // deferred tail done` stopped appearing entirely from 13:30 UTC.
    expect(src).toContain('import { planLatestSyncBatch, advanceSyncCursor } from "./d1-latest-sync-plan.js";');
    // The bound is whatever fits in the wall time actually left, so a tick
    // that spent 600s upstream syncs fewer rows rather than being killed with
    // none of them written.
    expect(src).toContain("const _d1CapRoom = _tickTimeLeftMs() - TICK_MONITOR_RESERVE_MS - D1_LATEST_SYNC_FIXED_MS;");
    expect(src).toContain("Math.max(D1_LATEST_SYNC_MIN, Math.floor(_d1CapRoom / D1_LATEST_SYNC_ROW_MS)),");
    expect(src).toContain("cap: _d1Cap,");
    expect(src).toContain("cursor: _d1LatestSyncCursor,");
    // The ceiling has to be low enough to fit the reserve at the measured RTH
    // row cost; the floor high enough to still cover the must-sync set.
    const max = Number(src.match(/const D1_LATEST_SYNC_MAX = (\d+);/)?.[1]);
    const min = Number(src.match(/const D1_LATEST_SYNC_MIN = (\d+);/)?.[1]);
    const rowMs = Number(src.match(/const D1_LATEST_SYNC_ROW_MS = (\d+);/)?.[1]);
    expect(max).toBeLessThanOrEqual(120);
    expect(min).toBeGreaterThanOrEqual(20);
    expect(min).toBeLessThan(max);
    expect(rowMs).toBeGreaterThanOrEqual(1000);
    // The loop has to walk the PLAN, not the raw changed set.
    expect(src).toContain("const _d1Syms = _d1Plan.batch;");
    // And the cursor may only advance over rows the tick actually reached.
    expect(src).toContain("_d1LatestSyncCursor = advanceSyncCursor(_d1Plan, _d1Attempted);");
  });

  it("never lets the cap defer an open position or a fresh stage flip", () => {
    // `prev_kanban_stage` is no substitute for a per-tick flip: it holds the
    // last transition's SOURCE lane indefinitely, so it reads as "changed"
    // for almost every ticker that ever moved lanes.
    expect(src).toContain("const stageFlipped = new Set();");
    expect(src).toContain("stageFlipped.add(ticker);");
    expect(src).toContain("const _d1MustSync = new Set(stageFlipped);");
    expect(src).toContain("_d1MustSync.add(_tk);");
    expect(src).toContain("mustSync: _d1MustSync,");
  });

  it("gives the tail its own backstop short of the 900s wall", () => {
    // Everything upstream overrunning lands on the last phase. Stopping with
    // a logged count beats being killed mid-sweep with nothing written.
    expect(src).toContain("const TICK_WALL_MS = 900 * 1000;");
    expect(src).toContain("const SCORING_TAIL_BUDGET_MS = TICK_WALL_MS - TICK_SAFETY_MS - TICK_MONITOR_RESERVE_MS;");
    // Measured from the tick's claim, like the entry deadline.
    expect(src).toContain("(_tickClaimedAt || _d1Now) + SCORING_TAIL_BUDGET_MS");
    const loop = src.indexOf("for (let _ci = 0; _ci < _d1Syms.length; _ci += _D1_CHUNK) {");
    expect(loop).toBeGreaterThan(0);
    // The check comes before the chunk's KV hydration — a deadline checked
    // after the expensive part is decoration.
    const body = src.slice(loop);
    expect(body.indexOf("if (Date.now() >= _tailDeadline) {")).toBeGreaterThan(0);
    expect(body.indexOf("if (Date.now() >= _tailDeadline) {"))
      .toBeLessThan(body.indexOf("hydrateSnapshotRows("));
  });

  it("does not park a full payload on the thin-slice patch list", () => {
    // The write-back destructures `[_sym, _patch]`. A third element was
    // pure retention, and it accumulated across every chunk.
    expect(src).toContain("_thinKvPatches.push([_sym, _kvPatch]);");
    expect(src).not.toContain("_thinKvPatches.push([_sym, _kvPatch, _plForD1]);");
  });
});

describe("the monolith pre-warms one endpoint at a time", () => {
  // The same disease on the other worker. `timed-trading-ingest`'s */5 fanned
  // its pre-warms out as separate `ctx.waitUntil` chains, and every one of
  // them re-enters the worker in-process (`_selfDispatch` is `this.fetch`),
  // so each one's whole request graph was resident at the same time. That
  // isolate was dying with `exceededMemory` 9-14s after the tick fired —
  // 10 of 10 consecutive ticks overnight, with no user traffic on it at all,
  // which rules out serve-time load as the cause.
  const src = readFileSync(join(root, "index.js"), "utf8");

  const steps = src.indexOf("const _prewarmSteps = [];");
  const runner = src.indexOf("for (const [_pwName, _pwStep] of _prewarmSteps) {");

  it("collects the pre-warm steps and runs them from one place", () => {
    expect(steps).toBeGreaterThan(-1);
    expect(runner).toBeGreaterThan(runner === -1 ? 0 : steps);
    expect(src.indexOf("const _prewarmSteps = [];", steps + 1)).toBe(-1);
    expect(src.indexOf("for (const [_pwName, _pwStep] of _prewarmSteps) {", runner + 1)).toBe(-1);
  });

  it("routes every heavy pre-warm through the chain, not its own waitUntil", () => {
    const chain = src.slice(steps, runner);
    for (const name of ["options_all", "timed_all_slim", "macro_actuals", "x_wire", "bridge_notify_drain"]) {
      expect(chain).toContain(`_prewarmSteps.push(["${name}"`);
    }
    // Five names, five pushes — a step added later must join the chain.
    expect(chain.match(/_prewarmSteps\.push\(\[/g)).toHaveLength(5);
    // Exactly one dispatch in the whole region: the chain itself. Any
    // second one is a step that went back to running concurrently.
    expect(chain.match(/ctx\.waitUntil\(/g)).toHaveLength(1);
  });

  it("awaits each step so two are never resident at once", () => {
    const body = src.slice(runner, runner + 400);
    expect(body).toContain("await _pwStep();");
    // A step that throws must not take the rest of the chain with it.
    expect(body).toContain("[CRON PREWARM]");
  });

  it("holds a per-isolate lease so a slow chain is not joined by the next tick", () => {
    expect(src).toContain("let _fiveMinPrewarmSince = 0;");
    expect(src).toContain("const FIVE_MIN_PREWARM_LEASE_MS =");
    expect(src).toContain("[CRON PREWARM] skipped: the previous chain has been running");
    // Released in a `finally`, or one dead chain wedges the lane until the
    // lease expires.
    expect(src.slice(runner, runner + 600)).toMatch(/finally\s*\{\s*_fiveMinPrewarmSince = 0;/);
  });

  it("leases the bar pass too, since that is the one that outlives its tick", () => {
    // The TwelveData pass is paced, not slow: four tiers at 2.5s between
    // batches runs 300-600s against a 5-minute cadence. Two ticks died
    // 59 ms apart, which is the isolate going, not one invocation.
    expect(src).toContain("let _barCronSince = 0;");
    expect(src).toContain("const BAR_CRON_LEASE_MS =");
    expect(src).toContain("[TD CRON] skipped: the previous bar pass has been running");
    const dispatch = src.indexOf("DataProvider.cronFetchLatest(env, allTickers, {");
    expect(dispatch).toBeGreaterThan(-1);
    // Claimed before the dispatch and released when the pass settles —
    // `.finally`, not `.then`, or a failed fetch wedges the lane.
    expect(src.lastIndexOf("_barCronSince = Date.now();", dispatch)).toBeGreaterThan(-1);
    expect(src.slice(dispatch, dispatch + 1200)).toContain(".finally(() => { _barCronSince = 0; })");
  });
});
