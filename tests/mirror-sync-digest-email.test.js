import { describe, it, expect } from "vitest";
import {
  buildMirrorSyncDigestEmail,
  groupMirrorNotifyItemsByUser,
  notifyItemToMirrorEvent,
} from "../worker/email.js";

describe("notifyItemToMirrorEvent", () => {
  it("drops in_sync / consistent events", () => {
    expect(notifyItemToMirrorEvent({
      severity: "warn",
      event: {
        ticker: "NVDA",
        sync_state: "in_sync",
        sync_note: "model_closed and broker flat — consistent",
      },
    })).toBeNull();
  });

  it("keeps broker_orphan", () => {
    const ev = notifyItemToMirrorEvent({
      severity: "warn",
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
});

describe("buildMirrorSyncDigestEmail", () => {
  it("builds one branded digest for multiple issues", () => {
    const digest = buildMirrorSyncDigestEmail([
      {
        severity: "warn",
        ticker: "PLTR",
        mode: "trader",
        instrument_type: "equity",
        sync_state: "broker_orphan",
        sync_note: "model_closed but broker holds 2",
      },
      {
        severity: "warn",
        ticker: "TWLO",
        mode: "trader",
        instrument_type: "equity",
        sync_state: "broker_orphan",
        sync_note: "model_closed but broker holds 1",
      },
    ]);
    expect(digest).toBeTruthy();
    expect(digest.count).toBe(2);
    expect(digest.subject).toMatch(/Mirror sync: 2 issues/);
    expect(digest.subject).toMatch(/PLTR/);
    expect(digest.html).toContain("Timed Trading");
    expect(digest.html).toContain("#0b0e11"); // brand dark
    expect(digest.html).toContain("PLTR");
    expect(digest.html).toContain("TWLO");
    expect(digest.html).toContain("What this means:");
    expect(digest.html.toLowerCase()).not.toMatch(/\byou(r)?\b/);
    expect(digest.text).toContain("PLTR");
  });

  it("does not describe a reducer unit mismatch as a fetch failure", () => {
    const digest = buildMirrorSyncDigestEmail([{
      severity: "warn",
      ticker: "PLTR",
      mode: "investor",
      instrument_type: "equity",
      sync_state: "reconcile_error",
      sync_note: "reducer discrepancy: trim requestedQty > modelRemaining without reduce_pct — likely model-space shares being treated as broker-space. Caller MUST send reduce_pct to size correctly.",
    }]);
    expect(digest.html).toMatch(/model-share quantity|percent of the mirrored holding/i);
    expect(digest.html).not.toMatch(/could not fetch broker positions/i);
    expect(digest.html.toLowerCase()).not.toMatch(/\byou(r)?\b/);
  });

  it("returns null when only healthy events remain", () => {
    expect(buildMirrorSyncDigestEmail([
      { severity: "warn", ticker: "NVDA", sync_state: "in_sync", sync_note: "ok" },
    ])).toBeNull();
  });
});

describe("groupMirrorNotifyItemsByUser", () => {
  it("groups by user_email / user_id", () => {
    const map = groupMirrorNotifyItemsByUser([
      { user_id: "a@x.com", event: { ticker: "A" } },
      { user_email: "a@x.com", event: { ticker: "B" } },
    ]);
    expect(map.get("a@x.com")).toHaveLength(2);
  });
});
