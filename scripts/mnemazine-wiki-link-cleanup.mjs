#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function flag(name) {
  return argv.includes(`--${name}`)
}

function norm(value) {
  return String(value || '')
    .replace(/\\+$/g, '')
    .replace(/\.md$/i, '')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripDate(value) {
  return norm(value)
    .replace(/^\d{4}-\d{2}-\d{2}\s*[-—–]\s*/, '')
    .replace(/-\d+$/, '')
    .trim()
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return ''
  return match[1].trim().replace(/^['"]|['"]$/g, '')
}

function frontmatterAliases(text) {
  const out = []
  const inline = text.match(/^aliases:\s*\[([^\]]+)\]/m)
  if (inline) out.push(...inline[1].split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  const block = text.match(/^aliases:\s*\n((?:\s+-\s+.+\n?)+)/m)
  if (block) {
    out.push(...block[1].split('\n')
      .map(line => line.replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean))
  }
  return out
}

function addIndex(index, key, file) {
  const normalized = norm(key)
  if (!normalized) return
  if (!index.has(normalized)) index.set(normalized, new Set())
  index.get(normalized).add(file)
}

function targetParts(raw) {
  const display = String(raw || '').trim()
  const target = display.split('|')[0].split('#')[0].split('^')[0].trim()
  return { display, target, normalized: norm(target) }
}

function linkScanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, block => ' '.repeat(block.length))
}

function sectionOf(file) {
  return file.includes('/') ? file.split('/')[0] : '(root)'
}

function classifyTarget(target) {
  const clean = target.trim()
  if (!clean || ['...', '…', 'note', 'Название'].includes(clean)) return 'placeholder'
  if (/\\$/.test(clean)) return 'escaped-link'
  if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|heic|mov|mp4|canvas)$/i.test(clean)) return 'file-or-asset'
  if (clean.includes('/')) return 'path-link'
  if (/^[A-ZА-ЯЁ0-9 _-]{2,}$/i.test(clean) && clean.length <= 40) return 'concept'
  return 'missing-note'
}

function suggestedAction(kind) {
  if (kind === 'placeholder') return 'удалить placeholder или заменить на реальную заметку'
  if (kind === 'escaped-link') return 'убрать лишний escape/backslash или пересобрать индекс'
  if (kind === 'file-or-asset') return 'заменить wiki-link на обычный путь/markdown-link или создать заметку-обёртку'
  if (kind === 'path-link') return 'уточнить путь до существующей заметки или заменить на текстовую ссылку'
  if (kind === 'concept') return 'создать короткую понятиевую заметку или заменить на обычный текст'
  return 'найти новое имя заметки, создать мост или удалить ссылку'
}

function yamlString(value) {
  return JSON.stringify(String(value || ''))
}

function safeRelTarget(target) {
  const clean = targetParts(target).target
  if (!clean || clean.startsWith('/') || clean.split('/').some(part => part === '..')) return ''
  return `${clean.replace(/\.md$/i, '')}.md`
}

function bridgeTitle(target) {
  return path.basename(targetParts(target).target).replace(/\.md$/i, '') || 'Wiki link bridge'
}

