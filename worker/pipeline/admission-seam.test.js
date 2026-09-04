import { describe, it, expect } from "vitest";
import { checkPlayAdmission } from "./admission-seam.js";
import { CORE_PLAYS, PLAY_STATUS } from "../foundation/play-catalog.js";

// Packet I (F15) contract: a PAUSED catalog play must be blocked no matter
// which identity form the entry carries — engine path, clean display name,
// legacy double-prefixed display name, or setup name with no path at all.
// The prior inline check only looked at the engine path.

const pausedPlay = CORE_PLAYS.find((p) => p.status === PLAY_STATUS.PAUSED);
const activePlay = CORE_PLAYS.find((p) => p.status === PLAY_STATUS.LIVE)
  || CORE_PLAYS.find((p) => p.id === "tt_gap_reversal_long");
const restrictedPlay = CORE_PLAYS.find((p) => p.status === PLAY_STATUS.RESTRICTED);

describe("checkPlayAdmission — paused play cannot enter via any identity form", () => {
  it("has a paused play in the catalog to test against", () => {
    expect(pausedPlay).toBeTruthy();
  });

  it("blocks by engine path", () => {
    const r = checkPlayAdmission({ entryPath: pausedPlay.id, direction: pausedPlay.direction });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("play_catalog_paused");
    expect(r.play_id).toBe(pausedPlay.id);
  });

  it("blocks by clean display label with no path", () => {
    const r = checkPlayAdmission({ setupName: pausedPlay.label, direction: pausedPlay.direction });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("play_catalog_paused");
  });

  it("blocks by the legacy double-prefixed display name (the F15 bypass)", () => {
    const mangled = `TT Tt ${pausedPlay.label}`;
    const r = checkPlayAdmission({ setupName: mangled, direction: pausedPlay.direction });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("play_catalog_paused");
  });

  it("blocks when the path is garbage but the setup name resolves", () => {
    const r = checkPlayAdmission({
      entryPath: "(unstamped)",
      setupName: pausedPlay.demotion_label || pausedPlay.label,
      direction: pausedPlay.direction,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("play_catalog_paused");
  });
});

describe("checkPlayAdmission — allowed outcomes are observable", () => {
  it("allows an active catalog play with its id", () => {
    const r = checkPlayAdmission({ entryPath: activePlay.id, direction: activePlay.direction });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("play_catalog_active");
    expect(r.play_id).toBe(activePlay.id);
    expect(r.identity_missing).toBe(false);
  });

  it("allows a restricted play but flags it", () => {
    expect(restrictedPlay).toBeTruthy();
    const r = checkPlayAdmission({ entryPath: restrictedPlay.id, direction: restrictedPlay.direction });
    expect(r.allowed).toBe(true);
    expect(r.restricted).toBe(true);
    expect(r.reason).toBe("play_catalog_restricted");
  });

  it("missing identity is allowed but named, never silent", () => {
    const r = checkPlayAdmission({});
    expect(r.allowed).toBe(true);
    expect(r.identity_missing).toBe(true);
    expect(r.reason).toBe("unresolved_play_identity_missing_inputs");
  });

  it("an experimental non-catalog path is allowed and carries its stable id", () => {
    const r = checkPlayAdmission({ entryPath: "ema_regime_confirmed_long" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("play_not_in_catalog");
    expect(r.play_id).toBe("ema_regime_confirmed_long");
    expect(r.identity_missing).toBe(false);
  });
});

describe("checkPlayAdmission — direction pairing", () => {
  it("swaps direction-paired plays before the status check", () => {
    // tt_ath_breakout (LONG) pairs with tt_atl_breakdown (SHORT); both are
    // restricted, not paused — the check must resolve the directional twin
    // rather than misclassify.
    const r = checkPlayAdmission({ entryPath: "tt_ath_breakout", direction: "SHORT" });
    expect(r.play_id).toBe("tt_atl_breakdown");
  });
});
