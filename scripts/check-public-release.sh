#!/usr/bin/env bash
set -euo pipefail

# Root of the tree being scanned. Take it from the CURRENT git invocation
# (git runs hooks with cwd = worktree top) so a shared script installed at the
# main repo path still scans the right worktree. Fall back to script-relative
# only outside a git tree. An explicit $1 always wins.
ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))}"
ROOT_REAL="$(cd "$ROOT" 2>/dev/null && pwd -P || printf '%s' "$ROOT")"

# Private markers (machine paths, IPs, personal/project names) that must never ship publicly.
# `root@` requires a real host char after it (lowercase/digit) so the literal
# placeholder `root@YOUR_VPS_HOST` in docs/examples is not a false positive.
PRIVATE_MARKER_RULES_DEFAULT=(
  'private-path|/Users/'
  'remote-address|72\.56'
  'remote-root|root@[a-z0-9]'
  'vault-name-current|Мозг'
  'vault-name-legacy|Полезные знания'
  'owner-projects|TODOCUPS|ПКК|AthenaOS|legal-practice|Adventure Book'
  'owner-name|Филипп'
)
PRIVATE_MARKERS_FILE="${MNEMAZINE_PRIVATE_MARKERS_FILE:-$ROOT/.mnemazine/private-markers.txt}"
# Token-like values across common providers. Require realistic lengths and a
# non-word boundary before `sk-` to avoid false positives like `risk-or-x`.
# Covers: GitHub OAuth/PAT (gho_/ghp_/ghu_/ghs_/ghr_), OpenAI/Anthropic sk-,
# Slack xox*, AWS access key (AKIA/ASIA), GitLab PAT (glpat-), Google API
# (AIza), JWT (eyJ.header.payload), and PEM private-key blocks.
TOKEN_MARKERS='gh[opusr]_[A-Za-z0-9_]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(AKIA|ASIA)[A-Z0-9]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

PRIVATE_MARKERS=''

append_private_marker() {
  local marker="$1"
  [ -n "$marker" ] || return 0
  if [ -z "$PRIVATE_MARKERS" ]; then
    PRIVATE_MARKERS="$marker"
  else
    PRIVATE_MARKERS="$PRIVATE_MARKERS|$marker"
  fi
}

escape_ere() {
  printf '%s' "$1" | sed 's/[][\\.^$*+?{}()|]/\\&/g'
}

