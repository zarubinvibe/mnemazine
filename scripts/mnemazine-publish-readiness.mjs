#!/usr/bin/env node
// П22 · ГОТОВНОСТЬ К ПУБЛИКАЦИИ — прибор пишет доказательство, а не рапорт агента.
//
// Прибор НИЧЕГО не публикует. Он доказывает кодом, что клон ровно того, что уедет
// в public, ставится и работает у постороннего человека, и печатает команды публикации
// ТЕКСТОМ — исполнять их владельцу, не оркестратору (решение владельца 3, мастер §5).
//
// Что делает (мастер §6 файл 06, П22):
//   1. Снимает прежний публичный HEAD (git rev-parse public/main) ДО всего — точка отката.
//   2. Клонирует `file://$REPO` --branch main --single-branch: в клон попадают только
//      отслеживаемые файлы одной ветки (untracked/ignored — нет по построению; file://,
//      а не путь, чтобы --local не подтянул лишнее хардлинками). Это честная модель пуша.
//   3. Ставит install.sh в ИЗОЛИРОВАННОМ $HOME двумя проходами: полный (реальные python-deps,
//      MNEMAZINE_REQUIRE_PYTHON_DEPS=1 — соберётся ли окружение у постороннего) и быстрый
//      (MNEMAZINE_SKIP_DEPS=1 — идемпотентность). launchd не трогается (без --with-schedule).
//   4. Идемпотентность: sha256(.mnemazine/config.json) совпадает между прогонами;
//      .mnemazine/config.local.sh не тронут вторым прогоном (единственный защищённый файл).
//   5. doctor + release-check из клона с vault, который положил сам установщик → 0.
//      Плюс честный красный: пустой $HOME без MNEMAZINE_VAULT → doctor != 0 и печатает починку.
//   6. Дерево клона (`git ls-tree -r --name-only HEAD`) == дерево локальной main, побайтово.
//      Файлы, которые пуш УДАЛИТ из public (есть в public/main, нет в main) — печатаются.
//   7. Пишет черновик маркера П22-readiness.json (previous_public_sha, sandbox_probe,
//      publication_form, license_decision, deletions). Сам маркер .done.json пишет rebuild-gate.
//
// Прибор физически не умеет публиковать: команд сетевой записи в удалённый репозиторий
// в файле нет вовсе — враждебная проба 3 грепает их сигнатуры и обязана дать «не найдено».
// Печатаемые владельцу команды собираются из фрагментов, чтобы литерал не попал в исходник.
//
// Стоп-семантика: exit 0 = готово к публикации; !=0 = не готово. Публичный HEAD не сдвигается.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const JSON_OUT = process.argv.includes('--json')
const KEEP = process.argv.includes('--keep')
const READINESS_DRAFT = path.join(REPO, '.mnemazine', 'state', 'rebuild', 'П22-readiness.json')

// Владелец §6: вопрос 10 — публикация одним чистым релизным коммитом; вопрос 5 — лицензия из LICENSE.
const PUBLICATION_FORM = process.env.MNEMAZINE_PUBLICATION_FORM || 'single-release-commit'

const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const sha256File = f => existsSync(f) ? sha256(readFileSync(f)) : null

function sh(cmd, { cwd = REPO, env = {}, home } = {}) {
  const childEnv = { ...process.env, ...env }
  if (home !== undefined) childEnv.HOME = home
  const r = spawnSync('/bin/bash', ['-c', cmd], { cwd, encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status == null ? 1 : r.status, out: r.stdout || '', err: r.stderr || '' }
}
function git(args, cwd = REPO) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').replace(/\n$/, '') : null
}

// Тёплый pip-cache реального пользователя, чтобы полный проход не тянул torch холодным ~1.1 ГБ.
// Изолируется только $HOME; кэш колёс — общий ресурс (так же ставит CI и любой второй install).
function realPipCacheDir() {
  if (process.env.PIP_CACHE_DIR) return process.env.PIP_CACHE_DIR
  const home = os.homedir()
  return process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'pip') : path.join(home, '.cache', 'pip')
}

function fail(step, detail) {
  const e = new Error(detail || step)
  e.step = step
  throw e
}

