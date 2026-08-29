#!/usr/bin/env node
// Урок обязан быть правилом — но не задним числом (план П11, метод-правило 13).
//
// Читает леджер уроков ТОЛЬКО на чтение (живой <vault>/99 Система/_session-learning-ledger.jsonl
// либо MNEMAZINE_LEDGER для проб на копии). У записей с ts не раньше отсечки
// (config/doc-claims.json → lesson_schema_since) обязаны быть cause/fix/rule/supersedes.
// Отсечка измерена: в живом леджере 29 записей и ни одна этих полей не несет; проверка без
// отсечки покраснела бы на историческом корпусе и была бы отключена в первый же день.
// При rule_kind:"executable" файл из enforced_by существует и проходит node --check / bash -n.
//
// Коды: 0 — нарушений нет (в т.ч. ноль записей после отсечки: за ночь урока может не случиться;
//        а также нейтральный репо-дефолт vault/ без леджера — у фикстуры учиться нечему, проверять нечего);
// 1 — запись после отсечки без обязательного поля либо enforced_by на мертвый/непроходящий файл;
// 2 — леджера нет или он пуст ПРИ ЯВНО заданном корпусе (MNEMAZINE_VAULT/MNEMAZINE_LEDGER или config ≠ дефолт):
//        назвали живой vault, а прибора в нем нет — это поломка, не «все хорошо».

import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveVault, DEFAULT_VAULT } from './mnemazine-paths.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED = ['cause', 'fix', 'rule', 'supersedes']
const REBUILD = path.join(ROOT, '.mnemazine', 'state', 'rebuild')

function ownerMachine() {
  return existsSync(path.join(REBUILD, 'П01.done.json'))
}

// Живой леджер + «явность» корпуса. MNEMAZINE_LEDGER — проба на копии (явная).
// Иначе <vault>/99 Система/…; корпус явный, когда MNEMAZINE_VAULT или config.vault
// уводят с нейтрального репо-дефолта vault/ (resolved ≠ DEFAULT_VAULT). Явность
// решает код при отсутствии/пустоте леджера: фикстура → 0, живой корпус → 2.
function resolveLedger() {
  if (process.env.MNEMAZINE_LEDGER) return { path: process.env.MNEMAZINE_LEDGER, explicit: true }
  const vault = resolveVault({ requireExists: false })
  return { path: path.join(vault, '99 Система', '_session-learning-ledger.jsonl'), explicit: vault !== DEFAULT_VAULT }
}

function cutoff() {
  const claimsPath = path.join(ROOT, 'config', 'doc-claims.json')
  if (existsSync(claimsPath)) {
    try {
      const since = JSON.parse(readFileSync(claimsPath, 'utf8')).lesson_schema_since
      if (since) return String(since)
    } catch {}
  }
  return '2026-08-22'
}

function syntaxOk(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
  if (!existsSync(abs)) return false
  const ext = path.extname(abs)
  if (ext === '.mjs' || ext === '.js') return spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' }).status === 0
  if (ext === '.sh') return spawnSync('bash', ['-n', abs], { encoding: 'utf8' }).status === 0
  if (ext === '.py') return spawnSync('python3', ['-m', 'py_compile', abs], { encoding: 'utf8' }).status === 0
  return true
}

function enforcedByLive(anchor) {
  const rel = String(anchor || '').replace(/:\d+$/, '')
  if (!rel) return `enforced_by пуст`
  if (!existsSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel))) return `enforced_by файл отсутствует: ${rel}`
  if (!syntaxOk(rel)) return `enforced_by не проходит синтаксис: ${rel}`
  return null
}

// {code, checked, after, failures}
function evaluate(ledgerPath, since, explicit) {
  if (!existsSync(ledgerPath)) {
    if (explicit && !ownerMachine()) {
      return { code: 0, checked: 0, after: 0, failures: [], skip: 'owner-ops lesson ledger: skipped-as-not-applicable — нет .mnemazine/state/rebuild/П01.done.json (форк/CI, не машина владельца)' }
    }
    if (!explicit) return { code: 0, checked: 0, after: 0, failures: [], skip: 'нейтральный репо-дефолт vault/ без леджера — учиться нечему' }
    return { code: 2, failures: [`леджер отсутствует: ${ledgerPath}`] }
  }
  const raw = readFileSync(ledgerPath, 'utf8')
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) {
    if (!explicit) return { code: 0, checked: 0, after: 0, failures: [], skip: 'леджер пуст (репо-дефолт) — проверять нечего' }
    return { code: 2, failures: ['леджер пуст'] }
  }

  const failures = []
  let after = 0
  for (const [i, line] of lines.entries()) {
    let obj
    try { obj = JSON.parse(line) } catch { failures.push(`строка ${i + 1}: не JSON`); continue }
    const ts = String(obj.ts || '')
    if (!ts || ts < since) continue
    after++
    for (const k of REQUIRED) {
      if (!(k in obj) || obj[k] == null || obj[k] === '') failures.push(`запись ts=${ts}: нет обязательного поля "${k}"`)
    }
    if (obj.rule_kind === 'executable') {
      const why = enforcedByLive(obj.enforced_by)
      if (why) failures.push(`запись ts=${ts}: ${why}`)
    }
  }
  return { code: failures.length ? 1 : 0, checked: lines.length, after, failures }
}

function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lesson-gate-selftest-'))
  try {
    const led = path.join(tmp, 'ledger.jsonl')
    // Красный кролик: запись ПОСЛЕ отсечки без поля fix обязана покраснеть.
    writeFileSync(led, JSON.stringify({ ts: '2999-01-01', cause: 'x', rule: 'y', supersedes: '' }) + '\n', 'utf8')
    const r = evaluate(led, '2026-08-22', true)
    if (r.code !== 1) { console.error(`selftest FAILED: красный кролик прошел (code=${r.code})`); return 1 }
    console.log('selftest ok: урок после отсечки без обязательного поля краснит')
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())
  const { path: ledgerPath, explicit } = resolveLedger()
  const since = cutoff()
  const r = evaluate(ledgerPath, since, explicit)
  if (r.code === 2) { console.error(r.failures.join('\n')); process.exit(2) }
  if (r.skip) { console.log(`леджер: ${ledgerPath}\n${r.skip} (code 0)`); process.exit(0) }
  console.log(`леджер: ${ledgerPath}\nотсечка: ${since}; записей всего ${r.checked}, после отсечки ${r.after}`)
  if (r.failures.length) {
    console.error('ПРОВАЛЫ:')
    for (const f of r.failures) console.error(`  - ${f}`)
  } else {
    console.log('уроки после отсечки соответствуют схеме (либо их нет)')
  }
  process.exit(r.code)
}

main()
