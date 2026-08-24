#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MIN_CYR_SHARE, SPEC_TYPES } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function flag(name) {
  return argv.includes(`--${name}`)
}

if (flag('help')) {
  console.log(`mnemazine-kb-lint.mjs — линт корпуса знаний: битые wikilinks, расхождение индексов,
NOTE-SPEC, сироты, кириллица, обязательные блоки, протухшие ноты, мусор корня.

Использование: node scripts/mnemazine-kb-lint.mjs [флаги]
  --vault <путь>  корпус (иначе MNEMAZINE_VAULT или repo-local vault)
  --limit N       сколько худших показать в каждом списке (по умолчанию 20)
  --json          полный отчёт в JSON в stdout (report_path: null без --write)
  --write         записать отчёт и .last-lint в <vault>/99 Система/_lint/
                  (по умолчанию НИЧЕГО не пишет: отчёт уходит в stdout)
  --help          эта справка

Коды возврата: 0 — чисто; 1 — есть critical-находки или ошибка запуска.`)
  process.exit(0)
}

// Закрытый enum type из docs/NOTE-SPEC.md — незнакомое значение = провал.
// Ноты, датированные с этой даты, обязаны NOTE-SPEC (старые — advisory, отдельная кампания).
const SPEC_DATE = '2026-07-25'
const STALE_DAYS = 30
// Короче — доля кириллицы шумит на списках путей/команд, не на прозе.
const MIN_PROSE_LETTERS = 100
const DAY_MS = 24 * 60 * 60 * 1000
// Порог «индекс протух», а не строгое «старше хоть на секунду». Строгое сравнение было красным ПО
// ПОСТРОЕНИЮ: конвейер строит эмбеддинги и граф, а потом дописывает ноты — mtime индекса всегда раньше
// mtime свежайшей ноты, и линт печатал critical «старше на 0 дн.» сразу после успешного прогона.
// Гейт, который нельзя пройти, ничего не измеряет: он просто приучает не смотреть на красное.
const INDEX_STALE_MS = Number(process.env.MNEMAZINE_INDEX_STALE_DAYS || '1') * DAY_MS

// macOS хранит имена файлов в NFD, текст ссылок обычно NFC — без нормализации
// русские wikilinks ложно битые.
const nfc = value => String(value || '').normalize('NFC')

// Служебный слой (NOTE-SPEC «Когда НЕ по этой спеке»): свои форматы,
// спека/сиротство/блоки к ним не применяются.
function isService(rel) {
  if (rel.startsWith('99 Система/') || rel.startsWith('00 Входящие/')) return true
  const parts = rel.split('/')
  if (parts.some(part => part.startsWith('_'))) return true
  const base = parts[parts.length - 1]
  return /^(AGENTS|CLAUDE|README)\.md$/i.test(base) || base.startsWith('Лог ') || base.startsWith('Без названия')
}

async function walkVault(vault) {
  const md = []
  const dirs = new Set()
  const fileKeys = new Set()
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, item.name)
      const rel = nfc(path.relative(vault, abs).replace(/\\/g, '/'))
      if (item.isDirectory()) {
        if (['.git', '.obsidian', '.mnemazine'].includes(item.name) || item.name.startsWith('graphify-out')) continue
        // Отчёты этого же линта — не ноты: не линтуются и не входят в счёт диска.
        if (rel === '99 Система/_lint') continue
        dirs.add(rel)
        await walk(abs)
      } else if (item.isFile()) {
        fileKeys.add(rel)
        fileKeys.add(nfc(item.name))
        fileKeys.add(nfc(item.name).replace(/\.md$/i, ''))
        if (item.name.endsWith('.md')) md.push({ abs, rel })
      }
    }
  }
  await walk(vault)
  return { md, dirs, fileKeys }
}

function fmValue(fm, key) {
  const match = (fm || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  if (!match) return ''
  return match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
}

function fmDate(fm, key) {
  const hit = fmValue(fm, key).match(/\d{4}-\d{2}-\d{2}/)
  return hit ? hit[0] : ''
}

// Код-блоки гасятся пробелами, не вырезаются — номера строк и позиции не едут.
function scanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, block => ' '.repeat(block.length))
}

function proseOf(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
}

