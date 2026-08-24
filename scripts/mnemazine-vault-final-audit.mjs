#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
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

const VAULT = resolveVault({ cli: arg('vault') })
const MAX_FAILURES = Number(arg('max-failures', '50'))
const WIKI_SCOPE = arg('wiki-scope', flag('strict-wiki') ? 'all' : 'critical')
const STRICT_WIKI = flag('strict-wiki')

const rawAllowed = new Set([
  '99 Система/Лог обработки.md',
  '99 Система/Протокол_Мнемозина.md',
  'Лог обработки.md'
])

const wikiTargetIgnore = new Set(['...', '…', 'note', 'Название'])

const rawRules = [
  ['raw-media-name', /\b(?:temp[_-]?image|tmpImage|IMG_\d+)(?:\.(?:WEBP|PNG|JPE?G|HEIC|TIFF|MOV|MP4))?\b/gi],
  ['draft-marker', /\b(?:intake-draft|draft-local)\b/gi],
  ['raw-ocr', /\braw\s+ocr\b|сыр[оы]й\s+ocr|Локальное извлечение/gi],
  ['external-sandbox-ref', /\b(?:attached_file:\/\/|sandbox:\/mnt\/data\/|oai_citation|turn\d+(?:search|fetch|view)\d+)\b/gi],
  ['chatgpt-tracking-ref', /[?&]utm_source=chatgpt\.com\b/gi],
  ['english-section-shell', /^##\s+(What This Is|Why It Matters|How To Use It|Source|Verification|Related Notes|Reuse)\b/gm]
]

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

function pathRel(file) {
  return path.relative(VAULT, file).replace(/\\/g, '/')
}

function addFailure(failures, rule, file, details) {
  if (failures.length >= MAX_FAILURES) return
  failures.push({ rule, file, details })
}

function addIndex(index, key, file) {
  const normalized = norm(key)
  if (!normalized) return
  if (!index.has(normalized)) index.set(normalized, new Set())
  index.get(normalized).add(file)
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return ''
  return match[1].trim().replace(/^['"]|['"]$/g, '')
}

function frontmatterAliases(text) {
  const out = []
  const inline = text.match(/^aliases:\s*\[([^\]]+)\]/m)
  if (inline) {
    out.push(...inline[1].split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  }
  const block = text.match(/^aliases:\s*\n((?:\s+-\s+.+\n?)+)/m)
  if (block) {
    out.push(...block[1].split('\n')
      .map(line => line.replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean))
  }
  return out
}

function strictWikiFile(rel) {
  return [
    '_МАСТЕР-ИНДЕКС.md',
    '10 Карта возможностей.md',
    'AGENTS.md',
    'CLAUDE.md',
    '99 Система/Протокол_Мнемозина.md',
    '99 Система/Agent_Handoff_Graph.md'
  ].includes(rel) || rel.startsWith('08 AI и Инструменты/Capabilities/_СПОСОБНОСТИ')
}

async function collectVault() {
  const files = []
  const dirs = new Set([''])
  const nestedGraphify = []

  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian', '.mnemazine'].includes(item.name)) continue
      const file = path.join(dir, item.name)
      const rel = pathRel(file)
      if (item.isDirectory()) {
        if (item.name.startsWith('graphify-out')) {
          if (path.dirname(rel) !== '.') nestedGraphify.push(rel)
          continue
        }
        dirs.add(rel)
        await walk(file)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        files.push(file)
      }
    }
  }

  await walk(VAULT)
  return { files, dirs, nestedGraphify }
}

function rawMarkerFailures(files) {
  const failures = []
  for (const file of files) {
    const rel = pathRel(file)
    const basename = path.basename(file)
    if (/Users [^/ ]+|\/Users\/[^/]+|Проекты mnemazine|личный vault 0\d/.test(basename)) {
      addFailure(failures, 'private-path-filename', rel, [basename])
    }
    if (rawAllowed.has(rel)) continue
    const text = existsSync(file) ? String(readFileSync(file, 'utf8')) : ''
    const haystack = `${basename}\n${text}`
    for (const [rule, re] of rawRules) {
      const matches = [...haystack.matchAll(re)].slice(0, 5).map(match => match[0])
      if (matches.length) addFailure(failures, rule, rel, matches)
    }
  }
  return failures
}

function buildWikiIndex(files, dirs) {
  const index = new Map()
  for (const file of files) {
    const rel = pathRel(file)
    const withoutExt = rel.replace(/\.md$/, '')
    const basename = path.basename(withoutExt)
    const text = existsSync(file) ? String(readFileSync(file, 'utf8')) : ''
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

function wikiTargetExists(target, wiki) {
  let clean = String(target || '').split('|')[0].split('#')[0].split('^')[0].trim()
  clean = clean.replace(/\\+$/g, '').trim()
  if (!clean || clean.startsWith('#') || /^https?:\/\//i.test(clean)) return true
  if (wikiTargetIgnore.has(clean)) return true

  const normalized = norm(clean)
  if (!normalized) return true
  if (wiki.dirs.has(normalized) || wiki.index.has(normalized)) return true
  const basename = path.basename(normalized)
  return wiki.index.has(basename) || wiki.index.has(stripDate(basename))
}

function linkScanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, block => ' '.repeat(block.length))
}

function wikiFailures(files, wiki) {
  const failures = []
  const warnings = []
  const linkRe = /\[\[([^\]\n]+)\]\]/g
  for (const file of files) {
    const rel = pathRel(file)
    if (WIKI_SCOPE === 'none') continue
    if (WIKI_SCOPE === 'critical' && !strictWikiFile(rel)) continue
    const text = existsSync(file) ? linkScanText(readFileSync(file, 'utf8')) : ''
    let match
    while ((match = linkRe.exec(text))) {
      const target = match[1].split('|')[0].trim()
      if (wikiTargetExists(target, wiki)) continue
      const item = { rule: 'broken-wiki-link', file: rel, details: [target] }
      if (STRICT_WIKI || WIKI_SCOPE === 'critical') {
        if (failures.length < MAX_FAILURES) failures.push(item)
      } else if (warnings.length < MAX_FAILURES) {
        warnings.push(item)
      }
    }
  }
  return { failures, warnings }
}

async function main() {
  const failures = []
  const warnings = []
  const { files, dirs, nestedGraphify } = await collectVault()

  for (const rel of nestedGraphify) addFailure(failures, 'nested-graphify-runtime', rel, ['move graphify runtime out of note folders'])
  for (const failure of rawMarkerFailures(files)) addFailure(failures, failure.rule, failure.file, failure.details)

  const wiki = wikiFailures(files, buildWikiIndex(files, dirs))
  for (const failure of wiki.failures) addFailure(failures, failure.rule, failure.file, failure.details)
  warnings.push(...wiki.warnings)

  const result = {
    ok: failures.length === 0,
    vault: VAULT,
    checked: {
      markdown_files: files.length,
      nested_graphify_dirs: nestedGraphify.length,
      wiki_scope: WIKI_SCOPE,
      strict_wiki: STRICT_WIKI
    },
    failures,
    warnings
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exit(1)
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
