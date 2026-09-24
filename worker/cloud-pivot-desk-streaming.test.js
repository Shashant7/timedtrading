// The Cloud Pivot desk, built by the scoring tick instead of at serve time.
//
// `/timed/plays/today` used to rank the desk itself, which meant reading the
// whole `timed:all:snapshot` blob: ranking a row needs the deep 10m/1h ripster
// clouds, and the blob was the only place a handler could get them for the
// whole universe. That read is one of the ones that broke when the blob hit
// KV's 26,214,400-byte value ceiling on 2026-08-14, and it is a 25 MB parse in
// a 128 MB isolate besides.
//
// The five-minute scoring tick already holds each full payload for a moment,
// so it ranks there and keeps only the small ranked rows. These tests pin that
// the streamed desk is the SAME desk -- if it is not, the desk silently
// degrades and nobody finds out from the UI.

import { describe, it, expect } from "vitest";
import {
  CLOUD_PIVOT_LEADERS,
  cloudLeaderFollowUniverse,
  cloudPivotFollowersOf,
  resolveCloudLeaderFollowStamps,
  annotateCloudPivotLeaderFollows,
  detectTenMinCurl,
  rankCloudPivotDeskRow,
  assembleCloudPivotDesk,
  buildCloudPivotDesk,
} from "./foundation/tt-cloud-pivot.js";

/** A payload with the clouds the desk ranks on. */
function cloudPayload(ticker, {
  direction = "LONG",
  cross = true,
  price = 100,
  magnetPx = null,
  fires = false,
} = {}) {
  const bull = direction === "LONG";
  const p = {
    ticker,
    price,
    close: price,
    tf_tech: {
      10: {
        ripster: {
          c5_12: {
            crossUp: bull && cross,
            crossDn: !bull && cross,
            bull,
            bear: !bull,
            above: bull,
            below: !bull,
            fastSlope: bull ? 0.4 : -0.4,
          },
          c34_50: { bull, bear: !bull, above: bull, below: !bull },
        },
      },
      "1H": { ripster: { c34_50: { bull, bear: !bull, above: bull, below: !bull } } },
    },
    // A detail blob, so a "did this row come from the index?" mistake shows up.
    _journey: { blob: "j".repeat(4000) },
  };
  if (magnetPx != null) p._cloud_magnet = { px: magnetPx, label: "1h_5_12" };
  if (fires) p._cloud_pivot_detect = { fires: true, direction, session: "midday_curl" };
  return p;
}

/** Rank the way the scoring tick does: one payload at a time, keep the row. */
function streamDesk(store, syms, { limit = 28, minScore = 30 } = {}) {
  const curls = {};
  for (const sym of cloudLeaderFollowUniverse()) {
    if (store[sym]) curls[sym] = detectTenMinCurl(store[sym]);
  }
  const stamps = resolveCloudLeaderFollowStamps(curls);
  const ranked = [];
  let scanned = 0;
  for (const sym of syms) {
    const payload = store[sym];
    if (!payload) continue;
    // The tick stamps onto the payload it is about to let go of.
    const stamp = stamps[sym];
    if (stamp?._cloud_leader) payload._cloud_leader = stamp._cloud_leader;
    if (stamp?._cloud_leader_follow) payload._cloud_leader_follow = stamp._cloud_leader_follow;
    scanned++;
    const r = rankCloudPivotDeskRow(sym, payload, {});
    if (r && Number(r.score) >= minScore) ranked.push(r);
  }
  return assembleCloudPivotDesk(ranked, { limit, minScore, scanned });
}

describe("cloudLeaderFollowUniverse", () => {
  it("covers the leaders and their proxy followers, and stays bounded", () => {
    const u = cloudLeaderFollowUniverse();
    for (const l of CLOUD_PIVOT_LEADERS) expect(u).toContain(l);
    for (const l of CLOUD_PIVOT_LEADERS) {
      for (const f of cloudPivotFollowersOf(l)) expect(u).toContain(f);
    }
    // This set is read payload-by-payload as a pre-pass before the main
    // stream, so it has to stay small enough to be free.
    expect(u.length).toBeLessThan(40);
    expect(new Set(u).size).toBe(u.length);
  });
});

