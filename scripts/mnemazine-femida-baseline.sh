#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THEMIS_ROOT="${THEMIS_ROOT:-../themis}"
OUT="$ROOT/.mnemazine/state/rebuild/femida-baseline.json"
MD_OUT="$ROOT/.mnemazine/state/rebuild/femida-baseline.md"
VERIFY=0

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/mnemazine-femida-baseline.sh [--out PATH] [--md PATH]
  bash scripts/mnemazine-femida-baseline.sh --verify [--out PATH]
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      OUT="${2:?--out needs path}"
      shift 2
      ;;
    --md)
      MD_OUT="${2:?--md needs path}"
      shift 2
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$THEMIS_ROOT" ]; then
  echo "missing themis repo: $THEMIS_ROOT" >&2
  exit 2
fi

if [ "$VERIFY" = "1" ] && [ ! -s "$OUT" ]; then
  echo "missing baseline: $OUT" >&2
  exit 2
fi

owner_launchd_json() {
  local count plist mtime uid label print last_exit_code
  uid="$(id -u)"
  label="themis.morning-briefing"
  count="$(/bin/launchctl list 2>/dev/null | grep -c themis || true)"
  print="$(/bin/launchctl print "gui/$uid/$label" 2>/dev/null || true)"
  if [ "$count" = "0" ] && [ -n "$print" ]; then
    count=1
  fi
  last_exit_code="$(printf '%s\n' "$print" | awk -F'= ' '/last exit code = / {print $2; exit}')"
  plist="$HOME/Library/LaunchAgents/themis.morning-briefing.plist"
  if [ -e "$plist" ]; then
    mtime="$(/usr/bin/stat -f %m "$plist")"
  else
    mtime=""
  fi
  node -e 'const count=Number(process.argv[1]||0); const raw=process.argv[2]||""; const label=process.argv[3]||null; const last=process.argv[4]||""; process.stdout.write(JSON.stringify({count, plist_mtime: raw === "" ? null : Number(raw), label: count ? label : null, last_exit_code: last === "" ? null : Number(last)}));' "$count" "$mtime" "$label" "$last_exit_code"
}

make_sandbox() {
  local sbx
  sbx="$(mktemp -d)"
  mkdir -p "$sbx/home" "$sbx/shim" "$sbx/themis"
  git -C "$THEMIS_ROOT" archive HEAD | tar -x -C "$sbx/themis"

  for name in pip3 pip launchctl brew xcode-select; do
    cat > "$sbx/shim/$name" <<SHIM
#!/usr/bin/env bash
printf '%s %s\n' "\$(basename "\$0")" "\$*" >> "$sbx/trace.log"
exit 0
SHIM
    chmod +x "$sbx/shim/$name"
  done

  cat > "$sbx/shim/swiftc" <<SHIM
#!/usr/bin/env bash
printf '%s %s\n' "\$(basename "\$0")" "\$*" >> "$sbx/trace.log"
out=""
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "-o" ]; then
    out="\$arg"
    break
  fi
  prev="\$arg"
done
if [ -n "\$out" ]; then
  mkdir -p "\$(dirname "\$out")"
  printf '#!/usr/bin/env sh\nexit 0\n' > "\$out"
fi
exit 0
SHIM
  chmod +x "$sbx/shim/swiftc"

  if [ -n "${MNEMAZINE_FEMIDA_BASELINE_DROP_SHIM:-}" ]; then
    case "$MNEMAZINE_FEMIDA_BASELINE_DROP_SHIM" in
      pip3|pip|launchctl|swiftc|brew|xcode-select)
        rm -f "$sbx/shim/$MNEMAZINE_FEMIDA_BASELINE_DROP_SHIM"
        ;;
      *)
        echo "unknown shim for drop probe: $MNEMAZINE_FEMIDA_BASELINE_DROP_SHIM" >&2
        return 2
        ;;
    esac
  fi

  printf '%s\n' "$sbx"
}

require_shims() {
  local sbx="$1" name resolved
  for name in pip3 pip launchctl swiftc brew xcode-select; do
    if [ ! -x "$sbx/shim/$name" ]; then
      echo "нет шима на $name" >&2
      return 1
    fi
    resolved="$(PATH="$sbx/shim:$PATH" command -v "$name" 2>/dev/null || true)"
    if [ "$resolved" != "$sbx/shim/$name" ]; then
      echo "нет шима на $name: PATH резолвит ${resolved:-ничего}" >&2
      return 1
    fi
  done
}