function cyrillicShare(prose) {
  const cyr = (prose.match(/[а-яё]/gi) || []).length
  const lat = (prose.match(/[a-z]/gi) || []).length
  const total = cyr + lat
  return { total, share: total ? cyr / total : 1 }
}

function linkTarget(raw) {
  return nfc(raw.split('|')[0].split('#')[0].split('^')[0].trim().replace(/\\+$/, ''))
}

async function checkIndexes(vault, notes) {
  const issues = []
  const diskCount = notes.length
  const master = await fs.readFile(path.join(vault, '_МАСТЕР-ИНДЕКС.md'), 'utf8').catch(() => '')
  const hit = master.match(/Всего markdown[^:]*:\s*\*\*(\d+)\*\*/i)
  const counter = hit ? Number(hit[1]) : null
  if (counter === null) issues.push('в _МАСТЕР-ИНДЕКС.md не найден счётчик «Всего markdown: **N**»')
  else if (counter !== diskCount) issues.push(`_МАСТЕР-ИНДЕКС.md заявляет ${counter} .md, на диске ${diskCount}`)
  const newestMs = notes.reduce((max, note) => Math.max(max, note.mtimeMs), 0)
  for (const relIndex of ['99 Система/_embeddings.json', 'graphify-out/graph.json']) {
    const stat = await fs.stat(path.join(vault, relIndex)).catch(() => null)
    if (!stat) issues.push(`${relIndex} отсутствует`)
    else if (newestMs - stat.mtimeMs >= INDEX_STALE_MS) {
      const lagDays = Math.round((newestMs - stat.mtimeMs) / DAY_MS * 10) / 10
      issues.push(`${relIndex} старше свежайшей ноты на ${lagDays} дн.`)
    }
  }
  return { issues, counter, disk_count: diskCount, newest_note: new Date(newestMs).toISOString() }
}

async function rootJunk(vault) {
  const junk = []
  for (const item of await fs.readdir(vault, { withFileTypes: true }).catch(() => [])) {
    const name = nfc(item.name)
    if (name === '.DS_Store' || name.startsWith('Без названия')) junk.push(name)
  }
  return junk.sort()
}

