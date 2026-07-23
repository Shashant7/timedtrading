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

describe("tt-bottom-nav pin-to-bottom v6", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/today.html");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById("tt-bottom-nav")?.remove();
    document.getElementById("tt-bottom-nav-style")?.remove();
  });

  it("mounts five journey tabs and v6 vintage", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-07-23-v6");
    expect(nav.parentNode).toBe(document.body);
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
  });

  it("CSS does not use transform or backdrop-filter on .tt-bn", () => {
    loadBottomNav();
    const css = document.getElementById("tt-bottom-nav-style").textContent;
    expect(css).not.toMatch(/\.tt-bn\s*\{[^}]*transform:/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).toMatch(/position:\s*fixed\s*!important/);
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
