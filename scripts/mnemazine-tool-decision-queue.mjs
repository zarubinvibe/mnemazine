#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SPEC_TYPES } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function lastRun() {
  try { return JSON.parse(readFileSync(path.join(ROOT, '.mnemazine/state/last-run.json'), 'utf8')) } catch { return null }
}

const LAST_RUN = lastRun()
const VAULT = resolveVault({ cli: arg('vault'), env: process.env.MNEMAZINE_VAULT || LAST_RUN?.vault })
const SINCE = arg('changed-since', LAST_RUN?.started_at || '')
const SINCE_MS = Number.isFinite(Date.parse(SINCE)) ? Date.parse(SINCE) : 0
const OUT = path.resolve(arg('out', path.join(VAULT, '08 AI и Инструменты/Tools/Очередь разбора инструментов.md')))
const SESSION = arg('session', new Date().toISOString().slice(0, 10))

function escMd(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
}

function clean(value, max = 500) {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\bprimary source\b/gi, 'первичным источникам')
    .replace(/\bGitHub repo\b/gi, 'GitHub-репозиторий')
    .replace(/\bREADME\/release\b/gi, 'README и release')
    .replace(/README и release и метаданные/gi, 'README, release и метаданные')
    .replace(/\bknowledge notes\b/gi, 'заметки знаний')
    .replace(/\bevidence\b/gi, 'доказательства')
    .replace(/\bworkflow\b/gi, 'рабочий сценарий')
    .replace(/\bsandbox\b/gi, 'песочница')
    .replace(/\bdraft\b/gi, 'черновик')
    .replace(/\s+/g, ' ')
    .replace(/ \./g, '.')
    .replace(/\.\./g, '.')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text
}

function section(text, names) {
  for (const name of names) {
    const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi')
    const hit = text.match(re)
    if (hit) return hit[1].trim()
  }
  return ''
}

function titleOf(text, file) {
  return text.match(/^title:\s*"([^"]+)"/m)?.[1]?.trim() ||
    text.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(file, '.md')
}

function frontmatterType(text) {
  const match = String(text || '').match(/^type:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m)
  return match ? match[1].trim() : ''
}

async function walk(dir) {
  const out = []
  async function visit(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      const file = path.join(folder, item.name)
      if (item.isDirectory()) await visit(file)
      else if (item.isFile() && item.name.endsWith('.md')) out.push(file)
    }
  }
  await visit(dir)
  return out
}

function reposFrom(text) {
  const repos = []
  for (const hit of String(text || '').matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = hit[1]
    const repo = hit[2].replace(/\.git$/i, '')
    if (!owner || !repo || repo === 'releases' || repo === 'blob') continue
    repos.push(`${owner}/${repo}`)
  }
  return [...new Set(repos)]
}

function classifyNote(title) {
  const low = title.toLowerCase()
  if (low.includes('решение')) return 'decision'
  if (low.includes('риск')) return 'risk'
  if (low.includes('readme')) return 'readme'
  if (low.includes('карточка')) return 'identity'
  return 'note'
}

function humanRepoName(repo) {
  if (/aider/i.test(repo)) return 'Aider'
  if (/browser-use/i.test(repo)) return 'browser-use'
  if (/moneyprinter/i.test(repo)) return 'MoneyPrinterTurbo'
  return repo
}

function defaultCard(repo, merged) {
  const name = humanRepoName(repo)
  const lower = repo.toLowerCase()
  if (lower.includes('aider')) {
    return {
      status: 'Пробовать только точечно',
      decision: 'тестировать первым, если нужен независимый пробный запуск coding-агента; основной стек не менять',
      scenario: 'маленькая правка или рефакторинг в отдельном git worktree',
      trial: 'создать одноразовый worktree, дать Aider одну задачу, принять результат только после `git diff` и ручного ревью',
      gate: 'не давать широкий доступ к основному рабочему дереву; не принимать изменения без ревью diff',
      accept: 'ускоряет маленькие кодовые правки без роста риска',
      reject: 'лезет слишком широко, шумит в diff или требует ручной чистки',
    }
  }
  if (lower.includes('browser-use')) {
    return {
      status: 'Отложить до задачи, где Playwright мало',
      decision: 'не брать сейчас в постоянный стек; сначала использовать обычную браузерную smoke-проверку, browser-use проверять только для агентных UI-сценариев',
      scenario: 'проверка браузера в режиме чтения, сбор доказательств, воспроизведение UI-сценария',
      trial: 'запустить на тестовом профиле и списке разрешенных доменов; без отправки форм, оплат, публикаций и действий в живых аккаунтах',
      gate: 'тестовый профиль, список разрешенных доменов, явное подтверждение перед любой внешней мутацией',
      accept: 'надежно воспроизводит сценарий и дает проверяемые доказательства',
      reject: 'пытается действовать в живом аккаунте или требует слишком много присмотра',
    }
  }
  if (lower.includes('moneyprinterturbo')) {
    return {
      status: 'Отложить до контент-эксперимента',
      decision: 'не ставить сейчас; возвращаться только когда есть конкретный ролик, канал и критерий качества',
      scenario: 'один черновик короткого видео для проверки крючка и призыва к действию',
      trial: 'собрать один черновик без автопубликации, проверить права на ассеты, голос, качество сценария и итоговый монтаж',
      gate: 'никакой автопубликации; проверка прав на контент и стоковые материалы; ручная проверка качества',
      accept: 'быстро дает пригодный черновик, который можно довести руками',
      reject: 'получается фабрика однотипного контента или юридический риск',
    }
  }
  return {
    status: 'Проверить на одном сценарии',
    decision: 'не добавлять в постоянный стек автоматически',
    scenario: clean(merged.decision || merged.what || 'один конкретный рабочий сценарий', 140),
    trial: `сделать маленький пробный запуск ${name} без установки в постоянный стек`,
    gate: 'проверить README, лицензию, issues, свежесть релизов и риск для данных',
    accept: 'есть понятная польза в одном рабочем сценарии',
    reject: 'нет сценария, высокий риск или слабая поддержка',
  }
}

