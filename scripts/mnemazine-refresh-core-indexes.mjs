#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)
const today = new Date().toISOString().slice(0, 10)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.split('=').slice(1).join('=')
  return argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const CHECK = argv.includes('--check')
// `.mnemazine` — рантайм-состояние, `99 Система/_lint` — отчёты kb-lint. Ни то, ни другое не ноты.
// Набор обязан совпадать с walkVault() в mnemazine-kb-lint.mjs: линтер сравнивает счётчик мастер-индекса
// со своим счётом диска, поэтому любое расхождение НАБОРОВ он печатает как critical «расхождение индексов»
// — вечный красный, который растёт с каждым прогоном линта. Измерено 2026-07-26: индексатор считал 1815,
// линтер 1812, разница ровно три отчёта в `99 Система/_lint/`. Правишь одну сторону — правь вторую.
const EXCLUDE_DIRS = new Set(['.git', '.obsidian', '.mnemazine'])
const EXCLUDE_RELS = new Set(['99 Система/_lint'])
const MASTER = path.join(VAULT, '_МАСТЕР-ИНДЕКС.md')
const LOG = path.join(VAULT, '99 Система', 'Лог обработки.md')

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    const rel = path.relative(VAULT, p).replace(/\\/g, '/')
    if (item.isDirectory() && !EXCLUDE_DIRS.has(item.name) && !EXCLUDE_RELS.has(rel) && !item.name.startsWith('graphify-out')) out.push(...await walk(p))
    else if (item.isFile() && item.name.endsWith('.md')) out.push(p)
  }
  return out
}

function titleOf(text, file) {
  const fm = text.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]
  if (fm) return fm
  const h1 = text.match(/^#\s+(.+)$/m)?.[1]
  return h1 || path.basename(file, '.md')
}

const CAP_DIR = path.join(VAULT, '08 AI и Инструменты', 'Capabilities')
const CAP_INDEX = path.join(CAP_DIR, '_Содержание.md')

const all = await walk(VAULT)
if (!CHECK) {
  // Файлы, которые этот же прогон создаёт, считаются существующими — иначе на
  // свежем vault записанные счётчики устаревают в момент записи и --check
  // сразу после прогона краснеет.
  for (const own of [MASTER, CAP_INDEX, LOG]) {
    if (!all.includes(own)) all.push(own)
  }
}
const bySection = new Map()
const rootFiles = []
for (const file of all) {
  const rel = path.relative(VAULT, file)
  const parts = rel.split(path.sep)
  if (parts.length === 1) {
    rootFiles.push(rel)
    continue
  }
  const section = parts[0]
  if (!section || rel.includes('/graphify-out/')) continue
  bySection.set(section, (bySection.get(section) || 0) + 1)
}

// ── --check: детерминированный гейт «число в индексе == число на диске» ──

// Ячейка счётчика — третья колонка таблицы разделов; строка узнаётся по тому,
// что третья ячейка целиком число (шапка и разделитель отсеиваются сами).
function parseIndexCounts(md) {
  const counts = new Map()
  for (const line of md.split('\n')) {
    const cells = line.split('|').map(s => s.trim())
    if (cells.length >= 5 && cells[1] && /^\d+$/.test(cells[3])) counts.set(cells[1], Number(cells[3]))
  }
  const total = md.match(/Всего markdown[^*\n]*\*\*(\d+)\*\*/)?.[1]
  return { counts, total: total ? Number(total) : null }
}

if (CHECK) {
  const md = await fs.readFile(MASTER, 'utf8').catch(() => null)
  if (md === null) {
    console.error(JSON.stringify({ ok: false, error: `нет файла ${MASTER}` }))
    process.exit(1)
  }
  const { counts, total } = parseIndexCounts(md)
  const mismatches = []
  for (const [section, disk] of bySection) {
    const index = counts.has(section) ? counts.get(section) : null
    if (index !== disk) mismatches.push({ section, index, disk })
  }
  for (const [section, index] of counts) {
    if (!bySection.has(section) && index !== 0) mismatches.push({ section, index, disk: 0 })
  }
  mismatches.sort((a, b) => a.section.localeCompare(b.section, 'ru'))
  const ok = mismatches.length === 0 && total === all.length
  const report = { ok, master: MASTER, total: { index: total, disk: all.length }, sections_on_disk: bySection.size, mismatches }
  ;(ok ? console.log : console.error)(JSON.stringify(report, null, 2))
  process.exit(ok ? 0 : 1)
}

// ── Запись: пересчёт мастер-индекса, индекса Capabilities, запись в лог ──

