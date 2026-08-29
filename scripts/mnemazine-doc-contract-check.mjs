#!/usr/bin/env node
// Документация отвечает за свои слова (план П11, метод-правило 12 — честная граница).
//
// Выводимая часть (всегда блокирующая):
//   - каждая `npm run <target>` из README.md/README.ru.md/docs/*.md существует в package.json,
//     и файл, на который цель указывает, отслеживается git. Извлекается любой непробельный
//     токен цели (кириллица/юникод тоже, не только латиница) с обрезкой оправы по краям;
//     несуществующая цель → провал с именем цели и файлом:строкой. Легальные плейсхолдеры —
//     только через явный PLACEHOLDER_TARGETS, не смягчением regex;
//   - каждый упомянутый scripts/<file> существует и отслеживается git;
//   - путь vault из README сходится с DEFAULT_VAULT (scripts/mnemazine-paths.mjs).
// Объявленная часть: config/doc-claims.json — {claim, command, expect_exit, enforcement}.
//   Блокирующий claim с несходящимся кодом → провал; warn → предупреждение. Claim с
//   execute:false не исполняется (например doctor: он сам гоняет release-check — рекурсия).
//
// Коды: 2 — ноль извлеченных утверждений; 1 — любой блокирующий провал; 0 — иначе.

import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DEFAULT_VAULT } from './mnemazine-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAIMS = path.join(ROOT, 'config', 'doc-claims.json')

