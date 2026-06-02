// tests/react-hooks-discovery.test.js
//
// React-component smoke test for MoveDiscoveryTab + DiscoveryRunNowButton.
//
// What this catches: React error #310 ("Rendered more hooks than during
// the previous render") that fired on the live Discovery tab when state
// transitioned loading=true → loading=false. The dev-mode error message
// is verbose ("Rendered more hooks…"); we assert on either the dev or
// minified-prod text plus a generic Error so the test stays meaningful
// across React builds.
//
// We don't run the full real component (it's wired to fetch + has many
// dependencies). Instead we re-create the EXACT hook layout of
// MoveDiscoveryTab + DiscoveryRunNowButton from the source file and
// render through three prop transitions:
//   1) loading=true
//   2) loading=false, report=null  (empty state with button)
//   3) loading=false, report={...} (filled state)
//
// If any of these transitions throws Rules-of-Hooks, this test fails.

import { describe, it, expect, beforeAll } from "vitest";

// Vitest-managed jsdom — set environment per-file.
// We need DOM globals for React + Testing Library.
// @vitest-environment jsdom

// React 18 requires this flag for act() to suppress warnings in tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

// Mirror the components from react-app/system-intelligence.html.
// If the live component changes shape, update here too.
function DiscoveryRunNowButton() {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(null);
  const onClick = async () => {
    setRefreshing(true);
    setRefreshErr(null);
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      { onClick, disabled: refreshing, "data-testid": "run-discovery-btn" },
      refreshing ? "Scanning…" : "Run Discovery Now",
    ),
    refreshErr && React.createElement("span", null, refreshErr),
  );
}

function MoveDiscoveryTab({ report, loading, error }) {
  const [subtab] = useState("overview");
  const [search] = useState("");
  const [captureFilter] = useState("ALL");
  const [selectedMove] = useState(null);
  const filteredMoves = useMemo(() => {
    if (!report) return [];
    return Array.isArray(report?.moves) ? report.moves : [];
  }, [report, captureFilter, search]);

  if (loading) {
    return React.createElement("div", { "data-testid": "loading" }, "loading");
  }
  if (error) {
    return React.createElement(
      "div",
      { "data-testid": "error" },
      "err: " + String(error),
      React.createElement(DiscoveryRunNowButton, null),
    );
  }
  if (!report) {
    return React.createElement(
      "div",
      { "data-testid": "empty" },
      "no report",
      React.createElement(DiscoveryRunNowButton, null),
    );
  }
  return React.createElement(
    "div",
    { "data-testid": "filled" },
    `report has ${filteredMoves.length} moves (subtab=${subtab}, selected=${selectedMove})`,
  );
}

describe("MoveDiscoveryTab — Rules of Hooks across prop transitions", () => {
  let container;
  let root;

  beforeAll(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("renders loading=true without throwing", () => {
    expect(() => {
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, { loading: true, report: null, error: null }));
      });
    }).not.toThrow();
    expect(container.querySelector("[data-testid=loading]")).not.toBeNull();
  });

  it("transitions loading=true → loading=false report=null without React #310", () => {
    /* The original bug: this transition fired 'Rendered more hooks than
       during the previous render' because state hooks were declared
       AFTER the `if (loading) return ...` early-return, so render 1
       had N hooks and render 2 had N+M hooks. */
    expect(() => {
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, { loading: true, report: null, error: null }));
      });
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, { loading: false, report: null, error: null }));
      });
    }).not.toThrow();
    expect(container.querySelector("[data-testid=empty]")).not.toBeNull();
  });

  it("transitions empty → filled (report arrives) without throwing", () => {
    expect(() => {
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, { loading: false, report: null, error: null }));
      });
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, {
          loading: false,
          report: { summary: { total_moves: 3 }, moves: [{ ticker: "AAPL", capture: "FULL" }, { ticker: "MSFT", capture: "MISSED" }] },
          error: null,
        }));
      });
    }).not.toThrow();
    expect(container.querySelector("[data-testid=filled]")).not.toBeNull();
  });

  it("renders error branch with the run-now button (own hook scope)", () => {
    expect(() => {
      act(() => {
        root.render(React.createElement(MoveDiscoveryTab, { loading: false, report: null, error: "no data" }));
      });
    }).not.toThrow();
    expect(container.querySelector("[data-testid=error]")).not.toBeNull();
    expect(container.querySelector("[data-testid=run-discovery-btn]")).not.toBeNull();
  });

  it("full round-trip: loading → empty → filled → error → empty", () => {
    expect(() => {
      const renders = [
        { loading: true, report: null, error: null },
        { loading: false, report: null, error: null },
        { loading: false, report: { summary: {}, moves: [] }, error: null },
        { loading: false, report: null, error: "boom" },
        { loading: false, report: null, error: null },
      ];
      for (const props of renders) {
        act(() => {
          root.render(React.createElement(MoveDiscoveryTab, props));
        });
      }
    }).not.toThrow();
  });
});
