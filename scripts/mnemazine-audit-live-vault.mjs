#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)
const today = new Date().toISOString().slice(0, 10)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.split('=').slice(1).join('=')
  return argv[argv.indexOf(hit) + 1] || fallback
}

const ROOT = path.resolve(process.cwd())
const VAULT = resolveVault({ cli: arg('vault') })
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'reports')))
const LIMIT = Number(arg('limit', '80'))

const EXCLUDED_PARTS = new Set(['.git', '.obsidian'])
const SYSTEM_REL = /^99 Система\/(_legacy-index|Лог обработки|_last-session-review|_run-observability|_ROUTING|Agent_Handoff_Graph|Nova_Radar|00 СИСТЕМА|Паспорта_агентов_Мнемозины)/
const INDEX_FILE = /(^|\/)_(Содержание|МАСТЕР-ИНДЕКС|ROUTING|ШАБЛОНЫ|CAPABILITIES|СПОСОБНОСТИ.*)\.(md|json)$/
const SYSTEM_ROOT_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  '_ROUTING.md',
  '_МАСТЕР-ИНДЕКС.md',
  '_ШАБЛОНЫ.md',
  'Лог обработки.md'
])

const CANON_SECTIONS = [
  '00 Входящие',
  '01 Обо мне',
  '01 Право и Юриспруденция',
  '02 Бизнес и Предпринимательство',
  '02 Здоровье',
  '02 Знания',
  '03 Проекты',
  '04 Образование',
  '05 Кино и Сериалы',
  '06 Промты',
  '07 Бизнес и Финансы',
  '08 AI и Инструменты',
  '09 Личная продуктивность',
  '09 Технологии и Разработка',
  '99 Система'
]

const SECTION_ALIASES = new Map([
  ['09 Технологии', '09 Технологии и Разработка'],
  ['09 Техническое', '09 Технологии и Разработка'],
  ['05 Продуктивность и Процессы', '09 Личная продуктивность'],
  ['07 Скиллы', '08 AI и Инструменты/skills']
])

const RAW_PATTERNS = [
  [/raw\s+ocr/i, 'raw OCR'],
  [/сырой\s+ocr/i, 'сырой OCR'],
  [/Локальное извлечение/i, 'локальное извлечение'],
  [/intake-draft/i, 'intake draft'],
  [/temp_image/i, 'temp image'],
  [/\bIMG_\d+/i, 'raw image filename'],
  [/\.(WEBP|PNG|JPE?G)\b/i, 'raw image extension'],
  [/TODO:\s*rewrite/i, 'rewrite TODO'],
  [/скриншот\s+без\s+контекста/i, 'screenshot without context']
]

