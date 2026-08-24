#!/usr/bin/env node
// Readonly-gate (план П08): config/command-surface.json обязан покрывать каждую
// цель package.json, а цели с writes.vault=false доказывают это поведением —
// прогоном по фикстур-корпусу tests/fixtures/readonly/ со снимком содержимого
// до и после. Изменённый/удалённый/добавленный файл фикстуры = провал с именем
// цели. Пустая выборка (0 проверенных целей) = провал: «сдано 0/0» не считается.
//   node scripts/mnemazine-readonly-gate.mjs [--only <цель>] [--help]
//   node scripts/mnemazine-readonly-gate.mjs --selftest
// Коды: 0 — декларация полна и подтверждена поведением; 1 — есть провалы.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const SURFACE = path.join(ROOT, 'config', 'command-surface.json')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'readonly')

const argv = process.argv.slice(2)
const SELFTEST = argv.includes('--selftest')
// Скрытый режим для --selftest: заведомо пишущая «цель». Не для ручного запуска.
const POLLUTE = argv.includes('--pollute')
const ONLY = (() => { const i = argv.indexOf('--only'); return i === -1 ? '' : (argv[i + 1] || '') })()
const TIMEOUT_DEFAULT_SEC = Number(process.env.MNEMAZINE_RO_GATE_TIMEOUT_SEC || '180')

if (argv.includes('--help')) {
  console.log(`mnemazine-readonly-gate.mjs — проверка декларации поверхности команд (П08).

1) Каждая цель package.json обязана иметь строку в config/command-surface.json
   (writes: {vault, repo, home, net} + назначение). Нет строки — exit 1.
2) Каждая цель с writes.vault=false прогоняется по копии фикстур-корпуса
   tests/fixtures/readonly/ со снимком sha256 до и после. Хотя бы один
   изменённый, удалённый или добавленный файл — exit 1 с именем цели.
   Цель с "probe": false пропускается только с "probe_reason".
3) --selftest: временная копия декларации помечает заведомо пишущую цель
   как vault:false, и прибор обязан поймать её кодом 1.

Флаги: --only <цель> — одна цель; --selftest — самопроверка прибора; --help.
Коды возврата: 0 — декларация полна и правдива; 1 — есть провалы.`)
  process.exit(0)
}

if (POLLUTE) {
  const vault = process.env.MNEMAZINE_VAULT
  if (!vault) { console.error('pollute: MNEMAZINE_VAULT не задан'); process.exit(1) }
  await fs.writeFile(path.join(vault, 'ZZ-POLLUTED.md'), 'selftest pollution\n', 'utf8')
  process.exit(0)
}

async function snapshot(dir) {
  const map = new Map()
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(folder, item.name)
      const rel = path.relative(dir, abs)
      if (item.isDirectory()) await walk(abs)
      else if (item.isFile()) {
        const hash = crypto.createHash('sha256').update(await fs.readFile(abs)).digest('hex')
        map.set(rel, hash)
      }
    }
  }
  await walk(dir)
  return map
}

function diffSnapshots(before, after) {
  const added = []
  const removed = []
  const changed = []
  for (const [rel, hash] of after) {
    if (!before.has(rel)) added.push(rel)
    else if (before.get(rel) !== hash) changed.push(rel)
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel)
  return { added, removed, changed }
}

// Детерминированный возраст: ноты старше graph.json — так фикстура
// воспроизводит ветку протухшего маркера complete-check независимо от mtime чекаута.
async function normalizeMtimes(vault) {
  const old = new Date(Date.now() - 2 * 3600 * 1000)
  const fresh = new Date()
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(folder, item.name)
      if (item.isDirectory()) await walk(abs)
      else if (item.isFile()) await fs.utimes(abs, old, old).catch(() => {})
    }
  }
  await walk(vault)
  const graph = path.join(vault, 'graphify-out', 'graph.json')
  await fs.utimes(graph, fresh, fresh).catch(() => {})
}

function runShell(command, env, timeoutSec) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stderrTail = ''
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-2000) })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* уже ушёл */ }
    }, timeoutSec * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, timeout: code === null, stderrTail })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: 1, timeout: false, stderrTail: error.message })
    })
  })
}

