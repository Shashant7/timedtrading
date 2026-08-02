// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadBottomNav() {
  document.getElementById("tt-bottom-nav")?.remove();
  document.getElementById("tt-bottom-nav-style")?.remove();
  document.getElementById("tt-bn-admin-sheet")?.remove();
  const src = readFileSync(join(process.cwd(), "react-app/tt-bottom-nav.js"), "utf8");
  // eslint-disable-next-line no-eval
  window.eval(src);
  return document.getElementById("tt-bottom-nav");
}

describe("tt-bottom-nav pin-to-bottom v8", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.isAdmin;
    delete document.body.dataset.tier;
    delete document.body.dataset.userRole;
    try { delete window._ttIsAdmin; } catch (_) {}
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
    document.getElementById("tt-bn-admin-sheet")?.remove();
  });

  it("mounts five journey tabs and v9 vintage for non-admin", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-08-02-v9");
    expect(nav.parentNode).toBe(document.body);
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
    expect(nav.querySelector('[data-tt-bn-id="admin"]')).toBeNull();
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

  it("adds Admin tab for admin users and opens bottom sheet", () => {
    document.body.dataset.isAdmin = "true";
    const nav = loadBottomNav();
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn", "Admin"]);
    expect(nav.dataset.ttBnAdmin).toBe("1");
    expect(nav.querySelector(".tt-bn-row").classList.contains("tt-bn-row--admin")).toBe(true);

    const adminBtn = nav.querySelector('[data-tt-bn-id="admin"]');
    expect(adminBtn).toBeTruthy();
    expect(adminBtn.tagName).toBe("BUTTON");

    adminBtn.click();
    const sheet = document.getElementById("tt-bn-admin-sheet");
    expect(sheet).toBeTruthy();
    expect(sheet.classList.contains("open")).toBe(true);
    expect(adminBtn.getAttribute("aria-expanded")).toBe("true");

    const linkTexts = [...sheet.querySelectorAll(".tt-bn-sheet-link")].map((a) => a.textContent);
    expect(linkTexts).toContain("System Intelligence");
    expect(linkTexts).toContain("Trade Autopsy");
    expect(linkTexts).toContain("Screener");

    sheet.querySelector(".tt-bn-sheet-backdrop").click();
    expect(sheet.classList.contains("open")).toBe(false);

    adminBtn.click();
    expect(sheet.classList.contains("open")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sheet.classList.contains("open")).toBe(false);
  });

  it("injects Admin tab after tt-auth-bootstrap-updated", () => {
    const nav = loadBottomNav();
    expect(nav.querySelector('[data-tt-bn-id="admin"]')).toBeNull();

    document.body.dataset.isAdmin = "true";
    Object.defineProperty(window, "_ttIsAdmin", {
      configurable: true,
      get() { return true; },
    });
    window.dispatchEvent(new Event("tt-auth-bootstrap-updated"));

    expect(nav.querySelector('[data-tt-bn-id="admin"]')).toBeTruthy();
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels[labels.length - 1]).toBe("Admin");
  });
});