write_stub_doctor() {
  local sbx="$1" rc="$2"
  cat > "$sbx/themis/scripts/setup_doctor.py" <<PY
#!/usr/bin/env python3
print("stub doctor rc=$rc")
raise SystemExit($rc)
PY
  chmod +x "$sbx/themis/scripts/setup_doctor.py"
}

run_install() {
  local sbx="$1" output="$2"
  require_shims "$sbx"
  set +e
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" THEMIS_YES=1 bash install.sh
  ) > "$output" 2>&1
  local rc=$?
  set -e
  printf '%s\n' "$rc"
}

measure_once() {
  local owner_json sbx original_doctor help_rc silent_rc red_rc warn_rc doctor_rc selftest_rc
  local help_before warn_form warnings_without_fix linux_replacements install_lines themis_head themis_has_ci
  owner_json="$(owner_launchd_json)"
  sbx="$(make_sandbox)"
  cp "$sbx/themis/scripts/setup_doctor.py" "$sbx/original_setup_doctor.py"

  require_shims "$sbx"
  set +e
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" bash install.sh --help
  ) > "$sbx/help.txt" 2>&1
  help_rc=$?
  set -e
  help_before="$(awk 'index($0, "bash install.sh [") {print NR - 1; found=1; exit} END {if (!found) print "null"}' "$sbx/help.txt")"

  require_shims "$sbx"
  set +e
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" bash install.sh </dev/null
  ) > "$sbx/silent.txt" 2>&1
  silent_rc=$?
  set -e
  find "$sbx/home" -mindepth 1 -print | sed "s|^$sbx/home/||" | LC_ALL=C sort > "$sbx/home_paths.txt"

  write_stub_doctor "$sbx" 1
  red_rc="$(run_install "$sbx" "$sbx/install_red.txt")"

  write_stub_doctor "$sbx" 2
  warn_rc="$(run_install "$sbx" "$sbx/install_warn.txt")"
  if grep -q "УСТАНОВКА НЕ ЗАВЕРШЕНА" "$sbx/install_warn.txt"; then
    warn_form="УСТАНОВКА НЕ ЗАВЕРШЕНА"
  elif grep -q "Готово. Дальше:" "$sbx/install_warn.txt"; then
    warn_form="Готово. Дальше:"
  else
    warn_form="не найдено"
  fi

  cp "$sbx/original_setup_doctor.py" "$sbx/themis/scripts/setup_doctor.py"
  set +e
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" python3 scripts/setup_doctor.py
  ) > "$sbx/doctor.txt" 2>&1
  doctor_rc=$?
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" python3 scripts/setup_doctor.py --selftest
  ) > "$sbx/selftest.txt" 2>&1
  selftest_rc=$?
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" python3 scripts/setup_doctor.py --json --offline
  ) > "$sbx/doctor.json" 2>/dev/null
  (
    cd "$sbx/themis" || exit 99
    HOME="$sbx/home" PATH="$sbx/shim:$PATH" python3 scripts/setup_doctor.py --platform linux --offline --json
  ) > "$sbx/linux.json" 2>/dev/null
  set -e

  warnings_without_fix="$(node - "$sbx/doctor.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const rep = JSON.parse(fs.readFileSync(p, 'utf8'));
const checks = rep['проверки'] || [];
const n = checks.filter(c => c['статус'] !== 'ок' && !String(c['как починить'] || '').trim()).length;
process.stdout.write(String(n));
NODE
)"
  linux_replacements="$(node - "$sbx/linux.json" <<'NODE'
