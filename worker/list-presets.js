/**
 * Ripster-style list presets for UI chips and filters.
 * Single source of truth: sector-mapping THEMES + static MAG7.
 */
import { getTickersInTheme } from "./sector-mapping.js";

export const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"];

export const AI_ECOSYSTEM_THEME_KEYS = [
  "ai_infra_compute",
  "ai_infra_memory",
  "ai_infra_energy",
  "ai_infra_cooling",
  "ai_infra_dc_reit",
  "ai_infra_semicap",
  "ai_software",
  "ai_consumer",
];

function unionThemeTickers(themeKeys) {
  const out = new Set();
  for (const key of themeKeys) {
    for (const sym of getTickersInTheme(key)) {
      out.add(String(sym).toUpperCase());
    }
  }
  return [...out];
}

export function buildListPresets() {
  return [
    {
      id: "mag7",
      label: "MAG7",
      tickers: [...MAG7_TICKERS],
    },
    {
      id: "ai_ecosystem",
      label: "AI Ecosystem",
      tickers: unionThemeTickers(AI_ECOSYSTEM_THEME_KEYS),
    },
    {
      id: "cybersecurity",
      label: "Cybersecurity",
      tickers: getTickersInTheme("cybersecurity").map((t) => String(t).toUpperCase()),
    },
    {
      id: "saas_cloud",
      label: "SaaS & Cloud",
      tickers: getTickersInTheme("ai_software").map((t) => String(t).toUpperCase()),
    },
  ];
}