describe("resolveCloudLeaderFollowStamps", () => {
  it("stamps a leader that printed a 10m curl", () => {
    const stamps = resolveCloudLeaderFollowStamps({
      SPY: { direction: "LONG", trigger: "5_12_cross_up" },
    });
    expect(stamps.SPY._cloud_leader).toEqual({
      role: "leader", symbol: "SPY", direction: "LONG", trigger: "5_12_cross_up",
    });
  });

  it("stamps a same-side follower and an opposite-side one as oppose", () => {
    // A leader can also be someone else's follower, and it stamps itself, so
    // pick followers that are not leaders in their own right.
    const followers = cloudPivotFollowersOf("SPY").filter((f) => !CLOUD_PIVOT_LEADERS.includes(f));
    expect(followers.length).toBeGreaterThan(1);
    const [same, opposite] = followers;
    const stamps = resolveCloudLeaderFollowStamps({
      SPY: { direction: "LONG", trigger: "5_12_cross_up" },
      [same]: { direction: "LONG", trigger: "5_12_curl_bounce" },
      [opposite]: { direction: "SHORT", trigger: "5_12_cross_dn" },
    });
    expect(stamps[same]._cloud_leader_follow.leader).toBe("SPY");
    expect(stamps[opposite]._cloud_leader_oppose).toEqual({
      leader: "SPY",
      leader_direction: "LONG",
      direction: "SHORT",
      trigger: "5_12_cross_dn",
    });
  });

  it("stamps nothing when the leader has no curl", () => {
    expect(resolveCloudLeaderFollowStamps({ SPY: null })).toEqual({});
    expect(resolveCloudLeaderFollowStamps({})).toEqual({});
  });

  it("accepts a Map as well as an object", () => {
    const stamps = resolveCloudLeaderFollowStamps(
      new Map([["SPY", { direction: "LONG", trigger: "5_12_cross_up" }]]),
    );
    expect(stamps.SPY._cloud_leader.symbol).toBe("SPY");
  });

  it("agrees with the in-place annotator it was factored out of", () => {
    const followers = cloudPivotFollowersOf("SPY");
    const follower = followers[0];
    const store = {
      SPY: cloudPayload("SPY", { direction: "LONG" }),
      ...(follower ? { [follower]: cloudPayload(follower, { direction: "LONG" }) } : {}),
    };
    const rows = Object.entries(store).map(([sym, t]) => ({ sym, t }));
    annotateCloudPivotLeaderFollows(rows);

    const curls = Object.fromEntries(
      cloudLeaderFollowUniverse()
        .filter((s) => store[s])
        .map((s) => [s, detectTenMinCurl(store[s])]),
    );
    const stamps = resolveCloudLeaderFollowStamps(curls);
    expect(stamps.SPY._cloud_leader).toEqual(store.SPY._cloud_leader);
    if (follower) {
      expect(stamps[follower]._cloud_leader_follow).toEqual(store[follower]._cloud_leader_follow);
    }
  });
});

