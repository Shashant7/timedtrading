import { describe, it, expect } from "vitest";
import { stripBriefMarkdownForDisplay } from "../worker/daily-brief-markdown.js";
import { extractPredictionLine, extractBriefLead } from "../worker/daily-brief.js";

describe("extractPredictionLine", () => {
  it("extracts from merged Index Outlook ### SPY sub-heading", () => {
    const content = `## Index Outlook & Game Plan

### SPY
**SPY Prediction**: SPY holds above $580 early.
**SPY @ $582** · Range today $575–$585
▲ Bull above $584 → $590
▼ Bear below $578 → $572
Lean: BULL — breadth firm

### QQQ
**QQQ Prediction**: Tech leads if rates stay calm.`;
    const spy = extractPredictionLine(content, "SPY");
    expect(spy).toContain("SPY holds above");
    expect(spy).toContain("Lean: BULL");
    const qqq = extractPredictionLine(content, "QQQ");
    expect(qqq).toContain("Tech leads");
  });

  it("still extracts legacy ## SPY Prediction heading", () => {
    const content = `## SPY Prediction
SPY stays inside the day range.`;
    expect(extractPredictionLine(content, "SPY")).toContain("inside the day range");
  });
});

describe("extractBriefLead", () => {
  it("prefers At a Glance bullets over Market Read prose", () => {
    const content = `SUBJECT: Test hook

## At a Glance
- Stocks opened higher after strong jobs data.
- Playbook still favors dips in large-cap tech.
- Model is patient — no new entries yet.

## The Market Read
Dense technical prose about SMC and FVG levels that should not appear in the lead.`;
    const lead = extractBriefLead(content);
    expect(lead).toContain("Stocks opened higher");
    expect(lead).toContain("Model is patient");
    expect(lead).not.toContain("SMC");
  });

  it("uses intraday TLDR when At a Glance is absent", () => {
    const content = `TLDR: SPY holding gains while the model waits for a cleaner setup.

## Model Pulse
Trader model: waiting.`;
    const lead = extractBriefLead(content);
    expect(lead).toContain("SPY holding gains");
  });
});

describe("stripBriefMarkdownForDisplay", () => {
  it("removes legacy duplicate sections but keeps The Market Read", () => {
    const md = `## The Market Read
Tech sold off on hot CPI.

## Market Context
Duplicate macro copy.

## Index Outlook & Game Plan
### SPY
Stale body.

## Investor Portfolio
AAPL and MSFT in one paragraph.

## Risk Factors
- Fed speak`;
    const out = stripBriefMarkdownForDisplay(md);
    expect(out).toContain("The Market Read");
    expect(out).toContain("hot CPI");
    expect(out).not.toMatch(/Market Context/i);
    expect(out).not.toMatch(/Index Outlook/i);
    expect(out).toContain("Investor Portfolio");
    expect(out).toContain("AAPL and MSFT");
    expect(out).toContain("Risk Factors");
  });

  it("drops a leading Index Outlook block before The Market Read", () => {
    const md = `## Index Outlook & Scorecard
### ES
**ES Prediction**: Bull above $7630.

## The Market Read
Tech sold off on hot CPI.`;
    const out = stripBriefMarkdownForDisplay(md);
    expect(out).toMatch(/^## The Market Read/m);
    expect(out).not.toMatch(/Index Outlook/i);
    expect(out).toContain("hot CPI");
  });

  it("removes duplicate CRO Desk section from markdown body", () => {
    const md = `## The Market Read
Tech sold off on hot CPI.

## CRO Research Desk
Verdict duplicate.

## Risk Factors
- Fed speak`;
    const out = stripBriefMarkdownForDisplay(md);
    expect(out).toContain("The Market Read");
    expect(out).not.toMatch(/CRO Research Desk/i);
    expect(out).toContain("Risk Factors");
  });
});
