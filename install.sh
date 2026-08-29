#!/usr/bin/env bash
# Mnemazine skeleton installer. Non-interactive by default; every write outside
# the clone is gated behind explicit consent. Missing capabilities are printed
# with a fix command, never silently skipped, and the exit code is the honest
# install status: 0 ready, 2 ready with degraded capabilities, 1 not finished.
set -euo pipefail

# --- flags: parsed FIRST, before any output or mkdir (unlike the Femida etalon,
# --- which prints ~270 lines of prose before it ever reaches --help). --------
DRY="${MNEMAZINE_SETUP_DRYRUN:-0}"
WITH_SCHEDULE=0
CHECK_ONLY=0
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage: bash install.sh [--yes] [--dry-run] [--check] [--with-schedule] [--help]

  --yes            install without asking (same as MNEMAZINE_YES=1)
  --dry-run        walk every step, install/write nothing
  --check          run the health doctor only, install nothing
  --with-schedule  also register the launchd background jobs (off by default)
  --help           show this and exit

Consent: without --yes the installer asks once on the terminal before it writes
anything outside the clone. No answer means no: it installs nothing and exits 1.
Bypass in automation with: MNEMAZINE_YES=1 bash install.sh
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY=1 ;;
    --yes|-y) MNEMAZINE_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --with-schedule) WITH_SCHEDULE=1 ;;
    *) echo "install.sh: unknown flag: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# shellcheck source=scripts/mnemazine-ui.sh
. "$SRC/scripts/mnemazine-ui.sh"

# ROOT (install target) is separate from SRC (where the scripts live): the CI
# fresh-install job and the sandbox probes point MNEMAZINE_ROOT at a throwaway
# clone while the scripts are read from here.
ROOT="${MNEMAZINE_ROOT:-$SRC}"
[ -f "$ROOT/.mnemazine/config.local.sh" ] && . "$ROOT/.mnemazine/config.local.sh"
INBOX="${MNEMAZINE_INBOX:-$ROOT/inbox}"
VAULT="${MNEMAZINE_VAULT:-$ROOT/vault}"
REPORTS="${MNEMAZINE_REPORTS:-$ROOT/reports}"
STATE="${MNEMAZINE_STATE:-$ROOT/.mnemazine/state}"
BIN="$ROOT/.mnemazine/bin"
USER_BIN="$HOME/.local/bin"
DOCTOR="$SRC/scripts/mnemazine-doctor.mjs"

# --check: run the doctor and exit with its code. Read-only, no consent needed.
if [ "$CHECK_ONLY" = "1" ]; then
  exec node "$DOCTOR"
fi

_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "nohash"; fi
}

MANIFEST_PATHS=()
manifest_add() { MANIFEST_PATHS+=("$1"); }
write_manifest() {
  [ "$DRY" = "1" ] && return 0
  local out="$STATE/install-manifest.json" rel sha first=1
  {
    printf '{\n  "root": %s,\n  "paths": [\n' "\"$ROOT\""
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      if [ -f "$ROOT/$rel" ]; then sha="$(_sha256 "$ROOT/$rel")"; else sha="dir"; fi
      [ "$first" = 1 ] || printf ',\n'
      first=0
      printf '    {"path": "%s", "sha256": "%s"}' "$rel" "$sha"
    done < <(printf '%s\n' "${MANIFEST_PATHS[@]}" | LC_ALL=C sort -u)
    printf '\n  ]\n}\n'
  } > "$out"
}

STATUS=0            # 0 ready · 2 degraded · 1 not finished
degrade() { warn "DEGRADED: $1 fix: $2"; [ "$STATUS" -lt 2 ] && STATUS=2; return 0; }
fatal()   { no "$1"; STATUS=1; }