describe("the streamed desk is the same desk", () => {
  const universe = ["SPY", "QQQ", "NVDA", "AMD", "MSTR", "COIN", "TSLA", "AAPL"];

  function buildStore() {
    return {
      SPY: cloudPayload("SPY", { direction: "LONG", price: 640, magnetPx: 642 }),
      QQQ: cloudPayload("QQQ", { direction: "LONG", price: 570, magnetPx: 571 }),
      NVDA: cloudPayload("NVDA", { direction: "LONG", price: 180, magnetPx: 181, fires: true }),
      AMD: cloudPayload("AMD", { direction: "SHORT", price: 160, magnetPx: 158 }),
      MSTR: cloudPayload("MSTR", { direction: "LONG", price: 340, cross: false }),
      COIN: cloudPayload("COIN", { direction: "LONG", price: 300, magnetPx: 301 }),
      TSLA: cloudPayload("TSLA", { direction: "SHORT", price: 420, fires: true }),
      AAPL: cloudPayload("AAPL", { direction: "LONG", price: 230 }),
    };
  }

  it("produces the identical watching list to the whole-universe build", () => {
    const streamed = streamDesk(buildStore(), universe);

    const store = buildStore();
    const rows = universe.map((sym) => ({ sym, t: store[sym] }));
    const legacy = buildCloudPivotDesk(rows, { limit: 28, minScore: 30 });

    expect(streamed.count).toBe(legacy.count);
    expect(streamed.watching.map((x) => `${x.ticker}:${x.score}`))
      .toEqual(legacy.watching.map((x) => `${x.ticker}:${x.score}`));
    expect(streamed.fires.map((x) => x.ticker)).toEqual(legacy.fires.map((x) => x.ticker));
    expect(streamed.leaders.map((x) => x.ticker)).toEqual(legacy.leaders.map((x) => x.ticker));
    expect(streamed.stalks.map((x) => x.ticker)).toEqual(legacy.stalks.map((x) => x.ticker));
  });

  it("never holds two payloads at once", () => {
    const store = buildStore();
    let live = 0;
    let peak = 0;
    const ranked = [];
    for (const sym of universe) {
      live++;
      peak = Math.max(peak, live);
      const r = rankCloudPivotDeskRow(sym, store[sym], {});
      if (r) ranked.push(r);
      live--;
    }
    expect(peak).toBe(1);
    // A ranked row is a fraction of the payload it came from, which is the
    // whole point: 330 of these are retainable, 330 payloads are not.
    const rowBytes = JSON.stringify(ranked).length;
    const payloadBytes = JSON.stringify(Object.values(store)).length;
    expect(rowBytes).toBeLessThan(payloadBytes / 4);
  });

  it("credits the leader bonus, which is why the pre-pass runs first", () => {
    const store = buildStore();
    const withLeader = streamDesk(store, universe);
    const spyWith = withLeader.watching.find((x) => x.ticker === "SPY");

    const bare = buildStore();
    const spyBare = rankCloudPivotDeskRow("SPY", bare.SPY, {});
    expect(spyWith.score).toBeGreaterThan(spyBare.score);
    expect(spyWith.why).toContain("leader_SPY");
  });
});

describe("assembleCloudPivotDesk", () => {
  const row = (ticker, score, extra = {}) => ({ ticker, score, why: [], ...extra });

  it("sorts by score, then by ticker for a tie", () => {
    const desk = assembleCloudPivotDesk([
      row("ZZZ", 50), row("AAA", 50), row("MMM", 90),
    ], { minScore: 30 });
    expect(desk.watching.map((x) => x.ticker)).toEqual(["MMM", "AAA", "ZZZ"]);
  });

  it("drops anything under the minimum score", () => {
    const desk = assembleCloudPivotDesk([row("A", 100), row("B", 29)], { minScore: 30 });
    expect(desk.watching.map((x) => x.ticker)).toEqual(["A"]);
  });

  it("honours the limit and clamps an absurd one", () => {
    const many = Array.from({ length: 200 }, (_, i) => row(`T${i}`, 100 - (i / 1000)));
    expect(assembleCloudPivotDesk(many, { limit: 5 }).watching.length).toBe(5);
    expect(assembleCloudPivotDesk(many, { limit: 9999 }).watching.length).toBe(80);
  });

  it("reports what was scanned, not just what survived", () => {
    const desk = assembleCloudPivotDesk([row("A", 100)], { scanned: 330 });
    expect(desk.scanned).toBe(330);
    expect(desk.count).toBe(1);
  });

  it("buckets fires, leaders, catalysts and stalks", () => {
    const desk = assembleCloudPivotDesk([
      row("F", 100, { role: "fire" }),
      row("L", 90, { role: "leader" }),
      row("C", 80, { role: "catalyst" }),
      row("S", 70, { role: "stalk" }),
    ], { minScore: 30 });
    expect(desk.fires.map((x) => x.ticker)).toEqual(["F"]);
    expect(desk.leaders.map((x) => x.ticker)).toEqual(["L"]);
    expect(desk.catalysts.map((x) => x.ticker)).toEqual(["C"]);
    expect(desk.stalks.map((x) => x.ticker)).toEqual(["S"]);
  });

  it("returns an empty desk rather than throwing on junk", () => {
    expect(assembleCloudPivotDesk(null).count).toBe(0);
    expect(assembleCloudPivotDesk([null, undefined]).count).toBe(0);
  });
});
