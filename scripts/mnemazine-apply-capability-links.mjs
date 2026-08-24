#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.split('=').slice(1).join('=')
  return argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const SUGGESTIONS = path.resolve(arg('suggestions', path.join(process.cwd(), 'reports', `${new Date().toISOString().slice(0, 10)}-capability-link-suggestions.json`)))
const THRESHOLD = Number(arg('threshold', '35'))
const APPLY = argv.includes('--apply')
const LIMIT = Number(arg('limit', '0'))

const SKIP_REL = [
  /^99 Система\//,
  /^00 Входящие\//,
  /^AGENTS\.md$/,
  /^_ROUTING\.md$/,
  /^Лог обработки\.md$/,
  /^08 AI и Инструменты\/Capabilities\//
]

const PURPOSES = {
  'graphify': 'построить или запросить граф связей перед реализацией знания',
  'knowledge-ops': 'сохранить, дедуплицировать и связать знание с другими слоями базы',
  'ui-ux-pro-max': 'применить готовые UI/UX-паттерны при превращении знания в интерфейс',
  'agent-browser': 'проверить веб-сценарий через управляемый браузер',
  'test-driven-development': 'реализовать методику через тесты и проверяемый цикл разработки',
  'context7': 'подтянуть свежую документацию перед кодом или настройкой',
  'firecrawl-mcp': 'извлечь содержимое сайта как источник для проверки и атомизации',
  'github': 'проверить репозиторий, issues, stars, commits или PR как evidence',
  'memory': 'сохранить устойчивую связь/факт в MCP memory после отбора',
  'ads': 'превратить знание в аудит или улучшение рекламной кампании',
  'remotion-official': 'реализовать видео/анимацию через Remotion',
  'playwright': 'проверить веб-интерфейс и сценарии в браузере',
  'documents': 'создать или отредактировать документальный артефакт',
  'local-doc-ops': 'локально обработать PDF/OCR/документы без утечки сырья',
  'codex-review': 'провести код-ревью перед применением в проекте'
}

function purposeFor(s) {
  return PURPOSES[s.id] || String(s.description || '').replace(/\s+/g, ' ').slice(0, 120)
}

function statusFor(s) {
  if (['mcp', 'plugin'].includes(s.type)) return 'local, включать только по задаче'
  return 'local/evaluate'
}

function blockFor(suggestions) {
  const rows = suggestions.map(s => {
    const link = `[[_СПОСОБНОСТИ — реестр|${s.id}]]`
    return `| ${link} | ${s.type} | ${purposeFor(s)} | ${statusFor(s)} |`
  })
  return `\n## Применимые способности\n\n| Способность | Тип | Зачем здесь | Статус |\n|---|---|---|---|\n${rows.join('\n')}\n`
}

function insertBlock(text, block) {
  if (/^##\s+Применимые способности\b/m.test(text)) return text
  const markers = [
    /^##\s+(Достоверность|Verification|Проверка)\b/m,
    /^##\s+(Связанные темы|Related Notes|Связи)\b/m,
    /^##\s+(Следующее действие|Next Action)\b/m
  ]
  for (const re of markers) {
    const m = text.match(re)
    if (m && typeof m.index === 'number') {
      return `${text.slice(0, m.index).trimEnd()}\n${block}\n${text.slice(m.index)}`
    }
  }
  return `${text.trimEnd()}\n${block}\n`
}

const data = JSON.parse(await fs.readFile(SUGGESTIONS, 'utf8'))
const candidates = []
for (const item of data.suggestions || []) {
  if (SKIP_REL.some(re => re.test(item.rel))) continue
  const picked = []
  const seen = new Set()
  for (const s of item.suggestions || []) {
    if (s.score < THRESHOLD || seen.has(s.id)) continue
    seen.add(s.id)
    picked.push(s)
  }
  if (picked.length) candidates.push({ ...item, suggestions: picked })
}

const chosen = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates
const changed = []
const skipped = []

for (const item of chosen) {
  const file = path.join(VAULT, item.rel)
  const text = await fs.readFile(file, 'utf8')
  if (/^##\s+Применимые способности\b/m.test(text)) {
    skipped.push({ rel: item.rel, reason: 'already_has_block' })
    continue
  }
  const next = insertBlock(text, blockFor(item.suggestions))
  if (next !== text) {
    changed.push({ rel: item.rel, capabilities: item.suggestions.map(s => s.id) })
    if (APPLY) await fs.writeFile(file, next)
  }
}

console.log(JSON.stringify({
  ok: true,
  apply: APPLY,
  threshold: THRESHOLD,
  candidates: candidates.length,
  changed: changed.length,
  skipped: skipped.length,
  changed_preview: changed.slice(0, 80)
}, null, 2))
