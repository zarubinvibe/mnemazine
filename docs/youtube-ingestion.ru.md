# Парсинг YouTube

🇷🇺 **Русский** · [🇬🇧 English](youtube-ingestion.md)

Mnemazine умеет забирать YouTube-канал и превращать каждое видео в заметку-транскрипт
в inbox, а затем автоматически подтягивать новые загрузки.

Два скрипта, оба чистый CLI (модельные токены здесь не тратятся):

- `scripts/kb-yt-harvest.py` — забрать канал (или одно видео) сейчас.
- `scripts/kb-yt-watch.py` — опрашивать подписанные каналы на новые загрузки.

## Забрать канал

```bash
# новейшие 50 видео (дефолтный лимит) + подписка на будущие загрузки
python3 scripts/kb-yt-harvest.py "https://www.youtube.com/@SomeChannel" --subscribe

# весь канал
python3 scripts/kb-yt-harvest.py "https://www.youtube.com/@SomeChannel" --all --subscribe

# одно видео
python3 scripts/kb-yt-harvest.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Для каждого видео пишет одну заметку в корень inbox с именем
`yt_<upload_date>_<video_id>_<title>.md` и frontmatter (`source`, `channel`,
`video_id`, `upload_date`, `transcript_method`). Дальше конвейер изучает их
как любой другой элемент inbox.

Источник транскрипта, от самого дешевого:

1. **Субтитры** через yt-dlp (`ru`, `en`; ручные предпочтительнее авто) — почти нулевая стоимость.
2. **Локальный whisper** как откат, когда у видео нет пригодных субтитров.

Per-channel download-archive yt-dlp гарантирует, что каждое видео забирается один раз —
хоть бэкфиллом, хоть watch-циклом.

## Следить за новыми загрузками

`--subscribe` регистрирует канал в `.mnemazine/cache/kb-yt/channels.json`.
Watcher читает RSS-фид каждого канала (последние 15 загрузок), сравнивает с
архивом и забирает только новое:

```bash
python3 scripts/kb-yt-watch.py --dry-run        # показать, что было бы забрано
python3 scripts/kb-yt-watch.py --harvest-only   # забрать новое, не изучать
python3 scripts/kb-yt-watch.py                  # забрать новое, затем изучить
```

После забора watcher изучает inbox через
`node scripts/mnemazine-run.mjs` (переопределяется `MNEMAZINE_STUDY_CMD`).

### Ежедневное расписание (macOS launchd)

Сгенерируйте конкретный агент из шаблона (машинные пути остаются вне репо):

```bash
sed -e "s#__PYTHON__#$(command -v python3)#g" \
    -e "s#__NODE_BIN__#$(dirname "$(command -v node)")#g" \
    -e "s#__ROOT__#$PWD#g" \
    -e "s#__INBOX__#$PWD/inbox#g" \
    scripts/com.mnemazine.kb-yt-watch.plist.template \
    > ~/Library/LaunchAgents/com.mnemazine.kb-yt-watch.plist
launchctl load ~/Library/LaunchAgents/com.mnemazine.kb-yt-watch.plist
```

Запускается ежедневно в 09:00 в режиме `--harvest-only`.

## Пути

| Что | Где |
|------|-------|
| Заметки | `$MNEMAZINE_INBOX` (дефолт `ROOT/inbox`) |
| Состояние (подписки, архив) | `ROOT/.mnemazine/cache/kb-yt/` (в gitignore) |

Установите `MNEMAZINE_INBOX`, чтобы направить забранные заметки в другой inbox.

## Требования

`yt-dlp`, `ffmpeg` и `openai-whisper` в `PATH` (`curl` используется для RSS).
См. [Установку](installation.ru.md).

## Безопасность

Забираются только публичные видео. Субтитры и метаданные — публичные данные. Путь
по умолчанию не использует cookie или сессии аккаунта — не прогоняйте приватный,
age-gated или members-only контент через конвейер знаний.

Если yt-dlp ловит «Sign in to confirm you're not a bot» на некоторых видео, поставьте
backend имитации браузера (`yt-dlp` curl_cffi extra); харвестер откатывается на
whisper, когда субтитры забрать нельзя.