function shouldPlainText(target, kind) {
  const clean = targetParts(target).target
  return kind === 'placeholder' ||
    kind === 'escaped-link' ||
    kind === 'file-or-asset' ||
    clean.startsWith('artifacts/') ||
    /(?:^|[\s"`])[$][A-Z_]+/.test(clean) ||
    /[<>=~]/.test(clean)
}

function plainReplacement(target, kind) {
  const clean = targetParts(target).target.replace(/\\+$/g, '').trim()
  if (kind === 'placeholder') return clean === '…' ? '...' : clean
  if (kind === 'file-or-asset' || clean.startsWith('artifacts/')) return `\`${clean}\``
  if (/[<>=~]/.test(clean)) return `\`${clean}\``
  return clean
}

function bridgeNote(target, kind) {
  const clean = targetParts(target).target.replace(/\\+$/g, '').trim()
  const title = bridgeTitle(clean)
  const isPath = clean.includes('/')
  const aliasLines = [...new Set([clean, title, stripDate(title)].filter(Boolean))]
    .map(alias => `  - ${yamlString(alias)}`)
    .join('\n')
  const noteKind = isPath ? 'точного пути' : kind === 'concept' ? 'понятия' : 'старой ссылки'
  return `---
title: ${yamlString(title)}
type: "knowledge-note"
source_type: "wiki-link-bridge"
source_ref: "wiki-link-cleanup:${new Date().toISOString().slice(0, 10)}"
verified: false
verification_status: "unknown"
status: "bridge"
aliases:
${aliasLines}
---

# ${title}

## Что это

Это мостовая заметка для ${noteKind} \`${clean}\`. Она нужна, чтобы старая wiki-ссылка в базе знаний вела в живой узел, а не оставалась битой.

## Зачем это нужно

В vault много исторических ссылок из digest, старых заметок и автоматических синтезов. Мост сохраняет навигацию и не выдаёт себя за новый проверенный источник.

## Как использовать

- Если тема стала рабочей, заменить этот мост полноценной заметкой.
- Если ссылка была только техническим хвостом digest, оставить мост как совместимость.
- Если рядом найдена лучшая целевая заметка, перенести alias туда и удалить этот мост.

## Источники

- Внутренний отчёт Mnemazine: \`npm run wiki:links\`.
- Тип цели: \`${kind}\`.
- Исходная цель: \`${clean}\`.

## Проверка

Статус: навигационный мост, внешняя факт-проверка не требуется. Содержательные утверждения надо брать из связанных заметок, не из этого файла.

## Связанные заметки

- Протокол Мнемозина.

## Следующее действие

При ближайшей ручной чистке заменить мост на полноценный атом знания или привязать alias к существующей заметке.
`
}

async function rewritePlainLinks(vault, targets) {
  const changes = []
  const byFile = new Map()
  for (const target of targets) {
    for (const example of target.examples || []) {
      const rel = example.file
      if (!byFile.has(rel)) byFile.set(rel, [])
      byFile.get(rel).push({ display: example.display, target: target.target, kind: target.kind })
    }
  }

  for (const [rel, items] of byFile) {
    const file = path.join(vault, rel)
    let text = await fs.readFile(file, 'utf8')
    const before = text
    for (const item of items) {
      const escapedDisplay = item.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      text = text.replace(new RegExp(`\\[\\[${escapedDisplay}\\]\\]`, 'g'), plainReplacement(item.target, item.kind))
    }
    text = text.replace(/\[\[([^\]\n]*?)\\+\]\]/g, (_, inner) => `[[${inner.trim()}]]`)
    if (text !== before) {
      await fs.writeFile(file, text, 'utf8')
      changes.push(rel)
    }
  }
  return changes
}

async function createBridgeNotes(vault, targets) {
  const created = []
  const skipped = []
  for (const target of targets) {
    if (shouldPlainText(target.target, target.kind)) continue
    const rel = target.target.includes('/')
      ? safeRelTarget(target.target)
      : path.posix.join('99 Система', 'Wiki Link Bridges', `${bridgeTitle(target.target)}.md`)
    if (!rel) {
      skipped.push({ target: target.target, reason: 'unsafe path' })
      continue
    }
    const file = path.join(vault, rel)
    if (existsSync(file)) {
      skipped.push({ target: target.target, reason: 'exists', file: rel })
      continue
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bridgeNote(target.target, target.kind), 'utf8')
    created.push(rel)
  }
  return { created, skipped }
}

async function applyCleanup({ vault, reportsDir, limit }) {
  const first = await runAudit({ vault, reportsDir, limit })
  const targets = first.report.targets
  const plainTargets = targets.filter(item => shouldPlainText(item.target, item.kind))
  const rewritten = await rewritePlainLinks(vault, plainTargets)
  const mid = await runAudit({ vault, reportsDir, limit })
  const bridges = await createBridgeNotes(vault, mid.report.targets)
  const second = await runAudit({ vault, reportsDir, limit })
  return { before: first.report.broken, after: second.report.broken, rewritten, bridges, report: second }
}

async function collectVault(vault) {
  const files = []
  const dirs = new Set([''])

  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian', '.mnemazine'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      const file = path.join(dir, item.name)
      const rel = path.relative(vault, file).replace(/\\/g, '/')
      if (item.isDirectory()) {
        dirs.add(rel)
        await walk(file)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        files.push(file)
      }
    }
  }

  await walk(vault)
  return { files, dirs }
}

