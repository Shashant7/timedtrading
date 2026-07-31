import { describe, it, expect } from "vitest";
import {
  shouldDispatchDriftNotification,
  notifyItemToEvent,
  groupNotifyItemsByUser,
  meaningForSyncState,
} from "./bridge-notifications.js";

describe("shouldDispatchDriftNotification — healthy states", () => {
  it("skips in_sync even when severity is warn (stale-row false positive)", () => {
    const r = shouldDispatchDriftNotification({
      sync_state: "in_sync",
      sync_note: "model_closed and broker flat — consistent",
      last_user_notified_at: 0,
    }, "warn");
    expect(r.dispatch).toBe(false);
    expect(r.reason).toBe("in_sync_no_notify");
  });

  it("skips notes that say consistent", () => {
    const r = shouldDispatchDriftNotification({
      sync_state: "broker_orphan",
      sync_note: "residual flat — consistent",
      last_user_notified_at: 0,
    }, "warn");
    expect(r.dispatch).toBe(false);
  });

  it("dispatches real broker_orphan warn", () => {
    const r = shouldDispatchDriftNotification({
      sync_state: "broker_orphan",
      sync_note: "model_closed but broker holds 2",
      last_user_notified_at: 0,
    }, "warn");
    expect(r.dispatch).toBe(true);
  });
});

describe("notify coalesce helpers", () => {
  it("groupNotifyItemsByUser buckets by email", () => {
    const map = groupNotifyItemsByUser([
      { user_id: "a@x.com", event: { ticker: "PLTR" } },
      { user_email: "A@x.com", event: { ticker: "TWLO" } },
      { user_id: "b@x.com", event: { ticker: "NVDA" } },
    ]);
    expect(map.get("a@x.com")).toHaveLength(2);
    expect(map.get("b@x.com")).toHaveLength(1);
  });

  it("notifyItemToEvent prefers structured event fields", () => {
    const ev = notifyItemToEvent({
      severity: "warn",
      ticker: "STALE",
      event: {
        ticker: "PLTR",
        mode: "trader",
        instrument_type: "equity",
        sync_state: "broker_orphan",
        sync_note: "model_closed but broker holds 2",
      },
    });
    expect(ev.ticker).toBe("PLTR");
    expect(ev.sync_state).toBe("broker_orphan");
  });

  it("meaningForSyncState has no you/your", () => {
    for (const state of ["broker_orphan", "partial_fill", "mothership_orphan", "reconcile_error"]) {
      const m = meaningForSyncState(state);
      expect(m.toLowerCase()).not.toMatch(/\byou(r)?\b/);
    }
  });
});
