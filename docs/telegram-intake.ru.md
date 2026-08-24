# Приём через Telegram (бот + Mini App)

Шлёшь что угодно в Telegram-бота — текст, фото, документ, голос, аудио, видео —
и оно попадает в `inbox/` Mnemazine. Маленькая Mini App показывает буфер,
даёт быстро бросить заметку и запустить прогон протокола по требованию.
Ежедневный авто-прогон работает как и раньше.

Сам протокол идёт **на твоей машине** (локальные OCR-движки, локальный
LLM-бинарь). Бот живёт на всегда-онлайн хосте, чтобы принимать пока машина
спит; машина сама забирает буфер и обрабатывает. Хост — только транзитный
буфер, не второе хранилище.

## Архитектура

```
  Telegram ──сообщение──▶ Бот (всегда-онлайн хост)
                            │ long-poll getUpdates (без webhook/TLS)
                            ▼
                    staging-inbox хоста  ◀── Mini App: POST /api/send
                            │                Mini App: POST /api/run → флаг .run-now
                            │
        твоя машина ────────┤ pull, каждые ~5 мин:
                            │   • есть флаг .run-now?   → прогон
                            │   • наступило окно дня?   → прогон
                            ▼
                  rsync-копия в локальный staging
                            ▼
                    локальный inbox/  ──▶  npm start  (строгий протокол)
                            ▼
                          vault/      ──только после success: delete на хосте
                            │
                            └─────────пишет .last-run──▶ статус Mini App
```

Обратный канал без публичной машины: хост не достучится до машины. Машина
сама поллит флаг, который ставит хост. Кнопка «Прогнать сейчас» в Mini App
просто пишет флаг; ближайший poll его забирает.

## Компоненты

| Часть | Где | Что |
|---|---|---|
| `scripts/mnemazine-telegram-bot.mjs` | хост | Long-poll бот. Пишет каждое сообщение в staging-inbox. Ноль зависимостей. |
| `scripts/mnemazine-webapp-server.mjs` | хост | API Mini App (`/api/status`, `/api/send`, `/api/run`). Верифицирует `initData`, держит allowlist. Ноль зависимостей. |
| `webapp/index.html` | хост (статика) | UI Mini App. Тема-aware, один файл. |
| `scripts/mnemazine-telegram-poll.sh` | твоя машина | Тик ~5 мин: флаг run-now / дневное окно → pull + прогон. |
| `scripts/mnemazine-telegram-sync.sh` | твоя машина | rsync-копия в staging + `npm start` + удаление забранных файлов на хосте только после success. |
| `scripts/com.mnemazine.telegram-sync.plist.template` | твоя машина | launchd-агент (macOS) для тика. |

## Установка

### 1. Бот на хосте

```bash
TELEGRAM_BOT_TOKEN=<от @BotFather> \
MNEMAZINE_INBOX=/path/to/staging-inbox \
node scripts/mnemazine-telegram-bot.mjs
```

Первое сообщение логирует твой `chat_id`. Закрой бота на себя:

```bash
ALLOWED_CHAT_IDS=<твой_chat_id>   # через запятую для нескольких
```

Перезапусти с этим env. Пусто = bootstrap-режим (принимает, логирует id для настройки).

### 2. Mini App на хосте

Раздавай `webapp/index.html` по **HTTPS** (Telegram требует TLS) и проксируй
`/api/` на API-сервер:

```bash
TELEGRAM_BOT_TOKEN=<токен> \
MNEMAZINE_INBOX=/path/to/staging-inbox \
ALLOWED_CHAT_IDS=<твой_chat_id> \
PORT=8787 \
node scripts/mnemazine-webapp-server.mjs
```

Пример reverse-proxy (любой TLS-фронт подойдёт):

```nginx
location /mini/mnemazine/api/ { proxy_pass http://127.0.0.1:8787/api/; }
location /mini/mnemazine/     { alias /path/to/webapp/; index index.html; }
```

Страница тянет `api/...` относительно своего пути — работает под любым
суб-путём. Наведи кнопку-меню бота на URL страницы:

