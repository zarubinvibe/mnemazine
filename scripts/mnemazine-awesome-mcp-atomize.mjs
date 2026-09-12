#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { resolveVault } from './mnemazine-paths.mjs'
import { projectCategory } from './mnemazine-project-categories.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const APPLY = argv.includes('--apply')
const README_URL = arg('url', 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md')
const REPO_API = 'https://api.github.com/repos/punkpeye/awesome-mcp-servers'
const SESSION = arg('session', new Date().toISOString().slice(0, 10))
const OUT_DIR = path.join(VAULT, '08 AI и Инструменты', 'MCP Servers', 'awesome-mcp-servers')
const INDEX_FILE = path.join(OUT_DIR, '_index.md')
const DATA_FILE = path.join(OUT_DIR, '_servers.json')
const INTEGRATIONS_FILE = path.join(VAULT, '03 Проекты', 'интеграции-новых-инструментов-в-проекты.md')

const langMap = new Map([
  ['🐍', 'Python'],
  ['📇', 'TypeScript/JavaScript'],
  ['🏎️', 'Go'],
  ['🦀', 'Rust'],
  ['#️⃣', 'C#'],
  ['☕', 'Java'],
  ['🌊', 'C/C++'],
  ['💎', 'Ruby']
])
const scopeMap = new Map([
  ['☁️', 'cloud-service'],
  ['🏠', 'local-service'],
  ['📟', 'embedded-systems']
])
const osMap = new Map([
  ['🍎', 'macOS'],
  ['🪟', 'Windows'],
  ['🐧', 'Linux']
])

const categoryFits = [
  { re: /^(Aggregators|Coding Agents|Command Line|Code Execution)$/i, categories: [projectCategory('agent-os')] },
  { re: /^(Developer Tools|Version Control|Cloud Platforms|Monitoring|Security)$/i, categories: [projectCategory('dev-platform')] },
  { re: /^(Knowledge & Memory|Search & Data Extraction|Research|File Systems)$/i, categories: [projectCategory('knowledge-rag')] },
  { re: /^(Databases|Data Platforms|Data Science Tools|Data Visualization)$/i, categories: [projectCategory('data-bi')] },
  { re: /^(Legal|Cryptography|Identity)$/i, categories: [projectCategory('legal-trust')] },
  { re: /^(Marketing|E-Commerce|Customer Data Platforms|Delivery|Product Management)$/i, categories: [projectCategory('crm-commerce')] },
  { re: /^(Finance & Fintech)$/i, categories: [projectCategory('fintech-risk')] },
  { re: /^(Art & Culture|Education|Gaming|Multimedia Process|Speech-to-Text|Text-to-Speech|Translation Services|Podcasts)$/i, categories: [projectCategory('media-education-games')] },
  { re: /^(Browser Automation|OS Automation)$/i, categories: [projectCategory('browser-os-automation')] },
  { re: /^(Communication|Support & Service Management|Workplace & Productivity)$/i, categories: [projectCategory('workplace-support')] },
  { re: /^(Home Automation|Industrial & IoT|Embedded System|Environment & Nature|Location Services|Travel & Transportation|Real Estate|Sports|Health & Wellness)$/i, categories: [projectCategory('real-world-iot')] }
]

const keywordCategories = [
  { re: /agent|orchestrat|gateway|proxy|registry|discover|marketplace|multi-agent|tool intelligence/i, categories: [projectCategory('agent-os')] },
  { re: /github|gitlab|code|coding|developer|ci|deployment|observability|sentry|logs|pull request|kubernetes|cloud/i, categories: [projectCategory('dev-platform')] },
  { re: /memory|knowledge|obsidian|vector|rag|search|wiki|document|pdf|semantic|summar/i, categories: [projectCategory('knowledge-rag')] },
  { re: /database|postgres|mysql|sqlite|snowflake|analytics|bi|dashboard|warehouse|data/i, categories: [projectCategory('data-bi')] },
  { re: /legal|court|case law|contract|compliance|federal register|identity|kyc|ofac|trust/i, categories: [projectCategory('legal-trust')] },
  { re: /crm|sales|marketing|e-?commerce|shopify|customer|lead|support|ticket|ads|seo/i, categories: [projectCategory('crm-commerce')] },
  { re: /finance|crypto|wallet|trading|payment|x402|usdc|defi|market data|tax/i, categories: [projectCategory('fintech-risk')] },
  { re: /image|audio|video|speech|voice|tts|story|game|education|translation|podcast|music/i, categories: [projectCategory('media-education-games')] },
  { re: /browser|chrome|playwright|web automation|scrap|crawl|screen|desktop|os automation/i, categories: [projectCategory('browser-os-automation')] },
  { re: /slack|discord|email|gmail|calendar|notion|jira|confluence|support|helpdesk/i, categories: [projectCategory('workplace-support')] }
]

function curl(url, optional = false) {
  const result = spawnSync('curl', ['-L', '--fail', '--silent', url], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 && !optional) throw new Error(`curl failed for ${url}: ${result.stderr || result.status}`)
  return result.status === 0 ? result.stdout : ''
}

function escYaml(value) {
  return JSON.stringify(String(value ?? ''))
}

function yamlList(key, items) {
  return `${key}:\n${items.length ? items.map(item => `  - ${escYaml(item)}`).join('\n') : '  []'}`
}

function slug(value) {
  return String(value || 'mcp-server')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 110) || 'mcp-server'
}