const HEADING_RULES = {
  meaning: [/^##+\s+(Что это|Суть|Что это и зачем|What This Is)(?:\s|$)/im],
  value: [/^##+\s+(Зачем|Зачем мне|Как это поможет|Почему важно|Why It Matters)(?:\s|$)/im],
  use: [/^##+\s+(Как применить|Как использовать|Когда использовать|How To Use)(?:\s|$)/im],
  source: [/^##+\s+(Источник|Источники|Source|Sources|Источники и подтверждения)(?:\s|$)/im, /\bsource(_url)?:\s*["']?[^"'\n]+/i],
  verification: [/^##+\s+(Достоверность|Проверка|Верификация|Verification|Риски и проверки)(?:\s|$)/im, /\bverified:\s*["']?[^"'\n]+/i],
  related: [/^##+\s+(Связанные темы|Related Notes|Связи)(?:\s|$)/im, /\[\[[^\]]+\]\]/]
}

function shouldSkip(rel) {
  const parts = rel.split(path.sep)
  return parts.some(part => EXCLUDED_PARTS.has(part) || part.startsWith('graphify-out'))
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...await walk(p))
    else if (item.isFile() && item.name.endsWith('.md')) out.push(p)
  }
  return out
}

function frontmatter(text) {
  if (!text.startsWith('---\n')) return {}
  const end = text.indexOf('\n---', 4)
  if (end === -1) return {}
  const body = text.slice(4, end)
  const data = {}
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Za-zА-Яа-я0-9_-]+):\s*(.*)$/)
    if (!m) continue
    data[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return data
}

function topSection(rel) {
  if (!rel.includes(path.sep)) {
    if (/^(AGENTS|CLAUDE|Лог обработки|_ROUTING|_МАСТЕР-ИНДЕКС|_COMMUNITY_)/.test(rel)) return '99 Система'
  }
  return rel.split(path.sep)[0] || ''
}

function titleFrom(file, text, fm) {
  if (fm.title) return fm.title
  const h1 = text.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return path.basename(file, '.md')
}

function inferSection(note) {
  const title = String(note.title || '').toLowerCase()
  const tags = String(note.fm.tags || '').toLowerCase()
  const type = String(note.fm.type || '').toLowerCase()
  const pathHint = note.rel.toLowerCase()
  const section = String(note.section || '')
  const isCapability = note.rel.includes('/Capabilities/') || section === '08 AI и Инструменты' && /способност|capabilit/i.test(pathHint)

  if (/^_community_/i.test(note.basename)) return '99 Система'
  if (section === '06 Промты' || pathHint.startsWith('06 промты/') || type === 'prompt') return '06 Промты'
  if (pathHint.startsWith('08 ai и инструменты/skills/')) return '08 AI и Инструменты'
  if (section === '08 AI и Инструменты' && (pathHint.includes('/claude code/') || pathHint.includes('/project structure/') || /^ai-инструменты/.test(title))) return '08 AI и Инструменты'
  if (section === '09 Технологии и Разработка' && /database|api|gateway|queue|sre|frontend|backend|erd|nvr|analytics|scanner|code review|fraud|rag|парсинг|уязвим|база данных|мониторинг|newsletter|confluence|код|сканер/.test(title)) return '09 Технологии и Разработка'
  if (section === '02 Бизнес и Предпринимательство' && /marketing|monetization|маркетинг|продаж|бизнес|saas|open-source/.test(title + ' ' + pathHint)) return '02 Бизнес и Предпринимательство'
  if (section === '07 Бизнес и Финансы' && /profit|cash flow|ltv|cac|payback|юнит-эконом|прибыл|финанс/.test(title)) return '07 Бизнес и Финансы'
  if (pathHint.startsWith('03 проекты/athenaos/')) return '03 Проекты'
  if (pathHint.startsWith('08 ai и инструменты/claude code/second brain/')) return '08 AI и Инструменты'
  if (pathHint.startsWith('08 ai и инструменты/mcp/')) return '08 AI и Инструменты'
  if (isCapability) return '08 AI и Инструменты'
  if (/^99 система\//.test(pathHint) || /мнемозина|vault|индекс|агентн[ыи]й конвейер|лог обработки|community \d+|^протокол[_\s-]/.test(title)) return '99 Система'
  if (/обо мне|биограф|личный профиль|профиль владельца/.test(title)) return '01 Обо мне'
  if (/(^|\s)право(\s|$)|правов|юрид|договор|(^|\s)иск(а|и|ом|ов)?(\s|$)|(^|\s)суд(ы|а|ом|ебн)?(\s|$)|фемида|корпоративн/.test(title)) return '01 Право и Юриспруденция'
  if (/trading|трейдинг|bloomberg|инвест|бирж|финанс|financial|hedge|хедж|fund|фонд|рын[оа]к|акци[ия]|portfolio|портфел/i.test(title)) return '07 Бизнес и Финансы'
  if (/здоров|(^|\s)сон(\s|$)|трениров|питани|ментальн|медицин|врач|болезн/.test(title)) return '02 Здоровье'
  if (/бизнес|стартап|продаж|маркетинг|gtm|unit economics|cash flow|юнит-эконом/.test(title)) return '02 Бизнес и Предпринимательство'
  if (/кино|сериал|фильм|box office/.test(title)) return '05 Кино и Сериалы'
  if (/prompt|промпт|шаблон ответа|system prompt/.test(title) || type === 'prompt') return '06 Промты'
  if (/claude|codex|agent|агент|mcp|llm|rag|ai|нейросет|скилл|skill|github|open-source|browser|ocr|chat|hyperframes|librechat/.test(title) || tags.includes('#ai')) return '08 AI и Инструменты'
  if (/react|next\.js|api|backend|frontend|monorepo|serverless|архитектур|разработк|код|база данных|парсинг/.test(title)) return '09 Технологии и Разработка'
  if (/фокус|продуктив|gtd|para|deep work|flow|планиров/.test(title)) return '09 Личная продуктивность'
  if (/обуч|курс|книга|ментор|образован|learn/.test(title)) return '04 Образование'
  return note.section || '02 Знания'
}

function canonFlags(note) {
  const flags = []
  const soft = []
  const isSystem = SYSTEM_ROOT_FILES.has(note.rel) || SYSTEM_REL.test(note.rel) || INDEX_FILE.test(note.rel) || note.rel.includes('/Capabilities/_')
  const isAtomizedSource = /^##\s+Атомизировано(?:\s|$)/m.test(note.text)
  const requiredCanonPresent = Object.values(HEADING_RULES).every(rules => rules.some(re => re.test(note.text)))
  const processedType = /^(level2-atom|canonical-summary|tool-record|tool|tool-reference|reference|method|architecture|learning-resource|capability-method|capability-policy|frontend-stack|safety-method|weak-source|archived-reference|project-plan|prompt|business-method)$/i.test(String(note.fm.type || ''))
  const isProcessedCanon = String(note.fm.status || '').toLowerCase() === 'processed' && requiredCanonPresent && processedType

  if (!isSystem && !isAtomizedSource) {
    for (const [key, rules] of Object.entries(HEADING_RULES)) {
      if (!rules.some(re => re.test(note.text))) flags.push(`missing:${key}`)
    }
  } else if (isAtomizedSource) {
    soft.push('atomized-source')
  }

  for (const [re, label] of RAW_PATTERNS) {
    if (re.test(note.text)) {
      if (isSystem || /source|источник/i.test(note.text.match(re)?.input || '')) soft.push(`raw-reference:${label}`)
      else flags.push(`raw:${label}`)
    }
  }

  if (!isSystem && !isAtomizedSource && note.lines > 220) flags.push('long-note')
  if (!isSystem && !isAtomizedSource && note.headings >= 12) flags.push('many-headings')
  if (!isSystem && !isAtomizedSource && !isProcessedCanon && /подборка|каталог|топ[-\s]?\d+|серия|\bpack\b|\bstack\b|полная карта/i.test(note.title)) flags.push('collection-candidate')
  if (/^_COMMUNITY_|Community \d+/.test(note.basename)) {
    soft.push('graph-community-note')
  }

  const alias = SECTION_ALIASES.get(note.section)
  if (alias) flags.push(`section-alias:${alias}`)
  if (!CANON_SECTIONS.includes(note.section) && !alias && !note.section.startsWith('08 AI и Инструменты/')) flags.push('noncanonical-section')

  const inferred = inferSection(note)
  if (!isSystem && inferred !== note.section && alias !== inferred && !note.rel.startsWith(inferred + path.sep)) {
    flags.push(`route:${inferred}`)
  }

  const score = Math.max(0, 100 - flags.filter(f => !f.startsWith('route:')).length * 12 - soft.length * 3)
  return { flags, soft, score, inferred }
}

function mdTable(rows) {
  if (!rows.length) return '_Нет._\n'
  return [
    '| Файл | Score | Флаги | Предложение |',
    '|---|---:|---|---|',
    ...rows.map(r => `| ${r.link} | ${r.score} | ${r.flags.join('<br>')} | ${r.suggestion} |`)
  ].join('\n') + '\n'
}

await fs.mkdir(OUT_DIR, { recursive: true })
const allFiles = await walk(VAULT)
const files = allFiles.filter(file => !shouldSkip(path.relative(VAULT, file)))

const notes = []
for (const file of files) {
  const text = await fs.readFile(file, 'utf8')
  const rel = path.relative(VAULT, file)
  const fm = frontmatter(text)
  const note = {
    file,
    rel,
    basename: path.basename(file),
    text,
    fm,
    title: titleFrom(file, text, fm),
    section: topSection(rel),
    lines: text.split('\n').length,
    words: (text.match(/\S+/g) || []).length,
    headings: (text.match(/^##+\s+/gm) || []).length
  }
  Object.assign(note, canonFlags(note))
  note.link = `[[${note.rel.replace(/\.md$/, '')}]]`
  note.suggestion = note.flags.find(f => f.startsWith('route:'))?.replace('route:', 'перенести в ') ||
    note.flags.find(f => f.startsWith('section-alias:'))?.replace('section-alias:', 'слить в ') ||
    (note.flags.includes('long-note') || note.flags.includes('many-headings') || note.flags.includes('collection-candidate') ? 'атомизировать' : 'дописать канон')
  notes.push(note)
}

const dirty = notes.filter(n => n.flags.length).sort((a, b) => a.score - b.score || b.lines - a.lines)
const atomize = notes.filter(n => n.flags.some(f => ['long-note', 'many-headings', 'collection-candidate'].includes(f))).sort((a, b) => b.lines - a.lines)
const routes = notes.filter(n => n.flags.some(f => f.startsWith('route:') || f.startsWith('section-alias:'))).sort((a, b) => a.rel.localeCompare(b.rel, 'ru'))
const raw = notes.filter(n => n.flags.some(f => f.startsWith('raw:') || f.startsWith('raw-reference:'))).sort((a, b) => a.score - b.score)
const bySection = new Map()
for (const note of notes) bySection.set(note.section, (bySection.get(note.section) || 0) + 1)

const report = `# Mnemazine Live Vault Audit — ${today}

Vault: \`${VAULT}\`

## Сводка

- Markdown всего: ${allFiles.length}
- Markdown в scoring: ${files.length}
- Ноты с флагами: ${dirty.length}
- Кандидаты на атомизацию: ${atomize.length}
- Кандидаты на перенос/слияние разделов: ${routes.length}
- Raw/reference маркеры: ${raw.length}

## Разделы

| Раздел | Нот |
|---|---:|
${[...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([name, count]) => `| ${name} | ${count} |`).join('\n')}

## Первые правки: неканон

${mdTable(dirty.slice(0, LIMIT))}

## Атомизация

${mdTable(atomize.slice(0, LIMIT))}

## Роутинг

${mdTable(routes.slice(0, LIMIT))}

## Raw/reference

${mdTable(raw.slice(0, LIMIT))}

## Канон применения

1. Не удалять полезное знание. Сначала атомизировать или карантин.
2. Raw OCR, screenshot filenames и длинные подборки не должны быть телом знания.
3. Один атом = одна задача применения, один набор источников, одна категория.
4. После правок обновить \`_Содержание.md\`, \`_МАСТЕР-ИНДЕКС.md\`, потом Graphify.
`

const json = {
  generated_at: new Date().toISOString(),
  vault: VAULT,
  totals: {
    markdown_total: allFiles.length,
    markdown_scored: files.length,
    dirty: dirty.length,
    atomize: atomize.length,
    routes: routes.length,
    raw: raw.length
  },
  sections: Object.fromEntries([...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))),
  dirty: dirty.map(({ text, ...n }) => n),
  atomize: atomize.map(({ text, ...n }) => n),
  routes: routes.map(({ text, ...n }) => n),
  raw: raw.map(({ text, ...n }) => n)
}

const base = path.join(OUT_DIR, `${today}-live-vault-audit`)
await fs.writeFile(`${base}.md`, report)
await fs.writeFile(`${base}.json`, JSON.stringify(json, null, 2))
console.log(JSON.stringify({ ok: true, report: `${base}.md`, json: `${base}.json`, ...json.totals }, null, 2))