const fs = require('fs');
const rep = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const notes = rep['платформенные особенности'] || [];
const text = notes.join('\n').toLowerCase();
const ok = {
  apple_vision: text.includes('apple vision') && text.includes('markitdown'),
  scheduler: text.includes('systemd'),
  cyrillic_paths: text.includes('utf-8')
};
process.stdout.write(JSON.stringify(ok));
NODE
)"

  install_lines="$(wc -l < "$sbx/themis/install.sh" | tr -d ' ')"
  themis_head="$(git -C "$THEMIS_ROOT" rev-parse --short HEAD)"
  if [ -d "$sbx/themis/.github" ]; then
    themis_has_ci=true
  else
    themis_has_ci=false
  fi

  node - "$sbx" "$owner_json" "$themis_head" "$themis_has_ci" "$install_lines" \
    "$help_rc" "$help_before" "$silent_rc" "$red_rc" "$warn_rc" "$doctor_rc" "$selftest_rc" \
    "$warn_form" "$warnings_without_fix" "$linux_replacements" <<'NODE'
const fs = require('fs');
const path = require('path');
const [
  sbx, ownerRaw, themisHead, themisHasCiRaw, installLinesRaw, helpRcRaw,
  helpBeforeRaw, silentRcRaw, redRcRaw, warnRcRaw, doctorRcRaw, selfRcRaw,
  warnForm, warningsWithoutFixRaw, linuxReplacementsRaw
] = process.argv.slice(2);
const readLines = p => fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
  : [];
const lastNonEmpty = p => {
  const lines = readLines(p);
  return lines.length ? lines[lines.length - 1] : '';
};
const installLines = readLines(path.join(sbx, 'install_warn.txt')).concat(readLines(path.join(sbx, 'install_red.txt')));
const steps = [];
for (const line of installLines) {
  const m = line.match(/^\[(.+?)\]/);
  if (m) {
    const step = `[${m[1]}]`;
    if (!steps.includes(step)) steps.push(step);
  }
}
const trace = readLines(path.join(sbx, 'trace.log')).map(line => line.split(sbx).join('<SBX>'));
const helpBefore = helpBeforeRaw === 'null' ? null : Number(helpBeforeRaw);
const obj = {
  taken_at: new Date().toISOString(),
  themis_head: themisHead,
  themis_has_ci: themisHasCiRaw === 'true',
  install_lines: Number(installLinesRaw),
  help_rc: Number(helpRcRaw),
  help_lines_before_usage: helpBefore,
  silent_rc: Number(silentRcRaw),
  home_paths_created_on_silence: readLines(path.join(sbx, 'home_paths.txt')),
  install_rc_when_doctor_red: Number(redRcRaw),
  install_rc_when_doctor_warn: Number(warnRcRaw),
  doctor_rc: Number(doctorRcRaw),
  doctor_selftest_rc: Number(selfRcRaw),
  steps_seen: steps,
  shim_calls: trace,
  warnings_without_fix: Number(warningsWithoutFixRaw),
  owner_launchd_before: JSON.parse(ownerRaw)
};
obj._observations = {
  doctor_red_last_line: lastNonEmpty(path.join(sbx, 'install_red.txt')),
  doctor_warn_result_phrase: warnForm,
  linux_replacements_named: JSON.parse(linuxReplacementsRaw)
};
process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
NODE
}

write_markdown() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<'MD'
НАСЛЕДУЕМ:
- ${THEMIS_ROOT}/install.sh:300-354 — смета до первого действия.
- ${THEMIS_ROOT}/install.sh:356-385 — гейт согласия читает `/dev/tty`, а текст отказа называет обход `THEMIS_YES=1 bash install.sh`.
- ${THEMIS_ROOT}/install.sh:401 — нумерация шага со знаменателем `[1/7]`.
- ${THEMIS_ROOT}/install.sh:429 — нумерация шага со знаменателем `[2/7]`.
- ${THEMIS_ROOT}/install.sh:451 — нумерация шага со знаменателем `[3/7]`.
- ${THEMIS_ROOT}/install.sh:462 — нумерация шага со знаменателем `[4/7]`.
- ${THEMIS_ROOT}/install.sh:468 — нумерация шага со знаменателем `[5/7]`.
- ${THEMIS_ROOT}/install.sh:474 — нумерация шага со знаменателем `[6/7]`.
- ${THEMIS_ROOT}/install.sh:488 — промежуточный шаг `[6.5]` явно назван.
- ${THEMIS_ROOT}/install.sh:498 — промежуточный шаг `[6.6]` явно назван.
- ${THEMIS_ROOT}/install.sh:521 — финальная проверка `[7/7]`.
- ${THEMIS_ROOT}/install.sh:445 — предупреждение дает копируемую команду `xcode-select --install` / `swiftc ...`.
- ${THEMIS_ROOT}/install.sh:455 — предупреждение дает копируемую команду `brew install ffmpeg`.
- ${THEMIS_ROOT}/install.sh:507 — предупреждение дает копируемую команду `launchctl load ...`.
- ${THEMIS_ROOT}/install.sh:540 — доктор вызывается последним проверочным шагом.
- ${THEMIS_ROOT}/scripts/setup_doctor.py:30-31 — контракт трех кодов возврата.
- ${THEMIS_ROOT}/scripts/setup_doctor.py:486 — selftest доктора есть отдельным режимом.
- ${THEMIS_ROOT}/scripts/setup_doctor.py:446-450 — чужая платформа подставляется флагом `--platform`.
- ${THEMIS_ROOT}/scripts/update.sh:29-30 — обновление перечисляет только системные пути, `cases/` и `knowledge/` не трогает.