function stripMd(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanDesc(value) {
  return stripMd(value)
    .replace(/\s*[—–-]\s*$/, '')
    .replace(/["']/g, match => match)
    .trim()
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

function vaultProjects() {
  const file = path.join(VAULT, '99 Система', '_ПРОЕКТЫ.md')
  const text = fs.readFile(file, 'utf8').catch(() => '')
  return text
}

let projectIndexCache = null
async function currentProjects() {
  if (projectIndexCache) return projectIndexCache
  const text = await vaultProjects()
  projectIndexCache = [...String(text).matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1].trim()).filter(Boolean)
  return projectIndexCache
}

function parseReadme(readme) {
  let category = ''
  const servers = []
  for (const line of readme.split(/\r?\n/)) {
    const h = line.match(/^###\s+(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)?(?:<a name="[^"]+"><\/a>)?(.+?)\s*$/u)
    if (h) {
      category = stripMd(h[1]).replace(/^<a name=.*?>/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
      continue
    }
    if (!line.startsWith('- [')) continue
    const first = line.match(/^- \[([^\]]+)]\((https:\/\/github\.com\/[^)\s]+)\)(.*)$/)
    if (!first) continue
    const [, rawName, rawUrl, rest] = first
    const url = rawUrl.replace(/[.,;]+$/, '')
    let tail = rest.replace(/\[!\[[^\]]*]\([^)]+\)]\([^)]+\)/g, ' ')
    const sep = tail.match(/\s-\s/)
    const desc = cleanDesc(sep ? tail.slice(sep.index + sep[0].length) : tail)
    const flags = sep ? tail.slice(0, sep.index) : tail
    const languages = [...langMap].filter(([symbol]) => flags.includes(symbol)).map(([, name]) => name)
    const scopes = [...scopeMap].filter(([symbol]) => flags.includes(symbol)).map(([, name]) => name)
    const os = [...osMap].filter(([symbol]) => flags.includes(symbol)).map(([, name]) => name)
    const repo = githubRepo(url)
    if (!repo) continue
    servers.push({
      name: stripMd(rawName),
      repo,
      url: repo.url,
      category: category || 'Uncategorized',
      description: desc || 'Описание в README отсутствует или не распознано.',
      official: flags.includes('🎖️'),
      languages,
      scopes,
      os,
      raw_line: line
    })
  }
  return servers
}