# --- consent: the one gate in front of every write outside the clone. --------
smeta() {
  local n=90 lock="$SRC/requirements.lock"
  [ -f "$lock" ] && n="$(grep -c '==' "$lock" 2>/dev/null || echo 90)"
  b "$(L 'Mnemazine — установка каркаса.' 'Mnemazine — skeleton install.')"
  note "$(L "Python-зависимости: $n пакетов из requirements.lock, ~1.1 ГБ (замер на macOS 22.08.2026)." "Python deps: $n packages from requirements.lock, ~1.1 GB (measured on macOS 2026-08-22).")"
  note "$(L 'markitdown — разбор PDF/DOCX/PPTX/XLSX/HTML; openai-whisper — транскрипт речи; onnxruntime/torch/fastembed — локальные эмбеддинги поиска.' 'markitdown — PDF/DOCX/PPTX/XLSX/HTML parsing; openai-whisper — speech transcript; onnxruntime/torch/fastembed — local search embeddings.')"
  note "$(L 'Тяжёлые: torch, onnxruntime, openai-whisper.' 'Heavy: torch, onnxruntime, openai-whisper.')"
  note "$(L 'Всё ставится локально, наружу ничего не уходит.' 'Everything installs locally; nothing leaves your machine.')"
  note "$(L "Пишем в: $INBOX, $VAULT, $ROOT/.venv, $USER_BIN, $HOME/.claude/skills, $HOME/.codex/skills." "Writes to: $INBOX, $VAULT, $ROOT/.venv, $USER_BIN, $HOME/.claude/skills, $HOME/.codex/skills.")"
}

consent() {
  [ "${MNEMAZINE_YES:-0}" = "1" ] && return 0
  local ans=""
  printf '\n%s ' "$(L 'Поставить каркас? [y/N]:' 'Install the skeleton? [y/N]:')"
  if { exec 3</dev/tty; } 2>/dev/null; then
    read -r ans <&3 || ans=""
    exec 3<&- || true
  else
    read -r ans || ans=""
  fi
  case "$ans" in
    y|Y|yes|Yes|YES|да|Да|д|Д) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$DRY" = "1" ]; then
  b "$(L 'DRY RUN — ничего не ставится и не пишется.' 'DRY RUN — nothing is installed or written.')"
  smeta
elif [ "${MNEMAZINE_FROM_SETUP:-0}" = "1" ]; then
  : # setup.sh already gated consent and printed its own intro
else
  smeta
  if ! consent; then
    no "$(L 'Согласия нет — ничего не поставлено.' 'No consent — nothing installed.')"
    note "$(L 'Обойти вопрос: MNEMAZINE_YES=1 bash install.sh' 'Bypass the prompt: MNEMAZINE_YES=1 bash install.sh')"
    exit 1
  fi
fi

run() { if [ "$DRY" = "1" ]; then printf '  [dry] %s\n' "$*"; else "$@"; fi; }

