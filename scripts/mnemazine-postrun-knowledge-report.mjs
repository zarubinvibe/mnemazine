#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)
const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function flag(name) {
  return argv.includes(`--${name}`)
}

function lastRunVault() {
  const file = path.join(ROOT, '.mnemazine/state/last-run.json')
  try {
    const state = JSON.parse(fsSync.readFileSync(file, 'utf8'))
    return state?.vault || ''
  } catch {
    return ''
  }
}
const VAULT = resolveVault({
  cli: arg('vault', process.env.MNEMAZINE_VAULT || ''),
})
const REPORTS = path.resolve(arg('reports', process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')))
const RUN_ID = arg('run-id', new Date().toISOString().slice(0, 10))
const TITLE = arg('title', 'Отчет Mnemazine по знаниям')
const LOGS = arg('logs', '')
const RESULTS_JSON = arg('results-json', '')
const FINAL_FILES_JSON = arg('final-files-json', '')
const SINCE_DAYS = Number(arg('since-days', process.env.MNEMAZINE_POSTRUN_SINCE_DAYS || '7'))
function lastRunState() {
  const file = path.join(ROOT, '.mnemazine/state/last-run.json')
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8')) } catch { return null }
}
const LAST_RUN = lastRunState()
const CHANGED_SINCE = arg('changed-since', LAST_RUN?.started_at || '')

const DEFAULT_LOGS = (process.env.MNEMAZINE_POSTRUN_LOGS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function mdEsc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
}

function rel(file) {
  return file && file.startsWith(VAULT) ? path.relative(VAULT, file) : file
}

function clean(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function present(text) {
  return String(text || '')
    .replace(/\bcandidate capability\b/gi, 'кандидат в рабочие возможности')
    .replace(/\bcapability review queue\b/gi, 'очередь разбора возможностей')
    .replace(/\bworkflow-fit\b/gi, 'пригодность для конкретного сценария')
    .replace(/\bworkflow\b/gi, 'рабочий сценарий')
    .replace(/с одним реальным рабочий сценарий/gi, 'с одним реальным рабочим сценарием')
    .replace(/если пригодность для конкретного сценария конкретный/gi, 'если есть понятная пригодность для конкретного сценария')
    .replace(/с одним критерием принять\/отклонить/gi, 'с одним критерием: принять или отклонить')
    .replace(/Перед пробный запуск проверить/gi, 'Перед пробным запуском проверить')
    .replace(/режим только чтение режим/gi, 'режим только чтения')
    .replace(/список разрешенных доменов доменов/gi, 'список разрешенных доменов')
    .replace(/web-рабочий сценарий/gi, 'браузерный сценарий')
    .replace(/черновик короткое видео/gi, 'черновик короткого видео')
    .replace(/\bfit под конкретный рабочий сценарий\b/gi, 'пригодность к конкретному рабочему сценарию')
    .replace(/\blocal trial\b/gi, 'локальный пробный запуск')
    .replace(/\btrial\b/gi, 'пробный запуск')
    .replace(/\breview diff\b/gi, 'проверку изменений кода')
    .replace(/\bweb-workflow\b/gi, 'браузерный сценарий')
    .replace(/\bshort-form video\b/gi, 'короткое видео')
    .replace(/\bhook\/CTA\b/gi, 'крючок и призыв к действию')
    .replace(/\bread-only\b/gi, 'режим только чтение')
    .replace(/\ballowlist\b/gi, 'список разрешенных доменов')
    .replace(/\bregistry\/ledger\b/gi, 'реестр и журнал')
    .replace(/\s+(?:src|href|alt|title)=["'][^"']*["']/gi, '')
    .replace(/\b(?:src|href|alt|title)=["'][^"']*["']/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\bIMG_\d+(?:\.(?:WEBP|PNG|JPE?G|HEIC|TIFF|MOV|MP4))?\b/gi, 'локальный визуальный источник')
    .replace(/\btemp_image[_-][\w.-]+/gi, 'локальный визуальный источник')
    .replace(/\b[\w.-]+\.(?:WEBP|PNG|JPE?G|HEIC|TIFF|MOV|MP4)\b/gi, 'локальный медиафайл')
    .replace(/\bDESIGN\.md\b/gi, 'дизайн-контракт')
    .replace(/\bgetdesign\.md\b/gi, 'getdesign')
    .replace(/\b[\wА-Яа-яЕе ._-]+\.md\b/gi, 'локальная заметка')
    .replace(/\b[\w.-]+\.md\b/gi, 'локальная заметка')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstPara(text, max = 420) {
  const para = clean(text).split(/\n\s*\n/).map(x => x.replace(/\n/g, ' ').trim()).find(Boolean) || ''
  return para.length > max ? `${para.slice(0, max - 1).trim()}...` : para
}

function titleOf(text, file) {
  return text.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ||
    text.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    path.basename(file || 'untitled', '.md')
}

function extractSection(text, names) {
  for (const name of names) {
    const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi')
    const hit = text.match(re)
    if (hit) return clean(hit[1])
  }
  return ''
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
    const p = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...await walk(p))
    else if (item.isFile() && item.name.endsWith('.md')) out.push(p)
  }
  return out
}

let allMdCache = null
async function findByBasename(name) {
  allMdCache ||= await walk(VAULT)
  return allMdCache.find(file => path.basename(file) === name) || ''
}

async function resolveNote(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const text = raw.trim()
  if (!text || text.includes('\n') || text.startsWith('Группа ') || text.startsWith('Смешанный материал')) return ''
  if (path.isAbsolute(text) && fsSync.existsSync(text)) return text
  if (text.includes('/') && text.endsWith('.md')) {
    const full = path.join(VAULT, text)
    if (fsSync.existsSync(full)) return full
  }
  if (text.endsWith('.md')) return await findByBasename(path.basename(text))
  return ''
}

function parseJsonLine(line) {
  const s = line.trim()
  if (!s.startsWith('{') || !s.includes('"group_id"')) return null
  try {
    const obj = JSON.parse(s)
    if (obj && obj.group_id && obj.outcome && Array.isArray(obj.files)) return obj
  } catch {}
  return null
}

async function loadResults() {
  const rows = []
  if (RESULTS_JSON) {
    const raw = JSON.parse(await fs.readFile(RESULTS_JSON, 'utf8'))
    if (Array.isArray(raw)) rows.push(...raw)
    else if (Array.isArray(raw.processResults)) rows.push(...raw.processResults)
  }
  const logs = LOGS ? LOGS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_LOGS
  for (const log of logs) {
    if (!fsSync.existsSync(log)) continue
    for (const line of (await fs.readFile(log, 'utf8')).split(/\n/)) {
      const obj = parseJsonLine(line)
      if (obj) rows.push(obj)
    }
  }
  if (!rows.length) rows.push(...await loadRecentVaultResults(SINCE_DAYS, CHANGED_SINCE))
  const byGroup = new Map()
  for (const row of rows) byGroup.set(row.group_id, row)
  return [...byGroup.values()]
}

function sinceMs(value) {
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function loadRecentVaultResults(days, changedSince = '') {
  const files = await walk(VAULT)
  const cutoff = sinceMs(changedSince) || (Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000)
  const rows = []
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null)
    if (!stat || stat.mtimeMs < cutoff) continue
    const id = path.relative(VAULT, file).replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-')
    rows.push({
      group_id: `vault-${id}`,
      outcome: 'note',
      files: [file],
      filename: file,
    })
  }
  return rows
}

function fileCount(result) {
  return new Set((result.files || []).map(f => path.basename(f))).size
}

function sectionOf(file) {
  if (!file) return 'не найдено'
  const parts = path.relative(VAULT, file).split(path.sep)
  return parts[0] || 'корень'
}

function splitAtoms(text) {
  const fromSection = extractSection(text, ['Атомизация', 'Атомизировано'])
  const raw = fromSection || ''
  return raw.split(/\n+/)
    .map(line => line.replace(/^[-*]\s*/, '').replace(/^`([^`]+)`:\s*/, '$1 - ').trim())
    .filter(line => line && !line.startsWith('#'))
    .slice(0, 8)
}

function scoreRecord(record) {
  const text = `${record.title} ${record.summary} ${record.helps}`.toLowerCase()
  let score = 0
  const weights = [
    ['agent', 16], ['codex', 15], ['claude', 15], ['mnemazine', 14], ['мнемозина', 14],
    ['legal', 14], ['юрист', 14], ['investor', 13], ['startup', 13], ['стартап', 13],
    ['quick wins', 12], ['workflow', 11], ['portal', 10], ['marketplace', 10],
    ['промпт', 8], ['skill', 8], ['graph', 7], ['dashboard', 7],
  ]
  for (const [term, value] of weights) if (text.includes(term)) score += value
  if (record.outcomes.note) score += 6
  if (record.outcomes.atoms) score += 5
  score += Math.min(record.files, 10)
  return score
}

function inferAction(record) {
  const text = `${record.title} ${record.summary}`.toLowerCase()
  if (record.next && record.next !== '—') return record.next
  if (text.includes('legal') || text.includes('юрист') || text.includes('lexora')) return 'Собрать product spec для Legal/Femida: витрина, intake, кабинет, документы, статусы.'
  if (text.includes('investor') || text.includes('cap table') || text.includes('esop') || text.includes('стартап')) return 'Собрать investor-ready data room pack: документы, cap table, ESOP, agreements, memo.'
  if (text.includes('agent') || text.includes('codex') || text.includes('claude')) return 'Перенести в Agent OS blueprint: роли, команды, memory, trace, gates, dashboard.'
  if (text.includes('quick wins') || text.includes('support') || text.includes('sales')) return 'Сделать AI quick-wins offer: боль, данные, MVP, риск, цена, демо.'
  if (text.includes('промпт') || text.includes('prompt')) return 'Добавить в slash-command pack и протестировать на одной реальной задаче.'
  return 'Прочитать ноту, выбрать один применимый проект и превратить в маленькое действие.'
}

function clusterOf(record) {
  const text = `${record.title} ${record.summary}`.toLowerCase()
  if (text.includes('legal') || text.includes('lexora') || text.includes('юрист') || text.includes('marketplace')) return 'Legal / Femida'
  if (text.includes('investor') || text.includes('cap table') || text.includes('esop') || text.includes('founder') || text.includes('shareholder')) return 'Investor-ready startup'
  if (text.includes('agent') || text.includes('codex') || text.includes('claude') || text.includes('mnemazine') || text.includes('graph')) return 'Agent OS'
  if (text.includes('quick wins') || text.includes('support') || text.includes('sales') || text.includes('onboarding')) return 'AI business offers'
  if (text.includes('prompt') || text.includes('промпт') || text.includes('slash')) return 'Промпты и команды'
  return 'Прочие полезные знания'
}

async function buildRecords(results) {
  const records = new Map()
  for (const result of results) {
    const raw = result.filename || result.note_md || ''
    const noteFile = await resolveNote(raw)
    const key = noteFile || raw || `${result.outcome}:${result.group_id}`
    const record = records.get(key) || {
      key,
      file: noteFile,
      raw,
      title: '',
      section: '',
      summary: '',
      helps: '',
      next: '',
      atoms: [],
      files: 0,
      groups: [],
      outcomes: {},
      cluster: '',
      score: 0,
    }
    record.groups.push(result.group_id)
    record.files += fileCount(result)
    record.outcomes[result.outcome] = (record.outcomes[result.outcome] || 0) + 1
    if (noteFile && fsSync.existsSync(noteFile)) {
      const text = await fs.readFile(noteFile, 'utf8')
      record.title ||= titleOf(text, noteFile)
      record.section ||= sectionOf(noteFile)
      record.summary ||= firstPara(extractSection(text, ['Короткий ответ', 'Что это и зачем', 'Что это', 'Что обещает README', 'Риск', 'Решение', 'Суть', 'Полное объяснение', 'What This Is']), 430)
      record.helps ||= firstPara(extractSection(text, ['Как использовать', 'Как поможет мне', '🎯 Как поможет мне', 'Как это поможет мне', 'Зачем мне', 'Что добавила Mnemazine']), 340)
      record.next ||= firstPara(extractSection(text, ['Следующий ход', 'Следующее действие', 'Next Action']), 260).replace(/^[-*]\s*/, '')
      record.atoms = record.atoms.length ? record.atoms : splitAtoms(text)
    } else {
      record.title ||= raw ? firstPara(raw, 100) : result.group_id
      record.section ||= 'не найдено'
      record.summary ||= result.helps || ''
      record.next ||= result.next_action || ''
    }
    record.title = present(record.title) || 'Локальное знание'
    record.summary = present(record.summary)
    record.helps = present(record.helps)
    record.next = present(record.next)
    record.atoms = record.atoms.map(atom => present(atom)).filter(Boolean)
    record.next = inferAction(record)
    record.cluster = clusterOf(record)
    record.score = scoreRecord(record)
    records.set(key, record)
  }
  return [...records.values()]
}

function outcomeLabel(record) {
  const names = { note: 'заметка', atoms: 'атомы', dup: 'дубль' }
  return Object.entries(record.outcomes).map(([k, v]) => `${names[k] || k}:${v}`).join(', ')
}

function noteLink(record) {
  if (!record.file) return '—'
  return `[${present(record.title) || 'Локальное знание'}](${record.file})`
}

function top20(records) {
  return records
    .filter(r => r.outcomes.note || r.outcomes.atoms)
    .sort((a, b) => b.score - a.score || b.files - a.files)
    .slice(0, 20)
}

function groupByCluster(records) {
  const map = new Map()
  for (const record of records) {
    const list = map.get(record.cluster) || []
    list.push(record)
    map.set(record.cluster, list)
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
}

function brief(text, max = 150) {
  const value = present(String(text || '').replace(/\s+/g, ' ').trim())
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max - 1).trim()}...` : value
}

function unique(values, limit) {
  const seen = new Set()
  const out = []
  for (const value of values.map(v => brief(v, 96)).filter(Boolean)) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

function moduleModel(clusters) {
  return clusters.map(([name, items]) => {
    const sorted = [...items].sort((a, b) => b.score - a.score)
    const lead = sorted[0] || {}
    const atoms = unique(sorted.flatMap(item => item.atoms.length ? item.atoms : [item.title]), 6)
    return {
      name,
      count: items.length,
      files: items.reduce((sum, item) => sum + item.files, 0),
      title: brief(lead.title, 80) || name,
      what: brief(lead.summary || lead.title, 170) || 'Новый блок знаний для повторного использования.',
      why: brief(lead.helps, 150) || 'Можно привязать к проектам, агентам, скриптам или решениям.',
      next: brief(lead.next, 150) || inferAction(lead),
      atoms,
      score: sorted.reduce((sum, item) => sum + item.score, 0),
      file: lead.file || '',
    }
  })
}

function graphSvg(modules) {
  const width = 760
  const height = 380
  const cx = width / 2
  const cy = height / 2
  const radius = 142
  const nodes = modules.slice(0, 8).map((mod, index, arr) => {
    const angle = (-90 + index * (360 / Math.max(1, arr.length))) * Math.PI / 180
    return { ...mod, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })
  const lines = nodes.map(n => `<line x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" />`).join('')
  const circles = nodes.map((n, index) => `<g class="g-node" style="--i:${index}" transform="translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})"><circle r="${Math.min(48, 28 + n.count * 2)}" /><text text-anchor="middle" y="-4">${esc(n.name.slice(0, 18))}</text><text class="sub" text-anchor="middle" y="15">${n.count} нот</text></g>`).join('')
  return `<svg class="knowledge-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Карта модулей знаний"><g class="links">${lines}</g><g class="center"><circle cx="${cx}" cy="${cy}" r="54" /><text x="${cx}" y="${cy - 4}" text-anchor="middle">Mnemazine</text><text class="sub" x="${cx}" y="${cy + 17}" text-anchor="middle">новые знания</text></g>${circles}</svg>`
}

function mermaid(records) {
  const clusters = groupByCluster(records.filter(r => r.outcomes.note || r.outcomes.atoms))
  const lines = ['mindmap', '  root((Прогон Mnemazine))']
  for (const [cluster, items] of clusters) {
    lines.push(`    ${cluster.replace(/[()]/g, '')}`)
    for (const item of items.slice(0, 8)) {
      lines.push(`      ${item.title.replace(/[:()]/g, '').slice(0, 72)}`)
      for (const atom of item.atoms.slice(0, 3)) lines.push(`        ${atom.replace(/[:()]/g, '').slice(0, 66)}`)
    }
  }
  return lines.join('\n')
}

function markdown({ records, results, mdPath, htmlPath }) {
  const fresh = records.filter(r => r.outcomes.note || r.outcomes.atoms)
  const dup = records.filter(r => !r.outcomes.note && !r.outcomes.atoms && r.outcomes.dup)
  const action = top20(records)
  const rows = fresh
    .sort((a, b) => a.cluster.localeCompare(b.cluster, 'ru') || b.score - a.score)
    .map(r => `| ${mdEsc(r.cluster)} | ${mdEsc(outcomeLabel(r))} | ${r.files} | ${noteLink(r)} | ${mdEsc(r.summary || '—')} | ${mdEsc(r.helps || '—')} | ${mdEsc(r.next || '—')} |`)
  const actionRows = action.map((r, i) => `| ${i + 1} | ${mdEsc(r.cluster)} | ${noteLink(r)} | ${mdEsc(r.next)} |`)
  const dupRows = dup
    .sort((a, b) => b.files - a.files)
    .map(r => `| ${mdEsc(r.cluster)} | ${r.files} | ${noteLink(r)} | ${mdEsc(r.summary || r.title)} |`)
  return `# Отчет Mnemazine по знаниям

Прогон: ${RUN_ID}
HTML: ${htmlPath}

## Сводка

- Смысловых групп: **${results.length}**.
- Новые/обновленные цели знаний: **${fresh.length}**.
- Дубль-цели: **${dup.length}**.
- Визуальная логика: крупные кластеры -> ноты -> малые атомы -> действия.

## Карта знаний

\`\`\`mermaid
${mermaid(records)}
\`\`\`

## Новые и обновленные знания

| Кластер | Исход | Файлов | Нота | Что это | Как полезно | Следующий ход |
|---|---|---:|---|---|---|---|
${rows.join('\n')}

## Топ-20 к действию

| # | Кластер | Нота | Действие |
|---:|---|---|---|
${actionRows.join('\n')}

## Дубли, которые не потеряны

| Кластер | Файлов | Нота | Что уже покрыто |
|---|---:|---|---|
${dupRows.join('\n')}
`
}

function html({ records, results }) {
  const fresh = records.filter(r => r.outcomes.note || r.outcomes.atoms)
  const dup = records.filter(r => !r.outcomes.note && !r.outcomes.atoms && r.outcomes.dup)
  const actions = top20(records)
  const clusters = groupByCluster(fresh)
  const modules = moduleModel(clusters)
  const topModules = modules.slice(0, 6)
  const minuteActions = actions.slice(0, 6)
  const css = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#111827;--muted:#667085;--line:#e6eaf0;--blue:#0a66ff;--green:#0f9f6e;--yellow:#b7791f;--red:#d33a2c;--shadow:0 18px 44px rgba(24,39,75,.08);--ease:cubic-bezier(.23,1,.32,1)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;letter-spacing:0}
a{color:inherit}.hero{padding:44px max(18px,5vw) 24px;background:#fff;border-bottom:1px solid var(--line)}
.eyebrow{font-size:12px;font-weight:760;color:var(--blue);text-transform:uppercase;letter-spacing:.08em}.hero h1{font-size:clamp(36px,5vw,64px);line-height:1;margin:10px 0 10px;letter-spacing:0}.lead{font-size:clamp(16px,1.7vw,21px);line-height:1.35;color:#344054;max-width:900px;margin:0}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.stat{background:#f9fafb;border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:132px}.stat strong{display:block;font-size:24px}.stat span{font-size:12px;color:var(--muted)}
main{padding:20px max(16px,4.5vw) 64px}.minute{display:grid;grid-template-columns:minmax(340px,1.35fr) minmax(300px,.75fr);gap:14px;align-items:stretch}.panel{background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:16px}.panel h2{font-size:22px;margin:0 0 10px}.panel p{color:#475467;line-height:1.45;margin:0}
.knowledge-graph{width:100%;height:auto;display:block}.knowledge-graph .links line{stroke:#d8e2ef;stroke-width:2}.knowledge-graph .center circle{fill:#111827}.knowledge-graph .center text{fill:#fff;font-size:16px;font-weight:760}.knowledge-graph text.sub{font-size:12px;font-weight:560;fill:#667085}.knowledge-graph .center text.sub{fill:#d0d5dd}.g-node circle{fill:#fff;stroke:#a9c5ff;stroke-width:2;filter:drop-shadow(0 8px 18px rgba(24,39,75,.12))}.g-node text{font-size:12px;font-weight:760;fill:#1d2939}.g-node .sub{fill:#667085}
.action-stack{display:grid;gap:8px;counter-reset:step}.quick-action{display:grid;grid-template-columns:30px 1fr;gap:9px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fbfcff}.quick-action:before{counter-increment:step;content:counter(step);width:26px;height:26px;border-radius:8px;background:var(--ink);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800}.quick-action b{display:block;font-size:13px;margin-bottom:3px}.quick-action span{display:block;color:#475467;font-size:13px;line-height:1.35}
.section-title{display:flex;justify-content:space-between;gap:16px;align-items:end;margin:24px 0 12px}.section-title h2{font-size:24px;margin:0;letter-spacing:0}.section-title p{max-width:620px;color:var(--muted);line-height:1.45;margin:0}
.modules{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.module{background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:15px;display:grid;gap:10px}.module-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.module h3{font-size:18px;line-height:1.15;margin:0}.badge{font-size:12px;color:#344054;background:#f2f4f7;border:1px solid var(--line);border-radius:7px;padding:5px 7px;white-space:nowrap}.module-grid{display:grid;grid-template-columns:72px 1fr;gap:6px 10px;font-size:13px}.module-grid b{color:#1d2939}.module-grid span{color:#475467;line-height:1.35}.atoms{display:flex;flex-wrap:wrap;gap:6px}.atom{font-size:12px;color:#475467;background:#eef3ff;border:1px solid #dce7ff;border-radius:7px;padding:5px 7px}
.details{margin-top:18px}.details summary{cursor:pointer;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:14px 16px;font-weight:760}.details-body{padding-top:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px}.meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.tag{font-size:11px;color:#344054;background:#f2f4f7;border:1px solid var(--line);border-radius:7px;padding:4px 6px}.card h3{font-size:16px;line-height:1.2;margin:0 0 8px}.card p{font-size:13px;line-height:1.45;color:#344054;margin:7px 0}.dups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.dup{background:#fff;border:1px solid var(--line);border-radius:8px;padding:11px}.dup b{display:block;margin-bottom:4px}.dup span{color:var(--muted);font-size:12px}
@media(max-width:880px){.minute{grid-template-columns:1fr}.section-title{display:block}.section-title p{margin-top:6px}.knowledge-graph{max-height:360px}.module-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`
  const moduleHtml = topModules.map(mod => `<article class="module" id="${esc(mod.name)}">
    <div class="module-head"><h3>${esc(mod.name)}</h3><span class="badge">${mod.count} нот · ${mod.files} файлов</span></div>
    <div class="module-grid"><b>Что</b><span>${esc(mod.what)}</span><b>Зачем</b><span>${esc(mod.why)}</span><b>Действие</b><span>${esc(mod.next)}</span></div>
    <div class="atoms">${mod.atoms.map(atom => `<span class="atom">${esc(atom)}</span>`).join('')}</div>
  </article>`).join('')
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<style>${css}</style>
</head>
<body>
<header class="hero">
  <div>
    <div class="eyebrow">Отчет Mnemazine после прогона</div>
    <h1>Минутная карта знаний</h1>
    <p class="lead">Сначала модули и атомы, потом действия. Подробный текст спрятан ниже, чтобы быстро понять, что появилось и зачем это нужно.</p>
    <div class="stats">
      <div class="stat"><strong>${results.length}</strong><span>смысловых групп</span></div>
      <div class="stat"><strong>${fresh.length}</strong><span>новых и обновленных целей</span></div>
      <div class="stat"><strong>${dup.length}</strong><span>дубль-целей без потерь</span></div>
      <div class="stat"><strong>${actions.length}</strong><span>действий к запуску</span></div>
    </div>
  </div>
</header>
<main>
  <section class="minute">
    <div class="panel">
      <h2>Блок-схема</h2>
      ${graphSvg(topModules)}
      <p>Синтез: источники и проверка сведены в модули. Применение видно через действия, риск - через дубли, неизвестные и слабые извлечения.</p>
      <p><a href="#modules">Источники</a> · <a href="#actions">Где применить</a> · <a href="#details">Проверка и риск</a></p>
    </div>
    <div class="panel" id="actions">
      <h2>Следующее действие</h2>
      <div class="action-stack">${minuteActions.map(item => `<article class="quick-action"><div><b>${esc(item.cluster)}</b><span>${esc(brief(item.next, 120))}</span></div></article>`).join('')}</div>
    </div>
  </section>
  <section class="section-title" id="modules"><h2>Модули и атомы</h2><p>Каждый модуль: что это, для чего нужно, какие маленькие знания внутри.</p></section>
  <section class="modules">${moduleHtml}</section>
  <details class="details" id="details">
    <summary>Подробности: все ноты, top-20 действий и дубли</summary>
    <div class="details-body">
      <section class="section-title"><h2>Топ-20 к действию</h2><p>Полный рекомендуемый порядок.</p></section>
      <section class="cards">${actions.map((item, i) => `<article class="card"><div class="meta"><span class="tag">#${i + 1}</span><span class="tag">${esc(item.cluster)}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.next)}</p></article>`).join('')}</section>
      <section class="section-title"><h2>Новые и обновленные знания</h2><p>Архивная часть отчета.</p></section>
      <section class="cards">${fresh.sort((a, b) => b.score - a.score).map(item => `<article class="card"><div class="meta"><span class="tag">${esc(item.cluster)}</span><span class="tag">${esc(outcomeLabel(item))}</span><span class="tag">${item.files} файлов</span></div><h3>${item.file ? `<a href="file://${esc(item.file)}">${esc(item.title)}</a>` : esc(item.title)}</h3><p>${esc(brief(item.summary || 'Описание не найдено, смотри ноту.', 180))}</p><p><strong>Как полезно:</strong> ${esc(brief(item.helps || 'Привязать к ближайшему проекту.', 160))}</p></article>`).join('')}</section>
      <section class="section-title"><h2>Дубли без потерь</h2><p>Материалы, которые подтвердили уже существующие знания.</p></section>
      <section class="dups">${dup.sort((a, b) => b.files - a.files).map(item => `<article class="dup"><b>${esc(item.title)}</b><span>${esc(item.cluster)} · ${item.files} файлов · ${esc(outcomeLabel(item))}</span></article>`).join('')}</section>
    </div>
  </details>
</main>
</body>
</html>`
}

await fs.mkdir(REPORTS, { recursive: true })
const results = await loadResults()
const records = await buildRecords(results)
const stamp = new Date().toISOString().slice(0, 10)
const safeRun = RUN_ID.replace(/[^a-zA-Z0-9_-]+/g, '-')
const mdPath = path.join(REPORTS, `${stamp}-${safeRun}-visual-knowledge-report.md`)
const htmlPath = path.join(REPORTS, `${stamp}-${safeRun}-visual-knowledge-report.html`)
await fs.writeFile(mdPath, markdown({ records, results, mdPath, htmlPath }), 'utf8')
await fs.writeFile(htmlPath, html({ records, results }), 'utf8')

if (!flag('quiet')) {
  console.log(JSON.stringify({
    ok: true,
    run_id: RUN_ID,
    groups: results.length,
    records: records.length,
    fresh: records.filter(r => r.outcomes.note || r.outcomes.atoms).length,
    duplicates: records.filter(r => !r.outcomes.note && !r.outcomes.atoms && r.outcomes.dup).length,
    md: mdPath,
    html: htmlPath,
  }, null, 2))
}