const labels = {
  '00 Входящие': 'сырьё и временные буферы',
  '01 Обо мне': 'личные данные, профиль, цели',
  '01 Право и Юриспруденция': 'корпоративное право, юридические процессы',
  '02 Бизнес и Предпринимательство': 'бизнес-модели, стартапы, продажи',
  '02 Здоровье': 'тело, сон, питание, ментальное',
  '02 Знания': 'методики мышления и личная база знаний',
  '03 Проекты': 'материалы под конкретные проекты',
  '04 Образование': 'обучение, курсы, справочники',
  '05 Кино и Сериалы': 'медиа и рекомендации',
  '05 Продуктивность и Процессы': 'старый алиас продуктивности',
  '06 Промты': 'переиспользуемые промты',
  '07 Бизнес и Финансы': 'финансы, рынки, бизнес-аналитика',
  '07 Скиллы': 'старый алиас skills-знаний',
  '08 AI и Инструменты': 'AI, агенты, MCP, skills, plugins',
  '09 Личная продуктивность': 'фокус, flow, организация',
  '09 Технологии': 'старый алиас разработки',
  '09 Технологии и Разработка': 'технологии и разработка',
  '99 Система': 'инфраструктура vault, протоколы, логи'
}

const masterRows = [...bySection.entries()]
  .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
  .map(([section, count]) => {
    const indexPath = path.join(VAULT, section, '_Содержание.md')
    const hasIndex = all.includes(indexPath)
    const link = hasIndex ? `[[${section}/_Содержание|открыть]]` : '—'
    return `| ${section} | ${labels[section] || 'раздел'} | ${count} | ${link} |`
  })

const master = `---
title: "Мастер-индекс базы знаний"
type: master-index
updated: "${today}"
---

# Мастер-индекс — база знаний

Общий список разделов. Обновляется агентом после значимых изменений Vault.
Точка входа для человека и агента. Система: [[00 СИСТЕМА — Агентный конвейер знаний]].

## Разделы

| Раздел | Область | Заметок | Содержание |
|---|---|---:|---|
${masterRows.join('\n')}

Всего markdown в активном Vault: **${all.length}**

Корневые служебные файлы: ${rootFiles.map(f => `[[${f.replace(/\.md$/, '')}]]`).join(' · ') || '—'}

## Новая структура способностей

- [[08 AI и Инструменты/Capabilities/_СПОСОБНОСТИ — методика|Методика установки, оценки и применения]]
- [[08 AI и Инструменты/Capabilities/_СПОСОБНОСТИ — реестр|Полный реестр Skills/MCP/plugins]]

## Как пополнять

1. Кинь материал в инбокс.
2. Прогони pipeline Мнемозины.
3. Получи финальные атомы, источники, применимые способности и связи.

## Система

- [[00 СИСТЕМА — Агентный конвейер знаний]] — принципы и контракт
- [[_ROUTING]] — роутинг для агентов · [[_ШАБЛОНЫ]] — шаблоны · [[Лог обработки]] — журнал
`

await fs.writeFile(MASTER, master)

const capFiles = await walk(CAP_DIR)
const capRows = []
for (const file of capFiles.sort((a, b) => a.localeCompare(b, 'ru'))) {
  if (path.basename(file) === '_Содержание.md') continue
  const text = await fs.readFile(file, 'utf8')
  const relNoExt = path.relative(VAULT, file).replace(/\.md$/, '')
  capRows.push(`| [[${relNoExt}|${titleOf(text, file)}]] | ${path.basename(file)} |`)
}

const capIndex = `---
title: "Содержание — способности агента"
type: section-index
updated: "${today}"
---

# Capabilities — Содержание

Кратко: отдельная структура для Skills, MCP, plugins, agents и workflow. Методика сохраняет правила установки/оценки; реестр даёт полный каталог; конкретные знания ссылаются на применимые способности.

| Заметка | Файл |
|---|---|
${capRows.join('\n')}

Назад: [[_МАСТЕР-ИНДЕКС]]
`

await fs.mkdir(CAP_DIR, { recursive: true })
await fs.writeFile(CAP_INDEX, capIndex)

// Новые записи лога — только греп-парсибельным префиксом `## [ГГГГ-ММ-ДД] тип | заголовок`.
// Старые записи (`### [дата] — …`) не переписываются. Повторный прогон в тот же
// день обновляет свою запись, а не плодит дубли.
const ENTRY_HEAD_RE = /^#{2,3} \[\d{4}-\d{2}-\d{2}\]/
const heading = `## [${today}] индекс | Пересчёт мастер-индекса и Capabilities`
const entryLines = [
  heading,
  `- markdown всего: ${all.length}, разделов: ${bySection.size}`,
  '- обновлены: _МАСТЕР-ИНДЕКС.md · 08 AI и Инструменты/Capabilities/_Содержание.md',
  ''
]

const logText = await fs.readFile(LOG, 'utf8').catch(() => '# Лог обработки\n\n')
const logLines = logText.split('\n')
const existing = logLines.indexOf(heading)
if (existing !== -1) {
  let end = existing + 1
  while (end < logLines.length && !ENTRY_HEAD_RE.test(logLines[end])) end += 1
  logLines.splice(existing, end - existing, ...entryLines)
} else {
  const first = logLines.findIndex(l => ENTRY_HEAD_RE.test(l))
  if (first === -1) logLines.push(...entryLines)
  else logLines.splice(first, 0, ...entryLines)
}
await fs.writeFile(LOG, logLines.join('\n'))

console.log(JSON.stringify({
  ok: true,
  vault: VAULT,
  markdown: all.length,
  sections: Object.fromEntries([...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))),
  master: MASTER,
  capabilities_index: CAP_INDEX,
  log: LOG,
  log_entry: heading
}, null, 2))
