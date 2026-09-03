#!/usr/bin/env bash
# Mnemazine guided installer. Walks a fresh device through setup in clear stages.
# Questions are numbered menus (terminal "dropdown"). Each stage gates the next.
# When a capability is missing we say so plainly and move on — never silently skip.
#
# Dry run (walk stages + questions, install/deploy nothing):
#   MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY="${MNEMAZINE_SETUP_DRYRUN:-0}"
KNOWN_HOSTS="$ROOT/.mnemazine/known_hosts"

# ---- ui helpers (shared with install.sh) -----------------------------------
# shellcheck source=scripts/mnemazine-ui.sh
. "$ROOT/scripts/mnemazine-ui.sh"

# ask_choice "Question?" "opt1" "opt2" ... -> sets REPLY_IDX (1-based) and REPLY_VAL
ask_choice() {
  local q="$1"; shift
  local opts=("$@") i
  printf '\n%s\n' "$q"
  for i in "${!opts[@]}"; do printf '  %d) %s\n' $((i+1)) "${opts[$i]}"; done
  local sel
  while true; do
    printf '%s' "$(L "Выбери [1-${#opts[@]}]: " "Choose [1-${#opts[@]}]: ")"
    if ! read -r sel; then
      printf '\n%s\n' "$(L 'Нет TTY (ввод закрыт). Запусти setup.sh интерактивно или install.sh без вопросов.' 'No TTY (input closed). Run setup.sh interactively, or install.sh without questions.')" >&2
      exit 1
    fi
    if [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#opts[@]}" ]; then
      REPLY_IDX="$sel"; REPLY_VAL="${opts[$((sel-1))]}"; return 0
    fi
    no "$(L "Не понял. Введи число от 1 до ${#opts[@]}." "Didn't get it. Enter a number from 1 to ${#opts[@]}.")"
  done
}

ask_text() { # ask_text "prompt" [silent] -> REPLY_TXT
  local p="$1" silent="${2:-}"
  if [ "$silent" = "secret" ]; then printf '%s: ' "$p"; read -rs REPLY_TXT || { printf '\n%s\n' "$(L 'Нет TTY.' 'No TTY.')" >&2; exit 1; }; printf '\n'
  else printf '%s: ' "$p"; read -r REPLY_TXT || { printf '\n%s\n' "$(L 'Нет TTY.' 'No TTY.')" >&2; exit 1; }; fi
}

run() { # run a command unless dry-run
  if [ "$DRY" = "1" ]; then printf '  [dry] %s\n' "$*"; return 0; fi
  "$@"
}

sq() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

keychain_account() {
  printf '%s' "${MNEMAZINE_TELEGRAM_KEYCHAIN_ACCOUNT:-telegram-bot}"
}

keychain_store_token() {
  local token="$1" account
  account="$(keychain_account)"
  if ! command -v security >/dev/null 2>&1; then
    if [ "$DRY" = "1" ]; then
      note "[dry] security add-generic-password -s mnemazine-telegram -a $account -w <token>"
      return 0
    fi
    no "$(L 'macOS Keychain недоступен: команда security не найдена.' 'macOS Keychain unavailable: the security command is missing.')"
    halt
  fi
  run security add-generic-password -U -s mnemazine-telegram -a "$account" -w "$token"
  ok "$(L "Токен сохранен в Keychain: service=mnemazine-telegram account=$account." "Token stored in Keychain: service=mnemazine-telegram account=$account.")"
}

keychain_read_token() {
  local account
  account="$(keychain_account)"
  security find-generic-password -s mnemazine-telegram -a "$account" -w 2>/dev/null
}

b "$(L 'Mnemazine — установка по шагам.' 'Mnemazine — step-by-step install.')"
note ""
note "$(L 'Что это. Система превращает то, что вы сохраняете — скриншоты, статьи, PDF, видео —' 'What this is. The system turns what you save — screenshots, articles, PDFs, videos —')"
note "$(L 'в готовые заметки: разбирает материал, проверяет источник, связывает с тем, что уже есть.' 'into finished notes: it reads the material, checks the source, links it to what you already have.')"
note "$(L 'Заметки лежат обычными файлами Markdown — их читает Obsidian и любой редактор.' 'Notes are plain Markdown files — Obsidian and any editor can read them.')"
note ""
note "$(L 'Что сейчас будет. Семь коротких этапов, примерно пять минут. Четыре вопроса — меню:' 'What happens now. Seven short stages, about five minutes. Four questions are menus:')"
note "$(L 'куда класть входящие, чем разбирать материал, нужен ли Telegram-бот, есть ли сервер.' 'where incoming files land, what parses the material, whether you want a Telegram bot, whether you have a server.')"
note "$(L 'Ничего необратимого: прервать можно в любой момент через Ctrl+C.' 'Nothing is irreversible: stop at any moment with Ctrl+C.')"
note "$(L 'Посмотреть весь путь, ничего не устанавливая: MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh' 'Preview the whole path without installing: MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh')"
note ""
note "$(L 'Каждый этап завершается прежде чем начнется следующий.' 'Each stage finishes before the next begins.')"
[ "$DRY" = "1" ] && note "$(L 'DRY RUN — ничего не ставится и не деплоится.' 'DRY RUN — nothing is installed or deployed.')"

# ---- Stage 1: base environment (hard gate) ---------------------------------
stage "1/7" "$(L 'Базовое окружение (обязательно)' 'Base environment (required)')"
fail=0
if command -v git >/dev/null 2>&1; then ok "git"; else no "$(L 'git нет' 'git missing')"; note "macOS: xcode-select --install · Linux: apt install git"; fail=1; fi
if command -v node >/dev/null 2>&1; then
  ver="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$ver" -ge 20 ]; then ok "node $(node -v)"; else no "$(L "node слишком старый ($(node -v)), нужен >=20" "node too old ($(node -v)), need >=20")"; note "https://nodejs.org · nvm install 20"; fail=1; fi
else no "$(L 'node нет (нужен >=20)' 'node missing (need >=20)')"; note "https://nodejs.org · brew install node"; fail=1; fi
[ "$fail" = "1" ] && halt
ok "$(L 'База готова.' 'Base ready.')"

# ---- Stage 2: local engines (optional, degrade gracefully) -----------------
stage "2/7" "$(L 'Локальные движки распознавания (по желанию — экономят токены)' 'Local recognition engines (optional — they save tokens)')"
note "$(L 'Зачем: текст со скриншотов и речь из видео читаются на вашем компьютере, без облака и без токенов.' 'Why: text on screenshots and speech in video are read on your machine — no cloud, no tokens.')"
note "$(L 'Чего нет — подскажу команду установки; можно поставить позже, система будет работать и без них.' 'Anything missing gets an exact install command; you can add it later — the system works without it.')"
have_py=0; have_ff=0; have_whisper=0; have_swift=0
if command -v python3 >/dev/null 2>&1; then
  # Версия, а не факт наличия: на 3.13 нет колёс у numba/llvmlite ни под какую архитектуру, и молчаливая
  # установка кончается пустой .venv. Ядро при этом встаёт везде - продолжаем, но говорим вслух.
  PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo '?')"
  case "$PY_VER" in
    3.11|3.12) ok "python3 $PY_VER (markitdown: PDF/DOCX/PPTX/XLSX/HTML)"; have_py=1 ;;
    3.13|3.14) ok "python3 $PY_VER (markitdown: PDF/DOCX/PPTX/XLSX/HTML)"; have_py=1
      warn "$(L 'Python 3.13: локальный whisper недоступен, ставь 3.11/3.12' 'Python 3.13: local whisper unavailable, install 3.11/3.12')" ;;
    *) ok "python3 $PY_VER (markitdown: PDF/DOCX/PPTX/XLSX/HTML)"; have_py=1
      warn "$(L "Проверено на 3.11 и 3.12; на $PY_VER возможны пакеты без колёс." "Tested on 3.11 and 3.12; on $PY_VER some packages may have no wheels.")" ;;
  esac
