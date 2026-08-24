#!/usr/bin/env bash
# Shared terminal UI helpers for install.sh and setup.sh. Sourced, never run.
# Bilingual: MNEMAZINE_LANG is ru|en, chosen once from the locale. A public
# repo defaults to English so the first question a stranger sees is in English.

# Locale → language, one case. Explicit MNEMAZINE_LANG wins; otherwise ru_* → ru.
case "${MNEMAZINE_LANG:-}" in
  ru|en) : ;;
  *)
    case "${LC_ALL:-}${LANG:-}" in
      ru_*|ru|*ru_RU*|*ru.*) MNEMAZINE_LANG=ru ;;
      *) MNEMAZINE_LANG=en ;;
    esac
    ;;
esac
export MNEMAZINE_LANG

# L "<ru>" "<en>": echo the string for the active language (no trailing newline).
L() { if [ "$MNEMAZINE_LANG" = ru ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

b()    { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note() { printf '  • %s\n' "$*"; }
warn() { printf '  \033[33m[!]\033[0m %s\n' "$*"; }
# stage "<n/total>" "<title>" — numbered with a denominator so progress is legible.
stage() { printf '\n\033[1m\033[36m── %s %s ──\033[0m %s\n' "$(L 'Этап' 'Stage')" "$1" "$2"; }
miss()  { printf '\n  \033[33m%s\033[0m %s\n' "$1" "${2:-}"; }
halt()  { printf '\n\033[1m%s\033[0m\n' "$(L 'Установи это и запусти снова — продолжим со следующего этапа.' 'Install this, run again — we continue from the next stage.')"; exit 1; }
