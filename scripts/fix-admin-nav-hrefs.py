#!/usr/bin/env python3
"""
2026-05-28 — Replace outdated admin nav href targets.

Three replacements per page (desktop + mobile blocks):
  href="index-react.html" ... >Analysis<           → /today.html
  href="simulation-dashboard.html" ... >Trades<    → /portfolio.html
  href="index-react.html" ... title="Restart tour" → /today.html

Only touches anchor tags whose visible TEXT or title matches above. Leaves
self-references and other index-react.html links untouched.
"""
import re, sys
from pathlib import Path

PAGES = [
    "admin-clients", "screener", "ticker-management", "system-intelligence",
    "trade-autopsy", "calibration", "model-dashboard", "simulation-dashboard",
]
ROOT = Path(__file__).parent.parent / "react-app"

# Patterns intentionally anchor on the link TEXT or title attribute so we don't
# touch unrelated anchors that happen to use the same hrefs.
REPLACEMENTS = [
    # Desktop + mobile Analysis link → /today.html
    # Use [^<]*? (non-greedy, no '<') as the attribute span so JSX arrow
    # functions like `onClick={() => setMobileMenuOpen(false)}` — which
    # contain '>' inside the '=>' — don't break the match.
    (re.compile(r'(<a\s+href=")index-react\.html("[^<]*?>)Analysis(</a>)'),
     r'\1/today.html\2Analysis\3'),
    # Desktop + mobile Trades link → /portfolio.html
    (re.compile(r'(<a\s+href=")simulation-dashboard\.html("[^<]*?>)Trades(</a>)'),
     r'\1/portfolio.html\2Trades\3'),
    # Desktop + mobile Tour button → /today.html
    (re.compile(r'(<a\s+href=")index-react\.html("[^<]*?title="Restart tour"[^<]*?>)Tour(</a>)'),
     r'\1/today.html\2Tour\3'),
    # Brand-logo link (top-left of nav). The "flex items-center gap-2
    # no-underline shrink-0" className is the brand-wrap pattern used
    # across all admin pages. Point it to /today.html.
    (re.compile(r'(<a\s+href=")index-react\.html("\s+className="flex\s+items-center\s+gap-2\s+no-underline\s+shrink-0")'),
     r'\1/today.html\2'),
    # Desktop + mobile Active Trader link → /active-trader.html
    (re.compile(r'(<a\s+href=")index-react\.html("[^<]*?>)Active Trader(</a>)'),
     r'\1/active-trader.html\2Active Trader\3'),
]

total_files = 0
total_replacements = 0
for name in PAGES:
    p = ROOT / f"{name}.html"
    if not p.exists():
        print(f"  SKIP {name}.html (not found)", file=sys.stderr)
        continue
    src = p.read_text()
    new = src
    page_count = 0
    for pat, repl in REPLACEMENTS:
        new, n = pat.subn(repl, new)
        page_count += n
    if new != src:
        p.write_text(new)
        total_files += 1
        total_replacements += page_count
        print(f"  ✓ {name}.html — {page_count} hrefs updated")
    else:
        print(f"  · {name}.html — no changes")

print(f"\nTotal: {total_files} files / {total_replacements} hrefs")
