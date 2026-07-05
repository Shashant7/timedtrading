// worker/overlay-provenance.test.js — C3: overlays age like fish, not wine.

import { describe, it, expect } from "vitest";
import {
  overlayIssuedAt,
  overlayExpiresAt,
  overlayStatus,
  filterActiveOverlay,
  stampOverlayProvenance,
  signalExpired,
  OVERLAY_TTL_BY_HORIZON,
} from "./overlay-provenance.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T12:00:00Z");

function tacticalBlob(overrides = {}) {
  return {
    proposal_id: "prop-1",
    source: "cro_auto_apply",
    applied_at: T0,
    tactical_vintage: "2026-07-01",
    tactical_overlay: "Semis stalling; rotate into Mag 7 + software",
    tactical_signals: [
      { signal: "IGV/SMH breakout", horizon: "tactical", pair: "igv_smh", direction: "up", affected_tier1_themes: ["Software"], playbook_action: "favor software adds" },
    ],
    sector_notes: [],
    theme_notes: [{ theme: "Semiconductors", tactical_note: "stalling, expect profit taking" }],
    sector_stance_changes: [],
    theme_stance_changes: [],
    ...overrides,
  };
}

describe("provenance resolution", () => {
  it("issued_at: explicit > applied_at > tactical_vintage", () => {
    expect(overlayIssuedAt({ issued_at: 111, applied_at: 222 })).toBe(111);
    expect(overlayIssuedAt({ applied_at: 222 })).toBe(222);
    expect(overlayIssuedAt({ tactical_vintage: "2026-07-01" })).toBe(Date.parse("2026-07-01"));
  });

  it("tactical-only blob expires on the tactical TTL", () => {
    const blob = tacticalBlob();
    expect(overlayExpiresAt(blob)).toBe(T0 + OVERLAY_TTL_BY_HORIZON.tactical);
  });

  it("structural stance changes extend the blob lifespan", () => {
    const blob = tacticalBlob({
      sector_stance_changes: [{ sector: "Technology", new_stance: "overweight" }],
    });
    expect(overlayExpiresAt(blob)).toBe(T0 + OVERLAY_TTL_BY_HORIZON.structural);
  });

  it("explicit expires_at wins over defaults", () => {
    const blob = tacticalBlob({ expires_at: T0 + 2 * DAY });
    expect(overlayExpiresAt(blob)).toBe(T0 + 2 * DAY);
  });
});

describe("status lifecycle: active → maturing → expired", () => {
  const blob = tacticalBlob(); // 10-day tactical life
  it("fresh = active", () => {
    expect(overlayStatus(blob, T0 + 1 * DAY)).toBe("active");
  });
  it("last quarter of life = maturing", () => {
    expect(overlayStatus(blob, T0 + 8 * DAY)).toBe("maturing");
  });
  it("past expiry = expired", () => {
    expect(overlayStatus(blob, T0 + 11 * DAY)).toBe("expired");
  });
});

describe("filterActiveOverlay — central read-time enforcement", () => {
  it("active blob passes through with _provenance", () => {
    const out = filterActiveOverlay(tacticalBlob(), T0 + 1 * DAY);
    expect(out).not.toBeNull();
    expect(out._provenance.status).toBe("active");
    expect(out._provenance.age_days).toBe(1);
    expect(out.tactical_signals.length).toBe(1);
  });

  it("EXPIRED blob reads as null — the matured semis note can never be quoted", () => {
    const out = filterActiveOverlay(tacticalBlob(), T0 + 20 * DAY);
    expect(out).toBeNull();
  });

  it("matured tactical lines drop while structural stances live on", () => {
    const blob = tacticalBlob({
      sector_stance_changes: [{ sector: "Technology", new_stance: "overweight" }],
    }); // blob lives 90d, tactical signal only 10d
    const out = filterActiveOverlay(blob, T0 + 30 * DAY);
    expect(out).not.toBeNull();
    expect(out.tactical_signals.length).toBe(0);
    expect(out._provenance.signals_dropped).toBe(1);
    expect(out.sector_stance_changes.length).toBe(1);
  });

  it("per-signal explicit expires_at wins", () => {
    const blob = tacticalBlob({
      tactical_signals: [
        { signal: "short-lived", horizon: "structural", expires_at: T0 + 1 * DAY },
        { signal: "long-lived", horizon: "tactical" },
      ],
      sector_stance_changes: [{ sector: "Tech", new_stance: "overweight" }],
    });
    const out = filterActiveOverlay(blob, T0 + 2 * DAY);
    expect(out.tactical_signals.map((s) => s.signal)).toEqual(["long-lived"]);
    expect(signalExpired(blob.tactical_signals[0], T0, T0 + 2 * DAY)).toBe(true);
  });

  it("blob without any provenance fails open (active) — legacy blobs keep working", () => {
    const out = filterActiveOverlay({ tactical_overlay: "legacy", tactical_signals: [] }, T0);
    expect(out).not.toBeNull();
    expect(out._provenance.status).toBe("active");
    expect(out._provenance.issued_at).toBeNull();
  });
});

describe("stampOverlayProvenance — every overlay is born with a lifespan", () => {
  it("fills issued_at + expires_at, preserves explicit values", () => {
    const stamped = stampOverlayProvenance({ tactical_signals: [] }, T0);
    expect(stamped.issued_at).toBe(T0);
    expect(stamped.expires_at).toBe(T0 + OVERLAY_TTL_BY_HORIZON.tactical);

    const explicit = stampOverlayProvenance({ issued_at: 123, expires_at: 456 }, T0);
    expect(explicit.issued_at).toBe(123);
    expect(explicit.expires_at).toBe(456);
  });

  it("derives from applied_at when present", () => {
    const stamped = stampOverlayProvenance(tacticalBlob(), T0 + 5 * DAY);
    expect(stamped.issued_at).toBe(T0); // applied_at, not "now"
    expect(stamped.expires_at).toBe(T0 + OVERLAY_TTL_BY_HORIZON.tactical);
  });
});
