#!/usr/bin/env bash
# scripts/check-branch-merge-state.sh
#
# Before pushing to a branch, verify no PR from that branch is already
# merged. If a PR is MERGED and its mergeCommit is on origin/main, any
# new commit here will silently miss main (the exact class of miss in
# tasks/lessons.md 2026-08-12 + 2026-08-18 recurrence).
#
# It also checks the BASE of any OPEN PR from this branch. A stacked PR
# targets a feature branch rather than main, and merging it only delivers
# anything if that base still has a route to main. On 2026-09-22 #1479
# merged cleanly into cursor/mirror-sync-false-orphans-7ffc twenty
# minutes after #1478 had already merged THAT branch into main: GitHub
# said "merged", the branch tip carried the commits, and main never saw
# them. The head-branch check below cannot catch that — the head PR is
# open and healthy right up until it lands nowhere.
#
# Usage:
#   bash scripts/check-branch-merge-state.sh
#
# Exit codes:
#   0 — branch is safe to push
#   2 — MERGED PR on this branch; cherry-pick onto a fresh branch instead
#   3 — OPEN PR whose base has already merged; retarget it at main
set -euo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ] || [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[check-branch] gh not installed; skipping merge-state check." >&2
  exit 0
fi

# Ask GitHub if a PR from this branch has already merged.
# `gh pr list --head <branch> --state merged --json ...` returns [] if
# none exists, or an array with the merged PR(s).
PR_JSON="$(gh pr list --head "$BRANCH" --state merged \
  --json number,mergedAt,mergeCommit,url --limit 3 2>/dev/null || echo '[]')"

if [ "$PR_JSON" = "[]" ] || [ -z "$PR_JSON" ]; then
  # Nothing merged from this branch. Before calling it safe, check where
  # an OPEN PR from here actually points: a base that has already merged
  # is a dead end, and merging into it delivers nothing to main.
  OPEN_JSON="$(gh pr list --head "$BRANCH" --state open \
    --json number,baseRefName,url --limit 3 2>/dev/null || echo '[]')"
  if [ "$OPEN_JSON" != "[]" ] && [ -n "$OPEN_JSON" ]; then
    DEAD=""
    while read -r num base url; do
      [ -z "$base" ] && continue
      [ "$base" = "main" ] && continue
      BASE_MERGED="$(gh pr list --head "$base" --state merged \
        --json number --limit 1 2>/dev/null || echo '[]')"
      [ "$BASE_MERGED" = "[]" ] && continue
      DEAD="${DEAD}  PR #${num} targets '${base}', which has ALREADY merged — ${url}"$'\n'
    done < <(echo "$OPEN_JSON" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
except Exception:
  d = []
for p in d:
  print(p['number'], p.get('baseRefName',''), p.get('url',''))
")
    if [ -n "$DEAD" ]; then
      echo
      echo "[check-branch] ✋ OPEN PR stacked on a base that has already merged:"
      printf '%s' "$DEAD"
      cat <<'EOM'

  Merging into that base will report success and still never reach main.

  Recovery — retarget the PR at main, or rebuild on a fresh branch:
    git fetch origin main
    git checkout -b cursor/<next-slug>-dbdd origin/main
    git cherry-pick <first-sha>^..<last-sha>
    git push -u origin cursor/<next-slug>-dbdd

EOM
      exit 3
    fi
  fi
  exit 0
fi

echo
echo "[check-branch] ✋ MERGED PR detected on branch '$BRANCH':"
echo "$PR_JSON" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
except Exception:
  d = []
for p in d:
  print(f'  PR #{p[\"number\"]} merged at {p.get(\"mergedAt\")} — {p.get(\"url\")}')
  print(f'  merge commit: {(p.get(\"mergeCommit\") or {}).get(\"oid\")}')
"
cat <<'EOM'

  Any commit pushed here after the merge will NOT reach main
  (tasks/lessons.md — check-merge-state lesson, hit 3× on 2026-08-18).

  Recovery:
    git fetch origin main
    git checkout main && git pull --ff-only origin main
    git checkout -b cursor/<next-slug>-dbdd
    git cherry-pick <sha-of-orphan-commit>
    git push -u origin cursor/<next-slug>-dbdd
    # Then open a new PR.

EOM
exit 2
