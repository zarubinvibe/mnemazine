#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { strictKnowledgeReady } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const INBOX = path.resolve(arg('inbox', process.env.MNEMAZINE_INBOX || path.join(os.homedir(), 'Desktop', 'Mnemazine Inbox')))
const VAULT = resolveVault({ cli: arg('vault') })
const ARCHIVE = path.resolve(arg('archive', process.env.MNEMAZINE_ARCHIVE || path.join(INBOX, '_archive')))
const APPLY = argv.includes('--apply')
const ALLOW_WEAK_ARCHIVE = argv.includes('--allow-weak-archive')
const VERBOSE = argv.includes('--verbose')
const STARTED_AT = new Date().toISOString()

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
}

function sourceRef(hash) {
  return `local-media:${String(hash).slice(0, 16)}`
}

function addSourceValues(raw, out) {
  for (const part of String(raw).replace(/^\[|\]$/g, '').split(',')) {
    const value = part.trim().replace(/^["']|["']$/g, '')
    if (value) out.add(path.basename(value))
  }
}

// Provenance именованного файла (PDF/DOCX/…) — basename в `source:`/`sources:` frontmatter,
// а не local-media-хэш скриншота. Без этого гейт не видит покрытие и не дает архивировать.
export function sourceBasenames(text) {
  const out = new Set()
  if (!text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  const fm = end === -1 ? text.slice(3) : text.slice(3, end)
  let inList = false
  for (const line of fm.split('\n')) {
    const kv = line.match(/^\s*(sources?):\s*(.*)$/i)
    if (kv) {
      inList = !kv[2].trim()
      addSourceValues(kv[2], out)
      continue
    }
    if (!inList) continue
    const item = line.match(/^\s*-\s*(.+)$/)
    if (item) addSourceValues(item[1], out)
    else if (line.trim()) inList = false
  }
  return out
}

async function activeInboxFiles() {
  return (await fs.readdir(INBOX, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && !item.name.startsWith('.'))
    .map(item => path.join(INBOX, item.name))
}

async function vaultMarkdownFiles() {
  const out = []
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name)
      const rel = path.relative(VAULT, file).replace(/\\/g, '/')
      if (item.isDirectory()) {
        if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
        if (rel === '99 Система' || rel.startsWith('99 Система/')) continue
        await walk(file)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        out.push(file)
      }
    }
  }
  await walk(VAULT)
  return out
}

async function buildCoverageIndex() {
  const notes = []
  for (const file of await vaultMarkdownFiles()) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const sources = sourceBasenames(text)
    if (!text.includes('local-media:') && !text.includes('source_hash') && sources.size === 0) continue
    notes.push({ file, text, sources, strict: strictKnowledgeReady(text) })
  }
  return notes
}

function coverageFor(hash, basename, notes) {
  const ref = sourceRef(hash)
  const matches = notes.filter(note =>
    note.text.includes(ref) || note.text.includes(hash) || note.sources.has(basename))
  const strictMatches = matches.filter(note => note.strict)
  const fullStrictMatches = strictMatches.filter(note => !path.basename(note.file).startsWith('synthesis-'))
  return {
    covered: fullStrictMatches.length > 0,
    weak_covered: matches.length > 0,
    strict_final: fullStrictMatches.length > 0,
    notes: matches.slice(0, 8).map(note => path.relative(VAULT, note.file)),
    strict_notes: fullStrictMatches.slice(0, 8).map(note => path.relative(VAULT, note.file)),
    synthesis_notes: strictMatches
      .filter(note => path.basename(note.file).startsWith('synthesis-'))
      .slice(0, 8)
      .map(note => path.relative(VAULT, note.file))
  }
}

async function archiveFile(file, hash) {
  const month = new Date().toISOString().slice(0, 7)
  const dir = path.join(ARCHIVE, month)
  await ensureDir(dir)
  const ext = path.extname(file)
  let target = path.join(dir, `${hash}${ext}`)
  let suffix = 1
  while (existsSync(target)) {
    target = path.join(dir, `${hash}-${suffix}${ext}`)
    suffix += 1
  }
  await fs.rename(file, target)
  return target
}

async function writeState(result) {
  await ensureDir(STATE)
  const stamp = STARTED_AT.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = path.join(STATE, `archive-covered-${stamp}.json`)
  await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return file
}

async function main() {
  if (!existsSync(INBOX)) throw new Error(`Inbox not found: ${INBOX}`)
  const notes = await buildCoverageIndex()
  const files = await activeInboxFiles()
  const items = []
  for (const file of files) {
    const hash = await sha256(file)
    const coverage = coverageFor(hash, path.basename(file), notes)
    const canMove = ALLOW_WEAK_ARCHIVE ? coverage.weak_covered : coverage.strict_final
    items.push({
      file,
      name: path.basename(file),
      hash,
      source_ref: sourceRef(hash),
      covered: coverage.covered,
      weak_covered: coverage.weak_covered,
      strict_final: coverage.strict_final,
      notes: coverage.notes,
      strict_notes: coverage.strict_notes,
      synthesis_notes: coverage.synthesis_notes,
      action: canMove ? (APPLY ? 'archive' : 'would_archive') : 'keep'
    })
  }

  const moved = []
  if (APPLY) {
    for (const item of items.filter(item => item.action === 'archive')) {
      item.archived_to = await archiveFile(item.file, item.hash)
      moved.push(item.archived_to)
    }
  }

  const result = {
    ok: true,
    apply: APPLY,
    allow_weak_archive: ALLOW_WEAK_ARCHIVE,
    strict_final: !ALLOW_WEAK_ARCHIVE,
    inbox: INBOX,
    vault: VAULT,
    archive: ARCHIVE,
    total: items.length,
    covered: items.filter(item => item.covered).length,
    weak_covered: items.filter(item => item.weak_covered).length,
    final_covered: items.filter(item => item.strict_final).length,
    missing: items.filter(item => !item.covered).length,
    movable: items.filter(item => ALLOW_WEAK_ARCHIVE ? item.weak_covered : item.strict_final).length,
    moved: moved.length,
    kept: items.filter(item => item.action === 'keep').length,
    started_at: STARTED_AT,
    finished_at: new Date().toISOString(),
    items
  }
  result.state_file = await writeState(result)
  const summary = VERBOSE ? result : { ...result, items: undefined }
  console.log(JSON.stringify(summary, null, 2))
  if (result.missing > 0 || (result.total > 0 && result.movable === 0)) process.exitCode = 2
}

// запускаем скан только при прямом вызове — импорт (тесты) не должен трогать инбокс
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message || error)
    process.exit(1)
  })
}