else
  miss "$(L 'Разбор офис-файлов локально не оставим:' 'No local office-file parsing:')" "$(L 'поставь python3 — иначе их распознает LLM в deep-режиме.' 'install python3 — otherwise the LLM reads them in deep mode.')"
fi
command -v ffmpeg  >/dev/null 2>&1 && { ok "ffmpeg $(L '(видео-кадры/аудио)' '(video frames/audio)')"; have_ff=1; } || miss "$(L 'Локальную обработку видео/аудио не оставим:' 'No local video/audio processing:')" "brew install ffmpeg · apt install ffmpeg."
command -v whisper >/dev/null 2>&1 && { ok "whisper $(L '(транскрипт речи)' '(speech transcript)')"; have_whisper=1; } || miss "$(L 'Локальный транскрипт речи не оставим:' 'No local speech transcript:')" "$(L 'pip install openai-whisper — иначе только субтитры/LLM.' 'pip install openai-whisper — otherwise only subtitles/LLM.')"
if [ "$(uname)" = "Darwin" ]; then
  command -v swiftc >/dev/null 2>&1 && { ok "swiftc (Apple Vision OCR)"; have_swift=1; } || miss "Apple Vision OCR:" "$(L 'xcode-select --install — иначе картинки распознает LLM.' 'xcode-select --install — otherwise images are read by the LLM.')"