function githubRepo(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/i, '')
    return { owner, repo, full: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` }
  } catch {
    return null
  }
}

async function projectFit(server) {
  const available = await currentProjects()
  if (!available.length) return []
  const text = `${server.category} ${server.description} ${server.name}`
  const scored = available
    .map(project => {
      const p = project.toLowerCase()
      let score = 0
      if (/knowledge|memory|vault|note|search|rag|graph|документ|база|памят/i.test(text) && /knowledge|memory|vault|note|поиск|база|памят|знан/i.test(p)) score += 3
      if (/agent|orchestrat|mcp|gateway|coding|developer|github|ci|deploy|observability/i.test(text) && /agent|os|dev|инжен|код|platform|ops/i.test(p)) score += 2
      if (/legal|court|case law|contract|compliance|identity|trust/i.test(text) && /legal|law|прав|юр|compliance|trust/i.test(p)) score += 2
      if (/crm|sales|marketing|commerce|customer|support|ticket/i.test(text) && /crm|sales|shop|market|commerce|customer|support|продаж|маркет/i.test(p)) score += 2
      if (/image|audio|video|speech|game|education|story|translation/i.test(text) && /media|content|game|book|story|educ|контент|игр|книг/i.test(p)) score += 2
      return { project, score }
    })
    .sort((a, b) => b.score - a.score || a.project.localeCompare(b.project, 'ru'))
  const best = scored.filter(item => item.score > 0).slice(0, 5).map(item => item.project)
  return (best.length ? best : available.slice(0, 3))
}

function projectCategoryFit(server) {
  const text = `${server.category} ${server.description} ${server.name}`
  const categories = []
  for (const rule of categoryFits) if (rule.re.test(server.category)) categories.push(...rule.categories)
  for (const rule of keywordCategories) if (rule.re.test(text)) categories.push(...rule.categories)
  if (!categories.length) categories.push(projectCategory('universal-mcp'))
  return uniq(categories).slice(0, 6)
}

function riskOf(server) {
  const text = `${server.description} ${server.scopes.join(' ')} ${server.category}`.toLowerCase()
  if (/paid|payment|wallet|crypto|trading|finance|pay-per-call|x402|usdc|oauth|credential|browser|authenticated|write|deploy|cloud/.test(text)) return 'high: external account, paid call, credential, browser, finance, or cloud write risk possible'
  if (/local|file|database|shell|command|os automation|filesystem|postgres|mysql|sqlite/.test(text)) return 'medium: local file, DB, shell, or machine-access boundary'
  return 'low/medium: not vetted beyond awesome-list entry'
}

function installHint(server) {
  const hit = server.description.match(/(?:Install:|install(?: with)?:?)\s*`([^`]+)`/i) || server.description.match(/`((?:npx|uvx|pip install|docker|go install|cargo install)[^`]+)`/i)
  return hit?.[1] || 'README репозитория, перед установкой нужен отдельный vetting.'
}

function tags(server) {
  const categoryTags = projectCategoryFit(server).map(v => `project_category_${slug(v).replace(/-/g, '_')}`)
  return uniq([
    'mcp',
    'awesome-mcp-servers',
    slug(server.category).replace(/-/g, '_'),
    ...categoryTags,
    ...server.languages.map(v => slug(v).replace(/-/g, '_')),
    ...server.scopes.map(v => slug(v).replace(/-/g, '_'))
  ]).slice(0, 12)
}

function renderNote(server, meta, readmeSha) {
  const projects = server.projects || []
  const categories = projectCategoryFit(server)
  const risk = riskOf(server)
  const title = `${server.name}: MCP server из awesome-mcp-servers`
  const langs = server.languages.length ? server.languages.join(', ') : 'не указано'
  const scopes = server.scopes.length ? server.scopes.join(', ') : 'не указано'
  const systems = server.os.length ? server.os.join(', ') : 'не указано'
  const install = installHint(server)
  const projectLines = projects.map(project => `- ${project}: ${projectUse(project, server)}`).join('\n')
  const categoryLines = categories.map(category => `- ${category}: ${categoryUse(category, server)}`).join('\n')
  return `---
title: ${escYaml(title)}
type: tool-card
subject: world
section: "08 AI и Инструменты"
source: "awesome-mcp-servers:${server.repo.full}"
sources:
  - "https://github.com/punkpeye/awesome-mcp-servers"
  - ${escYaml(README_URL)}
  - ${escYaml(server.url)}
verified: подтвержден
verification_status: "verified"
status: "final"
enrichment: "external-research"
repo: ${escYaml(server.repo.full)}
stars: ${escYaml("unknown-individual; list-stars-" + (meta.stargazers_count || "unknown"))}
license: "unknown-individual; list-license-${meta.license?.spdx_id || 'unknown'}"
risk: ${escYaml(risk)}
${yamlList('projects', projects)}
${yamlList('project_categories', categories)}
tags: [${tags(server).map(escYaml).join(', ')}]
created: "${new Date().toISOString().slice(0, 10)}"
updated: "${new Date().toISOString().slice(0, 10)}"
---

# ${title}

## Короткий ответ

${server.name} - MCP-сервер из curated-списка punkpeye/awesome-mcp-servers. По описанию списка: ${server.description}

Это не рекомендация к установке. Это атом каталога: что за сервер, где он лежит, к каким текущим проектам и к каким категориям будущих проектов его можно примерить.

## Механика

- Категория списка: ${server.category}.
- Языки/стек: ${langs}.
- Среда: ${scopes}.
- ОС: ${systems}.
- Official marker: ${server.official ? 'да, отмечен значком official в списке' : 'нет'}.
- Репозиторий: ${server.url}.

## Применение

Сначала открывать README репозитория и проверять лицензию, свежесть, install-команду, права доступа и поверхность инструментов. Затем запускать только один маленький сценарий, без записи в живые аккаунты и без доступа к секретам.

Потенциальная install-подсказка из строки списка: \`${install}\`.

## Ошибки и границы

- Awesome-list подтверждает наличие записи, но не заменяет security review.
- Individual stars/license не вытягивались для 3850 репозиториев, чтобы не упереться в rate limit и не делать вид, что массовый список уже vetted.
- ${risk}.

## Как это поможет мне

Конкретные текущие проекты, где этот MCP-сервер может пригодиться:

${projectLines}

Категории проектов, где этот MCP-сервер стоит искать при создании нового проекта:

${categoryLines}

## Достоверность

- Источник: punkpeye/awesome-mcp-servers README, raw URL: ${README_URL}.
- SHA-256 README на момент прогона: \`${readmeSha}\`.
- Метаданные списка: ${meta.stargazers_count || 'unknown'} stars, license ${meta.license?.spdx_id || 'unknown'}, updated_at ${meta.updated_at || 'unknown'}, pushed_at ${meta.pushed_at || 'unknown'}.
- Строка списка: ${server.raw_line}
- Репозиторий сервера: ${server.url}.
- Проверка границ: отдельный репозиторий сервера не читался глубоко; перед установкой нужен vetting по README, license, scripts и MCP-scan/static scan.

## Связанные темы

инструмент-для [[Интеграции: новые инструменты → конкретные проекты]] · расширяет [[synthesis-mcp-нужен-для-внешних-систем-и-данных-6df49ec3ff]] · источник [[awesome-mcp-servers-index]]

## Следующий ход

Если сервер подходит под категорию нового проекта, выбрать один маленький сценарий из блока применения, прочитать README репозитория и провести safe install workflow. Без сценария - оставить в каталоге, не ставить.
`
}

