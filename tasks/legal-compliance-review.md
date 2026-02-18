# Legal Counsel Compliance — End-to-End Review

**Date:** 2026-02  
**Scope:** Splash, FAQ, Investor Dashboard, Active Trader (index-react), and related copy.

---

## ✅ COVERED (Already Compliant)

### Splash Page
| Item | Status |
|------|--------|
| Hero: "support disciplined decision-making" | ✅ |
| 8 Timeframes everywhere (5m, 10m, 30m, 1hr, 4hr, D, W, M) | ✅ |
| Trade the Momentum: SuperTrend, TD Sequential, EMA crossover | ✅ |
| Trade the Momentum: "eight timeframes", "Model-driven analysis" | ✅ |
| Build Wealth: "Timed Trading Simulated Portfolio" for sector rotation & portfolio health | ✅ |
| Build Wealth: "model allocation signals", "Model-based sizing framework and hypothetical portfolio allocation signals" | ✅ |
| Features: "Continuous Signal Updates" (no "Real-Time Market Data") | ✅ |
| Pricing: "Live model scoring updates", "5-minute model refresh cycle", "Timed Trading Simulated Portfolio tracking" | ✅ |
| Pricing: Market Pulse bullet removed | ✅ |

### FAQ
| Item | Status |
|------|--------|
| Scoring Q: "Scores stay fresh throughout market hours" (no "every minute") | ✅ |
| Investor Dashboard Q: TT Simulated Portfolio, hypothetical, not your holdings, automated/simulated | ✅ |
| Subscription Q: "Freshly updated model scoring", "TT Simulated Portfolio analytics" | ✅ |
| Technical section + "How often does data update?" removed; Mobile only | ✅ |
| Footer: Not RIA, educational only, not advice, full terms | ✅ |

### Safe Zone Language (DO)
- "Model Score", "Model Signal", "Model Bias", "Model allocation", "Model Framework" — used where appropriate.
- Simulated portfolio named in splash/FAQ pricing.

### No High-Risk Marketing
- No "Real-Time Market Data", "Live Futures Feed", "Streaming Equities Data" in splash/FAQ.
- No "beat the market", "outperform", "proven returns" in marketing copy.
- Win rate appears only as backtest/simulator metric (simulation-dashboard, index-react), not in marketing promises.

---

## 🔧 FIXES APPLIED IN THIS PASS

1. **Splash meta description** — "portfolio tracking" → "simulated portfolio analysis" to avoid implying we track the user's personal portfolio.
2. **Investor Dashboard** — Add visible "Timed Trading Simulated Portfolio (hypothetical)" label so performance/account view is clearly labeled.
3. **Active Trader Enter-lane tooltip** — Rephrase "consider position sizing based on your risk tolerance" to model-framed language (e.g. "Review model levels and your own risk parameters").
4. **Coachmark (nav modes)** — "real-time opportunities" → "fresh model signals" / "continuously updated scoring".
5. **LIVE badge tooltip** — "real-time push active" → "Live model updates active".

---

## 📌 NOTES (No Change)

- **terms.html** — "Real-time data may be delayed" is a risk disclaimer, not marketing; OK.
- **In-app "LIVE" badge** — Indicates connection status; tooltip updated to "model updates" only.
- **"Market Pulse"** in index-react — UI section name for the right-rail widget; not used in splash pricing (removed there). Left as product feature name.
- **"Sector Allocation"** on Investor Dashboard — Chart label for model portfolio allocation; not advisory. "Simulated" label added to page.
- **README.md** — Developer docs; not user-facing marketing.

---

## Checklist Summary

- [x] Hero message updated  
- [x] 9 → 8 timeframes everywhere  
- [x] Trade the Momentum (indicators + timeframes)  
- [x] Build Wealth: simulated portfolio + model-based sizing language  
- [x] Features: no "Real-Time Market Data"  
- [x] Investor Mode: no personal allocation advice; model framing  
- [x] Pricing: no Real-Time data bullet; Market Pulse removed; Investor = TT Simulated Portfolio  
- [x] FAQ: scoring generic; Investor = simulated; subscription wording; Technical section removed; footer  
- [x] Sell model not data; non-personalized; simulated clearly labeled; no outcome promises  
- [x] Meta + Investor page label + Enter tooltip + coachmark + LIVE tooltip  

---

## Verification (Codebase Sweep)

- **Splash meta** — Already: "Investor for systematic investing with the Timed Trading Simulated Portfolio."
- **Investor dashboard** — "Timed Trading Simulated Portfolio (hypothetical)" label present above Account row.
- **index-react** — Enter lane: "Review model levels and SL/TP targets below; you decide sizing and execution based on your own risk parameters." Momentum Elite description: "Use model signals as one input; you decide sizing and execution." Coachmark: "fresh model signals", "Timed Trading Simulated Portfolio". LIVE tooltip: "live model updates active."
- **Remaining "real-time"** — Only in code comments and in-app UX (e.g. "P&L updates in real-time") describing product behavior; not marketing. terms.html delay disclaimer retained.
- **Win rate** — Only in simulation/backtest context (metrics, filters); not in splash/FAQ/pricing.

---

## Full sweep (all areas checked)

| Area | Check |
|------|--------|
| **splash.html** | Hero, 8 timeframes, Trade the Momentum, Build Wealth, features strip, pricing, meta description |
| **faq.html** | Scoring, Investor Dashboard, subscription, Technical section removed, footer |
| **investor-dashboard.html** | "Timed Trading Simulated Portfolio (hypothetical)" above Account; disclaimer in footer |
| **index-react.html** | Enter/Momentum tooltips (model-framed sizing); coachmark (TT Simulated Portfolio); LIVE tooltip |
| **simulation-dashboard.html** | Win rate as backtest metric only; disclaimer present |
| **daily-brief.html** | Standard disclaimer only |
| **screener.html** | Standard disclaimer only |
| **terms.html** | "Real-time data may be delayed" = risk disclaimer (OK) |
| **README.md** | Dev docs only; not user-facing |

**Conclusion:** All counsel items are covered. No further copy changes required for the current checklist.
