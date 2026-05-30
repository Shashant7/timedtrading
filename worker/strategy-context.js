// worker/strategy-context.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  TT Strategy Context — Active Playbook
// ─────────────────────────────────────────────────────────────────────────────
//
//  Single source of truth for the macro / sector / theme playbook the system
//  uses to (a) bias the AI CIO, (b) flavour Daily Briefs, (c) boost qualified
//  promotion candidates, and (d) educate users via the Right Rail + Learn
//  pages.
//
//  The current vintage codifies the Fundstrat Direct 2026 thesis published
//  5/28/2026 by Tom Lee, Mark Newton, and Ken Xuan — TT's editorial
//  inspiration. When FSD publishes an updated deck, edit this file (bump
//  VINTAGE, update tilts/themes/risks) and redeploy. Everything downstream
//  reads through `getStrategyDigest()` so callers stay decoupled from the
//  schema details.
//
//  Design principles:
//    • One file. Plain data. No I/O. Trivially testable, trivially diffable.
//    • Theme keys MUST match `worker/sector-mapping.js#THEMES` so ticker
//      alignment is computable without a second mapping.
//    • Sectors named with the exact strings TT uses elsewhere (Information
//      Technology, Energy, Financials, Industrials, …) so SECTOR_TILTS can
//      be looked up against any ticker's `_ticker_profile.sector`.
//    • All ticker rationales are EDITORIAL — derived from the source deck.
//      They are surfaced as-is in the UI ("Why this is on the playbook")
//      and to the LLM as prompt context.
//
//  Authored 2026-05-29.

// ── Vintage / provenance ───────────────────────────────────────────────────
export const STRATEGY_VINTAGE = "2026-05-28";
export const STRATEGY_SOURCE = "Fundstrat Direct — 2026 Year Ahead (Tom Lee, Mark Newton, Ken Xuan)";
export const STRATEGY_TITLE = "Resilience & US Exceptionalism — Back-Ended 2026 Rally";

// ── 1. Headline thesis ─────────────────────────────────────────────────────
// One paragraph. Used verbatim in Daily Brief, Right Rail "Active Strategy",
// and Learn page. Keep <= 600 chars so it fits a Discord embed description.
export const STRATEGY_HEADLINE = [
  "Our active playbook (Fundstrat 5/28/26) tracks a back-ended 2026 rally:",
  "S&P 500 base case 7,300 → aspirational 7,700 by year-end, with a possible",
  "mid-year round-trip lower as markets test the new Fed (Warsh) and digest",
  "Iran-war shocks before resuming. US exceptionalism is the throughline:",
  "the only major economy with a growing prime-age population (age 30-48),",
  "AI/Compute leadership, and net energy export. Demographic tailwind",
  "implies S&P 500 trajectory toward 15,000 by 2030. Buy dips in MAG7,",
  "Semis/Memory, Software (laggard convergence), Industrials, Financials,",
  "Small-caps, Energy and Basic Materials.",
].join(" ");

// ── 2. Phase / regime stance ───────────────────────────────────────────────
export const STRATEGY_PHASE = {
  // Coarse stage label surfaced on the Right Rail strategy chip.
  label: "Phase 1 — Back-Ended Rally",
  // 3-phase market: Phase 1 = already-happened MAG7/Crypto/Software bottom,
  // Phase 2 = potential mid-year round-trip lower, Phase 3 = year-end push
  // to 7,300/7,700.
  current: "phase_1_bottoming_complete",
  next_pivot: "phase_2_round_trip_risk_mid_year_2026",
  spx_targets: {
    base_case: 7300,
    aspirational: 7700,
    bear_case_dip: null, // not explicitly stated — FSD shows a "round-trip" arc
    long_horizon_2030: 15000,
  },
  // Probability-weighted view, for the CIO prompt. (Editorial.)
  scenario_weights: {
    grind_higher_to_target: 0.45,
    round_trip_then_rally:  0.40,
    bear_case_retest_lows:  0.15,
  },
};