function projectUse(project, server) {
  const category = server.category.toLowerCase()
  const description = server.description.toLowerCase()
  if (/knowledge|memory|search|rag|document|pdf|obsidian|vector/i.test(`${category} ${description}`)) return 'примерить как слой поиска, чтения документов, RAG, графа знаний или ingestion.'
  if (/agent|developer|coding|github|ci|deploy|observability|security/i.test(`${category} ${description}`)) return 'примерить как capability для агентной ОС, developer platform, registry, gateway, observability или безопасного доступа к сервисам.'
  if (/legal|court|contract|compliance|identity|trust/i.test(`${category} ${description}`)) return 'проверить на чтении правовых источников, документов, compliance или trust workflows, сначала в read-only режиме.'
  if (/crm|sales|marketing|commerce|customer|support/i.test(`${category} ${description}`)) return 'примерить для CRM, продаж, маркетинга, e-commerce, support или customer data workflows.'
  if (/image|audio|video|speech|game|education|story|translation/i.test(`${category} ${description}`)) return 'использовать для контента, мультимедиа, перевода, озвучки, обучения, игр или interactive content.'
  return `проверить fit по категории ${server.category}.`
}

function categoryUse(category, server) {
  if (/агентная ОС|оркестрация/i.test(category)) return 'подходит для проектов, где агентам нужен общий gateway, registry, discovery, sandbox, router или meta-MCP слой.'
  if (/developer platform|CI\/CD|observability|security/i.test(category)) return 'подходит для инженерных платформ, внутренних devtools, релизных гейтов, мониторинга, security review и работы с репозиториями.'
  if (/RAG|база знаний|документный/i.test(category)) return 'подходит для second brain, ingestion pipeline, поиска по документам, retrieval, graph/RAG и knowledge ops.'
  if (/данные|аналитика|BI/i.test(category)) return 'подходит для проектов вокруг БД, витрин данных, аналитики, BI, dashboard, ETL и research datasets.'
  if (/legaltech|compliance|trust/i.test(category)) return 'подходит для правовых, compliance, identity, trust, audit и проверочных продуктов, особенно если режим можно держать read-only.'
  if (/CRM|продажи|маркетинг|e-commerce/i.test(category)) return 'подходит для CRM, лидогенерации, продаж, маркетинга, e-commerce, support и customer data workflows.'
  if (/финтех|крипто|платежи/i.test(category)) return 'подходит для финтеха, crypto, платежей, market data и risk monitoring, но требует отдельного денежного и credential gate.'
  if (/мультимедиа|контент|образование|игры/i.test(category)) return 'подходит для проектов с генерацией/обработкой медиа, аудио, видео, речи, переводов, обучения, игр и interactive content.'
  if (/browser automation|desktop\/OS/i.test(category)) return 'подходит для проектов, где агенту нужно читать сайты, управлять браузером, проверять UI или работать с локальной машиной.'
  if (/коммуникации|support|workplace/i.test(category)) return 'подходит для рабочих порталов, helpdesk, командных коммуникаций, календарей, docs/workspace и внутренних операционных ботов.'
  if (/доменные операционные системы|IoT|гео/i.test(category)) return 'подходит для проектов с реальными объектами: IoT, геоданные, путешествия, недвижимость, спорт, home automation или отраслевые данные.'
  return `подходит как MCP-кандидат для проектов, где нужна категория ${server.category}.`
}

