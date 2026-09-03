#!/usr/bin/env node
// Одна правда (план П11, метод-правило 8). Ловит СОДЕРЖАТЕЛЬНЫЙ дубль, а не различие хешей.
//
//  - CLAUDE.md/AGENTS.md: одна обязана быть указателем (симлинк или ≤5 строк, называющие
//    другую), другая — каноном. Требование черновика «sha256(A)!=sha256(B)→1» ПЕРЕВЕРНУТО:
//    оно закрепляло дубль. П05 сделал указателем CLAUDE.md (канон — AGENTS.md); прибор
//    распознает указатель в любую сторону. Оба указателя / канон схлопнулся / нет указателя → 1.
//  - enum SPEC_TYPES (mnemazine-note-spec.mjs) сходится с таблицей docs/NOTE-SPEC.md и с любой
//    второй литеральной копией; расхождение → 1.
//  - knowledge-note, встреченный в приемке или человеческом гейте при отсутствии в SPEC_TYPES → 1.
//  - две одноименные функции strictKnowledgeReady с разным телом → 1.
//
// Коды: 0 — одна правда; 1 — дубль/расхождение; 2 — ноль сравненных пар.

import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEC_TYPES } from './mnemazine-note-spec.mjs'

import { listTreeFiles } from './mnemazine-tracked-files.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNERS_WITH_FILE_ARG = new Set(['node', 'bash', 'sh', 'python', 'python3'])
const REPO_FILE_PREFIXES = ['scripts/', 'tests/', 'workflows/', 'skills/']
const PACKAGE_SCRIPT_FILE_EXCEPTIONS = [
  // { target: 'имя-цели', path: 'generated/file', reason: 'почему файл не отслеживается' }
]

function readSafe(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }

// Указатель: симлинк (цель — по readlink) либо ≤5 непустых строк, называющие .md-файл.
function pointerTarget(absPath, text) {
  try { if (lstatSync(absPath).isSymbolicLink()) return path.basename(readlinkSync(absPath)) } catch {}
  const nonEmpty = String(text).split(/\r?\n/).filter(l => l.trim())
  if (nonEmpty.length <= 5) {
    const m = String(text).match(/([A-Za-z0-9._-]+\.md)/)
    return m ? m[1] : null
  }
  return null
}

// {ok, reason}. ok=true когда ровно одна — указатель на другую, вторая — канон.
function evaluatePair(claudePath, agentsPath) {
  const cText = readSafe(claudePath)
  const aText = readSafe(agentsPath)
  if (!cText && !aText) return { present: false }
  const cTarget = pointerTarget(claudePath, cText)
  const aTarget = pointerTarget(agentsPath, aText)
  const cIsPtr = cTarget !== null
  const aIsPtr = aTarget !== null
  if (cIsPtr && !aIsPtr && cTarget === path.basename(agentsPath)) return { present: true, ok: true }
  if (aIsPtr && !cIsPtr && aTarget === path.basename(claudePath)) return { present: true, ok: true }
  return {
    present: true,
    ok: false,
    reason: `нет валидного указателя CLAUDE.md↔AGENTS.md: одна должна быть указателем (≤5 строк/симлинк на другую), другая — каноном (ptr C→${cTarget}, ptr A→${aTarget})`
  }
}