// ── 3. Sector tilts ────────────────────────────────────────────────────────
// stance ∈ {"overweight", "neutral", "underweight"}.
// Multiplier is what scoring layers apply when blending strategy alignment.
// rationale_short shows in UI cards; rationale_long shows on Learn page.
export const SECTOR_TILTS = {
  "Information Technology": {
    stance: "overweight",
    multiplier: 1.20,
    rationale_short: "AI/compute leader. NTM P/E still reasonable (NVDA 19x). Semis +115% YTD.",
    rationale_long:
      "Tech delivered +52.6% Y/Y earnings growth in 1Q26. Memory ($DRAM +142%) and " +
      "semiconductors ($SMH +115%) are leading; Software ($IGV -9%) is the laggard with " +
      "convergence potential. NVDA trades at 19.2x NTM PE — well below CSCO's 1999-era 55x " +
      "bubble level. AI capex cycle structurally supports compute, memory, semicap, " +
      "data-center REITs, and the power complex.",
    boost_themes: ["ai_infra_compute", "ai_infra_memory", "ai_infra_semicap", "ai_software", "ai_consumer", "ai_infra_dc_reit"],
  },
  "Communication Services": {
    stance: "overweight",
    multiplier: 1.15,
    rationale_short: "MAG7 cohort + 49.5% Y/Y earnings surprise; META/GOOGL lead AI consumer.",
    rationale_long:
      "Comm Services posted +49.5% Y/Y earnings growth and is a MAG7-heavy bucket. META, " +
      "GOOGL, NFLX benefit from the AI consumer playbook and reaccelerating digital ad spend.",
    boost_themes: ["ai_consumer"],
  },
  "Consumer Discretionary": {
    stance: "overweight",
    multiplier: 1.10,
    rationale_short: "MAG7 (AMZN, TSLA) anchor + 40.7% Y/Y earnings growth. Travel resilient.",
    rationale_long:
      "Anchored by AMZN (logistics/AI) and TSLA (compute/EV). Forward sales soft (-11.9%) but " +
      "trailing growth at +40.7% Y/Y. Travel/leisure remains resilient on prime-age cohort " +
      "spending — a key demographic tailwind through 2029.",
    boost_themes: ["ev_battery", "travel_leisure", "ecom_logistics"],
  },
  "Financials": {
    stance: "overweight",
    multiplier: 1.15,
    rationale_short: "Bottoming since April '25; large-cap + regional banks both bought.",
    rationale_long:
      "Bottoming pattern since April 2025. Both money-center banks (JPM, GS, MS, C, BAC) and " +
      "regional banks ($KRE) are on the buy list. Fed pivot away from forward guidance reduces " +
      "rate-path uncertainty — a tailwind for NIM and capital markets.",
    boost_themes: ["banks_money_center", "banks_regional", "fintech"],
  },
  "Industrials": {
    stance: "overweight",
    multiplier: 1.15,
    rationale_short: "Outperforming YTD (+6.6%). 1.1% relative-to-S&P move from bottom.",
    rationale_long:
      "Leading sector. +20.9% Y/Y earnings growth. AI-power capex (CEG, VRT, NEE) and " +
      "defense (LMT, RTX, NOC) catch the Iran-war + compute-buildout tailwinds simultaneously.",
    boost_themes: ["ai_infra_energy", "ai_infra_cooling", "defense", "space_tech"],
  },
  "Energy": {
    stance: "overweight",
    multiplier: 1.20,
    rationale_short: "Bottoming since March '25. Iran-war diesel/jet fuel shock potential.",
    rationale_long:
      "Cumulative -18.6% relative-to-S&P drawdown but showing signs of bottoming since the " +
      "Iran war began. Large-cap energy +22.2% and small-cap energy +27.3% from bottoms. " +
      "Uranium/nuclear adjacent themes (UEC, CCJ, SMR) benefit from AI power demand.",
    boost_themes: ["oil_gas", "oil_services", "refiners", "uranium_nuclear", "uranium_etf"],
  },
  "Materials": {
    stance: "overweight",
    multiplier: 1.10,
    rationale_short: "Basic Materials bottoming with Energy. +40.7% Y/Y earnings growth.",
    rationale_long:
      "Basic Materials surprised +17.3% in 1Q26 and posted +40.7% Y/Y earnings growth despite " +
      "a -13.9% relative drawdown. Bottoming alongside Energy; gold/precious metals catch " +
      "any dollar-weakness / safe-haven rotation if the Iran war escalates.",
    boost_themes: ["metals_miners"],
  },
  "Healthcare": {
    stance: "neutral",
    multiplier: 1.00,
    rationale_short: "-2.9% Y/Y earnings growth; lone outright contractor. Weight-loss is the bright spot.",
    rationale_long:
      "Only sector with negative earnings growth (-2.9% Y/Y). Defensive bias hurts in a " +
      "back-ended rally environment. Carve-out exposure to weight-loss leaders (LLY, NVO, " +
      "VKTX) where structural demand remains intact.",
    boost_themes: ["weight_loss"],
  },
  "Real Estate": {
    stance: "neutral",
    multiplier: 1.00,
    rationale_short: "Rate-sensitive. Data-center REITs (DLR, EQIX) are the AI-cycle carve-out.",
    rationale_long:
      "Broad REITs are rate-sensitive. The structural carve-out is data-center REITs (DLR, EQIX, IRM, COR) " +
      "which are direct AI-buildout beneficiaries.",
    boost_themes: ["ai_infra_dc_reit"],
  },
  "Consumer Staples": {
    stance: "underweight",
    multiplier: 0.90,
    rationale_short: "Defensive — lags in a back-ended rally. Costco 48x P/E is rich vs NVDA 19x.",
    rationale_long:
      "Defensive bias underperforms in a back-ended rally tape. Multiple compression risk " +
      "(Costco 48x, Walmart 41x trade at premium to NVDA 19x — anomalous). Underweight unless " +
      "macro flips to defensive rotation.",
    boost_themes: [],
  },
  "Utilities": {
    stance: "underweight",
    multiplier: 0.90,
    rationale_short: "Defensive bond proxy. Exception: AI-power utilities (CEG, VST, NEE).",
    rationale_long:
      "Broad Utilities are an underweight defensive bond proxy. The carve-out is AI-power " +
      "utilities (CEG, VST, NEE, TLN) which trade more like growth + infrastructure.",
    boost_themes: ["ai_infra_energy"],
  },
};

