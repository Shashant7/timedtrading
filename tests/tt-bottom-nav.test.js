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

describe("tt-bottom-nav pin-to-bottom v8", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/today.html");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        offsetTop: 0,
        offsetLeft: 0,
        width: 390,
        height: 700,
        scale: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById("tt-bottom-nav")?.remove();
    document.getElementById("tt-bottom-nav-style")?.remove();
  });

  it("mounts five journey tabs and v8 vintage", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-07-23-v8");
    expect(nav.parentNode).toBe(document.body);
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
  });

  it("CSS pins with bottom:0 and no transform/backdrop-filter", () => {
    loadBottomNav();
    const css = document.getElementById("tt-bottom-nav-style").textContent;
    expect(css).not.toMatch(/\.tt-bn\s*\{[^}]*\btransform\s*:/);
    expect(css).not.toMatch(/(?:^|[^-])backdrop-filter\s*:/);
    expect(css).toMatch(/position:\s*fixed\s*!important/);
    expect(css).toMatch(/bottom:\s*0\s*!important/);
    expect(css).toMatch(/top:\s*auto\s*!important/);
  });

  it("inline style uses bottom:0 / top:auto (no per-frame top)", () => {
    const nav = loadBottomNav();
    expect(nav.style.bottom).toBe("0px");
    expect(nav.style.top).toBe("auto");
    expect(nav.style.transform || "").toBe("");
    expect(nav.dataset.ttBnTop).toBeUndefined();
  });

  it("does not rewrite top on scroll events (jitter guard)", () => {
    const nav = loadBottomNav();
    nav.style.setProperty("top", "auto", "important");
    window.dispatchEvent(new Event("scroll"));
    // Immediate (non-debounced) scroll must not invent a top px
    expect(nav.style.top).toBe("auto");
    expect(nav.style.bottom).toBe("0px");
  });

  it("hides via class when a text input is focused (no transform)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const nav = loadBottomNav();
    expect(nav.classList.contains("is-keyboard-hidden")).toBe(true);
    expect(nav.dataset.ttBnState).toBe("keyboard");
    expect(nav.style.transform || "").not.toContain("200%");
  });
});
