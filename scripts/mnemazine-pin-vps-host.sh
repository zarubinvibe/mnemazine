#!/usr/bin/env bash
set -euo pipefail

REPO="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -f "$REPO/.mnemazine/config.env" ] && . "$REPO/.mnemazine/config.env"

VPS="${MNEMAZINE_VPS:-deploy@YOUR_VPS_HOST}"
EXPECTED="${MNEMAZINE_VPS_HOST_FINGERPRINT:-${1:-}}"
KNOWN_HOSTS="${MNEMAZINE_SSH_KNOWN_HOSTS:-$REPO/.mnemazine/known_hosts}"

if [ "$VPS" = "deploy@YOUR_VPS_HOST" ] || [ -z "$EXPECTED" ]; then
  echo "Usage: MNEMAZINE_VPS=deploy@example.com MNEMAZINE_VPS_HOST_FINGERPRINT=SHA256:... bash scripts/mnemazine-pin-vps-host.sh" >&2
  exit 1
fi

HOST="${VPS#*@}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

ssh-keyscan -T 10 "$HOST" > "$TMP" 2>/dev/null
[ -s "$TMP" ] || { echo "No SSH host key from $HOST" >&2; exit 1; }

if ! ssh-keygen -lf "$TMP" | awk '{print $2}' | grep -Fx "$EXPECTED" >/dev/null; then
  echo "SSH host fingerprint mismatch for $HOST" >&2
  echo "Expected: $EXPECTED" >&2
  echo "Seen:" >&2
  ssh-keygen -lf "$TMP" >&2
  exit 1
fi

mkdir -p "$(dirname "$KNOWN_HOSTS")"
touch "$KNOWN_HOSTS"
ssh-keygen -R "$HOST" -f "$KNOWN_HOSTS" >/dev/null 2>&1 || true
cat "$TMP" >> "$KNOWN_HOSTS"
chmod 600 "$KNOWN_HOSTS"
echo "Pinned SSH host key for $HOST in $KNOWN_HOSTS"