// ── 4. Theme tilts (THEME-keyed for direct join against THEMES{}) ──────────
// stance/multiplier mirror the sector schema. tier ∈ {tier_1, tier_2}.
// tier_1 = headline buy themes from the deck. tier_2 = adjacent / supporting.
export const THEME_TILTS = {
  // Tier 1: explicit "WHAT TO OWN" — MAG7, Ethereum, Software, Industrials,
  // Financials, Regional Banks, Small-Caps, Energy/Basic Materials.
  ai_infra_compute:  { stance: "overweight", multiplier: 1.25, tier: "tier_1", playbook: "MAG7 + AI compute cycle" },
  ai_infra_memory:   { stance: "overweight", multiplier: 1.25, tier: "tier_1", playbook: "DRAM +142% YTD; cycle inflecting" },
  ai_infra_semicap:  { stance: "overweight", multiplier: 1.20, tier: "tier_1", playbook: "Capex cycle confirmation" },
  ai_software:       { stance: "overweight", multiplier: 1.20, tier: "tier_1", playbook: "IGV -9% YTD — laggard convergence trade" },
  ai_consumer:       { stance: "overweight", multiplier: 1.20, tier: "tier_1", playbook: "MAG7 cohort (GOOGL/META/MSFT/ORCL)" },
  ai_infra_dc_reit:  { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "Data-center buildout" },
  ai_infra_cooling:  { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "AI thermal-management secular" },
  ai_infra_energy:   { stance: "overweight", multiplier: 1.20, tier: "tier_1", playbook: "AI power demand + nuclear renaissance" },

  banks_money_center:{ stance: "overweight", multiplier: 1.15, tier: "tier_1", playbook: "Bottoming since 4/25; Fed pivot tailwind" },
  banks_regional:    { stance: "overweight", multiplier: 1.15, tier: "tier_1", playbook: "KRE -2% from bottom; regional bank inflection" },
  fintech:           { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "Consumer credit + crypto adjacency" },

  oil_gas:           { stance: "overweight", multiplier: 1.15, tier: "tier_1", playbook: "Iran-war jet-fuel/diesel shock potential" },
  oil_services:      { stance: "overweight", multiplier: 1.10, tier: "tier_1", playbook: "Capex revival on supply tightening" },
  refiners:          { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "Crack-spread expansion" },
  uranium_nuclear:   { stance: "overweight", multiplier: 1.20, tier: "tier_1", playbook: "AI power demand secular thesis" },
  uranium_etf:       { stance: "overweight", multiplier: 1.15, tier: "tier_2", playbook: "Vehicle for the nuclear thesis" },
  metals_miners:     { stance: "overweight", multiplier: 1.10, tier: "tier_1", playbook: "Basic materials + dollar-hedge optionality" },

  crypto_proxies:    { stance: "overweight", multiplier: 1.15, tier: "tier_1", playbook: "Bitcoin +13.7% YTD; Ethereum bottoming -36.8% off lows" },
  crypto_etf:        { stance: "overweight", multiplier: 1.15, tier: "tier_1", playbook: "IBIT/ETHA — front-line crypto exposure" },
  crypto_miners:     { stance: "neutral",    multiplier: 1.00, tier: "tier_2", playbook: "High-beta proxy; trade vehicle only" },

  defense:           { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "Iran-war tailwind + global rearmament" },
  space_tech:        { stance: "overweight", multiplier: 1.05, tier: "tier_2", playbook: "SpaceX-adjacent narrative" },
  cybersecurity:     { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "AI-driven attack surface expansion" },

  weight_loss:       { stance: "overweight", multiplier: 1.10, tier: "tier_2", playbook: "Healthcare carve-out — structural demand" },
  travel_leisure:    { stance: "neutral",    multiplier: 1.00, tier: "tier_2", playbook: "Prime-age demographic tailwind" },
  ev_battery:        { stance: "neutral",    multiplier: 1.00, tier: "tier_2", playbook: "TSLA-heavy; high beta" },
  ecom_logistics:    { stance: "neutral",    multiplier: 1.00, tier: "tier_2", playbook: "AMZN/SHOP anchor — MAG7 adjacency" },

  // Country tilts (referenced when ticker is a country ETF).
  country_us_broad:  { stance: "overweight", multiplier: 1.10, tier: "tier_1", playbook: "US exceptionalism — primary positioning" },
  country_china:     { stance: "underweight", multiplier: 0.90, tier: "tier_2", playbook: "CSI 300 -44% over 10y vs MSCI; structural underperform" },
};