else
  miss "Apple Vision OCR:" "$(L 'доступен только на macOS — на этом устройстве картинки распознает LLM.' 'macOS only — images are read by the LLM on this device.')"
fi
note "$(L 'Это не блокеры. Каркас поставится и без них.' 'These are not blockers. The skeleton installs without them.')"

# ---- Stage 3: inbox location (required question) ---------------------------
stage "3/7" "$(L 'Куда класть inbox?' 'Where does the inbox go?')"
note "$(L 'Зачем: это единственная папка, куда вы бросаете материал. Все остальное система делает сама.' 'Why: this is the one folder you drop material into. The system handles everything after that.')"
ask_choice "$(L 'Входящие материалы будут падать сюда:' 'Incoming material lands here:')" \
  "$(L 'На рабочий стол' 'On the Desktop') — $HOME/Desktop/Mnemazine Inbox" \
  "$(L 'Внутри репозитория' 'Inside the repo') — $ROOT/inbox"
if [ "$REPLY_IDX" = "1" ]; then INBOX="$HOME/Desktop/Mnemazine Inbox"; else INBOX="$ROOT/inbox"; fi
ok "Inbox: $INBOX"

# ---- Stage 4: LLM provider (deep mode) -------------------------------------
stage "4/7" "$(L 'LLM-провайдер для deep-режима (атомизация/обогащение/проверка)' 'LLM provider for deep mode (atomize/enrich/verify)')"
note "$(L 'Зачем: глубокий режим режет материал на отдельные мысли, ищет источники и проверяет утверждения.' 'Why: deep mode splits material into separate ideas, finds sources and checks claims.')"
note "$(L 'Без него система тоже работает — извлекает текст и раскладывает файлы, но не проверяет факты.' 'Without it the system still works — it extracts text and files things away, but does not verify facts.')"
has_claude=0; has_codex=0
command -v claude >/dev/null 2>&1 && has_claude=1
command -v codex  >/dev/null 2>&1 && has_codex=1
if [ "$has_claude" = "1" ] || [ "$has_codex" = "1" ]; then
  opts=(); [ "$has_claude" = "1" ] && opts+=("Claude CLI"); [ "$has_codex" = "1" ] && opts+=("Codex CLI"); opts+=("$(L 'Без deep — только локальный разбор' 'No deep — local parsing only')")
  ask_choice "$(L 'Найдены провайдеры. Чем работать?' 'Providers found. Which one?')" "${opts[@]}"
  case "$REPLY_VAL" in
    "Claude CLI") LLM=claude ;; "Codex CLI") LLM=codex ;; *) LLM="" ;;
  esac
  [ -n "$LLM" ] && ok "$(L "Провайдер: $LLM" "Provider: $LLM")" || ok "$(L 'Deep выключен (conservative, 0 токенов).' 'Deep off (conservative, 0 tokens).')"
