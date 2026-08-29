#!/usr/bin/env node
// Проверка, что проверки живы (план П11, прием 34 — молчание конвейера ≠ исправность).
//
//  - реестр checks из mnemazine-release-check.mjs печатается и сверяется: каждая
//    зарегистрированная проверка ссылается на определенную функцию, и каждый новый скрипт
//    волны 2 (пять мета-приборов П11; model-pin — когда П09 закрыт) зарегистрирован;
//  - задания launchd com.mnemazine.*: последний код возврата из launchctl list; состояние в
//    .mnemazine/state/checks-inventory.json с first_red_at; красным становится задание,
//    висящее с ненулевым кодом дольше N дней (по умолчанию 1).
//  - стык с П01: он выгружает задания на время работ. При .mnemazine/state/rebuild/П01.done.json
//    без restored:true отсутствие задания — quarantined, не провал; после restored:true — провал.
//
// Коды: 0 — все живо; 1 — мертвая ссылка/незарегистрированный прибор/задание красное дольше N
// дней/пропавшее задание вне карантина; 2 — ноль найденных проверок в реестре.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_CHECK = path.join(ROOT, 'scripts', 'mnemazine-release-check.mjs')
const INVENTORY = path.join(ROOT, 'config', 'checks-inventory.json')
const STATE = path.join(ROOT, '.mnemazine', 'state', 'checks-inventory.json')
const TELEGRAM_BLOCKED = path.join(ROOT, '.mnemazine', 'state', 'telegram-blocked.json')
const REBUILD = path.join(ROOT, '.mnemazine', 'state', 'rebuild')
const REQUIRED_WAVE2 = ['rules-inventory', 'doc-contract-check', 'single-truth-check', 'lesson-gate', 'checks-inventory']
const RED_DAYS = Number(process.env.MNEMAZINE_CHECK_RED_DAYS || 1)

// --- реестр release-check ---
function evaluateRegistry(source, required) {
  const failures = []
  const block = source.match(/const checks\s*=\s*\[([\s\S]*?)\n\s*\]/)
  if (!block) return { code: 2, names: [], failures: ['реестр checks не найден в release-check'] }
  const names = []
  for (const m of block[1].matchAll(/\[\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\]/g)) {
    const [, name, fn] = m
    names.push(name)
    const defined = new RegExp(`(?:async\\s+)?function\\s+${fn}\\b|const\\s+${fn}\\s*=`).test(source)
    if (!defined) failures.push(`проверка '${name}' ссылается на неопределенную функцию ${fn}`)
  }
  if (names.length === 0) return { code: 2, names, failures: ['ноль найденных проверок в реестре'] }
  for (const r of required) if (!names.includes(r)) failures.push(`прибор волны 2 не зарегистрирован в release-check: ${r}`)
  return { code: failures.length ? 1 : 0, names, failures }
}

// --- задания launchd ---
// Признак машины владельца: маркер П01-перестройки. Он gitignored (в клон/форк/CI
// не попадает по построению), поэтому его НАЛИЧИЕ детерминированно отличает живую
// машину владельца от постороннего клона. Есть маркер → задания launchd обязаны быть
// живы (dead-man's switch владельца, проверки строги). Нет → это форк/CI, где
// launchd-конвейера Mnemazine нет по построению: owner-ops проверки не применимы —
// skipped-as-not-applicable с явной строкой, НЕ красное и НЕ молчаливый пропуск (П22).
function ownerMachine() {
  return existsSync(path.join(REBUILD, 'П01.done.json'))
}

function quarantineActive() {
  const marker = path.join(REBUILD, 'П01.done.json')
  if (!existsSync(marker)) return false
  try { return JSON.parse(readFileSync(marker, 'utf8')).restored !== true } catch { return true }
}

function expectedJobs() {
  if (existsSync(INVENTORY)) {
    try {
      const labels = JSON.parse(readFileSync(INVENTORY, 'utf8')).launchd_labels
      if (Array.isArray(labels) && labels.length) return labels
    } catch {}
  }
  const before = path.join(REBUILD, 'launchd-before.json')
  if (existsSync(before)) {
    try {
      const labels = JSON.parse(readFileSync(before, 'utf8')).labels
      if (Array.isArray(labels) && labels.length) return labels
    } catch {}
  }
  return ['com.mnemazine.kb-lint', 'com.mnemazine.kb-yt-watch', 'com.mnemazine.telegram-sync']
}

function launchAgentsDir() {
  return path.join(process.env.HOME || '', 'Library', 'LaunchAgents')
}

function plistPath(label) {
  return path.join(launchAgentsDir(), `${label}.plist`)
}

