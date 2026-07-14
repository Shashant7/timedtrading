#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const babel = require("@babel/core");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "react-app");
const outputDir = path.join(repoRoot, "react-app-dist");
const tailwindInputPath = path.join(sourceDir, "tailwind.input.css");
const outputCssPath = path.join(outputDir, "tailwind.generated.css");

function fail(message) {
  console.error(`[build-frontend] ${message}`);
  process.exit(1);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePosix(fromPath, toPath) {
  return toPosix(path.relative(path.dirname(fromPath), toPath) || ".");
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 10);
}

function removeOutputDir() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDir(outputDir);
}

function shouldSkipCopy(relativePath) {
  return (
    relativePath === "index-react.source.html" ||
    relativePath === "tailwind.input.css" ||
    relativePath === "shared-bubble-chart.js" ||
    // 2026-06-10 — babel-input source for shared-right-rail.compiled.js;
    // 1.1MB, never linked from HTML. Copying it to dist only inflated
    // every deploy upload.
    relativePath === "shared-right-rail.js" ||
    /^index-react\.compiled\.[a-f0-9]+\.js$/.test(relativePath)
  );
}

function copyStaticTree(srcDir, destDir, prefix = "") {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
    if (shouldSkipCopy(relPath)) continue;

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      ensureDir(destPath);
      copyStaticTree(srcPath, destPath, relPath);
      continue;
    }

    ensureDir(path.dirname(destPath));
    fs.copyFileSync(srcPath, destPath);

    // 2026-06-01 — Parse-check every .js file we copy to dist so silent
    // browser-side SyntaxErrors can't ship again. Background: PR #413's
    // tt-bottom-nav.js had inner backticks inside a CSS template literal
    // that terminated the literal early and threw SyntaxError on every
    // page load in every browser for ~2 weeks. babel/esbuild accepted
    // the file (more forgiving parser) so the bug wasn't caught by the
    // existing transpile step. new Function(src) uses the V8 parser
    // (same family as browsers) and would have caught it instantly.
    // Skip non-.js files; skip .compiled.js outputs (they're generated
    // by the babel transform we already trust); skip .min/.bundle files
    // (which often legitimately contain non-standard parser tokens).
    // 2026-06-01 — Files that are babel-input sources (contain JSX, get
    // transpiled to .compiled.js outputs). Loading these directly via
    // <script> would fail in any browser; they're never linked from
    // html, only their .compiled.js outputs are. Skip the parse check.
    const BABEL_INPUT_SOURCES = new Set([
      "shared-right-rail.js",
      "shared-bubble-chart.js",
      "investor-panel.js",   // contains JSX
    ]);

    if (entry.name.endsWith(".js")
        && !entry.name.endsWith(".compiled.js")
        && !entry.name.endsWith(".min.js")
        && !entry.name.endsWith(".bundle.js")
        && entry.name !== "_worker.js"               // CF Pages worker — runs ESM server-side
        && !entry.name.startsWith("_")               // underscore-prefixed = framework internal
        && !BABEL_INPUT_SOURCES.has(entry.name)) {
      try {
        const src = fs.readFileSync(srcPath, "utf8");
        // Skip files that are clearly ES modules (import/export at top
        // level). Those run as <script type="module"> in the browser
        // and the module parser handles them correctly there. Our
        // classic-script parse-check only matters for files loaded
        // via <script> (no type=module).
        const looksLikeEsm = /^\s*(?:import\s|export\s|export\s*\{)/m.test(src);
        if (looksLikeEsm) continue;
        new Function(src);
      } catch (e) {
        // Fail the build LOUDLY. The previous silent ship cost the
        // operator 3+ session round-trips diagnosing missing UI.
        const line = e.lineNumber || (e.stack || "").match(/<anonymous>:(\d+)/)?.[1] || "?";
        fail(`PARSE ERROR in ${relativePosix(repoRoot, srcPath)} (~line ${line}): ${e.message}\n  This script would silently fail to load in every browser. Fix before deploy.`);
      }
    }
  }
}

