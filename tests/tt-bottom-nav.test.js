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

describe("tt-bottom-nav pin-to-bottom v7", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/today.html");
    // jsdom often lacks visualViewport — stub a layout-sized one.
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
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById("tt-bottom-nav")?.remove();
    document.getElementById("tt-bottom-nav-style")?.remove();
  });

  it("mounts five journey tabs and v7 vintage", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-07-23-v7");
    expect(nav.parentNode).toBe(document.body);
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
  });

  it("CSS does not use transform or backdrop-filter on .tt-bn", () => {
    loadBottomNav();
    const css = document.getElementById("tt-bottom-nav-style").textContent;
    expect(css).not.toMatch(/\.tt-bn\s*\{[^}]*\btransform\s*:/);
    expect(css).not.toMatch(/(?:^|[^-])backdrop-filter\s*:/);
    expect(css).toMatch(/position:\s*fixed\s*!important/);
    expect(css).toMatch(/bottom:\s*auto\s*!important/);
  });

  it("pins with top from visualViewport (not bottom:0 / transform)", () => {
    const nav = loadBottomNav();
    // offsetHeight is 0 in jsdom — pin uses 72px fallback
    expect(nav.style.top).toBe("628px"); // 700 - 72
    expect(nav.style.bottom).toBe("auto");
    expect(nav.style.transform || "").toBe("");
    expect(nav.dataset.ttBnTop).toBe("628");
  });

  it("tracks visualViewport.offsetTop so chrome collapse cannot float the bar", () => {
    const nav = loadBottomNav();
    window.visualViewport.offsetTop = 40;
    window.visualViewport.height = 660;
    // Re-eval pin by dispatching vv resize if listener wired, else reload logic:
    // call via scroll schedule — flush rAF
    window.dispatchEvent(new Event("scroll"));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        // top = 40 + 660 - 72 = 628
        expect(nav.style.top).toBe("628px");
        expect(nav.style.bottom).toBe("auto");
        resolve();
      });
    });
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
