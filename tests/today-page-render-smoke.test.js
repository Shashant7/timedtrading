// @vitest-environment jsdom
//
// Reproduces the authenticated Today render path without Cloudflare Access.
// Captures console errors that would white-screen the page for Pro users.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { act } from "react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const errors = [];
const origError = console.error;

function loadScript(relPath) {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  // eslint-disable-next-line no-eval
  globalThis.eval(src);
}

function mockFetch() {
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/timed/all")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            AAPL: {
              ticker: "AAPL",
              investor_stage: "accumulate",
              score: 72,
              price: 190,
              rank: 5,
              simEligible: true,
              accumZone: { inZone: true, zoneTop: 195, zoneBottom: 180 },
            },
            IESC: {
              ticker: "IESC",
              investor_stage: "accumulate",
              recentlyExited: { closed_at: Date.now() - 3600000, last_action_type: "SELL" },
              score: 60,
              price: 681,
            },
            MSFT: { ticker: "MSFT", kanban_stage: "enter", price: 420, rank: 2 },
          },
        }),
      };
    }
    if (u.includes("/timed/tickers")) {
      return { ok: true, json: async () => ({ tickers: ["AAPL", "MSFT", "IESC"] }) };
    }
    if (u.includes("/timed/cal")) {
      return { ok: true, json: async () => ({ ok: true, sessions: [] }) };
    }
    if (u.includes("/timed/brief")) {
      return { ok: true, json: async () => ({ ok: false }) };
    }
    if (u.includes("/timed/earnings")) {
      return { ok: true, json: async () => ({ ok: false }) };
    }
    if (u.includes("/timed/trades/open")) {
      return { ok: true, json: async () => ({ ok: true, trades: [] }) };
    }
    if (u.includes("/timed/holdbook")) {
      return { ok: true, json: async () => ({ ok: true, holdings: [] }) };
    }
    if (u.includes("/timed/cro/") || u.includes("/timed/cto/")) {
      return { ok: true, json: async () => ({ ok: true, items: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
}

describe("Today page render (Pro, auth bypass)", () => {
  beforeAll(() => {
    console.error = (...args) => {
      errors.push(args.map(String).join(" "));
      origError(...args);
    };

    window.React = React;
    window.ReactDOM = require("react-dom/client");
    window.TimedAuthGate = ({ children }) =>
      children({
        email: "test@timedtrading.test",
        role: "admin",
        tier: "pro",
        subscription_status: "active",
      });
    window._ttIsPro = true;
    window._ttIsAdmin = true;
    window.TTFetchCache = {
      get: async (url) => {
        const r = await window.fetch(url);
        return r.json();
      },
      peek: () => null,
      put: () => {},
    };
    window.TimedBubbleChart = {
      getRankedTickers: () => [],
      BubbleChart: () => null,
    };
    mockFetch();

    const container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);

    loadScript("react-app/shared-price-utils.js");
    loadScript("react-app/investor-nav-badge.js");
    loadScript("react-app/shared-rail-helpers.js");
    loadScript("react-app/shared-verdict-ui.js");
    loadScript("react-app-dist/today.compiled.js");
  });

  afterAll(() => {
    console.error = origError;
  });

  it("mounts TodayApp without React render errors", async () => {
    errors.length = 0;
    const container = document.getElementById("root");
    expect(container).toBeTruthy();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    const rootText = container.textContent || "";
    expect(rootText.length).toBeGreaterThan(0);

    const reactErrors = errors.filter((e) =>
      /ReferenceError|TypeError|Rendered more hooks|Minified React error/i.test(e),
    );
    if (reactErrors.length) {
      throw new Error(`Console errors:\n${reactErrors.join("\n")}`);
    }
  });
});