async function collectTools() {
  const groups = new Map()
  for (const file of await walk(VAULT)) {
    if (file === OUT) continue
    const stat = await fs.stat(file)
    if (SINCE_MS && stat.mtimeMs < SINCE_MS) continue
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (!SPEC_TYPES.has(frontmatterType(text))) continue
    if (!/github\.com\//i.test(text)) continue
    if (!/verified:\s*true/.test(text)) continue
    const repos = reposFrom(text)
    if (!repos.length) continue
    const title = titleOf(text, file)
    const noteType = classifyNote(title)
    for (const repo of repos) {
      const group = groups.get(repo) || {
        repo,
        notes: [],
        sources: new Set(),
        metadata: '',
        freshness: '',
        what: '',
        decision: '',
        risk: '',
        readme: '',
        next: '',
      }
      group.notes.push({ file, title, type: noteType })
      for (const url of [...text.matchAll(/https?:\/\/[^\s)]+/g)].map(m => m[0].replace(/[.,;]+$/, ''))) {
        if (url.includes(repo)) group.sources.add(url)
      }
      group.metadata ||= text.match(/Метаданные GitHub:\s*([^\n]+)/)?.[1]?.trim() || ''
      group.freshness ||= text.match(/Свежесть репозитория:\s*([^\n]+)/)?.[1]?.trim() || ''
      if (noteType === 'identity') group.what ||= section(text, ['Что это'])
      if (noteType === 'decision') group.decision ||= section(text, ['Решение', 'Что это'])
      if (noteType === 'risk') group.risk ||= section(text, ['Что это'])
      if (noteType === 'readme') group.readme ||= section(text, ['Что обещает README', 'Что это'])
      group.next ||= clean(section(text, ['Следующее действие']), 180)
      groups.set(repo, group)
    }
  }
  return [...groups.values()].sort((a, b) => humanRepoName(a.repo).localeCompare(humanRepoName(b.repo), 'ru'))
}

function renderCard(group) {
  const card = defaultCard(group.repo, group)
  const noteLinks = group.notes
    .sort((a, b) => a.type.localeCompare(b.type))
    .map(note => `- [[${path.relative(VAULT, note.file).replace(/\.md$/, '')}|${note.title}]]`)
    .join('\n')
  const sources = [...group.sources].slice(0, 6).map(url => `- ${url}`).join('\n') || '- источник не найден'
  return `### ${humanRepoName(group.repo)} (${group.repo})

**Статус:** ${card.status}

**Что это:** ${clean(group.what || group.readme || group.decision, 360)}

**Решение сейчас:** ${card.decision}. Сначала один маленький пробный запуск, потом явное решение: берем, откладываем или забываем.

**Где проверять:** ${card.scenario}.

**Пробный запуск:** ${card.trial}.

**Гейт риска:** ${card.gate}.

**Принять, если:** ${card.accept}.

**Отклонить, если:** ${card.reject}.

**Метаданные:** ${clean([group.metadata, group.freshness].filter(Boolean).join(' '), 360)}

**Источники:**
${sources}

**Связанные ноты:**
${noteLinks}
`
}

function renderQueue(groups) {
  const rows = groups.map(group => {
    const card = defaultCard(group.repo, group)
    return `| ${escMd(humanRepoName(group.repo))} | ${escMd(card.status)} | ${escMd(card.scenario)} | ${escMd(card.gate)} | ${escMd(card.trial)} |`
  })
  return `---
title: "Очередь разбора инструментов"
type: "tool-decision-queue"
status: "active"
source_ref: "mnemazine-tool-decision-queue:${SESSION}"
generated_at: "${new Date().toISOString()}"
---

# Очередь разбора инструментов

## Что это

Это рабочая очередь решений по инструментам из Mnemazine. Она не заменяет исходные заметки знаний: она сжимает их в одно место, где видно, что тестировать, чем рискуем и по какому критерию принять или отклонить инструмент.

## Правило

- Скриншот, звезды GitHub и красивый README не являются решением.
- Один инструмент проверяется только на одном понятном рабочем сценарии.
- До принятия в стек нужен маленький пробный запуск в безопасной среде.
- Решение всегда одно из трех: берем, откладываем, забываем.

## Очередь

| Инструмент | Статус | Где проверять | Гейт риска | Пробный запуск |
|---|---|---|---|---|
${rows.join('\n')}

## Карточки

${groups.map(renderCard).join('\n')}

## Источники

- Сгенерировано из verified Mnemazine notes после ${SINCE || 'последнего прогона'}.
- Исходные заметки остаются в vault как доказательства и подробности.

## Проверка

- Очередь не устанавливает инструменты и не выполняет внешние действия.
- Перед установкой проверять README, лицензию, issues, свежесть релизов, доступ к данным и границы песочницы.
- Любой пробный запуск делать отдельно от боевого рабочего дерева или живых аккаунтов.

## Следующее действие

- Выбрать один инструмент из очереди и провести один маленький пробный запуск с критерием “берем / откладываем / забываем”.
`
}

const groups = await collectTools()
if (!groups.length) {
  console.log(JSON.stringify({ ok: true, written: false, tools: 0 }, null, 2))
  process.exit(0)
}

await fs.mkdir(path.dirname(OUT), { recursive: true })
await fs.writeFile(OUT, renderQueue(groups), 'utf8')
console.log(JSON.stringify({ ok: true, written: true, tools: groups.length, out: OUT }, null, 2))