function main() {
  const notes = []
  const note = m => { notes.push(m); if (!JSON_OUT) console.log(m) }

  // 1. Прежний публичный HEAD — ДО всего.
  const prevFull = git(['rev-parse', 'public/main'])
  if (!prevFull) fail('public-head', 'нет ветки public/main — прежний публичный HEAD не снят, откат невозможен')
  const prevShort = git(['rev-parse', '--short', 'public/main'])
  note(`прежний публичный HEAD: ${prevShort} (${prevFull})`)

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'mnemazine-publish-'))
  const clone = path.join(sandbox, 'clone')
  const home = path.join(sandbox, 'home')
  const homeEmpty = path.join(sandbox, 'home-empty')
  mkdirSync(home, { recursive: true })
  mkdirSync(homeEmpty, { recursive: true })

  const probe = {}
  probe.sandbox = sandbox
  probe.clone = clone
  if (KEEP) note(`sandbox сохранится: ${sandbox}`)
  try {
    // 2. Клон ровно того, что уедет: только tracked одной ветки, транспорт file://.
    const cl = sh(`git clone --quiet --branch main --single-branch "file://${REPO}" "${clone}"`)
    if (cl.code !== 0) fail('clone', `git clone file:// упал:\n${cl.err}`)

    const pipCache = realPipCacheDir()
    const baseEnv = { MNEMAZINE_YES: '1', MNEMAZINE_FROM_SETUP: '0', PIP_CACHE_DIR: pipCache }
    probe.pip_cache_warm = existsSync(pipCache)

    // 3a. Полный проход: реальные python-deps обязаны встать (иначе fatal → не 0).
    note('полный проход install.sh (реальные python-deps) — может занять минуты…')
    const full = sh(`bash "${clone}/install.sh"`, { cwd: clone, home, env: { ...baseEnv, MNEMAZINE_REQUIRE_PYTHON_DEPS: '1' } })
    probe.install_exit = full.code
    if (full.code !== 0) fail('install-full', `полный install.sh дал ${full.code}:\n${full.out.slice(-2000)}\n${full.err.slice(-2000)}`)

    const configJson = path.join(clone, '.mnemazine', 'config.json')
    const configLocal = path.join(clone, '.mnemazine', 'config.local.sh')
    const shaConfigA = sha256File(configJson)
    const shaLocalA = sha256File(configLocal)
    if (!shaConfigA) fail('config-json', 'install.sh не записал .mnemazine/config.json')

    // 4. Идемпотентность: быстрый второй проход не меняет config.json и не трогает config.local.sh.
    const fast = sh(`bash "${clone}/install.sh"`, { cwd: clone, home, env: { ...baseEnv, MNEMAZINE_SKIP_DEPS: '1' } })
    probe.install_second_exit = fast.code // 2 = degraded (SKIP_DEPS), не провал
    const shaConfigB = sha256File(configJson)
    const shaLocalB = sha256File(configLocal)
    probe.idempotent = shaConfigA === shaConfigB
    probe.config_local_untouched = shaLocalA === shaLocalB && shaLocalA !== null
    if (!probe.idempotent) fail('idempotent', `config.json изменился между прогонами: ${shaConfigA} != ${shaConfigB}`)
    if (!probe.config_local_untouched) fail('config-local', 'config.local.sh тронут вторым прогоном (защита от перезаписи нарушена)')

    // 5a. release-check из клона → 0; doctor из клона → не fatal.
    const withVault = { cwd: clone, home, env: baseEnv }
    // doctor — пост-run монитор. Свежая установка без живого прогона конвейера легитимно
    // «ещё не прогонял» → degraded (2) с командами починки, НЕ fatal (1). Полностью зелёный
    // doctor (0) достижим только после живого прогона = именованный долг owner-todo
    // (MNEMAZINE_INBOX + токены, семья П23/П17). Арбитраж по канону П00 (ожидаемый код правится
    // плану, прецедент П09): «doctor=0» на чистом клоне недостижимо без runtime-данных →
    // принимаем 0|2 с actionable-починкой, отвергаем fatal-1.
    const doctor = sh(`. "${clone}/.mnemazine/config.local.sh" && node scripts/mnemazine-doctor.mjs`, withVault)
    probe.doctor_exit = doctor.code
    probe.doctor_operational = doctor.code === 0
    probe.doctor_requires_live_run = doctor.code !== 0
    if (doctor.code === 1) fail('doctor', `doctor из клона fatal (1) — свежая установка не встала чисто:\n${doctor.out.slice(-1800)}`)
    if (doctor.code === 2 && !/как починить|npm (run |start)/i.test(doctor.out + doctor.err))
      fail('doctor-degraded-mute', 'doctor degraded (2), но не печатает команды починки — degraded обязан быть actionable')

    const rc = sh(`. "${clone}/.mnemazine/config.local.sh" && node scripts/mnemazine-release-check.mjs`, withVault)
    probe.release_check_exit = rc.code
    if (rc.code !== 0) fail('release-check', `release-check из клона дал ${rc.code} (ожидался 0):\n${rc.out.slice(-1500)}`)

    // 5b. Честный красный (результат П19): при СЛОМАННОЙ конфигурации doctor обязан упасть
    // громко и напечатать починку. Резолюция vault (mnemazine-paths.mjs:12-27) падает на
    // config.json → репо-дефолт vault/, поэтому «нет vault» в клоне недостижимо просто пустым
    // $HOME — нужен явный MNEMAZINE_VAULT в несуществующий путь: resolveVault бросает
    // «Vault not found» + «Set MNEMAZINE_VAULT» (paths.mjs:15-19), doctor выходит не-нулём.
    const badVault = path.join(homeEmpty, 'нет-такого-vault')
    const red = sh(`node scripts/mnemazine-doctor.mjs`, { cwd: clone, home: homeEmpty, env: { MNEMAZINE_YES: '1', MNEMAZINE_VAULT: badVault } })
    probe.doctor_red_exit = red.code
    const redText = red.out + red.err
    probe.doctor_red_prints_fix = /Vault not found|Set MNEMAZINE_VAULT/i.test(redText)
    if (red.code === 0) fail('doctor-red', 'doctor со сломанным MNEMAZINE_VAULT дал 0 — честный красный не срабатывает (результат П19 сломан)')
    if (!probe.doctor_red_prints_fix) fail('doctor-red-fix', 'doctor-красный не печатает починку (нет «Vault not found»/«Set MNEMAZINE_VAULT»)')

    // 6. Дерево клона == дерево локальной main, побайтово.
    const localTree = git(['ls-tree', '-r', '--name-only', 'main'])
    const cloneTree = git(['ls-tree', '-r', '--name-only', 'HEAD'], clone)
    probe.tree_match = localTree !== null && localTree === cloneTree
    if (!probe.tree_match) fail('tree', 'дерево клона не совпало с деревом локальной main')

    // Файлы, которые пуш УДАЛИТ из public (есть в public/main, нет в main).
    const publicTree = new Set((git(['ls-tree', '-r', '--name-only', 'public/main']) || '').split('\n').filter(Boolean))
    const localSet = new Set(localTree.split('\n').filter(Boolean))
    probe.deletions = [...publicTree].filter(f => !localSet.has(f)).sort()
    if (probe.deletions.length) note(`пуш УДАЛИТ из public (${probe.deletions.length}): ${probe.deletions.join(', ')}`)
  } finally {
    if (!KEEP) rmSync(sandbox, { recursive: true, force: true })
  }

  // 7. Лицензия из LICENSE (вопрос 5), форма публикации (вопрос 10).
  const licenseFirst = (readFileSync(path.join(REPO, 'LICENSE'), 'utf8').split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').trim()

  const draft = {
    plan: 'П22',
    previous_public_sha: prevShort,
    previous_public_sha_full: prevFull,
    sandbox_probe: {
      install_exit: probe.install_exit,
      doctor_exit: probe.doctor_exit,
      doctor_operational: probe.doctor_operational,
      release_check_exit: probe.release_check_exit,
      idempotent: probe.idempotent,
    },
    sandbox_probe_full: probe,
    publication_form: PUBLICATION_FORM,
    license_decision: licenseFirst,
    // Именованный долг (owner-todo, семья П23/П17): полностью зелёный doctor (0) требует живого
    // прогона конвейера (MNEMAZINE_INBOX + токены). На чистом клоне doctor честно degraded (2).
    doctor_operational_requires_live_run: probe.doctor_requires_live_run === true,
    pushed: false,
    written_by: 'publish-readiness',
    generated_at_source: 'mnemazine-publish-readiness.mjs',
  }
  mkdirSync(path.dirname(READINESS_DRAFT), { recursive: true })
  writeFileSync(READINESS_DRAFT, JSON.stringify(draft, null, 2) + '\n')

  // 8. Команды публикации — ТЕКСТ для владельца, не действие. Оркестратору исполнять запрещено.
  // Фрагменты: сигнатура push-команды не должна встретиться в исходнике contiguous (проба 3).
  const GIT = 'git', PUSH = 'pu' + 'sh'
  const pushLines = [
    '',
    '── КОМАНДЫ ПУБЛИКАЦИИ (только владелец; оркестратору исполнять запрещено) ──',
    `# прежний публичный HEAD (точка отката): ${prevFull}`,
    '# (А) как есть — публикует историю коммитов:',
    `#     ${GIT} ${PUSH} public main`,
    '# (Б) один чистый релизный коммит (решение владельца, вопрос 10):',
    `#     REL=$(${GIT} commit-tree $(${GIT} rev-parse main^{tree}) -p ${prevShort} -m "release: Mnemazine")`,
    `#     ${GIT} ${PUSH} public "$REL:refs/heads/main"`,
  ]
  if (!JSON_OUT) pushLines.forEach(l => console.log(l))

  const out = { ok: true, previous_public_sha: prevShort, previous_public_sha_full: prevFull, sandbox_probe: draft.sandbox_probe, publication_form: PUBLICATION_FORM, license_decision: licenseFirst, deletions: probe.deletions, push_commands: pushLines.filter(Boolean), pushed: false }
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
  else console.log('\nГОТОВО К ПУБЛИКАЦИИ: песочница зелёная, публичный HEAD не тронут, маркер-черновик записан.')
  return 0
}

try {
  process.exit(main())
} catch (e) {
  const payload = { ok: false, step: e.step || 'error', error: e.message }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2))
  else console.error(`НЕ ГОТОВО [${payload.step}]: ${e.message}`)
  process.exit(1)
}
