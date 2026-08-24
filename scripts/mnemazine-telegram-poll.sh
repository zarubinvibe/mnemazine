#!/usr/bin/env bash
# Runs every ~5 min via launchd. Decides whether to run the Mnemazine protocol:
#   - manual: mini app touched .run-now on the VPS (consumed atomically here)
#   - daily:  first eligible tick at/after 09:00 local that hasn't run today
# Reverse channel VPS->Mac without a public Mac: Mac polls a flag the VPS sets.
set -euo pipefail

REPO="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_DRAFT_ONLY="${MNEMAZINE_DRAFT_ONLY:-}"
ENV_REMOTE_INBOX="${MNEMAZINE_REMOTE_INBOX:-}"
ENV_REMOTE_REPORTS="${MNEMAZINE_REMOTE_REPORTS:-}"
# Live host/key/paths live in a gitignored config, never hardcoded here.
[ -f "$REPO/.mnemazine/config.env" ] && . "$REPO/.mnemazine/config.env"
# Non-secret personal overrides (e.g. MNEMAZINE_INBOX), gitignored.
[ -f "$REPO/.mnemazine/config.local.sh" ] && . "$REPO/.mnemazine/config.local.sh"
[ -n "$ENV_DRAFT_ONLY" ] && export MNEMAZINE_DRAFT_ONLY="$ENV_DRAFT_ONLY"
[ -n "$ENV_REMOTE_INBOX" ] && export MNEMAZINE_REMOTE_INBOX="$ENV_REMOTE_INBOX"
[ -n "$ENV_REMOTE_REPORTS" ] && export MNEMAZINE_REMOTE_REPORTS="$ENV_REMOTE_REPORTS"
VPS="${MNEMAZINE_VPS:-deploy@YOUR_VPS_HOST}"
KEY="${MNEMAZINE_VPS_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_INBOX="${MNEMAZINE_REMOTE_INBOX:-mnemazine/inbox}"
REMOTE_REPORTS="${MNEMAZINE_REMOTE_REPORTS:-mnemazine/reports}"
SSH_BIN="${MNEMAZINE_SSH_BIN:-ssh}"
SYNC_BIN="${MNEMAZINE_TELEGRAM_SYNC_BIN:-$REPO/scripts/mnemazine-telegram-sync.sh}"

print_remote_paths() {
  reports_count="$(find "$REPO/reports" -type f 2>/dev/null | wc -l | tr -d ' ')"
  capability_report="$REPO/reports/2026-06-15-capability-link-suggestions.md"
  capability_size="unknown"
  [ -f "$capability_report" ] && capability_size="$(wc -c < "$capability_report" | tr -d ' ')"
  cat <<EOF
Remote path review (host omitted)

| Remote path | Action | Code |
|---|---|---|
| ${REMOTE_INBOX%/}/ | read into local staging; no remote mutation | scripts/mnemazine-telegram-sync.sh:46 |
| ${REMOTE_INBOX%/}/.search-queue | read and truncate | scripts/mnemazine-telegram-poll.sh:52 |
| ${REMOTE_INBOX%/}/.run-now | read and delete; write retry back after failure | scripts/mnemazine-telegram-poll.sh:66,94 |
| ${REMOTE_INBOX%/}/.last-run | overwrite with UTC timestamp | scripts/mnemazine-telegram-poll.sh:90 |
| ${REMOTE_INBOX%/}/<pulled batch files> | delete only after successful local protocol run | scripts/mnemazine-telegram-sync.sh:65 |
| ${REMOTE_REPORTS%/}/ | upload local reports/ only after the data-class gate allows a staged export | scripts/mnemazine-telegram-poll.sh:130 |
| mnemazine/inbox, mnemazine/bot | create directories | setup.sh:178 |
| mnemazine/bot/mnemazine-telegram-bot.mjs | overwrite bot script | setup.sh:179 |
| mnemazine/bot/.env | write bot token under umask 177 | setup.sh:183 |
| pm2 process mnemazine-bot | start/restart and save process | setup.sh:185 |

WARNING: reports/ upload was 88 files on 2026-08-22; current local count is ${reports_count}. It includes 2026-06-15-capability-link-suggestions.md (${capability_size} bytes) and live vault audit files. Bulk upload is disabled; reports can leave only through the P24 data-class gate.

Owner step after review:
  add MNEMAZINE_REMOTE_MUTATION=1 to $REPO/.mnemazine/config.env
EOF
}