function gitTracked() {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`)
  return new Set(r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
}

function docSources() {
  const files = []
  for (const rel of ['README.md', 'README.ru.md']) {
    const p = path.join(ROOT, rel)
    if (existsSync(p)) files.push({ name: rel, text: readFileSync(p, 'utf8') })
  }
  // Только отслеживаемые docs/*.md (git ls-files исключает игнорируемые PLAN-*.md).
  const r = spawnSync('git', ['ls-files', 'docs/*.md'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status === 0) {
    for (const rel of r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const p = path.join(ROOT, rel)
      if (existsSync(p)) files.push({ name: rel, text: readFileSync(p, 'utf8') })
    }
  }
  return files
}

function pkgScripts() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {}
}

function targetFile(command) {
  const m = String(command).match(/(scripts|tests)\/[A-Za-z0-9_.-]+\.(mjs|js|py|sh)/)
  return m ? m[0] : null
}

// Легальные плейсхолдеры-примеры: явный список с причиной, НЕ regex-помягчение.
// Пусто — в проверяемых доках (README*, tracked docs/*.md) реальных плейсхолдеров нет.
// Появится `npm run <foo>` как пример — вписать сюда цель + причину, не расширять regex.
const PLACEHOLDER_TARGETS = new Map(/* [target, reason] */)

// Захват любого непробельного токена после `npm run ` (ловит кириллицу/юникод, не только латиницу),
// затем обрезка «оправы» — бэктиков, кавычек, скобок, знаков препинания — по краям.
// Внутренние `:`/`-`/`.`/`_` (audit:vault, graph:semantic:async, last-run) сохраняются.
const EDGE = /^[`"'([{<.,;:)\]}>»«]+|[`"'([{<.,;:)\]}>»«]+$/g
function normTarget(raw) {
  return raw.replace(EDGE, '')
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

// Выводимая часть. Возвращает {checked, failures}.
function checkOutput({ docs, scripts, tracked }) {
  const failures = []
  let checked = 0
  for (const { name, text } of docs) {
    for (const m of text.matchAll(/npm run (\S+)/g)) {
      const target = normTarget(m[1])
      if (!target) continue
      checked++
      if (PLACEHOLDER_TARGETS.has(target)) continue
      const at = `${name}:${lineOf(text, m.index)}`
      if (!(target in scripts)) { failures.push(`${at}: npm run ${target} — цели нет в package.json`); continue }
      const file = targetFile(scripts[target])
      if (file && !tracked.has(file)) failures.push(`${at}: npm run ${target} → ${file} не отслеживается git`)
    }
    for (const m of text.matchAll(/(?:scripts|tests)\/[A-Za-z0-9_.-]+\.(?:mjs|js|py|sh)/g)) {
      checked++
      const file = m[0]
      if (!tracked.has(file)) failures.push(`${name}:${lineOf(text, m.index)}: упомянут ${file}, не отслеживается git`)
    }
  }
  return { checked, failures }
}

function checkVaultPath(docs) {
  const failures = []
  const readme = docs.find(d => d.name === 'README.md')
  if (!readme) return { checked: 0, failures }
  const m = readme.text.match(/~\/[^\s`"'\n]*\/vault\b/)
  if (!m) return { checked: 0, failures }
  const declared = path.basename(m[0])
  const expected = path.basename(DEFAULT_VAULT)
  if (declared !== expected) {
    failures.push(`README путь vault "${m[0]}" (basename ${declared}) расходится с DEFAULT_VAULT (basename ${expected})`)
  }
  return { checked: 1, failures }
}

function runClaims(claimsCfg) {
  const claims = Array.isArray(claimsCfg?.claims) ? claimsCfg.claims : []
  const failures = []
  const warnings = []
  let checked = 0
  for (const c of claims) {
    if (c.execute === false) continue
    checked++
    const [cmd, ...args] = c.command
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
    const code = r.status == null ? 1 : r.status
    if (code !== c.expect_exit) {
      const line = `claim "${c.claim}" → код ${code}, ожидался ${c.expect_exit}`
      if (c.enforcement === 'warn') warnings.push(line)
      else failures.push(line)
    }
  }
  return { checked, failures, warnings }
}

function loadClaims() {
  if (!existsSync(CLAIMS)) return { claims: [] }
  try { return JSON.parse(readFileSync(CLAIMS, 'utf8')) } catch (e) { return { claims: [], _error: e.message } }
}

function selftest() {
  // Красные кролики: несуществующая npm-цель обязана покраснеть — латинская И кириллическая
  // (кириллица — тот самый пропуск, что дал ложный зеленый до фикса), с именем цели и строкой.
  const scripts = pkgScripts()
  const tracked = gitTracked()
  const cases = [
    { label: 'латиница', target: 'totally-nonexistent-target-xyz' },
    { label: 'кириллица', target: 'несуществующая-цель-п11' },
  ]
  for (const { label, target } of cases) {
    const docs = [{ name: 'README.md', text: `# X\nline2\nRun \`npm run ${target}\` to break.\n` }]
    const { failures } = checkOutput({ docs, scripts, tracked })
    const hit = failures.find(f => f.includes(target))
    if (!hit) {
      console.error(`selftest FAILED: красный кролик (${label}: ${target}) прошел зеленым`)
      return 1
    }
    if (!/README\.md:\d+:/.test(hit)) {
      console.error(`selftest FAILED: провал без файла:строки — "${hit}"`)
      return 1
    }
  }
  console.log('selftest ok: несуществующая npm-цель (латиница+кириллица) краснит с файлом:строкой')
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())

  const docs = docSources()
  const scripts = pkgScripts()
  const tracked = gitTracked()
  const claims = loadClaims()

  const out = checkOutput({ docs, scripts, tracked })
  const vault = checkVaultPath(docs)
  const declared = runClaims(claims)

  const totalChecked = out.checked + vault.checked + declared.checked
  if (totalChecked === 0) { console.error('ноль извлеченных утверждений'); process.exit(2) }

  const failures = [...out.failures, ...vault.failures, ...declared.failures]
  for (const w of declared.warnings) console.error(`warn: ${w}`)
  if (claims._error) console.error(`warn: config/doc-claims.json нечитаем: ${claims._error}`)

  if (failures.length) {
    console.error('ПРОВАЛЫ:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`doc-contract ok: проверено утверждений ${totalChecked}, предупреждений ${declared.warnings.length}`)
  process.exit(0)
}

main()
