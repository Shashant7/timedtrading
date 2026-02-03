#!/usr/bin/env node
/**
 * Compile shared-right-rail.js (JSX) to plain JavaScript so it can be loaded
 * without type="text/babel" in the browser.
 * Run: node scripts/compile-right-rail.js
 * Output: react-app/shared-right-rail.compiled.js
 */
const fs = require("fs");
const path = require("path");

const srcPath = path.join(__dirname, "../react-app/shared-right-rail.js");
const outPath = path.join(__dirname, "../react-app/shared-right-rail.compiled.js");

let code = fs.readFileSync(srcPath, "utf8");

try {
  const babel = require("@babel/core");
  const result = babel.transformSync(code, {
    configFile: false,
    babelrc: false,
    presets: [
      ["@babel/preset-react", { runtime: "classic" }],
    ],
  });
  if (!result || !result.code) throw new Error("Babel returned no code");
  fs.writeFileSync(outPath, result.code, "utf8");
  console.log("Wrote", outPath);
} catch (e) {
  if (e.code === "MODULE_NOT_FOUND") {
    console.error("Run: npm install @babel/core @babel/preset-react --save-dev");
    process.exit(1);
  }
  throw e;
}