async function probeTarget(name, command, decl) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-ro-'))
  try {
    const vault = path.join(tmp, 'vault')
    await fs.cp(FIXTURE, vault, { recursive: true })
    await normalizeMtimes(vault)
    for (const dir of ['inbox', 'state', 'reports']) await fs.mkdir(path.join(tmp, dir), { recursive: true })
    const before = await snapshot(vault)
    const env = {
      MNEMAZINE_VAULT: vault,
      MNEMAZINE_INBOX: path.join(tmp, 'inbox'),
      MNEMAZINE_STATE: path.join(tmp, 'state'),
      MNEMAZINE_REPORTS: path.join(tmp, 'reports'),
      MNEMAZINE_ROOT: ROOT
    }
    const timeoutSec = Number(decl.timeout_sec) > 0 ? Number(decl.timeout_sec) : TIMEOUT_DEFAULT_SEC
    const result = await runShell(command, env, timeoutSec)
    const after = await snapshot(vault)
    const diff = diffSnapshots(before, after)
    const dirt = [...diff.added, ...diff.removed, ...diff.changed]
    return {
      target: name,
      code: result.code,
      timeout: result.timeout,
      dirt,
      detail: dirt.length
        ? `добавлены: ${diff.added.join(', ') || '—'} · удалены: ${diff.removed.join(', ') || '—'} · изменены: ${diff.changed.join(', ') || '—'}`
        : ''
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

function validateSurface(scripts, surface) {
  const errors = []
  for (const name of Object.keys(scripts)) {
    const entry = surface[name]
    if (!entry) { errors.push(`цель «${name}» отсутствует в config/command-surface.json`); continue }
    if (typeof entry.purpose !== 'string' || !entry.purpose.trim()) errors.push(`цель «${name}»: пустое назначение`)
    const writes = entry.writes || {}
    for (const key of ['vault', 'repo', 'home', 'net']) {
      if (typeof writes[key] !== 'boolean') errors.push(`цель «${name}»: writes.${key} не boolean`)
    }
    if (entry.probe === false && !(typeof entry.probe_reason === 'string' && entry.probe_reason.trim())) {
      errors.push(`цель «${name}»: probe=false без probe_reason`)
    }
  }
  for (const name of Object.keys(surface)) {
    if (!Object.hasOwn(scripts, name)) errors.push(`config/command-surface.json: лишняя строка «${name}» — нет такой цели в package.json`)
  }
  return errors
}

async function checkSurface({ scripts, surface, only = '' }) {
  const errors = validateSurface(scripts, surface)
  const violations = []
  const skipped = []
  let probed = 0
  for (const [name, command] of Object.entries(scripts)) {
    const entry = surface[name]
    if (!entry || !entry.writes || entry.writes.vault !== false) continue
    if (only && name !== only) continue
    if (entry.probe === false) { skipped.push(`${name} (${entry.probe_reason})`); continue }
    if (only === '') console.error(`[readonly-gate] probe: ${name}`)
    const verdict = await probeTarget(name, command, entry)
    probed += 1
    if (verdict.timeout) violations.push(`${name}: проба не завершилась за таймаут — замер недействителен`)
    if (verdict.dirt.length) violations.push(`${name}: фикстур-корпус изменён — ${verdict.detail}`)
  }
  if (probed === 0 && !only) errors.push('ноль проверенных целей: пустая выборка — это не «сдано»')
  return { errors, violations, probed, skipped }
}

async function selftest() {
  const scripts = JSON.parse(await fs.readFile(PKG, 'utf8')).scripts || {}
  const surface = JSON.parse(await fs.readFile(SURFACE, 'utf8'))
  const fail = msg => { console.error(`selftest: ${msg}`); process.exit(1) }

  // Заведомо пишущая цель, помеченная vault:false во временной копии декларации.
  const writer = 'zz-selftest-writer'
  const scriptsCopy = { ...scripts, [writer]: `node ${path.join('scripts', 'mnemazine-readonly-gate.mjs')} --pollute` }
  const surfaceCopy = {
    ...surface,
    [writer]: { purpose: 'селф-тест прибора: гарантированно пишет в корпус', writes: { vault: false, repo: false, home: false, net: false } }
  }
  const caught = await checkSurface({ scripts: scriptsCopy, surface: surfaceCopy, only: writer })
  if (caught.probed !== 1) fail(`ожидалась 1 проба, фактически ${caught.probed}`)
  if (!caught.violations.some(v => v.startsWith(`${writer}:`))) {
    fail(`прибор не поймал заведомо пишущую цель (violations: ${JSON.stringify(caught.violations)})`)
  }

  // Пустая выборка — провал, а не «сдано 0/0».
  const allWriting = Object.fromEntries(Object.entries(surfaceCopy).map(([name, entry]) => [name, { ...entry, writes: { ...entry.writes, vault: true } }]))
  const empty = await checkSurface({ scripts: scriptsCopy, surface: allWriting })
  if (!empty.errors.some(e => e.includes('ноль проверенных'))) fail('пустая выборка не дала ошибку «ноль проверенных целей»')

  console.log(JSON.stringify({ ok: true, caught_writer: true, empty_selection_rejected: true }, null, 2))
}

async function main() {
  const scripts = JSON.parse(await fs.readFile(PKG, 'utf8')).scripts || {}
  const surface = await fs.readFile(SURFACE, 'utf8').then(JSON.parse).catch(error => {
    console.error(`config/command-surface.json нечитаем: ${error.message}`)
    process.exit(1)
  })
  const { errors, violations, probed, skipped } = await checkSurface({ scripts, surface, only: ONLY })
  const failures = [...errors, ...violations]
  console.log(JSON.stringify({
    ok: failures.length === 0,
    targets_total: Object.keys(scripts).length,
    probed,
    skipped,
    failures
  }, null, 2))
  if (failures.length) process.exit(1)
}

if (SELFTEST) {
  await selftest()
} else {
  await main()
}