// ── 5. Small-cap / SMID tilt (called out separately in the deck) ───────────
export const SIZE_TILTS = {
  small_cap_smid: {
    stance: "overweight",
    multiplier: 1.15,
    rationale_short: "IWM +5.8% from bottom; markets eye 2026 catch-up trade.",
    threshold_mcap_usd: 10_000_000_000, // any name < $10B gets the SMID bump
  },
};

// ── 6. Catalyst weighting overrides ────────────────────────────────────────
// Used by the Daily Brief + news-tracker scoring to bias which incoming
// catalysts get extra airtime. Names follow the catalyst taxonomy already
// in `news-tracker.js` (`catalyst_type` field).
export const CATALYST_WEIGHTS = {
  // Bullish — amplified
  ai_capex_announcement:       { weight: 1.5, note: "Core AI buildout thesis" },
  data_center_buildout:        { weight: 1.4, note: "AI infra capex" },
  power_partnership:           { weight: 1.4, note: "AI-power utility nexus" },
  fed_dovish_commentary:       { weight: 1.3, note: "Markets test new Fed (Warsh)" },
  earnings_beat_with_raise:    { weight: 1.3, note: "Resilience theme confirmation" },
  insider_buying_cluster:      { weight: 1.2, note: "Conviction signal" },
  semiconductor_orders:        { weight: 1.4, note: "Compute-cycle confirmation" },
  bitcoin_etf_inflow:          { weight: 1.2, note: "Crypto exposure thesis" },

  // Bearish / risk — also amplified (we want to react faster)
  iran_war_escalation:         { weight: 1.5, note: "Active 7th black swan" },
  oil_supply_shock:            { weight: 1.4, note: "Jet-fuel/diesel shock pathway" },
  spacex_ipo_lockup_release:   { weight: 1.3, note: "Mechanical equity supply headwind 2Q-3Q26" },
  fed_hawkish_pivot:           { weight: 1.3, note: "Futures already at 0.9 hikes for 2026" },
  recession_warning_economist: { weight: 1.1, note: "Round-trip-lower setup" },

  // Down-weighted (over-covered by financial media, low information value here)
  generic_analyst_upgrade:     { weight: 0.7, note: "Noisy; rely on insider/news" },
  generic_analyst_downgrade:   { weight: 0.7, note: "Noisy; rely on insider/news" },
};

