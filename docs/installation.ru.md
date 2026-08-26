# Установка

🇷🇺 **Русский** · [🇬🇧 English](installation.md)

Установка в одну папку:

```bash
git clone https://github.com/zarubinvibe/Mnemazine.git "$HOME/Desktop/Mnemazine"
cd "$HOME/Desktop/Mnemazine"
bash install.sh
```

Пошаговый режим:

```bash
bash setup.sh
```

Прогон без изменений:

```bash
MNEMAZINE_SETUP_DRYRUN=1 bash setup.sh
```

Установщик создаёт:

- `inbox/`;
- `vault/`;
- `reports/`;
- `.mnemazine/cache/`;
- `.mnemazine/state/`;
- `.mnemazine/bin/`.

Откройте `vault/` в Obsidian.

## macOS

На macOS установщик пытается скомпилировать Apple Vision OCR:

```bash
swiftc -O skills/mnemazine/vision-ocr.swift -o .mnemazine/bin/vision-ocr
```

Если не получилось — поставьте Xcode Command Line Tools:

```bash
xcode-select --install
```

## Python

Python-зависимости ставятся в `.venv/`. Это держит систему локальной внутри папки Mnemazine.

`install.sh` использует `requirements.lock`, если он есть, и откатывается на
`requirements.txt` только когда lock отсутствует. Политика обновления: меняешь
`requirements.txt`, пересобираешь локальный `.venv`, freeze'ишь
`requirements.lock`, коммитишь оба файла. Если Python-движки обязательны,
запускай с `MNEMAZINE_REQUIRE_PYTHON_DEPS=1`.

Отсутствующие опциональные движки видны явно: установщик пишет `DEGRADED: ...`
для Python deps, Apple Vision OCR или пропущенных локальных движков.

## Desktop dry-run

```bash
npm run protocol:desktop:dry-run
```

Команда гоняет Desktop-протокол на временных inbox/vault/cache/archive. Live
Desktop inbox не архивируется, не удаляется и не переписывается.

## Live preflight

```bash
npm run preflight:live
```

Перед настоящим `npm start` команда проверяет чистоту tracked-кода, совпадение
с `origin/main`, доступность LLM-провайдера, локальный security audit, Desktop
dry-run и наличие файлов в inbox. Пустой inbox, грязный код или недоступный LLM
— fail. Для проверки самой команды без файлов можно временно поставить
`MNEMAZINE_PREFLIGHT_ALLOW_EMPTY=1`.

После live-прогона смотри итог одной командой:

```bash
npm run last-run -- --require-ok
```

## Agent Skills

Если есть папки skills для Codex или Claude — установщик копирует туда переносимые skills. Если их нет, ничего не ломается.