function compileSharedRightRail() {
  compileSharedScript("shared-right-rail.js", "shared-right-rail.compiled.js");
}

function compileSharedBubbleChart() {
  // P0.B.1 — extracted from index-react.source.html. Loaded by today.html
  // (and eventually active-trader.html / investor.html after Phase 4 split).
  // Has JSX (BubbleChart React component) so needs babel transform.
  compileSharedScript("shared-bubble-chart.js", "tt-bubble-map-0714.compiled.js");
}

function compileSharedScript(srcName, destName) {
  const srcPath = path.join(sourceDir, srcName);
  const destPath = path.join(outputDir, destName);
  const code = fs.readFileSync(srcPath, "utf8");
  const result = babel.transformSync(code, {
    configFile: false,
    babelrc: false,
    presets: [[require.resolve("@babel/preset-react"), { runtime: "classic" }]],
    comments: false,
    compact: false,
    sourceMaps: false,
  });

  if (!result?.code) {
    fail(`Babel transpilation returned no code for ${srcName}`);
  }

  fs.writeFileSync(
    destPath,
    `// Generated by scripts/build-frontend.js - do not edit directly\n${result.code}\n`,
    "utf8",
  );
}

function buildTailwindCss() {
  const cli = path.join(
    repoRoot,
    "node_modules",
    "@tailwindcss",
    "cli",
    "dist",
    "index.mjs",
  );

  if (!fs.existsSync(cli)) {
    fail("Missing Tailwind CLI. Run `npm install` first.");
  }

  ensureDir(path.dirname(outputCssPath));
  const result = spawnSync(
    process.execPath,
    [cli, "-i", tailwindInputPath, "-o", outputCssPath, "--minify"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (result.status !== 0) {
    fail(
      `Tailwind build failed.\n${result.stdout || ""}\n${result.stderr || ""}`.trim(),
    );
  }
}

function replaceReactBuilds(html) {
  return html
    .replace(/react\.development\.js/g, "react.production.min.js")
    .replace(/react-dom\.development\.js/g, "react-dom.production.min.js");
}

// 2026-06-10 — PERF: rewrite third-party CDN script URLs to the vendored
// copies in react-app/vendor/ (committed to the repo; versions pinned in
// vendor/README.md). Why:
//   1) unpkg/jsdelivr add 2 extra TLS handshakes before first render and
//      are render-blocking in <head>;
//   2) same-origin assets ride the immutable ?v= cache set by _worker.js,
//      so page switches load them from disk/memory cache with zero
//      revalidation requests;
//   3) no third-party outage can blank the app.
// The `?v=vendor` placeholder gets restamped to the BUILD_MARKER by
// rewriteSharedScriptCacheBust later in the pipeline.
// index-react.source.html is excluded by the caller — its inline
// Recharts fallback-loader logic assumes CDN URLs.
const CDN_VENDOR_MAP = [
  [/https:\/\/unpkg\.com\/react@18(?:\.\d+\.\d+)?\/umd\/react\.production\.min\.js/g, "/vendor/react.production.min.js?v=vendor"],
  [/https:\/\/unpkg\.com\/react-dom@18(?:\.\d+\.\d+)?\/umd\/react-dom\.production\.min\.js/g, "/vendor/react-dom.production.min.js?v=vendor"],
  [/https:\/\/unpkg\.com\/lightweight-charts@4\.1\.1\/dist\/lightweight-charts\.standalone\.production\.js/g, "/vendor/lightweight-charts.standalone.production.js?v=vendor"],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/marked(?:@[\d.]+)?\/marked\.min\.js/g, "/vendor/marked.min.js?v=vendor"],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/dompurify@3(?:\.\d+\.\d+)?\/dist\/purify\.min\.js/g, "/vendor/purify.min.js?v=vendor"],
  [/https:\/\/unpkg\.com\/prop-types@15(?:\.\d+\.\d+)?\/prop-types\.min\.js/g, "/vendor/prop-types.min.js?v=vendor"],
  [/https:\/\/unpkg\.com\/htm@3(?:\.\d+\.\d+)?\/dist\/htm\.umd\.js/g, "/vendor/htm.umd.js?v=vendor"],
];

