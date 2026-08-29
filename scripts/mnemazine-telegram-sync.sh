#!/usr/bin/env bash
# Daily: pull buffered Telegram messages from the VPS into the local inbox,
# then run the Mnemazine protocol. Mac initiates (VPS can't reach Mac behind NAT).
# ponytail: rsync --remove-source-files = move; local protocol archives originals,
#           so the VPS stays a thin transit buffer, not a second store.
set -euo pipefail

REPO="${MNEMAZINE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_REMOTE_INBOX="${MNEMAZINE_REMOTE_INBOX:-}"
# Live host/key/paths live in a gitignored config, never hardcoded here.
[ -f "$REPO/.mnemazine/config.env" ] && . "$REPO/.mnemazine/config.env"
# Non-secret personal overrides (e.g. MNEMAZINE_INBOX), gitignored.
[ -f "$REPO/.mnemazine/config.local.sh" ] && . "$REPO/.mnemazine/config.local.sh"
[ -n "$ENV_REMOTE_INBOX" ] && export MNEMAZINE_REMOTE_INBOX="$ENV_REMOTE_INBOX"
VPS="${MNEMAZINE_VPS:-deploy@YOUR_VPS_HOST}"
KEY="${MNEMAZINE_VPS_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_INBOX="${MNEMAZINE_REMOTE_INBOX:-mnemazine/inbox/}"
REMOTE_INBOX="${REMOTE_INBOX%/}/"
# Inbox must be explicit: otherwise Telegram traffic splits into a repo-local
# inbox that the desktop protocol does not use.
if [ -z "${MNEMAZINE_INBOX:-}" ]; then
  echo "Set MNEMAZINE_INBOX in $REPO/.mnemazine/config.env; sync refuses to use $REPO/inbox silently." >&2
  exit 1
fi
LOCAL_INBOX="$MNEMAZINE_INBOX"
LOCAL_INBOX="${LOCAL_INBOX%/}/"
STAGING="${LOCAL_INBOX}.staging/"
# Export so the protocol runner reads the same inbox.
export MNEMAZINE_INBOX="${LOCAL_INBOX%/}"

if [ "$VPS" = "deploy@YOUR_VPS_HOST" ]; then
  echo "Set MNEMAZINE_VPS (and MNEMAZINE_VPS_KEY) in $REPO/.mnemazine/config.env" >&2
  exit 1
fi
if [ "${MNEMAZINE_REMOTE_MUTATION:-0}" != "1" ]; then
  echo "Set MNEMAZINE_REMOTE_MUTATION=1 after reviewing VPS paths; sync deletes remote files only after local success." >&2
  exit 1
fi

mkdir -p "$LOCAL_INBOX" "$STAGING"
KNOWN_HOSTS="${MNEMAZINE_SSH_KNOWN_HOSTS:-$REPO/.mnemazine/known_hosts}"
mkdir -p "$(dirname "$KNOWN_HOSTS")"
touch "$KNOWN_HOSTS"
HOST="${VPS#*@}"
if ! ssh-keygen -F "$HOST" -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
  echo "VPS host key is not pinned. Run: MNEMAZINE_VPS=$VPS MNEMAZINE_VPS_HOST_FINGERPRINT=SHA256:... bash $REPO/scripts/mnemazine-pin-vps-host.sh" >&2
  exit 1
fi
SSH_E="ssh -i $KEY -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=yes"

# Two-phase move (C2: never delete the only copy before processing succeeds).
# 1) pull into staging WITHOUT deleting on the VPS, resumable on partial transfer.
rsync -avz --partial --exclude '.*' -e "$SSH_E" "$VPS:$REMOTE_INBOX" "$STAGING"

# 2) promote staged files into the live inbox (atomic rename, same filesystem).
#    Record exactly which files we took, so we delete only those on the VPS later
#    (messages that arrive during the run stay buffered, not deleted).
pulled=()
shopt -s dotglob nullglob
for f in "$STAGING"*; do
  base="$(basename "$f")"
  case "$base" in .*) continue ;; esac   # skip dotfiles defensively
  mv -f "$f" "$LOCAL_INBOX$base"
  pulled+=("$base")
done
shopt -u dotglob nullglob

# 3) run the protocol; only AFTER it succeeds delete the taken files on the VPS.
cd "$REPO"
if npm run protocol:desktop; then
  if [ "${#pulled[@]}" -gt 0 ]; then
    printf '%s\n' "${pulled[@]}" | $SSH_E "$VPS" "cd ${REMOTE_INBOX%/} && xargs -d '\n' -r rm -f --"
  fi
else
  echo "protocol run failed — files are in local inbox, VPS copies kept for safety" >&2
  exit 1
fi
