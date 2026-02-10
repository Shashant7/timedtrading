#!/usr/bin/env node
/**
 * Patch DashboardWelcomeModal: replace steps 2–4 with new content and remove steps 5+.
 * Run from repo root: node scripts/patch-guide-steps.js
 */
const fs = require("fs");
const path = "react-app/index-react.html";
let s = fs.readFileSync(path, "utf8");

const curly = "\u2019";

// Step 2: "Save tickers you want to follow"
const step2 = `          {
            title: "Save tickers you want to follow",
            content: (
              <div className="space-y-4">
                <p className="text-[#d1d5db]">
                  You can save any ticker to a personal list so you can quickly filter to them and follow their lanes.
                </p>
                <p className="text-sm text-[#6b7280]">
                  Use the <strong className="text-white">Saved</strong> filter to show only your saved tickers. Toggle the star on any card to add or remove it from your saved list.
                </p>
              </div>
            ),
          },
`;

// Step 3: "Browse universe and add to saved" (uses universeList, savedTickers, toggleSavedTicker)
const step3 = "          {\n" +
"            title: \"Browse our ticker universe\",\n" +
"            content: (\n" +
"              <div className=\"space-y-4\">\n" +
"                <p className=\"text-[#d1d5db]\">\n" +
"                  Scroll the list below. Tap the star next to any ticker to add it to your saved list.\n" +
"                </p>\n" +
"                <div className=\"max-h-64 overflow-y-auto border border-white/[0.08] rounded-lg p-2 space-y-0.5 bg-white/[0.02]\">\n" +
"                  {universeList.length === 0 ? (\n" +
"                    <p className=\"text-sm text-[#6b7280] py-4 text-center\">No tickers loaded yet. Close and refresh the dashboard.</p>\n" +
"                  ) : (\n" +
"                    universeList.map((t) => {\n" +
"                      const sym = t && (t.ticker != null) ? t.ticker : String(t);\n" +
"                      const name = t && typeof t === \"object\" ? (t.name || t.description || \"\") : \"\";\n" +
"                      const saved = savedTickers && savedTickers.has ? savedTickers.has(sym) : false;\n" +
"                      return (\n" +
"                        <div key={sym} className=\"flex items-center justify-between py-2 px-2 rounded hover:bg-white/[0.06]\">\n" +
"                          <span className=\"text-sm text-white font-mono shrink-0\">{sym}</span>\n" +
"                          {name ? <span className=\"text-xs text-[#6b7280] truncate flex-1 mx-2\">{name}</span> : null}\n" +
"                          {toggleSavedTicker ? (\n" +
"                            <button\n" +
"                              type=\"button\"\n" +
"                              onClick={() => toggleSavedTicker(sym)}\n" +
"                              className={\"shrink-0 text-[14px] transition-colors \" + (saved ? \"text-amber-400\" : \"text-[#4b5563] hover:text-amber-300\")}\n" +
"                              title={saved ? \"Remove from Saved\" : \"Add to Saved\"}\n" +
"                            >\n" +
"                              {saved ? \"★\" : \"☆\"}\n" +
"                            </button>\n" +
"                          ) : (\n" +
"                            <span className=\"text-[#4b5563] text-sm\">☆</span>\n" +
"                          )}\n" +
"                        </div>\n" +
"                      );\n" +
"                    })\n" +
"                  )}\n" +
"                </div>\n" +
"              </div>\n" +
"            ),\n" +
"          },\n";

// Step 4: Confirmation / Close (no trailing comma; next bit in "after" is ", { step 5")
const step4 =
  "          {\n" +
  '            title: "You\'re all set",\n' +
  "            content: (\n" +
  '              <div className="space-y-4">\n' +
  '                <p className="text-[#d1d5db]">\n' +
  '                  Use the <strong className="text-white">Dashboard</strong> to follow lanes and the <strong className="text-white">Trades</strong> page to review open and closed trades. Close this guide to continue.\n' +
  "                </p>\n" +
  "              </div>\n" +
  "            ),\n" +
  "          }\n";

// Find and replace step 2 (Lane meanings) through step 4 (Viewport) with new steps 2, 3, 4
const startStep2 = s.indexOf('title: "Lane meanings (quick cheat sheet)"');
if (startStep2 === -1) {
  console.error("Could not find step 2 (Lane meanings)");
  process.exit(1);
}
// Start of block: the "          {" before "title: \"Lane meanings\""
const blockStart = s.lastIndexOf("          {", startStep2);

const startStep5 = s.indexOf('title: "Prime Setups ⭐"');
if (startStep5 === -1) {
  console.error("Could not find step 5 (Prime Setups)");
  process.exit(1);
}
// End of step 4: keep the comma so "after" is ",\n          { step 5 ..."
const step4Closer = s.lastIndexOf("          },", startStep5);
const blockEnd = step4Closer + "          }".length; // comma starts here

const before = s.slice(0, blockStart);
const after = s.slice(blockEnd);
const newMiddle = step2 + step3 + step4;
s = before + newMiddle + after;

// Remove steps 5 through end of array: from "          },{ title: Prime Setups" to "        ];"
const marker = "        ];\n\n        // Keep onboarding simple";
const idxRemove = s.indexOf(",          {\n            title: \"Prime Setups ⭐\"");
const idxMarker = s.indexOf(marker);
if (idxRemove !== -1 && idxMarker !== -1 && idxRemove < idxMarker) {
  const endMarker = marker + ": show only the first 3 lane-first steps.\n";
  const idxEndMarker = s.indexOf(endMarker);
  if (idxEndMarker !== -1) {
    s = s.slice(0, idxRemove) + endMarker + s.slice(idxEndMarker + endMarker.length);
  }
}

// Show 4 steps instead of 3
s = s.replace(/allSteps\.slice\(0, 3\)/g, "allSteps.slice(0, 4)");

// Update comment
s = s.replace(
  "// Keep onboarding simple: show only the first 3 lane-first steps.",
  "// Guide: 4 steps (dashboard, save tickers, universe list, confirm)."
);

fs.writeFileSync(path, s);
console.log("Patched Guide steps and slice.");