```bash
curl -X POST "https://api.telegram.org/bot<токен>/setChatMenuButton" \
  -H 'content-type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Mnemazine",
       "web_app":{"url":"https://<твой-хост>/mini/mnemazine/"}}}'
```

### 3. Поллер на твоей машине

```bash
# отрендерить launchd-шаблон и загрузить (macOS)
sed 's#__REPO__#'"$PWD"'#g' \
  scripts/com.mnemazine.telegram-sync.plist.template \
  > ~/Library/LaunchAgents/com.mnemazine.telegram-sync.plist
launchctl load ~/Library/LaunchAgents/com.mnemazine.telegram-sync.plist
```

Используй отдельного непривилегированного пользователя, например `deploy@host`,
не привилегированный логин. Дефолтные пути живут в home этого пользователя:
`mnemazine/inbox`, `mnemazine/reports`, `mnemazine/bot`.

Сначала закрепи SSH host key:

```bash
MNEMAZINE_VPS=deploy@example.com \
MNEMAZINE_VPS_HOST_FINGERPRINT=SHA256:... \
bash scripts/mnemazine-pin-vps-host.sh
```

Потом положи проверенные настройки в `.mnemazine/config.env`:

```bash
MNEMAZINE_VPS=deploy@example.com
MNEMAZINE_VPS_KEY=$HOME/.ssh/id_ed25519_mnemazine
MNEMAZINE_REMOTE_INBOX=mnemazine/inbox
MNEMAZINE_INBOX="/path/to/local/Mnemazine Inbox"
MNEMAZINE_REMOTE_MUTATION=1
MNEMAZINE_PUSH_REPORTS=0
```

`MNEMAZINE_REMOTE_MUTATION=1` ставится осознанно: poller потребляет `.run-now`,
обновляет `.last-run`, а sync удаляет remote-копии только после локального
успеха. Без этого флага скрипты падают закрыто. На Linux — cron на 5 минут,
вызывающий `mnemazine-telegram-poll.sh`.

## Что уезжает на VPS

На VPS уходит только транзитная поверхность бота:

- `mnemazine/bot/mnemazine-telegram-bot.mjs` перезаписывается во время setup.
- `mnemazine/bot/.env` пишется на VPS под `umask 177`; внутри `TELEGRAM_BOT_TOKEN` и путь remote inbox. Локальный setup читает токен из macOS Keychain service `mnemazine-telegram`, не из файла в git.
- `mnemazine/inbox/` хранит Telegram-файлы до pull с твоей машины. Забранные файлы удаляются с VPS только после успешного локального протокола.
- `.search-queue`, `.run-now`, `.last-run` — remote-файлы управления и статуса; Mac poller меняет их только после `MNEMAZINE_REMOTE_MUTATION=1`.

`reports/` больше не заливается пачкой. Аудит показал, что там могут быть структура и содержание живого vault. `MNEMAZINE_PUSH_REPORTS=1` теперь падает закрыто, пока П24 не даст классовый staging-gate и явный экспорт разрешённых классов из `config/data-classes.json`.

Чтобы отозвать доступ, ротируй токен в BotFather и перезапусти бота на VPS. Для безопасной ротации перегони setup или замени только `mnemazine/bot/.env` под `umask 177`, затем `pm2 restart mnemazine-bot --update-env && pm2 save`. SSH-ключ ротируется отдельно, если мог утечь пользователь хоста или ключ рабочей машины.

## Безопасность

- Токен — секрет: env / секрет-стор, никогда не в git.
- `initData` HMAC-верифицируется токеном бота; проходят только id из allowlist.
- Бот игнорирует сообщения от всех вне `ALLOWED_CHAT_IDS`.
- Ротируй bot token, если хост, pm2 env, shell history или логи могли утечь.
  Ротируй SSH-ключ, если мог утечь пользователь хоста или ключ рабочей машины.
  Перезакрепляй `known_hosts` только после проверки нового fingerprint через
  панель провайдера или другой доверенный канал.

## Селф-тесты

```bash
node scripts/mnemazine-telegram-bot.mjs --selftest
node scripts/mnemazine-webapp-server.mjs --selftest
```