else
  LLM=""
  miss "$(L 'deep-режим (атомизация/обогащение через LLM) не оставим:' 'no deep mode (LLM atomize/enrich):')" "$(L 'не найден ни claude, ни codex CLI. Каркас и локальный разбор работают.' 'neither claude nor codex CLI found. Skeleton and local parsing still work.')"
fi

# ---- Stage 5: Telegram bot --------------------------------------------------
stage "5/7" "$(L 'Telegram-бот для приема входящих' 'Telegram bot for intake')"
note "$(L 'Зачем: увидели что-то с телефона — отправили боту, и материал уже в инбоксе. Шаг необязательный.' 'Why: spot something on your phone, send it to the bot, and it is already in the inbox. Optional step.')"
BOT_TOKEN=""; BOT_MODE="none"
ask_choice "$(L 'Подключить Telegram-бота? (шлешь боту — падает в inbox)' 'Connect a Telegram bot? (send it a file — it lands in the inbox)')" "$(L 'Да' 'Yes')" "$(L 'Нет' 'No')"
if [ "$REPLY_IDX" = "1" ]; then
  ask_text "$(L 'Вставь токен бота от @BotFather' 'Paste the bot token from @BotFather')" secret; BOT_TOKEN="$REPLY_TXT"
  if [ -z "$BOT_TOKEN" ]; then
    miss "$(L 'Telegram-бота не оставим:' 'no Telegram bot:')" "$(L 'токен пустой — пропускаем.' 'token empty — skipping.')"
    note "$(L 'Как включить бота позже — docs/telegram-intake.md.' 'How to enable the bot later — docs/telegram-intake.md.')"
  else
    ok "$(L 'Токен принят (в git не пишем).' 'Token accepted (never written to git).')"
    keychain_store_token "$BOT_TOKEN"
    BOT_TOKEN=""
    b "$(L 'Бот должен идти через VPS (всегда-онлайн, принимает пока твое устройство спит).' 'The bot needs a VPS (always-on, receives while your device sleeps).')"
    ask_choice "$(L 'Есть VPS для бота?' 'Do you have a VPS for the bot?')" "$(L 'Да, есть VPS' 'Yes, I have a VPS')" "$(L 'Нет VPS' 'No VPS')"
    if [ "$REPLY_IDX" = "1" ]; then
      ask_text "$(L 'VPS (user@host)' 'VPS (user@host)')"; BOT_VPS="$REPLY_TXT"
      ask_text "$(L 'Путь к SSH-ключу (Enter = ~/.ssh/id_rsa)' 'SSH key path (Enter = ~/.ssh/id_rsa)')"; BOT_KEY="${REPLY_TXT:-$HOME/.ssh/id_rsa}"
      ask_text "$(L 'SSH fingerprint хоста (SHA256:..., из панели VPS или ssh-keygen -lf)' 'Host SSH fingerprint (SHA256:..., from the VPS panel or ssh-keygen -lf)')"; BOT_FP="$REPLY_TXT"
      [ -z "$BOT_FP" ] && { no "$(L 'fingerprint пустой — небезопасно.' 'fingerprint empty — unsafe.')"; halt; }
      if [ "$DRY" != "1" ]; then
        mkdir -p "$ROOT/.mnemazine"
        touch "$KNOWN_HOSTS"
        MNEMAZINE_VPS="$BOT_VPS" MNEMAZINE_VPS_KEY="$BOT_KEY" MNEMAZINE_VPS_HOST_FINGERPRINT="$BOT_FP" bash "$ROOT/scripts/mnemazine-pin-vps-host.sh"
      fi
      if [ "$DRY" != "1" ] && ! ssh -i "$BOT_KEY" -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$BOT_VPS" 'command -v node >/dev/null && command -v pm2 >/dev/null' 2>/dev/null; then
        no "$(L 'VPS недоступен или нет node+pm2.' 'VPS unreachable or missing node+pm2.')"
        halt
      fi
      BOT_MODE="vps"; ok "$(L 'VPS на связи (node+pm2 есть).' 'VPS reachable (node+pm2 present).')"
    else
      miss "$(L 'бота через VPS не оставим:' 'no bot over a VPS:')" "$(L 'Без VPS постоянного приема нет. Можешь запускать бота локально, пока устройство включено.' 'Without a VPS there is no round-the-clock intake. You can run the bot locally while your device is on.')"
      note "$(L 'Как жить без VPS — docs/telegram-intake.md.' 'Living without a VPS — docs/telegram-intake.md.')"
      BOT_MODE="manual"
    fi
  fi