add_basename_marker() {
  local value="$1"
  local base value_real
  [ -n "$value" ] || return 0
  case "$value" in
    "$ROOT"|"$ROOT"/*) return 0 ;;
  esac
  value_real="$(cd "$value" 2>/dev/null && pwd -P || printf '%s' "$value")"
  case "$value_real" in
    "$ROOT_REAL"|"$ROOT_REAL"/*) return 0 ;;
  esac
  base="$(basename "$value")"
  [ -n "$base" ] || return 0
  case "$base" in
    mnemazine|Mnemazine|vault|inbox|reports|state|home|"Mnemazine Inbox") return 0 ;;
  esac
  append_private_marker "(^|[^[:alnum:]_])$(escape_ere "$base")([^[:alnum:]_]|$)"
}

toml_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

print_gitleaks_config() {
  cat <<'EOF'
# Generated from scripts/check-public-release.sh.
# Do not hand-edit marker rules here; change PRIVATE_MARKER_RULES_DEFAULT there
# and regenerate with: bash scripts/check-public-release.sh --print-gitleaks-config > .gitleaks.toml

[extend]
useDefault = true

[[allowlists]]
paths = [
  '^scripts/check-public-release\.sh$',
  '^\.gitleaks\.toml$',
]

[[allowlists]]
description = 'Retrieval eval anchors are owner-approved measurement fixtures; keep token rules active, suppress only project/vault marker rules.'
targetRules = ['vault-name-current', 'owner-projects']
paths = [
  '^tests/retrieval-eval\.mjs$',
]

EOF
  for rule in "${PRIVATE_MARKER_RULES_DEFAULT[@]}"; do
    local id="${rule%%|*}"
    local regex="${rule#*|}"
    printf '[[rules]]\n'
    printf "id = '%s'\n" "$(toml_escape "$id")"
    printf "description = 'Mnemazine private marker: %s'\n" "$(toml_escape "$id")"
    printf "regex = '%s'\n" "$(toml_escape "$regex")"
    printf "tags = ['mnemazine-private']\n\n"
  done
}

if [ "${1:-}" = "--print-gitleaks-config" ]; then
  print_gitleaks_config
  exit 0
fi

load_config_markers() {
  local config="$ROOT/.mnemazine/config.json"
  [ -f "$config" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  while IFS= read -r value; do
    add_basename_marker "$value"
  done < <(node -e '
const fs = require("fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
for (const key of ["vault", "inbox", "root"]) {
  if (typeof cfg[key] === "string" && cfg[key]) console.log(cfg[key])
}
' "$config" 2>/dev/null || true)
}

if [ "${MNEMAZINE_PRIVATE_MARKERS_BASE+x}" = "x" ]; then
  append_private_marker "$MNEMAZINE_PRIVATE_MARKERS_BASE"
else
  for rule in "${PRIVATE_MARKER_RULES_DEFAULT[@]}"; do
    append_private_marker "${rule#*|}"
  done
  load_config_markers
  add_basename_marker "$HOME"
fi

if [ -f "$PRIVATE_MARKERS_FILE" ]; then
  while IFS= read -r marker || [ -n "$marker" ]; do
    marker="${marker%$'\r'}"
    [ -n "$marker" ] || continue
    case "$marker" in \#*) continue ;; esac
    append_private_marker "$marker"
  done < "$PRIVATE_MARKERS_FILE"
fi

if [ -z "$PRIVATE_MARKERS" ]; then
  echo "Public release check errored: private marker list is empty; scanner cannot validate privacy." >&2
  exit 1
fi

# Pick a scanner. Prefer ripgrep; fall back to POSIX grep so the gate still runs
# on machines without rg. A missing scanner must HARD-FAIL, never silently pass.
if command -v rg >/dev/null 2>&1; then
  SCANNER="rg"
elif command -v grep >/dev/null 2>&1; then
  SCANNER="grep"
else
  echo "Public release check errored: neither 'rg' nor 'grep' is available to scan." >&2
  exit 1
fi

TRACKED_ONLY=0
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_ONLY=1
fi

# Only two files may carry personal markers, and for opposite reasons: the scanners
# below have to spell the markers out to hunt for them, and the licence names the
# rights holder because that is what a licence is for. Everything else — agent
# prompts, skills, tests, reports — went public with an absolute home path and a private
# vault name baked in precisely because it sat on this list.
private_marker_excluded() {
  case "$1" in
    .gitleaks.toml|\
    scripts/check-public-release.sh|\
    LICENSE)
      return 0
      ;;
  esac
  return 1
}

# Files that could ship publicly: everything git tracks PLUS untracked files
# not covered by .gitignore (a staged-but-uncommitted secret would otherwise
# slip past a tracked-only scan). Ignored runtime noise (.mnemazine, backups)
# is correctly skipped — it never reaches a public push.
tracked_files() {
  local mode="${1:-all}"
  local files=()
	  while IFS= read -r -d '' file; do
	    [ "$file" = "scripts/check-public-release.sh" ] && continue
	    # Local runtime instruments intentionally contain machine/vault paths.
	    # Keep token scanning on them; exclude only private-marker noise.
	    if [ "$mode" = "private-marker" ] && private_marker_excluded "$file"; then
	      continue
	    fi
	    files+=("$ROOT/$file")
	  done < <(git -C "$ROOT" ls-files -z --cached --others --exclude-standard)
	  if [ "${#files[@]}" -gt 0 ]; then
	    printf '%s\0' "${files[@]}"
	  fi
	}

# scan PATTERN: print matches under $ROOT, excluding vendored/VCS noise and this
# script itself (it embeds the marker patterns). Exit: 0 = match, 1 = clean, >=2 = scanner error.
scan() {
  local pattern="$1"
  local mode="${2:-all}"
  if [ "$TRACKED_ONLY" -eq 1 ]; then
    local files=()
	    while IFS= read -r -d '' file; do
	      files+=("$file")
	    done < <(tracked_files "$mode")
	    if [ "${#files[@]}" -eq 0 ]; then
	      echo "Public release check errored: no public files available to scan." >&2
	      exit 1
	    fi
    if [ "$SCANNER" = "rg" ]; then
      rg -n "$pattern" "${files[@]}"
    else
      grep -En "$pattern" "${files[@]}"
    fi
  elif [ "$SCANNER" = "rg" ]; then
    rg -n "$pattern" "$ROOT" \
      -g '!node_modules/**' -g '!.git/**' -g '!scripts/check-public-release.sh'
  else
    grep -rEn "$pattern" "$ROOT" \
      --exclude-dir=node_modules --exclude-dir=.git --exclude=check-public-release.sh
  fi
}

# check PATTERN LABEL: fail on a match; also fail (never pass) if the scanner
# itself errors — a security gate must never read a tooling failure as green.
check() {
  local pattern="$1"
  local label="$2"
  local mode="${3:-all}"
  local status=0
  scan "$pattern" "$mode" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "Public release check failed: $label found." >&2
    exit 1
  elif [ "$status" -ge 2 ]; then
    echo "Public release check errored: scanner '$SCANNER' failed (exit $status) while checking $label." >&2
    exit 1
  fi
}

check "$PRIVATE_MARKERS" "private marker" "private-marker"
check "$TOKEN_MARKERS" "token-like value"

# Local extraction cache is gitignored (never shipped), but captured screenshots
# / PDFs can carry credentials that would flow into synthesized notes. Scan it
# for token-like secrets only (personal/Cyrillic text is expected here and fine).
# Token-only, dir-scoped, skipped when the cache does not exist (clean checkout).
scan_dir_tokens() {
  local dir="$1"
  [ -d "$dir" ] || return 1
  if [ "$SCANNER" = "rg" ]; then
    rg -n "$TOKEN_MARKERS" "$dir"
  else
    grep -rEn "$TOKEN_MARKERS" "$dir"
  fi
}

EXTRACTS_DIR="${MNEMAZINE_EXTRACTS:-$ROOT/.mnemazine/cache/extracted}"
status=0
scan_dir_tokens "$EXTRACTS_DIR" || status=$?
if [ "$status" -eq 0 ]; then
  echo "Public release check failed: token-like secret found in extraction cache ($EXTRACTS_DIR)." >&2
  echo "A captured screenshot/PDF likely contains a credential. Remove it before it reaches a note." >&2
  exit 1
elif [ "$status" -ge 2 ]; then
  echo "Public release check errored: scanner '$SCANNER' failed (exit $status) scanning extraction cache." >&2
  exit 1
fi

echo "Public release check passed."