// ── 7. Investor thesis ladders (per stance) ────────────────────────────────
// How the Investor classifier should "lean" given the active playbook. This
// does NOT override the classifier scoring — it provides a tie-break + a
// rationale string the classifier can attach to its output.
export const INVESTOR_THESIS_LEAN = {
  // For tier-1 themes in OVERWEIGHT sectors:
  on_thesis_overweight:
    "Active playbook: Tier-1 buy zone. Round-trip dips are accumulation opportunities (CORE_HOLD → ACCUMULATE on red days).",
  // For neutral themes:
  on_thesis_neutral:
    "Active playbook: Hold core, do not chase. Wait for pullbacks; trim into strength.",
  // For underweight themes:
  on_thesis_underweight:
    "Active playbook: Underweight sector. Hold only if name has theme tailwind; otherwise REDUCE on strength.",
};

// ── 8. Risk register (active black swans / known headwinds) ────────────────
export const ACTIVE_RISKS = [
  {
    name: "iran_war",
    severity: "high",
    note: "7th black swan — active. Pressures Energy supply; can deliver jet-fuel/diesel shock. Watch USO, XLE, defense for sustained bid.",
  },
  {
    name: "new_fed_test",
    severity: "medium",
    note: "Markets historically test new Fed chairs 11/13 times. Warsh prefers less forward guidance → expect FOMC vol spikes.",
  },
  {
    name: "spacex_ipo_lockup",
    severity: "medium",
    note: "Mechanical equity-supply headwind 2Q-3Q26 as SpaceX lockups release. Largest IPO in US history.",
  },
  {
    name: "ai_input_cost_inflation",
    severity: "low",
    note: "Fed minutes flag AI capex pushing up industry input costs; could keep inflation sticky.",
  },
];

// ── 9. User-facing education snippets ──────────────────────────────────────
// Surfaced on the Learn page. Plain-English jargon → meaning. Curated, not auto.
export const EDUCATION_SNIPPETS = [
  {
    term: "Back-ended rally",
    plain: "Gains skewed toward Q4 (Sep–Dec). Don't expect smooth grinding higher — expect a chop-then-rally pattern.",
  },
  {
    term: "Round-trip",
    plain: "Market dips meaningfully mid-year before recovering to new highs by year-end.",
  },
  {
    term: "Phase 1 / 2 / 3 market",
    plain: "Phase 1 (now): MAG7/Crypto/Software already bottomed. Phase 2: possible mid-year retest. Phase 3: year-end push to S&P 7,300/7,700.",
  },
  {
    term: "Black swan",
    plain: "Major, unexpected event. The deck cites 7 since 2020 (COVID, supply chain, inflation, fast Fed hikes, tariffs, Iran nuclear, Iran war).",
  },
  {
    term: "Prime-age population",
    plain: "Adults age 30-48 — peak earning, spending, and debt-leverage years. US is the only major economy with this cohort growing into 2029.",
  },
  {
    term: "Laggard convergence",
    plain: "When a sub-sector has under-performed its peers (e.g. Software vs Semis), historically it tends to catch up. We size into laggards within a winning theme.",
  },
];

