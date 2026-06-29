import { describe, it, expect } from "vitest";
import {
  mergeLatestSweep,
  shouldSendSanityDiscordAlert,
  ALERT_DELIVERY_EXCLUDED_ERRORS,
} from "../worker/sanity-sweep.js";

describe("sanity sweep latest merge", () => {
  it("overlays newer fast-sweep warn onto hourly full ok", () => {
    const full = {
      ts: 1000,
      kind: "full",
      checks: [
        { id: "cron_tick_alive", label: "Cron", status: "ok", anomalies: [] },
        { id: "alert_delivery", label: "Alerts", status: "ok", anomalies: [] },
      ],
      summary: { ok_count: 2, warn_count: 0, fail_count: 0, total_anomalies: 0 },
    };
    const fast = {
      ts: 2000,
      kind: "fast",
      checks: [
        { id: "cron_tick_alive", label: "Cron", status: "warn", anomalies: [{ detail: "stale 20m", severity: "warn" }] },
      ],
      summary: { ok_count: 0, warn_count: 1, fail_count: 0, total_anomalies: 1 },
    };
    const merged = mergeLatestSweep(full, fast);
    expect(merged.kind).toBe("merged");
    expect(merged.checks.find((c) => c.id === "cron_tick_alive")?.status).toBe("warn");
    expect(merged.checks.find((c) => c.id === "alert_delivery")?.status).toBe("ok");
    expect(merged.summary.warn_count).toBe(1);
  });
});

describe("sanity sweep discord alert threshold", () => {
  it("pages on critical-path warn even when total warns < 3", () => {
    const warning = [{ id: "alert_delivery", status: "warn", anomalies: [{ detail: "2 failed", severity: "warn" }] }];
    expect(shouldSendSanityDiscordAlert([], warning)).toBe(true);
  });

  it("skips discord when only low-priority warns and count < 3", () => {
    const warning = [{ id: "thesis_stage_consistency", status: "warn", anomalies: [{ detail: "x", severity: "warn" }] }];
    expect(shouldSendSanityDiscordAlert([], warning)).toBe(false);
  });

  it("pages on any fail", () => {
    expect(shouldSendSanityDiscordAlert([{ id: "portfolio_reconcile", status: "fail" }], [])).toBe(true);
  });
});

describe("alert_delivery excluded errors", () => {
  it("excludes deduped ledger rows from delivery failure counts", () => {
    expect(ALERT_DELIVERY_EXCLUDED_ERRORS).toContain("deduped_already_alerted");
  });
});