else
  note "$(L 'Бот пропущен.' 'Bot skipped.')"
  note "$(L 'Захочешь позже — docs/telegram-intake.md.' 'If you want it later — docs/telegram-intake.md.')"
fi

# ---- Stage 6: build the skeleton -------------------------------------------
stage "6/7" "$(L 'Ставлю каркас Mnemazine' 'Building the Mnemazine skeleton')"
note "$(L 'Зачем: создаю папки базы знаний и служебные файлы. Ничего за пределами проекта без спроса не трогаю.' 'Why: creating the knowledge-base folders and service files. Nothing outside the project is touched without asking.')"
ok "$(L 'Запускаю install.sh (vault, папки, venv, OCR-сборка)…' 'Running install.sh (vault, folders, venv, OCR build)…')"
# install.sh сам объявляет свои коды: 0 готов · 2 готов с урезанными возможностями · 1 не доделал.
# Раньше здесь стояло `if ! ...`, и код 2 читался как провал: пользователь видел «✓ Готово. Часть
# возможностей недоступна» от install.sh и тут же «✗ каркас не собран» от setup.sh, хотя vault, .venv
# и папки были на месте (issue #6, п.3). Код 2 - это предупреждение, а не отказ.
INSTALL_RC=0
MNEMAZINE_FROM_SETUP=1 MNEMAZINE_YES=1 MNEMAZINE_ROOT="$ROOT" MNEMAZINE_INBOX="$INBOX" run bash "$ROOT/install.sh" || INSTALL_RC=$?
if [ "$INSTALL_RC" -eq 1 ] || [ "$INSTALL_RC" -gt 2 ]; then
  no "$(L "install.sh завершился с ошибкой (код $INSTALL_RC) — каркас не собран." "install.sh failed (exit $INSTALL_RC) — skeleton not built.")"
  halt
elif [ "$INSTALL_RC" -eq 2 ]; then
  # «Урезано» нельзя объявлять на слово: проверяем сами, что именно живо. Иначе тихий приём кода 2
  # прячет пустую .venv за словом DEGRADED - установка выглядит успешной, а движков нет.
  warn "$(L 'Каркас собран, часть возможностей недоступна — проверяю, что именно живо.' 'Skeleton built, some capabilities are degraded — checking what actually works.')"
  VENV_BIN="$ROOT/.venv/bin"
  if "$VENV_BIN/graphify" --version >/dev/null 2>&1; then ok "graphify"; else no "graphify $(L '(граф знаний недоступен)' '(knowledge graph unavailable)')"; fi
  if "$VENV_BIN/markitdown" --help >/dev/null 2>&1; then ok "markitdown"; else no "markitdown $(L '(PDF/DOCX читает LLM)' '(PDF/DOCX read by the LLM)')"; fi
fi

# deploy bot if VPS path chosen
if [ "$BOT_MODE" = "vps" ]; then
  stage "6.1" "$(L 'Деплой бота на VPS' 'Deploying the bot to the VPS')"
  REMOTE_ROOT="mnemazine"
  REMOTE_INBOX="$REMOTE_ROOT/inbox"
  REMOTE_BOT="$REMOTE_ROOT/bot"
  # Persist the host/key boundary so poll/sync scripts read it (never hardcoded).
  if [ "$DRY" != "1" ]; then
    mkdir -p "$ROOT/.mnemazine"
    umask 177
    cat > "$ROOT/.mnemazine/config.env" <<CFG
