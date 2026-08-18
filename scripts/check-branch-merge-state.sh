#!/usr/bin/env bash
# scripts/check-branch-merge-state.sh
#
# Before pushing to a branch, verify no PR from that branch is already
# merged. If a PR is MERGED and its mergeCommit is on origin/main, any
# new commit here will silently miss main (the exact class of miss in
# tasks/lessons.md 2026-08-12 + 2026-08-18 recurrence).
#
# Usage:
#   bash scripts/check-branch-merge-state.sh
#
# Exit codes:
#   0 — branch is safe to push (no merged PR on it, or PR is open)
#   2 — MERGED PR found; refuse. Cherry-pick onto a fresh branch instead.
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