async function runLint({ vault, limit }) {
  const wiki = await walkVault(vault)
  const notes = []
  for (const file of wiki.md) {
    const [text, stat] = await Promise.all([fs.readFile(file.abs, 'utf8'), fs.stat(file.abs)])
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    notes.push({ ...file, text, mtimeMs: stat.mtimeMs, fm: fmMatch ? fmMatch[1] : null })
  }

  const noteIndex = new Map()
  const addKey = (key, rel) => {
    if (!key) return
    if (!noteIndex.has(key)) noteIndex.set(key, new Set())
    noteIndex.get(key).add(rel)
  }
  for (const note of notes) {
    const base = nfc(path.basename(note.rel))
    addKey(note.rel, note.rel)
    addKey(note.rel.replace(/\.md$/i, ''), note.rel)
    addKey(base, note.rel)
    addKey(base.replace(/\.md$/i, ''), note.rel)
  }

  const brokenByTarget = new Map()
  const linked = new Set()
  const linkRe = /\[\[([^\]\n]+)\]\]/g
  for (const note of notes) {
    const text = scanText(note.text)
    let match
    while ((match = linkRe.exec(text))) {
      const target = linkTarget(match[1])
      if (!target || target.startsWith('#') || /^(https?|mailto):/i.test(target)) continue
      const base = nfc(path.basename(target))
      const keys = [target, target.replace(/\.md$/i, ''), base, base.replace(/\.md$/i, '')]
      const hitNotes = keys.map(key => noteIndex.get(key)).find(Boolean)
      if (hitNotes) {
        for (const rel of hitNotes) linked.add(rel)
        continue
      }
      if (keys.some(key => wiki.dirs.has(key) || wiki.fileKeys.has(key))) continue
      if (!brokenByTarget.has(target)) brokenByTarget.set(target, { target, count: 0, examples: [] })
      const group = brokenByTarget.get(target)
      group.count += 1
      if (group.examples.length < 3) group.examples.push(note.rel)
    }
  }

  const orphans = []
  const specNew = []
  const specOld = []
  const lowCyr = []
  const missingBlocks = []
  let staleCount = 0
  let contentNotes = 0
  const nowMs = Date.now()
  for (const note of notes) {
    if (isService(note.rel)) continue
    contentNotes += 1
    if (!linked.has(note.rel)) orphans.push(note.rel)

    const problems = []
    if (!note.fm) problems.push('нет frontmatter')
    else {
      if (!/^source:\s*\S/m.test(note.fm)) problems.push('нет source:')
      const type = fmValue(note.fm, 'type')
      if (!SPEC_TYPES.has(type)) problems.push(`type вне enum: ${type || '(пусто)'}`)
    }
    if (problems.length) {
      const date = fmDate(note.fm, 'created') || fmDate(note.fm, 'updated') || new Date(note.mtimeMs).toISOString().slice(0, 10)
      ;(date >= SPEC_DATE ? specNew : specOld).push({ file: note.rel, date, problems })
    }

    const prose = cyrillicShare(proseOf(note.text))
    if (prose.total >= MIN_PROSE_LETTERS && prose.share < MIN_CYR_SHARE) {
      lowCyr.push({ file: note.rel, share_pct: Math.round(prose.share * 100) })
    }

    const missing = []
    if (!/^#{2,3}\s*(?:🎯\s*)?Как это поможет мне/m.test(note.text)) missing.push('Как это поможет мне')
    if (!/^#{2,3}\s*Достоверность/m.test(note.text)) missing.push('Достоверность')
    if (missing.length) missingBlocks.push({ file: note.rel, missing })

    const updated = fmDate(note.fm, 'updated')
    const ageMs = nowMs - (updated ? Date.parse(updated) : note.mtimeMs)
    if (ageMs > STALE_DAYS * DAY_MS) staleCount += 1
  }

  const brokenList = [...brokenByTarget.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  const indexes = await checkIndexes(vault, notes)
  const junk = await rootJunk(vault)
  const hasCritical = brokenList.length > 0 || indexes.issues.length > 0

  return {
    ok: !hasCritical,
    date: new Date().toISOString().slice(0, 10),
    vault,
    checked: { markdown_files: notes.length, content_notes: contentNotes },
    checks: {
      broken_wikilinks: {
        severity: 'critical',
        count: brokenList.reduce((sum, item) => sum + item.count, 0),
        unique_targets: brokenList.length,
        worst: brokenList.slice(0, limit)
      },
      index_divergence: { severity: 'critical', count: indexes.issues.length, ...indexes },
      spec_new: { severity: 'high', count: specNew.length, worst: specNew.slice(0, limit) },
      spec_old: { severity: 'medium', count: specOld.length, worst: specOld.slice(0, limit) },
      orphans: { severity: 'medium', count: orphans.length, worst: orphans.sort().slice(0, limit) },
      low_cyrillic: {
        severity: 'medium',
        count: lowCyr.length,
        worst: lowCyr.sort((a, b) => a.share_pct - b.share_pct).slice(0, limit)
      },
      missing_blocks: { severity: 'medium', count: missingBlocks.length, worst: missingBlocks.slice(0, limit) },
      stale_notes: { severity: 'info', count: staleCount },
      root_junk: { severity: 'info', count: junk.length, files: junk }
    }
  }
}

function renderReport(report, limit) {
  const c = report.checks
  const lines = []
  lines.push(`# KB Lint — ${report.date}`, '')
  lines.push(`- Vault: \`${report.vault}\``)
  lines.push(`- Всего .md: ${report.checked.markdown_files} · содержательных нот: ${report.checked.content_notes}`)
  lines.push(`- Итог: ${report.ok ? 'чисто (exit 0)' : 'есть critical (exit 1)'}`)
  lines.push('', '## Сводка', '')
  lines.push('| Проверка | Северити | Счёт |')
  lines.push('|---|---|---:|')
  lines.push(`| Битые wikilinks | critical | ${c.broken_wikilinks.count} |`)
  lines.push(`| Расхождение индексов | critical | ${c.index_divergence.count} |`)
  lines.push(`| Спека NOTE-SPEC: ноты ≥ ${SPEC_DATE} | high | ${c.spec_new.count} |`)
  lines.push(`| Спека NOTE-SPEC: старые ноты | medium | ${c.spec_old.count} |`)
  lines.push(`| Ноты-сироты | medium | ${c.orphans.count} |`)
  lines.push(`| Кириллица в прозе < ${MIN_CYR_SHARE * 100}% | medium | ${c.low_cyrillic.count} |`)
  lines.push(`| Нет «Как это поможет мне»/«Достоверность» | medium | ${c.missing_blocks.count} |`)
  lines.push(`| Протухшие ноты (> ${STALE_DAYS} дн.) | info | ${c.stale_notes.count} |`)
  lines.push(`| Мусор корня | info | ${c.root_junk.count} |`)

  lines.push('', `## Битые wikilinks — ${c.broken_wikilinks.count} (${c.broken_wikilinks.unique_targets} целей)`, '')
  for (const item of c.broken_wikilinks.worst) {
    lines.push(`- \`[[${item.target}]]\` — ${item.count} вхожд. · например: \`${item.examples[0]}\``)
  }

  lines.push('', '## Расхождение индексов', '')
  lines.push(`- Счётчик _МАСТЕР-ИНДЕКС.md: ${c.index_divergence.counter ?? 'не найден'} · на диске: ${c.index_divergence.disk_count}`)
  lines.push(`- Свежайшая нота: ${c.index_divergence.newest_note}`)
  for (const issue of c.index_divergence.issues) lines.push(`- ПРОБЛЕМА: ${issue}`)
  if (!c.index_divergence.issues.length) lines.push('- Индексы сходятся.')

  lines.push('', `## Спека NOTE-SPEC: ноты ≥ ${SPEC_DATE} (обязаны спеке) — ${c.spec_new.count}`, '')
  for (const item of c.spec_new.worst) lines.push(`- \`${item.file}\` (${item.date}) — ${item.problems.join(' · ')}`)

  lines.push('', `## Спека NOTE-SPEC: старые ноты (advisory) — ${c.spec_old.count}`, '')
  for (const item of c.spec_old.worst) lines.push(`- \`${item.file}\` (${item.date}) — ${item.problems.join(' · ')}`)

  lines.push('', `## Ноты-сироты (0 входящих ссылок) — ${c.orphans.count}`, '')
  for (const file of c.orphans.worst) lines.push(`- \`${file}\``)

  lines.push('', `## Кириллица в прозе < ${MIN_CYR_SHARE * 100}% — ${c.low_cyrillic.count}`, '')
  for (const item of c.low_cyrillic.worst) lines.push(`- \`${item.file}\` — ${item.share_pct}%`)

  lines.push('', `## Нет обязательных блоков — ${c.missing_blocks.count}`, '')
  for (const item of c.missing_blocks.worst) lines.push(`- \`${item.file}\` — нет: ${item.missing.join(', ')}`)

  lines.push('', `## Мусор корня (только список, ничего не удалено) — ${c.root_junk.count}`, '')
  for (const file of c.root_junk.files) lines.push(`- \`${file}\``)

  lines.push('', `Списки обрезаны до ${limit} худших; полные данные — \`npm run lint:kb -- --json\`.`)
  return `${lines.join('\n').trim()}\n`
}

const vault = resolveVault({ cli: arg('vault') })
const limit = Number(arg('limit', '20'))
const report = await runLint({ vault, limit })

// Запись в корпус — только по явному --write. Без него отчёт уходит в stdout,
// каталог _lint/ не создаётся: просмотр не правит корпус (план П08).
const WRITE = flag('write')
let reportPath = null
if (WRITE) {
  const lintDir = path.join(vault, '99 Система', '_lint')
  await fs.mkdir(lintDir, { recursive: true })
  reportPath = path.join(lintDir, `lint-${report.date}.md`)
  await fs.writeFile(reportPath, renderReport(report, limit), 'utf8')
  await fs.writeFile(path.join(lintDir, '.last-lint'), `${new Date().toISOString()}\n`, 'utf8')
}

if (flag('json')) {
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2))
} else if (WRITE) {
  const counts = Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.count]))
  console.log(JSON.stringify({ ok: report.ok, vault, counts, report_path: reportPath }, null, 2))
} else {
  process.stdout.write(renderReport(report, limit))
}
// Не process.exit(1): при пайпе хвост stdout (крупный --json) обрезается на выходе.
// exitCode даёт циклу событий дозаписать поток (вскрыто прибором П15 --converge).
if (!report.ok) process.exitCode = 1
