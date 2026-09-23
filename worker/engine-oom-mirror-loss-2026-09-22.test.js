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

  it("keeps the D1 sync chunk small enough that three sets of it fit", () => {
    // A chunk holds the hydrated payload, the enriched copy and the
    // previous payload parsed back out of D1 — three graphs per ticker,
    // each from ~165 KB of JSON.
    const decl = src.match(/const _D1_CHUNK = (\d+);/);
    expect(decl).not.toBeNull();
    expect(Number(decl[1])).toBeLessThanOrEqual(15);
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
});