function renderIndex(servers, meta, readmeSha) {
  const byCategory = new Map()
  for (const server of servers) byCategory.set(server.category, (byCategory.get(server.category) || 0) + 1)
  const byProjectCategory = new Map()
  for (const server of servers) {
    for (const category of projectCategoryFit(server)) byProjectCategory.set(category, (byProjectCategory.get(category) || 0) + 1)
  }
  const rows = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `| ${category} | ${count} |`)
    .join('\n')
  const projectRows = [...byProjectCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([category, count]) => `| ${category} | ${count} |`)
    .join('\n')
  const allProjects = uniq(servers.flatMap(server => server.projects || [])).sort((a, b) => a.localeCompare(b, 'ru'))
  return `---
title: "awesome-mcp-servers index"
type: reference
subject: world
section: "08 AI и Инструменты"
source: "awesome-mcp-servers:index"
sources:
  - "https://github.com/punkpeye/awesome-mcp-servers"
  - ${escYaml(README_URL)}
verified: подтвержден
verification_status: "verified"
status: "final"
enrichment: "external-research"
${yamlList('projects', allProjects)}
${yamlList('project_categories', [...byProjectCategory.keys()].sort((a, b) => a.localeCompare(b, 'ru')))}
tags: ["mcp", "awesome_mcp_servers", "index", "tool_radar"]
created: "${new Date().toISOString().slice(0, 10)}"
updated: "${new Date().toISOString().slice(0, 10)}"
---

# awesome-mcp-servers index

## Короткий ответ

Это локальный атомизированный снимок списка punkpeye/awesome-mcp-servers. В этом прогоне сохранено ${servers.length} MCP-серверов: один markdown-атом на сервер плюс JSON-индекс для машинной обработки.

Главное правило: каталог не равен установке. Любой сервер перед подключением проходит отдельный safe install workflow.

## Механика

- Источник: ${README_URL}.
- Репозиторий списка: https://github.com/punkpeye/awesome-mcp-servers.
- Метаданные списка: ${meta.stargazers_count || 'unknown'} stars, license ${meta.license?.spdx_id || 'unknown'}, updated_at ${meta.updated_at || 'unknown'}, pushed_at ${meta.pushed_at || 'unknown'}.
- README SHA-256: \`${readmeSha}\`.
- Формат: category -> server line -> атом tool-card.

## Применение

Использовать этот каталог как локальный shortlist. Для нового проекта ищи по категории проекта, домену или ключевому слову, потом открывай атом сервера и делай vetting его собственного README.

## Категории

| Категория | Серверов |
|---|---:|
${rows}

## Как это поможет мне

Конкретные текущие проекты берутся из текущего vault-индекса проектов во время запуска atomizer, а не хранятся в публичном репозитории.

Категории будущих проектов, по которым новый проект сможет свериться с базой знаний и найти подходящие MCP-атомы:

| Категория проекта | MCP-кандидатов |
|---|---:|
${projectRows}

## Достоверность

- Источник прочитан ${new Date().toISOString()}.
- Индивидуальные репозитории не проверялись глубоко в этом массовом прогоне.
- JSON-индекс: \`${path.relative(VAULT, DATA_FILE)}\`.
- Сессия: ${SESSION}.

## Связанные темы

расширяет [[Интеграции: новые инструменты → конкретные проекты]] · расширяет [[synthesis-mcp-нужен-для-внешних-систем-и-данных-6df49ec3ff]]

## Навигация

Полный список лежит не в этой индексной ноте, а в соседних атомах и JSON-файле. Так индекс остается читаемым и не превращается в простыню из латинских repo slug.

## Следующий ход

При создании нового проекта взять его категорию, найти по ней MCP-кандидатов в этом каталоге и прогнать 5-10 лучших через vetting: README, license, scripts, permissions, mcp-scan/static scan, одноразовый smoke.
`
}