function livePlistLabels() {
  const dir = launchAgentsDir()
  if (!dir || !existsSync(dir)) return []
  const r = spawnSync('find', [dir, '-maxdepth', '1', '-name', 'com.mnemazine.*.plist', '-print'], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split(/\r?\n/).filter(Boolean).map((p) => path.basename(p, '.plist'))
}

function telegramFirstSeen() {
  if (!existsSync(TELEGRAM_BLOCKED)) return null
  try {
    const first = JSON.parse(readFileSync(TELEGRAM_BLOCKED, 'utf8')).first_seen
    return Number.isFinite(Date.parse(first)) ? first : null
  } catch {
    return null
  }
}

// label → last exit code (number) или null если не загружено
function launchdExitCodes() {
  const map = new Map()
  if (process.platform !== 'darwin') return map
  const r = spawnSync('launchctl', ['list'], { encoding: 'utf8' })
  if (r.status !== 0) return map
  for (const line of r.stdout.split(/\r?\n/)) {
    const cols = line.split(/\t/)
    if (cols.length >= 3 && cols[2].startsWith('com.mnemazine.')) {
      const code = Number(cols[1])
      map.set(cols[2], Number.isFinite(code) ? code : null)
    }
  }
  return map
}

function loadState() {
  if (!existsSync(STATE)) return { jobs: {} }
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { jobs: {} } }
}

function saveState(state) {
  try { mkdirSync(path.dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)) } catch {}
}

function evaluateLaunchd(nowMs) {
  const failures = []
  const notes = []
  if (!ownerMachine()) {
    notes.push('owner-ops launchd: не применимо — нет .mnemazine/state/rebuild/П01.done.json (форк/CI, не машина владельца)')
    return { failures, notes }
  }
  if (process.platform !== 'darwin') { notes.push('не darwin: задания launchd не проверяются'); return { failures, notes } }
  const quarantined = quarantineActive()
  const loaded = launchdExitCodes()
  const state = loadState()
  const expected = expectedJobs()
  const expectedSet = new Set(expected)
  state.jobs = state.jobs || {}
  for (const label of livePlistLabels()) {
    if (!expectedSet.has(label)) failures.push(`${label}: plist есть в ~/Library/LaunchAgents, но метки нет в config/checks-inventory.json`)
  }
  for (const label of expected) {
    if (!loaded.has(label)) {
      if (quarantined) { notes.push(`${label}: отсутствует — quarantined (П01)`); delete state.jobs[label] }
      else if (existsSync(plistPath(label))) failures.push(`${label}: plist есть, но задание не загружено после restored:true`)
      else failures.push(`${label}: нет plist и нет задания после restored:true`)
      continue
    }
    const code = loaded.get(label)
    if (code === 0 || code == null) { delete state.jobs[label]; notes.push(`${label}: код ${code}`); continue }
    const rec = state.jobs[label] || { first_red_at: label === 'com.mnemazine.telegram-sync' ? (telegramFirstSeen() || new Date(nowMs).toISOString()) : new Date(nowMs).toISOString() }
    state.jobs[label] = rec
    const ageDays = (nowMs - Date.parse(rec.first_red_at)) / 86400000
    if (ageDays > RED_DAYS) failures.push(`${label}: код ${code} держится ${ageDays.toFixed(1)} дн (> ${RED_DAYS})`)
    else notes.push(`${label}: код ${code}, красное ${ageDays.toFixed(1)} дн (порог ${RED_DAYS}, пока grace)`)
  }
  saveState(state)
  return { failures, notes }
}

function selftest() {
  // Красный кролик: реестр без обязательного прибора обязан покраснеть.
  const fake = "const checks = [\n  ['syntax', checkSyntax],\n]\nfunction checkSyntax(){}\n"
  const r = evaluateRegistry(fake, REQUIRED_WAVE2)
  if (r.code === 0) { console.error('selftest FAILED: реестр без мета-приборов прошел зеленым'); return 1 }
  console.log('selftest ok: незарегистрированный прибор волны 2 краснит')
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())
  if (!existsSync(RELEASE_CHECK)) { console.error('release-check не найден'); process.exit(2) }
  const reg = evaluateRegistry(readFileSync(RELEASE_CHECK, 'utf8'), REQUIRED_WAVE2)
  if (reg.code === 2) { console.error(reg.failures.join('\n')); process.exit(2) }
  const jobs = evaluateLaunchd(Date.now())

  console.log(`реестр проверок: ${reg.names.length} (${reg.names.join(', ')})`)
  for (const n of jobs.notes) console.log(`  ${n}`)
  const failures = [...reg.failures, ...jobs.failures]
  if (failures.length) {
    console.error('ПРОВАЛЫ:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('все проверки живы')
  process.exit(0)
}

main()
