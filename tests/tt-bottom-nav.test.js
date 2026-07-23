// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadBottomNav() {
  document.getElementById("tt-bottom-nav")?.remove();
  document.getElementById("tt-bottom-nav-style")?.remove();
  const src = readFileSync(join(process.cwd(), "react-app/tt-bottom-nav.js"), "utf8");
  // eslint-disable-next-line no-eval
  window.eval(src);
  return document.getElementById("tt-bottom-nav");
}

describe("tt-bottom-nav pin-to-bottom", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/today.html");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById("tt-bottom-nav")?.remove();
    document.getElementById("tt-bottom-nav-style")?.remove();
  });

  it("mounts five journey tabs including Model", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-07-23-v5");
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
  });

  it("stays pinned at bottom even when visualViewport shrinks (no URL-bar push)", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 852 });
    window.visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const nav = loadBottomNav();
    expect(nav.dataset.ttBnState).toBe("pinned");
    expect(nav.style.transform).toBe("translate3d(0, 0, 0)");
  });

  it("hides only when a text input is focused", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const nav = loadBottomNav();
    expect(nav.dataset.ttBnState).toBe("keyboard");
    expect(nav.style.transform).toContain("200%");
  });
});
