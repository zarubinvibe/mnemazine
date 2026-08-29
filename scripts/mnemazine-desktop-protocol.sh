#!/usr/bin/env bash
set -euo pipefail

REPO="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_INBOX="${MNEMAZINE_INBOX:-}"
ENV_VAULT="${MNEMAZINE_VAULT:-}"
ENV_DEEP="${MNEMAZINE_DEEP:-}"
ENV_REQUIRE_DEEP="${MNEMAZINE_REQUIRE_DEEP:-}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

[ -f "$REPO/.mnemazine/config.env" ] && . "$REPO/.mnemazine/config.env"
[ -f "$REPO/.mnemazine/config.local.sh" ] && . "$REPO/.mnemazine/config.local.sh"

CONFIG_VAULT=""
if [ -f "$REPO/.mnemazine/config.json" ] && command -v node >/dev/null 2>&1; then
  CONFIG_VAULT="$(node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(typeof cfg.vault==="string" ? cfg.vault : "")' "$REPO/.mnemazine/config.json" 2>/dev/null || true)"
fi
DEFAULT_VAULT="$REPO/vault"

export MNEMAZINE_ROOT="$REPO"
BASE_INBOX="${ENV_INBOX:-${MNEMAZINE_INBOX:-$HOME/Desktop/Mnemazine Inbox}}"
export MNEMAZINE_VAULT="${ENV_VAULT:-${MNEMAZINE_VAULT:-${CONFIG_VAULT:-$DEFAULT_VAULT}}}"
if [ -n "$ENV_DEEP" ]; then
  export MNEMAZINE_DEEP="$ENV_DEEP"
fi
export MNEMAZINE_REQUIRE_DEEP="${ENV_REQUIRE_DEEP:-${MNEMAZINE_REQUIRE_DEEP:-1}}"

# Draft mode writes nothing to the vault and never archives. Silent draft runs
# look like успешный прогон, so say it out loud before any work starts.
if [ "${MNEMAZINE_DRAFT_ONLY:-0}" = "1" ]; then
  echo "WARNING: MNEMAZINE_DRAFT_ONLY=1 — draft only: заметки в vault НЕ пишутся, инбокс НЕ архивируется." >&2
  echo "         Снять в .mnemazine/config.local.sh или запустить: MNEMAZINE_DRAFT_ONLY=0 npm start" >&2
fi

active_count() {
  find "$1" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' '
}

run_inbox() {
  local inbox="$1"
  local count
  count="$(active_count "$inbox")"
  [ "$count" = "0" ] && return 0
  echo "Mnemazine protocol: $inbox ($count files)" >&2
  ran=1
  MNEMAZINE_INBOX="${inbox%/}" npm run run -- --require-deep
}

mkdir -p "$BASE_INBOX"
if [ "$MNEMAZINE_VAULT" = "$DEFAULT_VAULT" ]; then
  mkdir -p "$MNEMAZINE_VAULT"
fi

if [ "$DRY_RUN" = "1" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mnemazine-desktop-dry-run.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/inbox" "$tmp/vault" "$tmp/reports" "$tmp/state" "$tmp/cache/extracted" "$tmp/archive"
  cp "$REPO/demo/inbox/example-guide.md" "$tmp/inbox/example-guide.md"
  echo "Mnemazine protocol dry-run: live inbox untouched ($BASE_INBOX)" >&2
  MNEMAZINE_INBOX="$tmp/inbox" \
  MNEMAZINE_VAULT="$tmp/vault" \
  MNEMAZINE_REPORTS="$tmp/reports" \
  MNEMAZINE_STATE="$tmp/state" \
  MNEMAZINE_CACHE="$tmp/cache/processed-hashes.json" \
  MNEMAZINE_EXTRACTS="$tmp/cache/extracted" \
  MNEMAZINE_ARCHIVE="$tmp/archive" \
  MNEMAZINE_DEEP=0 \
  MNEMAZINE_REQUIRE_DEEP=0 \
  MNEMAZINE_FINISH=0 \
    npm run --silent run
  echo "Mnemazine protocol dry-run: ok" >&2
  exit 0
fi

ran=0

run_inbox "$BASE_INBOX"

# Historical Telegram sync bug could create a nested inbox. Keep this guard so
# old leftovers do not silently sit outside the active top-level scan.
NESTED="$BASE_INBOX/mnemazine-inbox"
if [ -d "$NESTED" ]; then
  run_inbox "$NESTED"
fi

# An empty inbox is no reason to skip the final gates — that exact hole let 20.08
# close green with nothing verified. Say it, then still run completion.
if [ "$ran" = "0" ]; then
  echo "Mnemazine protocol: no active inbox files" >&2
fi

MNEMAZINE_INBOX="${BASE_INBOX%/}" npm run complete -- --require-deep