function parseNoteSpecTypes() {
  const p = path.join(ROOT, 'docs', 'NOTE-SPEC.md')
  if (!existsSync(p)) return null
  const types = []
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([a-z][a-z-]*)`\s*\|/)
    if (m) types.push(m[1])
  }
  return types.length ? new Set(types) : null
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function scriptFiles() {
  return readdirSync(path.join(ROOT, 'scripts'))
    .filter(f => f.endsWith('.mjs'))
    .map(f => path.join('scripts', f))
}

function secondEnumLiteralMismatch() {
  const failures = []
  for (const rel of scriptFiles()) {
    if (rel.endsWith('mnemazine-note-spec.mjs')) continue
    const text = readFileSync(path.join(ROOT, rel), 'utf8')
    const m = text.match(/SPEC_TYPES\s*=\s*new Set\(\[([^\]]*)\]/)
    if (!m) continue
    const members = new Set(m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
    if (!setsEqual(members, SPEC_TYPES)) failures.push(`вторая литеральная копия SPEC_TYPES в ${rel} расходится с mnemazine-note-spec.mjs`)
  }
  return failures
}

function knowledgeNoteLeak() {
  const failures = []
  if (SPEC_TYPES.has('knowledge-note')) return failures
  for (const rel of ['scripts/mnemazine-release-check.mjs', 'scripts/mnemazine-human-layer-gate.mjs']) {
    const p = path.join(ROOT, rel)
    if (existsSync(p) && readFileSync(p, 'utf8').includes('knowledge-note')) {
      failures.push(`тип knowledge-note защищается в ${rel}, но отсутствует в SPEC_TYPES`)
    }
  }
  return failures
}

function extractFunctionBody(text, startIdx) {
  const open = text.indexOf('{', startIdx)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i) }
  }
  return text.slice(open + 1)
}

function strictKnowledgeReadyDivergence() {
  const defs = []
  for (const rel of scriptFiles()) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8')
    const m = text.match(/(?:export\s+)?function\s+strictKnowledgeReady\b|const\s+strictKnowledgeReady\s*=/)
    if (m) defs.push({ rel, body: extractFunctionBody(text, m.index).replace(/\s+/g, ' ').trim() })
  }
  if (defs.length <= 1) return []
  const distinct = new Set(defs.map(d => d.body))
  if (distinct.size > 1) return [`strictKnowledgeReady определена в ${defs.length} местах с разным телом: ${defs.map(d => d.rel).join(', ')}`]
  return []
}

function shTokens(command) {
  const tokens = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|[^\s]+/g
  for (const m of String(command).matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[0])
  return tokens
}

function normalizeRepoPath(token) {
  let rel = String(token).replace(/^\.\/+/, '')
  if (!rel || rel.startsWith('-') || path.isAbsolute(rel) || /[*?[\]{}$`]/.test(rel)) return null
  rel = path.posix.normalize(rel)
  if (rel === '.' || rel.startsWith('../') || rel.includes('/../')) return null
  return rel
}

function looksLikeRepoFileArg(token) {
  const rel = normalizeRepoPath(token)
  if (!rel) return null
  if (REPO_FILE_PREFIXES.some(prefix => rel.startsWith(prefix))) return rel
  if (!rel.includes('/') && /\.(?:sh|mjs|js|cjs|py)$/.test(rel)) return rel
  return null
}

function packageScriptFileRefs(scripts) {
  const refs = []
  for (const [target, command] of Object.entries(scripts || {})) {
    const tokens = shTokens(command)
    for (let i = 0; i < tokens.length; i++) {
      const runner = path.basename(tokens[i])
      if (!RUNNERS_WITH_FILE_ARG.has(runner)) continue
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j]
        if (/^(?:&&|\|\||;|\|)$/.test(token)) break
        if (token.startsWith('-')) continue
        const rel = looksLikeRepoFileArg(token)
        if (rel) refs.push({ target, path: rel })
        break
      }
    }
  }
  return refs
}

function packageScriptExceptionSet() {
  const failures = []
  const allowed = new Set()
  for (const e of PACKAGE_SCRIPT_FILE_EXCEPTIONS) {
    if (!e?.target || !e?.path || !e?.reason) {
      failures.push('PACKAGE_SCRIPT_FILE_EXCEPTIONS: каждая строка обязана иметь target, path, reason')
      continue
    }
    allowed.add(`${e.target}\0${normalizeRepoPath(e.path)}`)
  }
  return { failures, allowed }
}