record_blocked() {
  reason="$1"
  mkdir -p "$REPO/.mnemazine/state"
  set +e
  node - "$REPO/.mnemazine/state/telegram-blocked.json" "$reason" <<'NODE'
const fs = require('node:fs')
const [file, reason] = process.argv.slice(2)
const now = new Date().toISOString()
let prev = {}
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
const changed = prev.reason !== reason
const lastPrinted = Date.parse(prev.last_printed_at || '')
const shouldPrint = changed || !Number.isFinite(lastPrinted) || Date.now() - lastPrinted >= 86400000
const next = {
  reason,
  first_seen: changed || !prev.first_seen ? now : prev.first_seen,
  last_seen: now,
  count: changed ? 1 : Number(prev.count || 0) + 1,
  last_printed_at: shouldPrint ? now : prev.last_printed_at
}
fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
process.exit(shouldPrint ? 0 : 3)
NODE
  rc="$?"
  set -e
  case "$rc" in
    0) return 0 ;;
    3) return 1 ;;
    *) return 0 ;;
  esac
}

case "${1:-}" in
  --print-remote-paths) print_remote_paths; exit 0 ;;
  "") ;;
  *) echo "Usage: $0 [--print-remote-paths]" >&2; exit 2 ;;
esac

# ponytail: fail fast if still on the placeholder — beats a confusing ssh error.
if [ "$VPS" = "deploy@YOUR_VPS_HOST" ]; then
  if record_blocked "Set MNEMAZINE_VPS (and MNEMAZINE_VPS_KEY) in $REPO/.mnemazine/config.env"; then
    echo "Set MNEMAZINE_VPS (and MNEMAZINE_VPS_KEY) in $REPO/.mnemazine/config.env" >&2
  fi
  exit 1
fi
if [ "${MNEMAZINE_REMOTE_MUTATION:-0}" != "1" ]; then
  if record_blocked "Set MNEMAZINE_REMOTE_MUTATION=1 after reviewing VPS paths; poll mutates remote flags/reports."; then
    echo "Set MNEMAZINE_REMOTE_MUTATION=1 after reviewing VPS paths; poll mutates remote flags/reports." >&2
  fi
  exit 1
fi
ATTEMPT_MARKER="$REPO/.mnemazine/.last-daily-attempt"
COMPLETED_MARKER="$REPO/.mnemazine/.last-daily-completed"
MAX_DAILY_ATTEMPTS="${MNEMAZINE_DAILY_MAX_ATTEMPTS:-3}"
DAILY_RETRY_SECONDS="${MNEMAZINE_DAILY_RETRY_SECONDS:-3600}"
mkdir -p "$REPO/.mnemazine"
KNOWN_HOSTS="${MNEMAZINE_SSH_KNOWN_HOSTS:-$REPO/.mnemazine/known_hosts}"
touch "$KNOWN_HOSTS"
HOST="${VPS#*@}"
if ! ssh-keygen -F "$HOST" -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
  echo "VPS host key is not pinned. Run: MNEMAZINE_VPS=$VPS MNEMAZINE_VPS_HOST_FINGERPRINT=SHA256:... bash $REPO/scripts/mnemazine-pin-vps-host.sh" >&2
  exit 1
fi
SSH="$SSH_BIN -i $KEY -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=yes -o ConnectTimeout=10"

