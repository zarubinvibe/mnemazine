# Telegram intake (bot + Mini App)

Send anything to a Telegram bot — text, photo, document, voice, audio, video —
and it lands in the Mnemazine `inbox/`. A small Mini App shows the buffer,
lets you drop a quick note, and triggers a protocol run on demand. The daily
auto-run still happens on schedule.

The protocol itself runs **on your machine** (local OCR engines, local LLM
binary). The bot runs on an always-on host so it keeps receiving while your
machine is asleep; your machine pulls the buffer and processes it. The host is
only a transit buffer, never a second store.

## Architecture

```
  Telegram ──message──▶ Bot (always-on host)
                          │ long-poll getUpdates (no webhook/TLS)
                          ▼
                    host staging inbox  ◀── Mini App: POST /api/send
                          │                  Mini App: POST /api/run → .run-now flag
                          │
        your machine ─────┤ pull, every ~5 min:
                          │   • .run-now flag present?  → run
                          │   • daily window reached?   → run
                          ▼
                  rsync copy to local staging
                          ▼
                    local inbox/  ──▶  npm start  (the strict protocol)
                          ▼
                        vault/        ──success only: delete pulled host files
                          │
                          └───────────writes .last-run──▶ Mini App status
```

Reverse channel without a public machine: the host never reaches your machine.
Your machine polls a flag the host sets. "Run now" in the Mini App just writes
that flag; the next poll consumes it.

## Components

| Piece | Where | What |
|---|---|---|
| `scripts/mnemazine-telegram-bot.mjs` | host | Long-poll bot. Writes each message into the staging inbox. Zero deps. |
| `scripts/mnemazine-webapp-server.mjs` | host | Mini App API (`/api/status`, `/api/send`, `/api/run`). Verifies Telegram `initData`, enforces an allowlist. Zero deps. |
| `webapp/index.html` | host (static) | The Mini App UI. Theme-aware, single file. |
| `scripts/mnemazine-telegram-poll.sh` | your machine | ~5-min tick: consume run-now flag / daily window → pull + run. |
| `scripts/mnemazine-telegram-sync.sh` | your machine | rsync copy to staging + `npm start` + delete pulled host files only after success. |
| `scripts/com.mnemazine.telegram-sync.plist.template` | your machine | launchd agent (macOS) for the poll tick. |

## Setup

### 1. Bot on the host

```bash
TELEGRAM_BOT_TOKEN=<from @BotFather> \
MNEMAZINE_INBOX=/path/to/staging-inbox \
node scripts/mnemazine-telegram-bot.mjs
```

First message logs your `chat_id`. Lock the bot to yourself:

```bash
ALLOWED_CHAT_IDS=<your_chat_id>   # comma-separated for more
```

Restart with that env set. Unset = bootstrap mode (accepts, logs the id to set).

### 2. Mini App on the host

Serve `webapp/index.html` over **HTTPS** (Telegram requires TLS) and proxy
`/api/` to the API server:

```bash
TELEGRAM_BOT_TOKEN=<token> \
MNEMAZINE_INBOX=/path/to/staging-inbox \
ALLOWED_CHAT_IDS=<your_chat_id> \
PORT=8787 \
node scripts/mnemazine-webapp-server.mjs
```

Reverse-proxy example (any TLS-terminating front works):

```nginx
location /mini/mnemazine/api/ { proxy_pass http://127.0.0.1:8787/api/; }
location /mini/mnemazine/     { alias /path/to/webapp/; index index.html; }
```

The page fetches `api/...` relative to its own path, so it works under any
sub-path. Point the bot's menu button at the page URL:

```bash
curl -X POST "https://api.telegram.org/bot<token>/setChatMenuButton" \
  -H 'content-type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Mnemazine",
       "web_app":{"url":"https://<your-host>/mini/mnemazine/"}}}'
```

### 3. Poller on your machine

```bash
# render the launchd template and load it (macOS)
sed 's#__REPO__#'"$PWD"'#g' \
  scripts/com.mnemazine.telegram-sync.plist.template \
  > ~/Library/LaunchAgents/com.mnemazine.telegram-sync.plist
launchctl load ~/Library/LaunchAgents/com.mnemazine.telegram-sync.plist
```

Use a dedicated unprivileged host user, for example `deploy@host`, not a
privileged login. Default remote paths are under that user's home:
`mnemazine/inbox`, `mnemazine/reports`, and `mnemazine/bot`.

Pin the SSH host key before enabling polling:

```bash
MNEMAZINE_VPS=deploy@example.com \
MNEMAZINE_VPS_HOST_FINGERPRINT=SHA256:... \
bash scripts/mnemazine-pin-vps-host.sh
```

Then put reviewed settings in `.mnemazine/config.env`:

```bash
MNEMAZINE_VPS=deploy@example.com
MNEMAZINE_VPS_KEY=$HOME/.ssh/id_ed25519_mnemazine
MNEMAZINE_REMOTE_INBOX=mnemazine/inbox
MNEMAZINE_INBOX="/path/to/local/Mnemazine Inbox"
MNEMAZINE_REMOTE_MUTATION=1
MNEMAZINE_PUSH_REPORTS=0
```

`MNEMAZINE_REMOTE_MUTATION=1` is deliberate: the poller consumes `.run-now`,
updates `.last-run`, and the sync deletes remote copies only after local success.
Without that flag the scripts fail closed. On Linux, use a 5-minute cron entry
calling `mnemazine-telegram-poll.sh` instead.

## What Leaves For The VPS

The VPS receives only the transit bot surface:

- `mnemazine/bot/mnemazine-telegram-bot.mjs` is overwritten during setup.
- `mnemazine/bot/.env` is written on the VPS with `umask 177`; it contains `TELEGRAM_BOT_TOKEN` and the remote inbox path. The local setup reads the token from macOS Keychain service `mnemazine-telegram`, not from a committed file.
- `mnemazine/inbox/` stores incoming Telegram files until your machine pulls them. Pulled files are deleted from the VPS only after the local protocol succeeds.
- `.search-queue`, `.run-now`, and `.last-run` are remote control/status files mutated by the Mac poller after `MNEMAZINE_REMOTE_MUTATION=1`.

`reports/` does not bulk-upload. Historical audits showed this directory can contain live vault structure and content. `MNEMAZINE_PUSH_REPORTS=1` now fails closed until the P24 data-class staging gate explicitly exports reviewed report classes from `config/data-classes.json`.

To revoke access, rotate the token in BotFather and restart the VPS bot. To rotate safely, rerun setup or replace only `mnemazine/bot/.env` under `umask 177`, then `pm2 restart mnemazine-bot --update-env && pm2 save`. Rotate the SSH key separately if the host user or workstation key may have leaked.

## Security

- The token is a secret — keep it in env / a secret store, never in git.
- `initData` is HMAC-verified with the bot token; only allowlisted user ids pass.
- The bot ignores messages from anyone outside `ALLOWED_CHAT_IDS`.
- Rotate the bot token if the host, pm2 env, shell history, or logs may have
  leaked. Rotate the SSH key if the host user or your workstation key may have
  leaked. Re-pin `known_hosts` only after verifying the new host fingerprint
  from the provider console or another trusted channel.

## Self-tests

```bash
node scripts/mnemazine-telegram-bot.mjs --selftest
node scripts/mnemazine-webapp-server.mjs --selftest
```