function replaceCdnWithVendor(html) {
  let next = html;
  for (const [pattern, replacement] of CDN_VENDOR_MAP) {
    next = next.replace(pattern, replacement);
  }
  // Vendored same-origin scripts don't need crossorigin.
  next = next.replace(/(<script[^>]*src="\/vendor\/[^"]*"[^>]*?)\s+crossorigin(?=[\s>])/g, "$1");
  next = next.replace(/(<script[^>]*)\bcrossorigin\s+(src="\/vendor\/)/g, "$1$2");
  return next;
}

// 2026-06-10 — PERF: every external <script src> gets `defer`. The journey
// pages shipped ~17 SYNCHRONOUS scripts in <head> (882KB rail bundle, React,
// lightweight-charts, ...) — the browser could not paint anything until all
// of them downloaded AND executed. `defer` downloads in parallel with HTML
// parsing and executes in DOCUMENT ORDER after parse, so the existing
// dependency chain (react → tt-live-data → shared-* → page.compiled.js)
// is preserved exactly. Inline scripts are untouched (they cannot defer).
// Callers exclude pages whose INLINE scripts reference library globals at
// parse time (index-react.source.html, proof.html).
function addDeferToExternalScripts(html) {
  return html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/g, (tag) => {
    if (/\bdefer\b|\basync\b|type\s*=\s*["']module["']/.test(tag)) return tag;
    return tag.replace(/^<script\b/, "<script defer");
  });
}

function replaceTailwindRuntime(html, outputHtmlPath) {
  const cssRelPath = relativePosix(outputHtmlPath, outputCssPath);
  let next = html.replace(
    /\s*<script[^>]*src="https:\/\/cdn\.tailwindcss\.com"[^>]*><\/script>\s*/m,
    `\n    <link rel="stylesheet" href="${cssRelPath}" />\n`,
  );

  next = next.replace(
    /\s*<script>\s*tailwind\.config\s*=\s*\{[\s\S]*?<\/script>\s*/m,
    "\n",
  );

  return next;
}

function removeBabelStandalone(html) {
  return html.replace(
    /\s*<script[^>]*src="https:\/\/unpkg\.com\/@babel\/standalone\/babel\.min\.js"[^>]*><\/script>\s*/m,
    "\n",
  );
}

function buildCompiledScriptName(outputHtmlPath, sourceCode) {
  // Stable filename (no content hash). Pages auto-deploy reliably updates
  // content at stable asset paths (e.g. shared-right-rail.compiled.js) but
  // intermittently fails to publish *new* hashed asset paths to the edge,
  // serving 500 / SPA-HTML fallback for fresh hashes. Cache-bust at the
  // <script src="...?v=…"> query layer instead.
  // Touch outputHtmlPath/sourceCode reads to silence unused-arg warnings
  // without changing behaviour.
  void sourceCode;
  const baseName = path.basename(outputHtmlPath, ".html");
  return `${baseName}.compiled.js`;
}

// Build-time marker. Appended to every emitted asset so each deploy has
// a unique SHA256, which forces Cloudflare Pages to upload fresh blobs
// rather than reusing its content-addressed cache. Pages's cache has
// historically gone corrupt (manifest entry present, blob missing →
// HTTP 500 on the asset), and that mode is hard to recover from
// without bumping content hashes. A constant marker per build run
// guarantees we never hit that mode silently.
const BUILD_MARKER = `cache-bust:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;

// 2026-05-31 — Shared script cache-bust rewriter. The HTML pages
// reference shared scripts (auth-gate.js, tt-activity-strip.js,
// tt-nav-extras.js, shared-right-rail.compiled.js, etc.) with a
// hard-coded `?v=<date-tag>` query string that was bumped MANUALLY
// when those files changed. We kept forgetting (e.g. PR #397
// shipped sticky-header + Switch-account changes that landed in the
// JS but the HTML kept `tt-activity-strip.js?v=20260528a` and
// `auth-gate.js?v=20260516a` from 4+ days earlier — browsers served
// stale cached copies and the user reported "I merged but I don't
// see the change"). This pass rewrites the `?v=` value on every
// .js / .compiled.js reference to the current BUILD_MARKER's
// timestamp, so every deploy automatically busts every shared
// bundle's cache. Files: auth-gate, tt-*, shared-*, ds-components,
// ticker-spider-chart, investor-panel, trades-performance,
// service-worker. (Pages adds its own ETag on top, but the URL-
// level change is what forces a fresh fetch on the browser side.)
// iOS Safari reads apple-touch-icon from the initial HTML <head> — not from
// JS-injected links (auth-gate runs deferred). Stamp these at build time on
// every page so Add to Home Screen shows the Timed Trading logo.
function injectPwaHeadTags(html) {
  if (/rel=["']apple-touch-icon["']/i.test(html)) return html;
  const block = [
    '    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    '    <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/apple-touch-icon.png" />',
    '    <link rel="manifest" href="/site.webmanifest" />',
    '    <meta name="theme-color" content="#000000" />',
    '    <meta name="apple-mobile-web-app-capable" content="yes" />',
    '    <meta name="apple-mobile-web-app-title" content="Timed Trading" />',
    '    <meta name="mobile-web-app-capable" content="yes" />',
  ].join("\n");
  return html.replace(/<head([^>]*)>/i, `<head$1>\n${block}`);
}

function rewriteSharedScriptCacheBust(html) {
  const stamp = BUILD_MARKER.split(":")[1] || String(Date.now());
  // Match `<script src="<name>.js?v=<existing>">` and same for .compiled.js.
  // Captures the script path so we can rewrite only the query string.
  let next = html.replace(
    /(<script[^>]+src=["'])([^"'?]+\.(?:compiled\.)?js)\?v=[^"']+(["'])/g,
    `$1$2?v=${stamp}$3`,
  );
  // 2026-06-10 — same treatment for same-origin stylesheets. tt-tokens.css
  // was bumped MANUALLY (`?v=20260610-verda4`) and tailwind.generated.css
  // shipped UNVERSIONED — both repeatedly served stale after deploys.
  // Stamp every local .css link (with or without an existing ?v=) so they
  // also qualify for the immutable cache set by _worker.js. External
  // stylesheets (https://fonts.googleapis.com/...) are left alone.
  next = next.replace(
    /(<link[^>]+href=["'])(?!https?:\/\/)([^"'?]+\.css)(?:\?v=[^"']*)?(["'])/g,
    `$1$2?v=${stamp}$3`,
  );
  return next;
}

// Pages whose INLINE scripts call library globals (React, LightweightCharts)
// at parse time — adding `defer` to their external scripts would break that
// ordering, and index-react's inline Recharts fallback loader assumes CDN
// URLs. Keep them on the legacy sync/CDN path.
const PERF_TRANSFORM_EXCLUDED_SOURCES = new Set([
  "index-react.source.html",
  "proof.html",
]);

function compileHtmlSource(sourceHtmlPath, outputHtmlPath) {
  let html = fs.readFileSync(sourceHtmlPath, "utf8");
  const sourceName = path.basename(sourceHtmlPath);
  const applyPerfTransforms = !PERF_TRANSFORM_EXCLUDED_SOURCES.has(sourceName);

  html = replaceReactBuilds(html);
  html = injectPwaHeadTags(html);
  html = replaceTailwindRuntime(html, outputHtmlPath);
  html = removeBabelStandalone(html);
  if (applyPerfTransforms) {
    html = replaceCdnWithVendor(html);
    html = addDeferToExternalScripts(html);
  }
  html = rewriteSharedScriptCacheBust(html);

  const babelMatch = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/m);
  if (!babelMatch) {
    fs.writeFileSync(outputHtmlPath, html, "utf8");
    return;
  }

  const jsxSource = babelMatch[1];
  const transpiled = babel.transformSync(jsxSource, {
    presets: [[require.resolve("@babel/preset-react"), { runtime: "classic" }]],
    comments: false,
    compact: false,
    sourceMaps: false,
    babelrc: false,
    configFile: false,
  });

  if (!transpiled?.code) {
    fail(`Babel transpilation returned no code for ${sourceHtmlPath}`);
  }

  const compiledFileName = buildCompiledScriptName(outputHtmlPath, jsxSource);
  const compiledFilePath = path.join(path.dirname(outputHtmlPath), compiledFileName);
  const compiledScriptRel = toPosix(path.basename(compiledFilePath));

  fs.writeFileSync(
    compiledFilePath,
    `// Generated by scripts/build-frontend.js - do not edit directly\n${transpiled.code}\n// ${BUILD_MARKER}\n`,
    "utf8",
  );

  html = html.replace(
    /<script type="text\/babel">[\s\S]*?<\/script>/m,
    `<script${applyPerfTransforms ? " defer" : ""} src="${compiledScriptRel}?v=${BUILD_MARKER.split(":")[1] || Date.now()}"></script>`,
  );

  fs.writeFileSync(outputHtmlPath, html, "utf8");
}

function buildHtmlPages() {
  const htmlFiles = [];

  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }
      if (entry.name.endsWith(".html")) {
        htmlFiles.push(relPath);
      }
    }
  }

  walk(sourceDir);

  for (const relPath of htmlFiles) {
    // D4 retirement (2026-06-11, operator-approved): index-react.html now
    // ships as the redirect stub in react-app/index-react.html. The legacy
    // monolith source (index-react.source.html) stays in-repo as the
    // component-logic reference but is NO LONGER compiled or shipped.
    if (relPath === "index-react.source.html") continue;

    const sourceHtmlPath = path.join(sourceDir, relPath);
    const outputHtmlPath = path.join(outputDir, relPath);

    ensureDir(path.dirname(outputHtmlPath));
    compileHtmlSource(sourceHtmlPath, outputHtmlPath);
  }
}