НЕ НАСЛЕДУЕМ:
- ${THEMIS_ROOT}/install.sh:554 — нет `exit` кодом доктора; последняя команда `echo`, поэтому красный доктор не становится кодом установщика.
- ${THEMIS_ROOT}/install.sh:544 — код 2 доктора трактуется как «Готово», потому что сравнение есть только со строкой `1`.
- ${THEMIS_ROOT}/install.sh:283-292 — `--help` разбирается после длинной прозы.
- ${THEMIS_ROOT}/install.sh:13-276 — приветственный блок печатается до `--help`.
- ${THEMIS_ROOT}/install.sh:402-406 — `pip3` ставит зависимости мимо venv.
- ${THEMIS_ROOT}/install.sh:3 — есть только `set -e`, нет `set -u` и `pipefail`.
- ${THEMIS_ROOT}/scripts/pd_guard.py:581-592 — git-хуки перезаписываются без бэкапа.
- ${THEMIS_ROOT}/install.sh:8-11 — RU/EN выбирается по локали, но паритет текстов ничем не проверяется.
- ${THEMIS_ROOT}/scripts/setup_doctor.py:474 — число проверок печатается из фактического списка, но заявленное «118 проверок» нигде не считается и отдельным инвариантом не держится.
- ${THEMIS_ROOT}/install.sh:540 — приемка числа проверок доктора не подключена к установке.
- ${THEMIS_ROOT}/scripts/pd_guard.py:627 — приемка числа проверок доктора не подключена к git-хукам.
MD
}

compare_json() {
  local expected="$1" actual="$2"
  node - "$expected" "$actual" <<'NODE'
const fs = require('fs');
const [aPath, bPath] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
const mandatory = [
  'taken_at',
  'themis_head',
  'themis_has_ci',
  'install_lines',
  'help_rc',
  'help_lines_before_usage',
  'silent_rc',
  'home_paths_created_on_silence',
  'install_rc_when_doctor_red',
  'install_rc_when_doctor_warn',
  'doctor_rc',
  'doctor_selftest_rc',
  'steps_seen',
  'shim_calls',
  'warnings_without_fix',
  'owner_launchd_before'
];
const diffs = [];
for (const key of mandatory) {
  if (!(key in a)) diffs.push(`missing baseline key: ${key}`);
  if (!(key in b)) diffs.push(`missing actual key: ${key}`);
}
if (a.themis_has_ci !== false) {
  diffs.push(`themis_has_ci must be false, got ${JSON.stringify(a.themis_has_ci)}`);
}
for (const key of Object.keys(a)) {
  if (key === 'taken_at') continue;
  const av = JSON.stringify(a[key]);
  const bv = JSON.stringify(b[key]);
  if (av !== bv) diffs.push(`${key}: expected ${av}, got ${bv}`);
}
if (diffs.length) {
  console.error(diffs.join('\n'));
  process.exit(1);
}
NODE
}

if [ "$VERIFY" = "1" ]; then
  tmp="$(mktemp)"
  measure_once > "$tmp"
  compare_json "$OUT" "$tmp"
  echo "femida baseline verify ok"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
measure_once > "$OUT"
write_markdown "$MD_OUT"
echo "wrote $OUT"
echo "wrote $MD_OUT"
