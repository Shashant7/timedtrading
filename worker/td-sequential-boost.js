// The existing TD boost recipe, shared by its producer and technical rank.
// Re-evaluate for the candidate side; the aggregate boost is HTF-biased and
// its approach-count bonuses are not symmetric under simple sign inversion.
export function computeTdBoostForSide(td, side) {
  if (!td || (side !== "LONG" && side !== "SHORT")) return 0;
  const bull = side === "LONG";
  const own = bull ? "bullish" : "bearish";
  const other = bull ? "bearish" : "bullish";
  let boost = td["td9_" + own] ? 5
    : td["td13_" + own] ? 8
    : td["td9_" + other] ? -5
    : td["td13_" + other] ? -8 : 0;
  const prep = td[own + "_prep_count"];
  const leadup = td[own + "_leadup_count"];
  if (prep >= 6 && prep < 9) boost += 2;
  if (leadup >= 6 && leadup < 13) boost += 3;
  return boost;
}
