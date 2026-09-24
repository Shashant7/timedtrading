import { describe, it, expect } from "vitest";
import { planLatestSyncBatch, advanceSyncCursor } from "./d1-latest-sync-plan.js";

const universe = (n, prefix = "T") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

describe("planLatestSyncBatch", () => {
  it("passes the whole set through when it fits under the cap", () => {
    const syms = universe(30);
    const plan = planLatestSyncBatch({ syms, cap: 120 });
    expect(plan.batch).toEqual(syms);
    expect(plan.deferred).toBe(0);
    expect(plan.nextCursor).toBe(0);
  });

  it("passes the whole set through when there is no cap", () => {
    const syms = universe(329);
    for (const cap of [0, undefined, NaN, -5]) {
      const plan = planLatestSyncBatch({ syms, cap });
      expect(plan.batch).toHaveLength(329);
      expect(plan.deferred).toBe(0);
    }
  });

  it("caps the batch and reports what it deferred", () => {
    const syms = universe(329);
    const plan = planLatestSyncBatch({ syms, cap: 120 });
    expect(plan.batch).toHaveLength(120);
    expect(plan.deferred).toBe(209);
    expect(plan.must).toBe(0);
  });

  it("puts every must-sync ticker in the batch, cap or not", () => {
    const syms = universe(329);
    // Deliberately at the far end of the list, where the rotation would not
    // reach it for several ticks.
    const mustSync = new Set(["T300", "T310", "T328"]);
    const plan = planLatestSyncBatch({ syms, mustSync, cap: 120 });
    expect(plan.batch).toHaveLength(120);
    expect(plan.must).toBe(3);
    for (const sym of mustSync) expect(plan.batch).toContain(sym);
  });

  it("never drops a must-sync ticker to honour the cap", () => {
    const syms = universe(329);
    const mustSync = new Set(syms.slice(0, 200));
    const plan = planLatestSyncBatch({ syms, mustSync, cap: 120 });
    expect(plan.must).toBe(200);
    expect(plan.batch).toHaveLength(200);
    expect(plan.rotated).toBe(0);
    expect(plan.deferred).toBe(129);
  });

  it("accepts an array for mustSync as well as a Set", () => {
    const syms = universe(10);
    const plan = planLatestSyncBatch({ syms, mustSync: ["T009"], cap: 3 });
    expect(plan.batch[0]).toBe("T009");
    expect(plan.batch).toHaveLength(3);
  });

  it("sweeps the whole universe across consecutive ticks", () => {
    const syms = universe(329);
    const seen = new Set();
    let cursor = 0;
    let ticks = 0;
    while (seen.size < syms.length && ticks < 20) {
      const plan = planLatestSyncBatch({ syms, cap: 120, cursor });
      for (const sym of plan.batch) seen.add(sym);
      cursor = plan.nextCursor;
      ticks++;
    }
    expect(ticks).toBe(3);
    expect(seen.size).toBe(syms.length);
  });

  it("does not repeat a ticker inside one sweep", () => {
    const syms = universe(329);
    let cursor = 0;
    const counts = new Map();
    for (let t = 0; t < 3; t++) {
      const plan = planLatestSyncBatch({ syms, cap: 120, cursor });
      for (const sym of plan.batch) counts.set(sym, (counts.get(sym) || 0) + 1);
      cursor = plan.nextCursor;
    }
    // 329 over three ticks of 120 is 360 slots, so the third tick wraps and
    // re-covers 31. Nothing should be covered more than twice.
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect([...counts.values()].filter((c) => c === 1).length).toBe(298);
  });

  it("wraps the rotation window around the end of the list", () => {
    const syms = universe(10);
    const plan = planLatestSyncBatch({ syms, cap: 4, cursor: 8 });
    expect(plan.batch).toEqual(["T008", "T009", "T000", "T001"]);
    expect(plan.nextCursor).toBe(2);
  });

  it("normalises a negative or oversized cursor", () => {
    const syms = universe(10);
    expect(planLatestSyncBatch({ syms, cap: 2, cursor: -1 }).batch).toEqual(["T009", "T000"]);
    expect(planLatestSyncBatch({ syms, cap: 2, cursor: 23 }).batch).toEqual(["T003", "T004"]);
  });

  it("survives an empty or absent symbol list", () => {
    for (const syms of [[], undefined, null]) {
      const plan = planLatestSyncBatch({ syms, cap: 120 });
      expect(plan.batch).toEqual([]);
      expect(plan.nextCursor).toBe(0);
      expect(plan.deferred).toBe(0);
    }
  });
});

describe("advanceSyncCursor", () => {
  it("advances past the rotated symbols the tick actually wrote", () => {
    const syms = universe(329);
    const plan = planLatestSyncBatch({ syms, mustSync: new Set(["T300"]), cap: 120, cursor: 0 });
    expect(advanceSyncCursor(plan, plan.batch.length)).toBe(plan.nextCursor);
  });

  it("does not skip symbols the tick never reached", () => {
    const syms = universe(329);
    const plan = planLatestSyncBatch({ syms, cap: 120, cursor: 0 });
    // The tail stopped at its deadline after 36 of the 120 planned.
    expect(advanceSyncCursor(plan, 36)).toBe(36);
    // And the next tick resumes exactly there rather than at 120.
    const next = planLatestSyncBatch({ syms, cap: 120, cursor: advanceSyncCursor(plan, 36) });
    expect(next.batch[0]).toBe("T036");
  });

  it("does not move when only must-sync rows were written", () => {
    const syms = universe(329);
    const plan = planLatestSyncBatch({ syms, mustSync: new Set(["T300", "T301"]), cap: 120, cursor: 7 });
    expect(advanceSyncCursor(plan, 2)).toBe(7);
    expect(advanceSyncCursor(plan, 0)).toBe(7);
  });

  it("returns 0 when there is nothing to rotate", () => {
    expect(advanceSyncCursor({ restCount: 0, must: 3, rotateStart: 0 }, 3)).toBe(0);
    expect(advanceSyncCursor(null, 5)).toBe(0);
  });
});