function packageScriptTrackedPathFailures(scripts, tracked, fileExists = rel => existsSync(path.join(ROOT, rel))) {
  const { failures, allowed } = packageScriptExceptionSet()
  for (const ref of packageScriptFileRefs(scripts)) {
    if (allowed.has(`${ref.target}\0${ref.path}`)) continue
    if (!tracked.has(ref.path)) failures.push(`package.json:${ref.target} → ${ref.path}: файл не в git ls-files`)
    else if (!fileExists(ref.path)) failures.push(`package.json:${ref.target} → ${ref.path}: файл отслеживается, но отсутствует на диске`)
  }
  return failures
}

function gitTrackedFiles() {
  // Вне репозитория (распакованный релиз) состав дерева говорит диск: см.
  // mnemazine-tracked-files.mjs. Иначе проверка ссылок package.json падала бы
  // у каждого, кто скачал архив, а не клонировал.
  return new Set(listTreeFiles(ROOT).files)
}

function packageScriptTrackedPathCheck() {
  const p = path.join(ROOT, 'package.json')
  if (!existsSync(p)) return ['package.json отсутствует']
  const pkg = JSON.parse(readFileSync(p, 'utf8'))
  return packageScriptTrackedPathFailures(pkg.scripts || {}, gitTrackedFiles())
}

function evaluate() {
  const failures = []
  let pairs = 0 // число сравненных категорий (не число провалов)

  const pair = evaluatePair(path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'AGENTS.md'))
  if (pair.present) { pairs++; if (!pair.ok) failures.push(pair.reason) }

  const docTypes = parseNoteSpecTypes()
  if (docTypes) { pairs++; if (!setsEqual(docTypes, SPEC_TYPES)) failures.push(`SPEC_TYPES ${[...SPEC_TYPES].sort().join(',')} != таблица NOTE-SPEC ${[...docTypes].sort().join(',')}`) }

  pairs++; failures.push(...secondEnumLiteralMismatch())
  pairs++; failures.push(...knowledgeNoteLeak())
  pairs++; failures.push(...strictKnowledgeReadyDivergence())
  pairs++; failures.push(...packageScriptTrackedPathCheck())

  if (pairs === 0) return { code: 2, failures: ['ноль сравненных пар'] }
  return { code: failures.length ? 1 : 0, failures, pairs }
}

function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'single-truth-selftest-'))
  try {
    const body = '# Canon\n\n' + Array.from({ length: 10 }, (_, i) => `Rule line ${i} with real content.`).join('\n') + '\n'
    writeFileSync(path.join(tmp, 'CLAUDE.md'), body, 'utf8')
    writeFileSync(path.join(tmp, 'AGENTS.md'), body, 'utf8')
    const pair = evaluatePair(path.join(tmp, 'CLAUDE.md'), path.join(tmp, 'AGENTS.md'))
    if (pair.ok) { console.error('selftest FAILED: два одинаковых канона прошли зеленым'); return 1 }
    const failures = packageScriptTrackedPathFailures({
      'graph:clean': 'python3 scripts/graphify_clean.py',
      'combo': 'node scripts/ok.mjs && bash install.sh',
      'delegated': 'npm run release-check'
    }, new Set(['scripts/ok.mjs', 'install.sh']), rel => rel !== 'scripts/graphify_clean.py')
    if (!failures.some(f => f.includes('graph:clean') && f.includes('scripts/graphify_clean.py'))) {
      console.error('selftest FAILED: неотслеживаемая цель package.json не покраснела')
      return 1
    }
    if (failures.some(f => f.includes('combo') || f.includes('delegated'))) {
      console.error('selftest FAILED: валидная или npm-делегированная цель покраснела')
      return 1
    }
    console.log('selftest ok: содержательный дубль CLAUDE/AGENTS краснит')
    console.log('selftest ok: package.json file targets должны быть tracked')
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())
  const r = evaluate()
  if (r.failures?.length) {
    console.error('ПРОВАЛЫ:')
    for (const f of r.failures) console.error(`  - ${f}`)
  } else {
    console.log(`одна правда: сравнено пар ${r.pairs}, расхождений нет`)
  }
  process.exit(r.code)
}

main()
