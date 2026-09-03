#!/usr/bin/env bash
# CI helper: npm install with retries.
#
# package-lock.json is gitignored, so every CI run does a floating resolve.
# Transient registry 404s (e.g. electron-to-chromium publishing race) used to
# red every deploy workflow on main. Retry a few times before giving up.
# Pin fragile transitive deps via package.json "overrides" as well.
set -euo pipefail

IGNORE_SCRIPTS=0
if [[ "${1:-}" == "--ignore-scripts" ]]; then
  IGNORE_SCRIPTS=1
fi

_install_once() {
  if [[ "$IGNORE_SCRIPTS" == "1" ]]; then
    npm install --no-audit --no-fund --ignore-scripts
  else
    npm install --no-audit --no-fund
  fi
}

attempt=1
max=4
while true; do
  if _install_once; then
    break
  fi
  if [[ "$attempt" -ge "$max" ]]; then
    echo "::error::npm install failed after ${max} attempts"
    exit 1
  fi
  sleep_s=$(( attempt * 8 ))
  echo "npm install failed (attempt ${attempt}/${max}); retrying in ${sleep_s}s…"
  sleep "$sleep_s"
  attempt=$(( attempt + 1 ))
  rm -rf node_modules
done

# 2026-06-11 — npm's optional-deps bug (npm/cli#4828) intermittently skips
# platform-specific binaries (e.g. @rolldown/binding-linux-x64-gnu), which
# kills vitest at startup. Verify; one clean reinstall self-heals.
if ! npm ls @rolldown/binding-linux-x64-gnu >/dev/null 2>&1; then
  echo "rolldown native binding missing — clean reinstall"
  rm -rf node_modules
  _install_once
fi
