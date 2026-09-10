// Armed-play side — the trade the desk is actually considering.
// HTF_BEAR with htf_score -2.5 is not a short when Cloud Pivot / weekly
// ST hold is long (BE 2026-09-10: quality-A compounder, pivot long).

export function resolvePlaySide(d = {}) {
  const cp = d?._cloud_pivot_detect;
  if (cp?.fires === true) {
    const dir = String(cp.direction || "").toUpperCase();
    if (dir === "LONG" || dir === "SHORT") return dir;
  }
  const st = d?.st_hold_setup?.best;
  if (st?.held && (st.quality === "high" || st.tested === true)) {
    const dir = String(st.sideLabel || "").toUpperCase();
    if (dir === "LONG" || dir === "SHORT") return dir;
  }
  return null;
}

export function playStructureAligned(d = {}, side) {
  const want = String(side || "").toUpperCase();
  if (want !== "LONG" && want !== "SHORT") return false;
  return resolvePlaySide(d) === want;
}