function buildIndex(vault, files, dirs) {
  const index = new Map()
  for (const file of files) {
    const rel = path.relative(vault, file).replace(/\\/g, '/')
    const withoutExt = rel.replace(/\.md$/, '')
    const basename = path.basename(withoutExt)
    const text = linkScanText(readFileSync(file, 'utf8'))
    for (const key of [
      rel,
      withoutExt,
      basename,
      stripDate(basename),
      frontmatterValue(text, 'title'),
      ...frontmatterAliases(text)
    ]) {
      addIndex(index, key, rel)
    }
  }
  return { index, dirs }
}

function targetExists(target, wiki) {
  const { normalized } = targetParts(target)
  if (!normalized || normalized.startsWith('#') || /^https?:\/\//i.test(normalized)) return true
  if (wiki.dirs.has(normalized) || wiki.index.has(normalized)) return true
  const basename = path.basename(normalized)
  return wiki.index.has(basename) || wiki.index.has(stripDate(basename))
}

function collectBrokenLinks(vault, files, wiki) {
  const byTarget = new Map()
  const bySection = new Map()
  const byFile = new Map()
  const linkRe = /\[\[([^\]\n]+)\]\]/g
  let totalLinks = 0

  for (const file of files) {
    const rel = path.relative(vault, file).replace(/\\/g, '/')
    const text = linkScanText(readFileSync(file, 'utf8'))
    let match
    while ((match = linkRe.exec(text))) {
      totalLinks += 1
      const { display, target } = targetParts(match[1])
      if (targetExists(target, wiki)) continue

      const line = text.slice(0, match.index).split('\n').length
      const kind = classifyTarget(target)
      const hit = { file: rel, line, target, display, section: sectionOf(rel), kind }

      if (!byTarget.has(target)) byTarget.set(target, { target, kind, action: suggestedAction(kind), count: 0, files: new Set(), examples: [] })
      const group = byTarget.get(target)
      group.count += 1
      group.files.add(rel)
      if (group.examples.length < 5) group.examples.push({ file: rel, line, display })

      if (!bySection.has(hit.section)) bySection.set(hit.section, { section: hit.section, count: 0, targets: new Set(), files: new Set() })
      const sec = bySection.get(hit.section)
      sec.count += 1
      sec.targets.add(target)
      sec.files.add(rel)

      if (!byFile.has(rel)) byFile.set(rel, { file: rel, section: hit.section, count: 0, targets: [] })
      const fileGroup = byFile.get(rel)
      fileGroup.count += 1
      if (fileGroup.targets.length < 20) fileGroup.targets.push({ line, target, kind })
    }
  }

  const targets = [...byTarget.values()]
    .map(item => ({ ...item, files: [...item.files], file_count: item.files.size }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  const sections = [...bySection.values()]
    .map(item => ({ section: item.section, count: item.count, unique_targets: item.targets.size, files: item.files.size }))
    .sort((a, b) => b.count - a.count || a.section.localeCompare(b.section))
  const filesOut = [...byFile.values()]
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))

  return { totalLinks, targets, sections, files: filesOut }
}

