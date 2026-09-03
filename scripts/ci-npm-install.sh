#!/usr/bin/env bash
# CI npm install without a committed lockfile.
#
# npm 10.9.x (Node 22 on GHA) crashes arborist with
#   Cannot read properties of null (reading 'edgesOut')
# when a just-published vitest major/patch skews optional peers
# (npm/cli#9787). Pin vitest in package.json AND pass
# --legacy-peer-deps; retry once if the first walk still dies.
set -euo pipefail

args=(--no-audit --no-fund --legacy-peer-deps)
while [[ $# -gt 0 ]]; do
  args+=("$1")
  shift
done

install() {
  npm install "${args[@]}"
}

if ! install; then
  echo "npm install failed — wiping node_modules and retrying (arborist edgesOut / registry race)"
  rm -rf node_modules
  install
fi

# 2026-06-11 — npm optional-deps bug (npm/cli#4828) can skip the
# platform-specific rolldown binding and then kill vitest at startup.
if ! npm ls @rolldown/binding-linux-x64-gnu >/dev/null 2>&1; then
  echo "rolldown native binding missing — clean reinstall"
  rm -rf node_modules
  install
fi
