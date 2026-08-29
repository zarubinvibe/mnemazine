#!/usr/bin/env node
// Правило без прибора становится ошибкой сборки (план П11, метод-правило 3).
//
// Каждое императивное предложение из CLAUDE.md/AGENTS.md (must / must not / never /
// do not / обязан / обязательно / никогда / не должен) обязано иметь запись в
// config/rules-enforcement.json с живым `enforced_by` (<файл>:<строка> — файл есть,
// строка в диапазоне, файл проходит node --check / bash -n / python3 -m py_compile).
// Форма «утверждение → якорь в отдельном json», а НЕ `enforced_by:` внутри CLAUDE.md:
// глобальная конституция держит бюджет ≤200 строк, машинные якоря ее ломают.
//
// Новые правила мастер-плана §17.8 (класс данных) и §18 (subject) заведены сразу,
// с полем pending_until: пока маркера их плана нет на диске — мертвый enforced_by не
// краснит; с маркером — краснит. Так правило не теряется между волнами и не блокирует
// их порядок.
//
// Коды: 0 — все правила имеют живой прибор; 1 — правило без записи, либо запись с
// мертвым файлом/несуществующей строкой/непроходящим синтаксисом; 2 — ноль извлеченных
// правил (пустая выборка = провал, не «сдано 0/0»).

import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC_FILES = ['CLAUDE.md', 'AGENTS.md']
const ENFORCEMENT = path.join(ROOT, 'config', 'rules-enforcement.json')
const KEYWORDS = /\b(must not|must|never|do not|обязан|обязательно|никогда|не должен)\b/i

// Мягкий перенос строки внутри абзаца или пункта списка — не конец предложения.
// Публичный контракт в AGENTS.md написан пунктами с переносом, и построчная нарезка
// резала правило пополам: хвост «...and the release gate blocks a push...» оставался
// без ключевого слова и вообще не попадал в выборку. Сначала склеиваем продолжение
// с началом блока, потом режем на предложения.
function unwrapBlocks(text) {
  const blocks = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('```')) { blocks.push(''); continue }
    const startsBlock = /^([-*+]|\d+\.)\s/.test(line) || line.startsWith('>') || line.startsWith('|')
    const prev = blocks.length - 1
    if (!startsBlock && prev >= 0 && blocks[prev]) blocks[prev] += ` ${line}`
    else blocks.push(line)
  }
  return blocks.filter(Boolean)
}

function splitSentences(text) {
  const out = []
  for (const block of unwrapBlocks(text)) {
    for (const piece of block.split(/(?<=[.!?;])\s+/)) {
      const t = piece.trim()
      if (t) out.push(t)
    }
  }
  return out
}

function norm(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase()
}

function extractRules(docRoot) {
  const rules = []
  const seen = new Set()
  for (const rel of DOC_FILES) {
    const p = path.join(docRoot, rel)
    if (!existsSync(p)) continue
    for (const sentence of splitSentences(readFileSync(p, 'utf8'))) {
      if (!KEYWORDS.test(sentence)) continue
      const key = norm(sentence)
      if (seen.has(key)) continue
      seen.add(key)
      rules.push({ file: rel, sentence, norm: key })
    }
  }
  return rules
}

function syntaxOk(rel) {
  const abs = path.join(ROOT, rel)
  const ext = path.extname(rel)
  let cmd, args
  if (ext === '.mjs' || ext === '.js') { cmd = process.execPath; args = ['--check', abs] }
  else if (ext === '.sh') { cmd = 'bash'; args = ['-n', abs] }
  else if (ext === '.py') { cmd = 'python3'; args = ['-m', 'py_compile', abs] }
  else return true // не-кодовый якорь: достаточно существования файла
  return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0
}

function enforcedByLive(anchor) {
  const m = String(anchor || '').match(/^(.+):(\d+)$/)
  if (!m) return `формат enforced_by не <файл>:<строка>: ${anchor}`
  const rel = m[1]
  const line = Number(m[2])
  const abs = path.join(ROOT, rel)
  if (!existsSync(abs)) return `enforced_by файл отсутствует: ${rel}`
  const lineCount = readFileSync(abs, 'utf8').split(/\r?\n/).length
  if (line < 1 || line > lineCount) return `enforced_by строка ${line} вне диапазона ${rel} (${lineCount} строк)`
  if (!syntaxOk(rel)) return `enforced_by файл не проходит синтаксис: ${rel}`
  return null
}

function markerExists(plan) {
  return existsSync(path.join(ROOT, '.mnemazine', 'state', 'rebuild', `${plan}.done.json`))
}

function evaluate({ docRoot, enforcement }) {
  const extracted = extractRules(docRoot)
  if (extracted.length === 0) return { code: 2, extracted, failures: ['ноль извлеченных правил из CLAUDE.md/AGENTS.md'] }
  const entries = Array.isArray(enforcement?.rules) ? enforcement.rules : []
  const failures = []

  for (const rule of extracted) {
    const hit = entries.find(e => e.quote && rule.norm.includes(norm(e.quote)))
    if (!hit) failures.push(`правило без записи в rules-enforcement.json: "${rule.sentence}" (${rule.file})`)
  }

  for (const e of entries) {
    const dormant = e.pending_until && !markerExists(e.pending_until)
    if (dormant) continue
    const why = enforcedByLive(e.enforced_by)
    if (why) failures.push(`${e.id || e.quote}: ${why}${e.pending_until ? ` (pending_until ${e.pending_until} снят)` : ''}`)
  }

  return { code: failures.length ? 1 : 0, extracted, failures }
}

function loadEnforcement() {
  if (!existsSync(ENFORCEMENT)) return { rules: [] }
  try { return JSON.parse(readFileSync(ENFORCEMENT, 'utf8')) } catch (e) { return { rules: [], _error: e.message } }
}

function selftest() {
  // Красный кролик: правило без прибора обязано покраснеть.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rules-inv-selftest-'))
  try {
    writeFileSync(path.join(tmp, 'CLAUDE.md'), '# X\n\nThe runner must never write outside the vault.\n', 'utf8')
    const r = evaluate({ docRoot: tmp, enforcement: { rules: [] } })
    if (r.code !== 1) {
      console.error(`selftest FAILED: красный кролик прошел зеленым (code=${r.code})`)
      return 1
    }
    console.log('selftest ok: правило без прибора краснит (1)')
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())

  const enforcement = loadEnforcement()
  if (enforcement._error) {
    console.error(`config/rules-enforcement.json нечитаем: ${enforcement._error}`)
    process.exit(1)
  }
  const r = evaluate({ docRoot: ROOT, enforcement })
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ code: r.code, extracted: r.extracted.length, failures: r.failures }, null, 2))
  } else {
    console.log(`извлечено правил: ${r.extracted.length}; записей в реестре: ${(enforcement.rules || []).length}`)
    for (const rule of r.extracted) console.log(`  rule: ${rule.sentence}`)
    if (r.failures.length) {
      console.error('ПРОВАЛЫ:')
      for (const f of r.failures) console.error(`  - ${f}`)
    } else {
      console.log('все правила имеют живой прибор')
    }
  }
  process.exit(r.code)
}

main()