function renderMarkdown(report, limit) {
  const lines = []
  lines.push(`# Wiki-link cleanup — ${report.date}`, '')
  lines.push('## Сводка', '')
  lines.push(`- Vault: \`${report.vault}\``)
  lines.push(`- Markdown files: ${report.checked.markdown_files}`)
  lines.push(`- Wiki links scanned: ${report.checked.wiki_links}`)
  lines.push(`- Broken links: ${report.broken.total}`)
  lines.push(`- Unique targets: ${report.broken.unique_targets}`)
  lines.push(`- Files with broken links: ${report.broken.files}`)
  lines.push('')
  lines.push('## Разделы', '')
  for (const section of report.sections.slice(0, limit)) {
    lines.push(`- ${section.section}: ${section.count} links · ${section.unique_targets} targets · ${section.files} files`)
  }
  lines.push('', '## Очередь по целям', '')
  for (const target of report.targets.slice(0, limit)) {
    lines.push(`### ${target.target}`)
    lines.push('')
    lines.push(`- Тип: ${target.kind}`)
    lines.push(`- Вхождений: ${target.count}`)
    lines.push(`- Файлов: ${target.file_count}`)
    lines.push(`- Действие: ${target.action}`)
    lines.push('- Примеры:')
    for (const example of target.examples) lines.push(`  - \`${example.file}:${example.line}\` — \`[[${example.display}]]\``)
    lines.push('')
  }
  lines.push('## Очередь по файлам', '')
  for (const file of report.files.slice(0, limit)) {
    lines.push(`### ${file.file}`)
    lines.push('')
    lines.push(`- Broken links: ${file.count}`)
    for (const target of file.targets.slice(0, 10)) lines.push(`- L${target.line}: \`[[${target.target}]]\` (${target.kind})`)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

async function runAudit({ vault, reportsDir, limit }) {
  const { files, dirs } = await collectVault(vault)
  const wiki = buildIndex(vault, files, dirs)
  const broken = collectBrokenLinks(vault, files, wiki)
  const date = new Date().toISOString().slice(0, 10)
  const report = {
    ok: true,
    date,
    vault,
    checked: {
      markdown_files: files.length,
      wiki_links: broken.totalLinks
    },
    broken: {
      total: broken.targets.reduce((sum, item) => sum + item.count, 0),
      unique_targets: broken.targets.length,
      files: broken.files.length
    },
    sections: broken.sections,
    targets: broken.targets,
    files: broken.files
  }

  await fs.mkdir(reportsDir, { recursive: true })
  const base = path.join(reportsDir, `${date}-wiki-link-cleanup`)
  const json = `${base}.json`
  const md = `${base}.md`
  await fs.writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await fs.writeFile(md, renderMarkdown(report, limit), 'utf8')
  return { report, json, md }
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-wiki-cleanup-'))
  const vault = path.join(temp, 'vault')
  const reports = path.join(temp, 'reports')
  await fs.mkdir(path.join(vault, '01 Concepts'), { recursive: true })
  await fs.writeFile(path.join(vault, '01 Concepts', 'target.md'), `---
title: "Живая цель"
aliases: ["Алиас цели"]
---

# Живая цель
`, 'utf8')
  await fs.writeFile(path.join(vault, '01 Concepts', 'source.md'), `# Source

Живая ссылка: [[Алиас цели]].
Битая ссылка: [[Несуществующая цель]].
Placeholder: [[...]].
Asset: [[artifacts/final.pdf]].
Escaped: [[2026-05-29 — Kronos\\]].
`, 'utf8')
  const { report } = await runAudit({ vault, reportsDir: reports, limit: 10 })
  if (report.broken.total !== 4) throw new Error(`selftest expected 4 broken links, got ${report.broken.total}`)
  if (!report.targets.some(item => item.target === 'Несуществующая цель')) throw new Error('selftest missed missing target')
  if (!report.targets.some(item => item.kind === 'placeholder')) throw new Error('selftest missed placeholder target')
  const applied = await applyCleanup({ vault, reportsDir: reports, limit: 10 })
  if (applied.after.total !== 0) throw new Error(`selftest apply expected 0 broken links, got ${applied.after.total}: ${applied.report.report.targets.map(item => item.target).join(', ')}`)
  console.log(JSON.stringify({ ok: true, selftest: true }, null, 2))
}

if (flag('selftest')) {
  await selftest()
} else {
  const vault = resolveVault({ cli: arg('vault') })
  const reportsDir = path.resolve(arg('reports', process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')))
  const limit = Number(arg('limit', '50'))
  if (flag('apply')) {
    const result = await applyCleanup({ vault, reportsDir, limit })
    console.log(JSON.stringify({
      ok: result.after.total === 0,
      vault,
      before: result.before,
      after: result.after,
      rewritten_files: result.rewritten.length,
      created_bridge_notes: result.bridges.created.length,
      skipped: result.bridges.skipped.length,
      report: {
        json: path.relative(ROOT, result.report.json),
        md: path.relative(ROOT, result.report.md)
      }
    }, null, 2))
    if (result.after.total !== 0) process.exit(1)
  } else {
  const { report, json, md } = await runAudit({ vault, reportsDir, limit })
  const output = {
    ok: true,
    vault,
    broken: report.broken,
    sections: report.sections.slice(0, 10),
    report: {
      json: path.relative(ROOT, json),
      md: path.relative(ROOT, md)
    }
  }
  console.log(JSON.stringify(output, null, 2))
  }
}
