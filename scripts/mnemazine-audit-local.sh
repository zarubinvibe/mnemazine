#!/usr/bin/env bash
set -euo pipefail

ROOT="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

while IFS= read -r -d '' file; do bash -n "$file"; done < <(find . -maxdepth 2 -type f \( -name '*.sh' -o -name 'install.sh' -o -name 'setup.sh' \) -not -path './node_modules/*' -print0)
while IFS= read -r -d '' file; do node --check "$file"; done < <(find scripts tests -type f -name '*.mjs' -print0)

npm run selftest:security
npm audit --audit-level=moderate
if [ "${MNEMAZINE_AUDIT_SKIP_PUBLIC_RELEASE:-0}" = "1" ]; then
  echo "audit:local public-release scan skipped; run bash scripts/check-public-release.sh before public release"
else
  # Прямой вызов, а не npm-скрипт: гейт приватности со списком PRIVATE_MARKERS в публичную сборку не
  # уходит (public-release.json:exclude), и публичный package.json на него ссылаться не может - issue #6, п.4.
  bash "$(dirname "$0")/check-public-release.sh"
fi

# Pick a scanner. Prefer ripgrep; fall back to POSIX grep -E so the scan still
# runs on machines without rg. A missing scanner must HARD-FAIL, never silently
# pass — same rule as check-public-release.sh:18-26. Without this: `rg` absent
# returns 127 inside the `if`, `set -euo pipefail` does NOT fire in that context,
# the body is skipped, and the script printed "audit:local passed" WITHOUT scanning.
if command -v rg >/dev/null 2>&1; then
  SCANNER=rg
elif command -v grep >/dev/null 2>&1; then
  SCANNER=grep
else
  echo "audit:local errored: neither 'rg' nor 'grep' is available to scan." >&2
  exit 1
fi

DANGEROUS_PATTERN='StrictHostKeyChecking=(no|accept-new)|root@[a-z0-9][A-Za-z0-9._-]*|(^|[^A-Za-z0-9_])--dangerously-skip-permissions([^A-Za-z0-9_]|$)|https?://[^/[:space:]'\''"]+@'
# `.*` (not `[^\n]*`): both scanners are line-based, so this matches identically,
# and it avoids grep-ERE reading `[^\n]` as the class "not backslash or n".
METADATA_PATTERN='fetch\(.*(169\.254\.169\.254|metadata\.google|metadata\.azure)'

scan_dangerous() {
  if [ "$SCANNER" = rg ]; then
    rg -n --glob '!node_modules/**' --glob '!.git/**' --glob '!.mnemazine/**' --glob '!scripts/mnemazine-audit-local.sh' "$DANGEROUS_PATTERN" .
  else
    grep -rEn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.mnemazine --exclude=mnemazine-audit-local.sh "$DANGEROUS_PATTERN" .
  fi
}
status=0; scan_dangerous || status=$?
if [ "$status" -eq 0 ]; then
  echo "audit:local failed: dangerous flag or credential URL pattern found." >&2
  exit 1
elif [ "$status" -ge 2 ]; then
  echo "audit:local errored: scanner '$SCANNER' failed (exit $status) on dangerous-pattern scan." >&2
  exit 1
fi

scan_metadata() {
  if [ "$SCANNER" = rg ]; then
    rg -n "$METADATA_PATTERN" scripts webapp
  else
    grep -rEn "$METADATA_PATTERN" scripts webapp
  fi
}
status=0; scan_metadata || status=$?
if [ "$status" -eq 0 ]; then
  echo "audit:local failed: metadata/private fetch pattern found." >&2
  exit 1
elif [ "$status" -ge 2 ]; then
  echo "audit:local errored: scanner '$SCANNER' failed (exit $status) on metadata scan." >&2
  exit 1
fi

echo "audit:local passed"