async function appendIntegrationSummary(servers, meta) {
  const blockId = 'awesome-mcp-servers-atomized'
  const start = `<!-- MNEMOZINA_ATOM_START ${blockId} -->`
  const end = '<!-- MNEMOZINA_ATOM_END -->'
  const block = `${start}

## awesome-mcp-servers - локальный каталог MCP-кандидатов 🔲

**Что сделано:** сохранен атомизированный снимок \`punkpeye/awesome-mcp-servers\`: ${servers.length} MCP-серверов, один vault-атом на сервер, плюс индекс \`08 AI и Инструменты/MCP Servers/awesome-mcp-servers/_index.md\`.

**Где применять сейчас:** конкретные проекты определяются из текущего vault-индекса проектов во время запуска atomizer; публичный репозиторий не хранит личную карту проектов.

**Категории будущих проектов:** агентная ОС и оркестрация агентов; developer platform/CI/CD/observability/security; поиск/RAG/база знаний/документный конвейер; данные/BI; legaltech/compliance/trust layer; CRM/маркетинг/e-commerce; финтех/крипто/платежи; мультимедиа/контент/образование/игры; browser и OS automation; коммуникации/support/workplace productivity; IoT/гео/real-world data.

**Гейт:** это каталог, не установка. Любой сервер перед подключением проходит README/license/scripts/permissions/mcp-scan или static scan и один безопасный smoke.

**Источник:** https://github.com/punkpeye/awesome-mcp-servers (${meta.stargazers_count || 'unknown'} stars на момент прогона).

${end}
`
  let text = await fs.readFile(INTEGRATIONS_FILE, 'utf8').catch(() => '')
  if (!text) return false
  const re = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  text = re.test(text) ? text.replace(re, block.trim()) : `${text.trim()}\n\n${block}`
  await fs.writeFile(INTEGRATIONS_FILE, `${text.trim()}\n`, 'utf8')
  return true
}

async function main() {
  const readme = curl(README_URL)
  const metaText = curl(REPO_API, true)
  const meta = metaText ? JSON.parse(metaText) : {}
  const readmeSha = crypto.createHash('sha256').update(readme).digest('hex')
  const parsed = parseReadme(readme)
  const byRepo = new Map()
  for (const server of parsed) if (!byRepo.has(server.repo.full)) byRepo.set(server.repo.full, server)
  const servers = [...byRepo.values()].sort((a, b) => a.repo.full.localeCompare(b.repo.full))
  if (!APPLY) {
    console.log(JSON.stringify({ ok: true, apply: false, parsed: parsed.length, unique: servers.length, outDir: OUT_DIR }, null, 2))
    return
  }
  await fs.mkdir(OUT_DIR, { recursive: true })
  for (const server of servers) {
    server.projects = await projectFit(server)
    const file = path.join(OUT_DIR, `${slug(server.repo.full)}.md`)
    await fs.writeFile(file, renderNote(server, meta, readmeSha), 'utf8')
  }
  await fs.writeFile(INDEX_FILE, renderIndex(servers, meta, readmeSha), 'utf8')
  await fs.writeFile(DATA_FILE, `${JSON.stringify({ source: README_URL, repo: REPO_API, readme_sha256: readmeSha, generated_at: new Date().toISOString(), servers }, null, 2)}\n`, 'utf8')
  const integrationUpdated = await appendIntegrationSummary(servers, meta)
  console.log(JSON.stringify({ ok: true, apply: true, parsed: parsed.length, unique: servers.length, outDir: OUT_DIR, index: INDEX_FILE, data: DATA_FILE, integrationUpdated }, null, 2))
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
