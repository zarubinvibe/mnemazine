#!/usr/bin/env bash
set -euo pipefail

ROOT="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

echo "Update touches code only. Your data stays put — inbox/, vault/, reports/"
echo "are gitignored and never pulled or rebuilt."

# git pull can fail on a local edit; say what to do instead of dying silently.
if ! git pull --ff-only; then
  echo "git pull --ff-only failed (local edits, or history diverged)." >&2
  echo "Your data is untouched. Inspect with: git status" >&2
  echo "Then: git stash (or commit) your changes, run this again, and reapply." >&2
  exit 1
fi

# install.sh now exits with its status. Code 2 = skeleton rebuilt, some optional
# capability degraded (deps intentionally skipped on update) — normal, not a stop.
# Code 1 = real failure — stop and surface it.
set +e
MNEMAZINE_FROM_SETUP=1 MNEMAZINE_SKIP_DEPS=1 bash install.sh
rc=$?
set -e
case "$rc" in
  0) : ;;
  2) echo "Some optional capabilities are degraded (deps skipped on update) — that is expected." ;;
  *) echo "install.sh failed (code $rc) — update not finished." >&2; exit "$rc" ;;
esac

npm run audit:local

echo "Mnemazine updated."
echo "Sign of life: npm run doctor"
echo "Preflight before live run: npm run preflight:live"
echo "Run from chat: Mnemazine"
echo "Run from terminal: mnemazine"
