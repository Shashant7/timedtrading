// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadBottomNav() {
  // Reset idempotent guards between tests.
  document.getElementById("tt-bottom-nav")?.remove();
  document.getElementById("tt-bottom-nav-style")?.remove();
  const src = readFileSync(join(process.cwd(), "react-app/tt-bottom-nav.js"), "utf8");
  // eslint-disable-next-line no-eval
  window.eval(src);
  return document.getElementById("tt-bottom-nav");
}

describe("tt-bottom-nav visualViewport sync", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // jsdom default pathname is "/" — force a journey page.
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
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-07-23-v4");
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
  });

  it("does not hide for expanded Safari chrome without a focused input", () => {
    // Pro-sized layout with chrome-shrunk visual viewport — previously
    // tripped vvH < innerH * 0.65 and hid the nav as "keyboard".
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 852 });
    window.visualViewport = {
      height: 520,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const nav = loadBottomNav();
    // Allow the 0/150/400 sync timers — only the sync0 runs sync immediately.
    expect(nav.dataset.ttBnState).not.toBe("keyboard");
    expect(nav.style.transform).not.toContain("200%");
    // Should push up by capped URL-bar delta, not vanish.
    expect(nav.style.transform).toMatch(/translate3d\(0,\s*-\d+px,\s*0\)/);
  });

  it("hides only when a text input is focused and viewport shrinks", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 852 });
    window.visualViewport = {
      height: 400,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const nav = loadBottomNav();
    expect(nav.dataset.ttBnState).toBe("keyboard");
    expect(nav.style.transform).toContain("200%");
  });
});