function appendBuildMarkerToAllAssets() {
  // Append a unique build marker to every JS / HTML asset under react-app-dist.
  // Skip _worker.js (Pages-internal) and anything in node_modules-style nested dirs.
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const name = entry.name;
      if (name === "_worker.js") continue;
      if (name.endsWith(".js")) {
        fs.appendFileSync(abs, `\n// ${BUILD_MARKER}\n`);
      } else if (name.endsWith(".html")) {
        fs.appendFileSync(abs, `\n<!-- ${BUILD_MARKER} -->\n`);
      }
    }
  }
  walk(outputDir);
}

function ensurePwaIcons() {
  const iconNames = ["apple-touch-icon.png", "icon-192.png", "icon-512.png"];
  const missing = iconNames.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
  if (missing.length === 0) return;
  try {
    const iconGen = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "generate-pwa-icons.js")], {
      stdio: "inherit",
    });
    if (iconGen.status !== 0) {
      console.warn("[build-frontend] generate-pwa-icons failed — continuing with existing icons");
    }
  } catch (e) {
    console.warn("[build-frontend] generate-pwa-icons skipped:", e?.message || e);
  }
}

function main() {
  removeOutputDir();
  ensurePwaIcons();
  copyStaticTree(sourceDir, outputDir);
  compileSharedRightRail();
  compileSharedBubbleChart();
  buildTailwindCss();
  buildHtmlPages();
  appendBuildMarkerToAllAssets();

  console.log(`Built frontend into ${path.relative(repoRoot, outputDir)}`);
  console.log(`Build marker: ${BUILD_MARKER}`);
}

main();
