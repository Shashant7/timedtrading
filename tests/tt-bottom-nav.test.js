// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadBottomNav() {
  document.getElementById("tt-bottom-nav")?.remove();
  document.getElementById("tt-bottom-nav-style")?.remove();
  document.getElementById("tt-bn-admin-sheet")?.remove();
  document.getElementById("tt-mobile-scroll")?.remove();
  document.documentElement.classList.remove("tt-mobile-shell");
  document.body.classList.remove("tt-mobile-shell");
  const src = readFileSync(join(process.cwd(), "react-app/tt-bottom-nav.js"), "utf8");
  // eslint-disable-next-line no-eval
  window.eval(src);
  return document.getElementById("tt-bottom-nav");
}

function stubMobileViewport(matches = true) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: matches && String(query).includes("768"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: matches ? 390 : 1200,
  });
}

describe("tt-bottom-nav mobile scroll-shell v11", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("tt-mobile-shell");
    delete document.body.dataset.isAdmin;
    delete document.body.dataset.tier;
    delete document.body.dataset.userRole;
    try { delete window._ttIsAdmin; } catch (_) {}
    window.history.replaceState({}, "", "/today.html");
    stubMobileViewport(true);
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
    document.getElementById("tt-mobile-scroll")?.remove();
    document.documentElement.classList.remove("tt-mobile-shell");
    document.body.classList.remove("tt-mobile-shell");
  });

  it("mounts five journey tabs and v11 vintage for non-admin", () => {
    const nav = loadBottomNav();
    expect(nav).toBeTruthy();
    expect(nav.dataset.ttBnBuiltAt).toBe("2026-09-05-v11");
    expect(nav.dataset.ttBnPin).toBe("shell");
    expect(nav.parentNode).toBe(document.body);
    const labels = [...nav.querySelectorAll(".tt-bn-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Today", "Model", "Portfolio", "Insights", "Learn"]);
    expect(nav.querySelector('[data-tt-bn-id="admin"]')).toBeNull();
  });

  it("wraps page content in #tt-mobile-scroll and keeps nav a body sibling", () => {
    const main = document.createElement("main");
    main.id = "page-main";
    main.textContent = "Capital shortlist";
    document.body.appendChild(main);

    const nav = loadBottomNav();
    const shell = document.getElementById("tt-mobile-scroll");
    expect(shell).toBeTruthy();
    expect(document.documentElement.classList.contains("tt-mobile-shell")).toBe(true);
    expect(document.body.classList.contains("tt-mobile-shell")).toBe(true);
    expect(shell.contains(main)).toBe(true);
    expect(nav.parentNode).toBe(document.body);
    expect(shell.contains(nav)).toBe(false);
    // Shell before nav in DOM order (content scrolls; nav stays at flex end)
    expect(shell.nextElementSibling).toBe(nav);
  });

  it("CSS uses in-flow relative nav under the mobile shell (no transform)", () => {
    loadBottomNav();
    const css = document.getElementById("tt-bottom-nav-style").textContent;
    expect(css).not.toMatch(/\.tt-bn\s*\{[^}]*\btransform\s*:/);
    expect(css).not.toMatch(/(?:^|[^-])backdrop-filter\s*:/);
    expect(css).toMatch(/html\.tt-mobile-shell\s+\.tt-bn\s*\{[^}]*position:\s*relative\s*!important/);
    expect(css).toMatch(/#tt-mobile-scroll\.tt-mobile-scroll/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/min-height:\s*0\s*!important/);
    expect(css).toMatch(/--tt-shell-h/);
    expect(css).toMatch(/100svh/);
    expect(css).not.toMatch(/(?:height|max-height):\s*100dvh/);
  });

  it("sizes the shell to the visual viewport height", () => {
    loadBottomNav();
    expect(document.documentElement.style.getPropertyValue("--tt-shell-h")).toBe("700px");
  });

  it("does not invent fixed top/bottom inline styles on mobile shell", () => {
    const nav = loadBottomNav();
    expect(nav.style.bottom || "").toBe("");
    expect(nav.style.top || "").toBe("");
    expect(nav.style.position || "").toBe("");
    expect(nav.style.transform || "").toBe("");
    expect(nav.dataset.ttBnTop).toBeUndefined();
  });

  it("does not rewrite geometry on scroll events", () => {
    const main = document.createElement("div");
    main.id = "long-page";
    document.body.appendChild(main);
    const nav = loadBottomNav();
    window.dispatchEvent(new Event("scroll"));
    expect(nav.style.top || "").toBe("");
    expect(nav.style.bottom || "").toBe("");
    expect(nav.parentNode).toBe(document.body);
    expect(document.getElementById("tt-mobile-scroll").contains(main)).toBe(true);
  });

  it("hides via class when a text input is focused (no transform)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const nav = loadBottomNav();
    // Focus after mount — moving the input into #tt-mobile-scroll can
    // drop focus in jsdom if we focused before the shell wrapped it.
    input.focus();
    window.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(nav.classList.contains("is-keyboard-hidden")).toBe(true);
    expect(nav.dataset.ttBnState).toBe("keyboard");
    expect(nav.style.transform || "").not.toContain("200%");
  });

  it("leaves scripts and admin sheet on body (not in scroll shell)", () => {
    document.body.dataset.isAdmin = "true";
    const script = document.createElement("script");
    script.id = "page-script";
    document.body.appendChild(script);
    loadBottomNav();
    const shell = document.getElementById("tt-mobile-scroll");
    const sheet = document.getElementById("tt-bn-admin-sheet");
    expect(shell.contains(script)).toBe(false);
    expect(sheet.parentNode).toBe(document.body);
    expect(shell.contains(sheet)).toBe(false);
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