// ── 10. Public API ─────────────────────────────────────────────────────────

/**
 * Returns the strategy alignment for a given ticker, joining sector + theme
 * tilts. Used by:
 *   - Promotion-queue scoring (boost overweight-theme candidates)
 *   - Right Rail "Strategy" chip
 *   - AI CIO memory layer 15
 *   - Daily Brief "On / Off thesis" callouts
 *
 * @param {string} sym        Ticker symbol
 * @param {object} tickerData Optional ticker data ({sector, market_cap, ...})
 * @param {function} getThemesForTicker  Optional injection — falls back to require
 * @returns {object}          { aligned, stance, multiplier, themes_matched, ... }
 */
export function getStrategyForTicker(sym, tickerData = null, themeResolver = null) {
  const ticker = String(sym || "").toUpperCase();
  if (!ticker) return { aligned: false, stance: "neutral", multiplier: 1.0 };

  let themes = [];
  try {
    if (typeof themeResolver === "function") {
      themes = themeResolver(ticker) || [];
    }
  } catch (_) { /* best-effort */ }

  // Theme-level alignment (take the strongest tilt across all matched themes).
  let themeStance = "neutral";
  let themeMultiplier = 1.0;
  let themeTier = null;
  let themePlaybook = null;
  let matchedThemes = [];
  for (const t of themes) {
    const tilt = THEME_TILTS[t];
    if (!tilt) continue;
    matchedThemes.push({ theme: t, stance: tilt.stance, tier: tilt.tier, playbook: tilt.playbook });
    if (Math.abs(tilt.multiplier - 1.0) > Math.abs(themeMultiplier - 1.0)) {
      themeStance = tilt.stance;
      themeMultiplier = tilt.multiplier;
      themeTier = tilt.tier;
      themePlaybook = tilt.playbook;
    }
  }

  // Sector-level alignment.
  const sectorName = tickerData?.sector || tickerData?._ticker_profile?.sector || null;
  const sectorTilt = sectorName ? SECTOR_TILTS[sectorName] : null;
  const sectorStance = sectorTilt?.stance || "neutral";
  const sectorMultiplier = sectorTilt?.multiplier || 1.0;

  // SMID add-on.
  const mcap = Number(tickerData?.market_cap || tickerData?.mcap || 0);
  const smidApplies = mcap > 0 && mcap < SIZE_TILTS.small_cap_smid.threshold_mcap_usd;
  const smidMultiplier = smidApplies ? SIZE_TILTS.small_cap_smid.multiplier : 1.0;

  // Composite stance: take the strongest (largest |x - 1|) of theme/sector.
  const themeWeight = Math.abs(themeMultiplier - 1.0);
  const sectorWeight = Math.abs(sectorMultiplier - 1.0);
  let stance, multiplier, reason;
  if (themeWeight >= sectorWeight && themeMultiplier !== 1.0) {
    stance = themeStance;
    multiplier = themeMultiplier;
    reason = themePlaybook || null;
  } else if (sectorMultiplier !== 1.0) {
    stance = sectorStance;
    multiplier = sectorMultiplier;
    reason = sectorTilt?.rationale_short || null;
  } else {
    stance = "neutral";
    multiplier = 1.0;
    reason = null;
  }
  multiplier *= smidMultiplier;

  return {
    aligned: stance === "overweight" || stance === "underweight",
    stance,
    multiplier: Math.round(multiplier * 1000) / 1000,
    tier: themeTier,
    reason,
    sector: sectorName,
    sector_stance: sectorStance,
    sector_multiplier: sectorMultiplier,
    theme_stance: themeStance,
    theme_multiplier: themeMultiplier,
    themes_matched: matchedThemes,
    smid_applies: smidApplies,
    market_cap_usd: mcap || null,
    vintage: STRATEGY_VINTAGE,
  };
}