MNEMAZINE_VPS="$BOT_VPS"
MNEMAZINE_VPS_KEY="$BOT_KEY"
MNEMAZINE_REMOTE_INBOX="$REMOTE_INBOX"
MNEMAZINE_INBOX="$INBOX"
MNEMAZINE_REMOTE_MUTATION=1
MNEMAZINE_PUSH_REPORTS=0
CFG
    umask 022
    ok "$(L 'Записал .mnemazine/config.env (chmod 600, gitignored).' 'Wrote .mnemazine/config.env (chmod 600, gitignored).')"
  fi
  if [ "$DRY" = "1" ]; then
    note "[dry] scp bot → $BOT_VPS:$REMOTE_BOT/ ; pm2 start с токеном"
  else
    SSH_OPTS=(-i "$BOT_KEY" -o "UserKnownHostsFile=$KNOWN_HOSTS" -o StrictHostKeyChecking=yes)
    BOT_TOKEN_FROM_KEYCHAIN="$(keychain_read_token)" || { no "$(L 'Не смог прочитать токен из Keychain.' 'Could not read the token from Keychain.')"; halt; }
    ssh "${SSH_OPTS[@]}" "$BOT_VPS" "mkdir -p $REMOTE_BOT $REMOTE_INBOX" || { no "$(L 'Не смог создать папки на VPS.' 'Could not create folders on the VPS.')"; halt; }
    ssh "${SSH_OPTS[@]}" "$BOT_VPS" "cat > $REMOTE_BOT/mnemazine-telegram-bot.mjs" < "$ROOT/scripts/mnemazine-telegram-bot.mjs" || { no "$(L 'Не смог загрузить bot script на VPS.' 'Could not upload the bot script to the VPS.')"; halt; }
    {
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "$(sq "$BOT_TOKEN_FROM_KEYCHAIN")"
      printf 'MNEMAZINE_INBOX=%s\n' "$(sq "$REMOTE_INBOX")"
    } | ssh "${SSH_OPTS[@]}" "$BOT_VPS" "umask 177; cat > $REMOTE_BOT/.env" || { no "$(L 'Не смог записать .env на VPS.' 'Could not write .env on the VPS.')"; halt; }
    BOT_TOKEN_FROM_KEYCHAIN=""
    # Idempotent: start, or restart if the process already exists (rerun-safe).
    ssh "${SSH_OPTS[@]}" "$BOT_VPS" "cd $REMOTE_BOT && set -a && . ./.env && set +a && pm2 start mnemazine-telegram-bot.mjs --name mnemazine-bot --update-env 2>/dev/null || pm2 restart mnemazine-bot --update-env; pm2 save" || { no "$(L 'Не смог запустить pm2 на VPS.' 'Could not start pm2 on the VPS.')"; halt; }
    ok "$(L 'Бот запущен на VPS (bootstrap-режим).' 'Bot started on the VPS (bootstrap mode).')"
    note "$(L 'Напиши боту сообщение, затем на VPS: pm2 logs mnemazine-bot — увидишь свой chat_id.' 'Message the bot, then on the VPS: pm2 logs mnemazine-bot — you will see your chat_id.')"
    note "$(L 'Закрой доступ: пустой ALLOWED_CHAT_IDS отвергает всех (fail-closed). Перезапусти с ALLOWED_CHAT_IDS=<chat_id> — см. docs/telegram-intake.md.' 'Lock it down: an empty ALLOWED_CHAT_IDS rejects everyone (fail-closed). Restart with ALLOWED_CHAT_IDS=<chat_id> — see docs/telegram-intake.md.')"
  fi
elif [ "$BOT_MODE" = "manual" ]; then
  stage "6.1" "$(L 'Бот локально (вручную)' 'Bot locally (manual)')"
  note "$(L 'Запусти когда нужно:' 'Run it when you need it:')"
  note "TELEGRAM_BOT_TOKEN=<$(L 'токен' 'token')> MNEMAZINE_INBOX=$INBOX node $ROOT/scripts/mnemazine-telegram-bot.mjs"
  note "$(L 'Подробнее и как закрыть бота на себя — docs/telegram-intake.md.' 'Details and how to lock the bot to yourself — docs/telegram-intake.md.')"
fi