# --- [1/6] folders ------------------------------------------------------------
stage "1/6" "$(L 'Папки каркаса' 'Skeleton folders')"
for d in "$INBOX" "$VAULT" "$REPORTS" "$STATE" "$BIN" "$USER_BIN" "$ROOT/.mnemazine/cache" \
         "$VAULT/00 System" "$VAULT/01 Concepts" "$VAULT/02 Tools" "$VAULT/03 Agents" "$VAULT/04 Projects" "$VAULT/99 Archive"; do
  run mkdir -p "$d"
  case "$d" in "$ROOT"/*) manifest_add "${d#$ROOT/}" ;; esac
done
ok "$(L 'Папки на месте.' 'Folders ready.')"

# --- [2/6] python deps --------------------------------------------------------
stage "2/6" "$(L 'Python-зависимости' 'Python dependencies')"
if [ "${MNEMAZINE_SKIP_DEPS:-0}" = "1" ]; then
  degrade "$(L 'Python-зависимости пропущены (MNEMAZINE_SKIP_DEPS=1).' 'Python deps skipped (MNEMAZINE_SKIP_DEPS=1).')" "MNEMAZINE_SKIP_DEPS=0 bash install.sh"
elif [ "$DRY" = "1" ]; then
  note "[dry] python3 -m venv .venv && pip install -r requirements.lock"
elif command -v python3 >/dev/null 2>&1; then
  req="$SRC/requirements.lock"; [ -f "$req" ] || req="$SRC/requirements.txt"
  if python3 -m venv "$ROOT/.venv"; then
    if ! "$ROOT/.venv/bin/python" -m pip install --upgrade pip >/dev/null || ! "$ROOT/.venv/bin/python" -m pip install -r "$req"; then
      degrade "$(L "Python-зависимости не встали из $req; локальные движки документов недоступны." "Python deps failed from $req; local document engines unavailable.")" "$ROOT/.venv/bin/python -m pip install -r $req"
      [ "${MNEMAZINE_REQUIRE_PYTHON_DEPS:-0}" = "1" ] && { fatal "$(L 'Python-зависимости обязательны и не встали.' 'Required Python deps failed.')"; }
    else ok "$(L 'Python-зависимости готовы.' 'Python deps ready.')"; fi
  else
    degrade "$(L 'Не удалось создать .venv; локальные движки документов недоступны.' 'Could not create .venv; local document engines unavailable.')" "python3 -m venv $ROOT/.venv"
    [ "${MNEMAZINE_REQUIRE_PYTHON_DEPS:-0}" = "1" ] && fatal "$(L '.venv обязателен.' '.venv is required.')"
  fi
else
  degrade "$(L 'python3 не найден; локальные движки документов недоступны.' 'python3 missing; local document engines unavailable.')" "$(L 'macOS: brew install python@3.11 · Linux: apt install python3' 'macOS: brew install python@3.11 · Linux: apt install python3')"
  [ "${MNEMAZINE_REQUIRE_PYTHON_DEPS:-0}" = "1" ] && fatal "$(L 'python3 обязателен.' 'python3 is required.')"
fi

# --- [3/6] Apple Vision OCR (macOS only) --------------------------------------
stage "3/6" "$(L 'Apple Vision OCR' 'Apple Vision OCR')"
if [ "$DRY" = "1" ]; then
  note "[dry] swiftc -O skills/mnemazine/vision-ocr.swift -o .mnemazine/bin/vision-ocr"
elif command -v swiftc >/dev/null 2>&1 && [ -f "$SRC/skills/mnemazine/vision-ocr.swift" ]; then
  if swiftc -O "$SRC/skills/mnemazine/vision-ocr.swift" -o "$BIN/vision-ocr"; then ok "$(L 'Apple Vision OCR собран.' 'Apple Vision OCR built.')"
  else degrade "$(L 'Сборка Apple Vision OCR провалилась; OCR картинок недоступен.' 'Apple Vision OCR build failed; image OCR unavailable.')" "swiftc -O $SRC/skills/mnemazine/vision-ocr.swift -o $BIN/vision-ocr"; fi
else
  degrade "$(L 'swiftc или исходник Vision отсутствуют; на этом устройстве картинки распознает LLM.' 'swiftc or the Vision source is missing; images are read by the LLM here.')" "xcode-select --install"
fi

# --- [4/6] agent skills (copy into agent homes if present) --------------------
stage "4/6" "$(L 'Скиллы агентов' 'Agent skills')"
copy_skill() { # copy_skill <src> <dest-parent>; warns (not silent) if an existing copy diverges
  local s="$1" parent="$2" name; name="$(basename "$s")"
  local dst="$parent/$name"
  if [ -e "$dst" ] && command -v diff >/dev/null 2>&1 && ! diff -rq "$s" "$dst" >/dev/null 2>&1; then
    warn "$(L "Копия $dst разошлась с репозиторием — обнови вручную." "Copy $dst diverged from the repo — update it manually.")"
    note "rm -rf $dst && cp -R $s $parent/"
    return 0
  fi
  run cp -R "$s" "$parent/"
}
for home in "$HOME/.codex/skills" "$HOME/.claude/skills"; do
  if [ -d "$home" ]; then
    copy_skill "$SRC/skills/mnemazine" "$home"
    copy_skill "$SRC/skills/local-doc-ops" "$home"
    ok "$(L "Скиллы → $home" "Skills → $home")"
  fi
done

# --- [5/6] vault protocol, config, symlinks, pre-commit -----------------------
stage "5/6" "$(L 'Протокол, конфиг, ссылки, pre-commit' 'Protocol, config, links, pre-commit')"
if [ "$DRY" != "1" ]; then
  cat > "$VAULT/00 System/Mnemazine Protocol.md" <<'EOF'
# Mnemazine Protocol

The vault contains finished knowledge only.

Unprocessed captures — OCR text, copied fragments, transcripts, screenshots, and unverified dumps — stay in `inbox/`, `.mnemazine/cache/`, or `99 Archive/`.

Every durable note should contain:

- clear title;
- short explanation;
- source links;
- verified facts;
- open questions;
- practical use;
- related notes.
EOF
  manifest_add "vault/00 System/Mnemazine Protocol.md"
  cat > "$ROOT/.mnemazine/config.json" <<EOF
{
  "root": "$ROOT",
  "inbox": "$INBOX",
  "vault": "$VAULT",
  "reports": "$REPORTS",
  "state": "$STATE",
  "ocr": "$BIN/vision-ocr"
}
EOF
  manifest_add ".mnemazine/config.json"

  # Config: create when absent, otherwise APPEND only the missing keys and never
  # touch a line that is already there (master §17.7: a key added later must not
  # skip everyone who installed earlier).
  cfg="$ROOT/.mnemazine/config.local.sh"
  if [ ! -f "$cfg" ]; then
    cat > "$cfg" <<EOF
# Non-secret local paths. Safe to edit.
export MNEMAZINE_INBOX="$INBOX"
export MNEMAZINE_VAULT="$VAULT"
EOF
    ok "$(L 'Записал config.local.sh' 'Wrote config.local.sh')"
  else
    grep -q '^[[:space:]]*export[[:space:]]*MNEMAZINE_INBOX=' "$cfg" || printf 'export MNEMAZINE_INBOX="%s"\n' "$INBOX" >> "$cfg"
    grep -q '^[[:space:]]*export[[:space:]]*MNEMAZINE_VAULT=' "$cfg" || printf 'export MNEMAZINE_VAULT="%s"\n' "$VAULT" >> "$cfg"
    ok "$(L 'config.local.sh на месте — дописал недостающие ключи, старые не тронул.' 'config.local.sh kept — appended missing keys, existing lines untouched.')"
  fi
  manifest_add ".mnemazine/config.local.sh"

  # Same append-missing-keys treatment for .mnemazine/config.env (from example).
  env_ex="$SRC/.mnemazine/config.env.example"
  env_cfg="$ROOT/.mnemazine/config.env"
  if [ -f "$env_cfg" ] && [ -f "$env_ex" ]; then
    umask 177
    while IFS= read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      key="${line%%=*}"; key="${key# }"
      grep -q "^[[:space:]]*${key}=" "$env_cfg" || printf '%s\n' "$line" >> "$env_cfg"
    done < "$env_ex"
    umask 022
    ok "$(L 'config.env на месте — дописал недостающие ключи.' 'config.env kept — appended missing keys.')"
  fi
else
  note "[dry] write vault protocol, config.json, config.local.sh"
fi

if [ -f "$SRC/bin/mnemazine" ]; then
  run chmod +x "$SRC/bin/mnemazine"
  run ln -sf "$SRC/bin/mnemazine" "$USER_BIN/mnemazine"
  run ln -sf "$SRC/bin/mnemazine" "$USER_BIN/Mnemazine"
fi

# pre-commit = the public-release scanner (CONTRIBUTING.md / SECURITY.md make it
# mandatory). Three rules: honour core.hooksPath; never touch existing hooks;
# back up a pre-commit if one appears later.
install_pre_commit() {
  [ "$DRY" = "1" ] && { note "[dry] install pre-commit = check-public-release.sh"; return 0; }
  git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  local hooks; hooks="$(git -C "$SRC" rev-parse --git-path hooks 2>/dev/null || echo)"
  [ -n "$hooks" ] || return 0
  case "$hooks" in /*) : ;; *) hooks="$SRC/$hooks" ;; esac
  mkdir -p "$hooks"
  local target="$hooks/pre-commit"
  if [ -e "$target" ] && ! grep -q 'check-public-release.sh' "$target" 2>/dev/null; then
    local bak="$target.bak-$(date +%Y%m%d)"
    cp "$target" "$bak"
    note "$(L "Существующий pre-commit сохранён: $bak" "Existing pre-commit backed up: $bak")"
  fi
  cat > "$target" <<EOF
#!/usr/bin/env bash
# Installed by Mnemazine install.sh. Blocks a commit that would ship private data.
exec bash "$SRC/scripts/check-public-release.sh"
EOF
  chmod +x "$target"
  ok "$(L 'pre-commit = проверка публичности.' 'pre-commit = public-release scanner.')"
}
install_pre_commit

# --- schedule (opt-in only; default prints the command) -----------------------
register_schedule() {
  local tpl label plist
  for tpl in "$SRC"/scripts/com.mnemazine.*.plist.template; do
    [ -f "$tpl" ] || continue
    label="$(basename "$tpl" .plist.template)"
    if [ "$(uname)" = "Darwin" ]; then
      plist="$HOME/Library/LaunchAgents/$label.plist"
      if [ "$WITH_SCHEDULE" = "1" ] && [ "$DRY" != "1" ]; then
        mkdir -p "$HOME/Library/LaunchAgents"
        sed "s#__ROOT__#$ROOT#g" "$tpl" > "$plist"
        launchctl unload "$plist" 2>/dev/null || true
        launchctl load "$plist" && ok "$(L "Расписание: $label" "Scheduled: $label")"
      else
        note "$(L "Расписание $label не ставлю. Включить: bash install.sh --with-schedule" "Schedule $label not registered. Enable with: bash install.sh --with-schedule")"
      fi
    else
      note "$(L "На Linux вместо launchd — systemd-таймер для $label." "On Linux use a systemd timer for $label instead of launchd.")"
    fi
  done
}
register_schedule

# --- [6/6] final status = the doctor's contract in three codes ----------------
stage "6/6" "$(L 'Итог' 'Result')"
write_manifest

if [ "$STATUS" = "1" ]; then
  no "$(L 'УСТАНОВКА НЕ ЗАВЕРШЕНА — см. ✗ выше.' 'INSTALL NOT FINISHED — see ✗ above.')"
  note "$(L 'Почини причину и запусти снова. Проверка: npm run doctor' 'Fix the cause and run again. Health check: npm run doctor')"
elif [ "$STATUS" = "2" ]; then
  ok "$(L 'Готово. Часть возможностей недоступна — см. [!] выше.' 'Done. Some capabilities are degraded — see [!] above.')"
  note "$(L "Корень: $ROOT · Inbox: $INBOX · Vault: $VAULT" "Root: $ROOT · Inbox: $INBOX · Vault: $VAULT")"
  note "$(L 'Признак жизни: npm run doctor (или bash install.sh --check)' 'Sign of life: npm run doctor (or bash install.sh --check)')"
else
  ok "$(L 'Готово.' 'Done.')"
  note "$(L "Корень: $ROOT · Inbox: $INBOX · Vault: $VAULT" "Root: $ROOT · Inbox: $INBOX · Vault: $VAULT")"
  note "$(L 'Открой папку vault в Obsidian.' 'Open the vault folder in Obsidian.')"
  note "$(L 'Признак жизни: npm run doctor (или bash install.sh --check)' 'Sign of life: npm run doctor (or bash install.sh --check)')"
fi

# Greet only when run directly. Under setup.sh this is a mid-flow sub-step;
# setup.sh prints the greeting itself at its true end so it is not buried.
[ "${MNEMAZINE_FROM_SETUP:-0}" = "1" ] || [ "$DRY" = "1" ] || bash "$SRC/scripts/hello.sh"

exit "$STATUS"