/**
 * Returns a compact brief suitable for inclusion in an LLM system prompt.
 * Strings only — no nested objects. ~1.5KB.
 */
export function getStrategyBrief() {
  const overweightSectors = Object.entries(SECTOR_TILTS)
    .filter(([, v]) => v.stance === "overweight")
    .map(([k, v]) => `${k} (${v.rationale_short})`);
  const underweightSectors = Object.entries(SECTOR_TILTS)
    .filter(([, v]) => v.stance === "underweight")
    .map(([k, v]) => `${k} (${v.rationale_short})`);
  const tier1Themes = Object.entries(THEME_TILTS)
    .filter(([, v]) => v.tier === "tier_1" && v.stance === "overweight")
    .map(([k, v]) => `${k} — ${v.playbook}`);
  const risks = ACTIVE_RISKS.map(r => `${r.name} (${r.severity}): ${r.note}`);

  return [
    `## TT Active Strategy — ${STRATEGY_TITLE}`,
    `Source: ${STRATEGY_SOURCE}. Vintage: ${STRATEGY_VINTAGE}.`,
    ``,
    `Headline: ${STRATEGY_HEADLINE}`,
    ``,
    `Phase: ${STRATEGY_PHASE.label}.`,
    `S&P targets: base ${STRATEGY_PHASE.spx_targets.base_case}, aspirational ${STRATEGY_PHASE.spx_targets.aspirational}, long-horizon ${STRATEGY_PHASE.spx_targets.long_horizon_2030} (2030).`,
    `Scenario weights: grind-higher ${(STRATEGY_PHASE.scenario_weights.grind_higher_to_target * 100).toFixed(0)}%, round-trip ${(STRATEGY_PHASE.scenario_weights.round_trip_then_rally * 100).toFixed(0)}%, bear-retest ${(STRATEGY_PHASE.scenario_weights.bear_case_retest_lows * 100).toFixed(0)}%.`,
    ``,
    `OVERWEIGHT sectors: ${overweightSectors.join("; ")}.`,
    `UNDERWEIGHT sectors: ${underweightSectors.join("; ")}.`,
    ``,
    `TIER-1 THEMES (buy dips): ${tier1Themes.join(" | ")}.`,
    ``,
    `ACTIVE RISKS: ${risks.join(" | ")}.`,
    ``,
    `USE THIS to bias commentary toward on-thesis names, flag off-thesis trades, and explain WHY a sector is leading/lagging in plain English.`,
  ].join("\n");
}

/**
 * UI-friendly digest payload, served from /timed/strategy.
 * Plain JSON; no functions. ≤ 8KB.
 */
export function getStrategyDigest() {
  return {
    vintage: STRATEGY_VINTAGE,
    source: STRATEGY_SOURCE,
    title: STRATEGY_TITLE,
    headline: STRATEGY_HEADLINE,
    phase: STRATEGY_PHASE,
    sector_tilts: SECTOR_TILTS,
    theme_tilts: THEME_TILTS,
    size_tilts: SIZE_TILTS,
    catalyst_weights: CATALYST_WEIGHTS,
    investor_thesis_lean: INVESTOR_THESIS_LEAN,
    active_risks: ACTIVE_RISKS,
    education: EDUCATION_SNIPPETS,
  };
}

/**
 * Return the active sector stance for a given sector string.
 * Convenience helper for the AI CIO + Daily Brief.
 */
export function getSectorStance(sectorName) {
  const t = SECTOR_TILTS[sectorName];
  if (!t) return { stance: "neutral", multiplier: 1.0, rationale_short: null };
  return {
    stance: t.stance,
    multiplier: t.multiplier,
    rationale_short: t.rationale_short,
    boost_themes: t.boost_themes || [],
  };
}