# ---- Stage 7: done ----------------------------------------------------------
stage "7/7" "$(L 'Готово' 'Done')"
ok "$(L "Каркас: $ROOT" "Skeleton: $ROOT")"
ok "Inbox: $INBOX"
[ -n "$LLM" ] && ok "$(L "Deep-провайдер: $LLM" "Deep provider: $LLM")" || note "$(L 'Deep выключен — включишь позже через MNEMAZINE_LLM.' 'Deep off — enable later via MNEMAZINE_LLM.')"
note "$(L 'Открой папку vault в Obsidian.' 'Open the vault folder in Obsidian.')"
note "$(L "Открой проект: $ROOT" "Open the project: $ROOT")"
note "$(L "Клади файлы: $INBOX" "Drop files into: $INBOX")"
note "$(L 'В чате агента: Mnemazine' 'In the agent chat: Mnemazine')"
note "$(L 'В терминале: npm start' 'In the terminal: npm start')"
note "$(L 'Признак жизни: npm run doctor' 'Sign of life: npm run doctor')"
note "$(L 'Если ~/.local/bin есть в PATH: mnemazine' 'If ~/.local/bin is on your PATH: mnemazine')"

# First real result beats any amount of documentation: offer one demo pass so the
# user sees a finished note before deciding whether this belongs in their life.
if [ "$DRY" != "1" ] && [ -f "$ROOT/demo/inbox/example-guide.md" ]; then
  ask_choice "$(L 'Показать, как это работает, прямо сейчас? Возьму демо-файл из репозитория и сделаю из него заметку.' 'Want to see it work right now? I will take a demo file from the repo and turn it into a note.')" \
    "$(L 'Да, покажи' 'Yes, show me')" "$(L 'Нет, я сам' 'No, I will do it myself')"
  if [ "$REPLY_IDX" = "1" ]; then
    demo_dir="$(mktemp -d "${TMPDIR:-/tmp}/mnemazine-first-run.XXXXXX")"
    mkdir -p "$demo_dir/inbox" "$demo_dir/vault"
    cp "$ROOT/demo/inbox/example-guide.md" "$demo_dir/inbox/"
    note "$(L 'Прогон идет в отдельной песочнице — ваша база знаний не тронута.' 'The run happens in a sandbox — your own knowledge base is untouched.')"
    if MNEMAZINE_INBOX="$demo_dir/inbox" MNEMAZINE_VAULT="$demo_dir/vault" \
       MNEMAZINE_REPORTS="$demo_dir/reports" MNEMAZINE_STATE="$demo_dir/state" \
       MNEMAZINE_CACHE="$demo_dir/cache.json" MNEMAZINE_EXTRACTS="$demo_dir/extracts" \
       MNEMAZINE_ARCHIVE="$demo_dir/archive" MNEMAZINE_DEEP=0 MNEMAZINE_REQUIRE_DEEP=0 \
       MNEMAZINE_FINISH=0 node "$ROOT/scripts/mnemazine-run.mjs" >/dev/null 2>&1; then
      first_note="$(find "$demo_dir/vault" -name '*.md' | head -1)"
      if [ -n "$first_note" ]; then
        ok "$(L 'Готовая заметка:' 'Here is the finished note:')"
        printf '\n'; sed -n '1,24p' "$first_note"; printf '\n'
        note "$(L 'Так же будет с вашими файлами — только с проверкой источников, если включен deep-режим.' 'Your own files go the same way — with source checks too, when deep mode is on.')"
      else
        note "$(L 'Демо-прогон прошел, но заметки не видно — напишите нам, это баг.' 'The demo ran but produced no note — tell us, that is a bug.')"
      fi
    else
      note "$(L 'Демо-прогон не завершился. Установка в порядке: проверьте npm run doctor.' 'The demo run did not finish. The install is fine: check npm run doctor.')"
    fi
    rm -rf "$demo_dir"
  fi
fi
[ "$BOT_MODE" = "vps" ] && note "$(L 'Mini App + ежедневный pull: см. docs/telegram-intake.md (этапы 2-3).' 'Mini App + daily pull: see docs/telegram-intake.md (stages 2-3).')"
b "$(L 'Все. Пользуйся.' 'All set. Enjoy.')"

# Author greeting last, so it is what the user sees at the end (not buried
# mid-flow inside install.sh, which stays silent under MNEMAZINE_FROM_SETUP).
[ "$DRY" = "1" ] || bash "$ROOT/scripts/hello.sh"