# Single-flight lock. macOS has no flock, so use an atomic mkdir lock dir.
# Steal a stale lock (>60 min) left by a killed run.
LOCK="$REPO/.mnemazine/poll.lock"
[ -d "$LOCK" ] && find "$LOCK" -maxdepth 0 -mmin +60 -exec rmdir {} \; 2>/dev/null
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi   # previous tick still running
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Search queue (vault is Mac-only, so searches run here). Drain atomically:
# cat + truncate in one ssh. Each line is a JSON {topic}; parse safely in node.
queue="$($SSH "$VPS" "f=$REMOTE_INBOX/.search-queue; if [ -f \"\$f\" ]; then cat \"\$f\"; : > \"\$f\"; fi" 2>/dev/null || true)"
if [ -n "$queue" ]; then
  topics="$(printf '%s' "$queue" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const l of d.split("\n")){if(!l.trim())continue;try{const t=JSON.parse(l).topic;if(t)process.stdout.write(t.replace(/\n/g," ")+"\n")}catch{}}})' 2>/dev/null || true)"
  cd "$REPO"
  while IFS= read -r topic; do
    [ -z "$topic" ] && continue
    MNEMAZINE_DEEP=1 npm run --silent search -- --topic "$topic" || echo "search failed: $topic" >&2
  done <<< "$topics"
  # Заливка reports наружу — только через классовый барьер П24: партия
  # описывается манифестом, манифест проходит machine-class-gate, ненулевой код
  # ОСТАНАВЛИВАЕТ отправку. rsync ниже ОБЯЗАН стоять после вызова гейта — это
  # требование проверяет release-check machine-class-gate (грепом по этому файлу).
  if [ "${MNEMAZINE_PUSH_REPORTS:-0}" = "1" ]; then
    REPORTS_MANIFEST="$REPO/.mnemazine/state/reports-export-manifest.txt"
    mkdir -p "$REPO/.mnemazine/state"
    find "$REPO/reports" -type f -name '*.md' > "$REPORTS_MANIFEST"
    if node "$REPO/scripts/mnemazine-machine-class-gate.mjs" --batch "$REPORTS_MANIFEST" --target vps; then
      rsync -az -e "$SSH" "$REPO/reports/" "$VPS:$REMOTE_REPORTS/"
    else
      echo "reports export заблокирован гейтом класса данных П24 (pd/personal или неопределимый класс в партии)." >&2
      exit 1
    fi
  fi
fi

run=0; manual=0; daily=0
# Consume run-now flag atomically: print + delete in one ssh.
flag="$($SSH "$VPS" "f=$REMOTE_INBOX/.run-now; if [ -f \"\$f\" ]; then cat \"\$f\"; rm -f \"\$f\"; fi" 2>/dev/null || true)"
[ -n "$flag" ] && { run=1; manual=1; }

today="${MNEMAZINE_POLL_TODAY:-$(date +%F)}"
hour="${MNEMAZINE_POLL_HOUR:-$(date +%H)}"
now_epoch="${MNEMAZINE_POLL_EPOCH:-$(date +%s)}"
if [ "$(cat "$COMPLETED_MARKER" 2>/dev/null || true)" != "$today" ] && [ "$hour" -ge 9 ]; then
  read -r attempt_day attempt_count attempt_epoch < "$ATTEMPT_MARKER" 2>/dev/null || true
  if [ "${attempt_day:-}" != "$today" ]; then
    attempt_count=0
    attempt_epoch=0
  fi
  retry_wait=$((now_epoch - ${attempt_epoch:-0}))
  if [ "${attempt_count:-0}" -lt "$MAX_DAILY_ATTEMPTS" ] && { [ "${attempt_count:-0}" -eq 0 ] || [ "$retry_wait" -ge "$DAILY_RETRY_SECONDS" ]; }; then
    run=1
    daily=1
    attempt_count=$((attempt_count + 1))
    printf '%s %s %s\n' "$today" "$attempt_count" "$now_epoch" > "$ATTEMPT_MARKER"
  fi
fi

[ "$run" -eq 0 ] && exit 0

if bash "$SYNC_BIN"; then
  $SSH "$VPS" "echo $(date -u +%FT%TZ) > $REMOTE_INBOX/.last-run" 2>/dev/null || true
  [ "$daily" = "1" ] && echo "$today" > "$COMPLETED_MARKER"
else
  # A manual run-now we already consumed shouldn't vanish on failure — re-queue it.
  [ "$manual" = "1" ] && $SSH "$VPS" "echo retry > $REMOTE_INBOX/.run-now" 2>/dev/null || true
  exit 1
fi
