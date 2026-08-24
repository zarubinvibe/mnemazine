#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const EXTRACTS = process.env.MNEMAZINE_EXTRACTS || path.join(ROOT, '.mnemazine/cache/extracted')
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const SINCE = arg('changed-since', process.env.MNEMAZINE_CHANGED_SINCE || '')
const APPLY = argv.includes('--apply')
const MIN_SCORE = Number(arg('min-score', process.env.MNEMAZINE_REATTR_MIN_SCORE || '2'))

const STOP = new Set('github com https http www для что это как если или при над надо нужно нужно нужно агент agents skills skill local media source refs verified status final draft через который которая которые и или в на с по из к от до под над без тоже только один одна одно есть нет был была были будет'.split(/\s+/))

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function words(value) {
  return compact(value)
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter(word => word.length >= 4 && !STOP.has(word))
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function githubRepos(value) {
  return unique([...String(value || '').matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)]
    .map(match => match[1].toLowerCase().replace(/\.git$/, '')))
}

function publicUrls(value) {
  return unique([...String(value || '').matchAll(/https?:\/\/[^\s)]+/g)]
    .map(match => match[0].replace(/[.,;]+$/, '')))
}

function sourceRefList(text) {
  return unique([...String(text || '').matchAll(/local-media:([a-f0-9]{16})/g)].map(match => match[1]))
}

async function sourceText(ref) {
  const entries = await fs.readdir(EXTRACTS, { withFileTypes: true }).catch(() => [])
  const jsonName = entries.find(entry => entry.isFile() && entry.name.startsWith(ref) && entry.name.endsWith('.json'))?.name
  if (!jsonName) return { source_hash: '', text: '' }
  const record = JSON.parse(await fs.readFile(path.join(EXTRACTS, jsonName), 'utf8'))
  const text = record.text_path ? await fs.readFile(path.join(EXTRACTS, record.text_path), 'utf8').catch(() => '') : ''
  return { source_hash: record.source_hash || '', text }
}

function noteSupportText(text) {
  const sections = []
  for (const name of ['Что это', 'Зачем это нужно', 'Как использовать', 'Следующее действие']) {
    const re = new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\z)`, 'mi')
    const hit = text.match(re)
    if (hit) sections.push(hit[1])
  }
  return sections.join('\n')
}

function scoreRef({ title, body, urls, noteRepos }, source) {
  const text = String(source.text || '').toLowerCase()
  const titleTokens = unique(words(title))
  const bodyTokens = unique(words(body)).slice(0, 160)
  const refRepos = githubRepos(source.text)
  let score = 0
  const reasons = []

  for (const repo of noteRepos) {
    if (refRepos.includes(repo) || text.includes(repo)) {
      score += 30
      reasons.push(`repo:${repo}`)
    }
  }
  for (const url of urls) {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^www\./, '').toLowerCase()
      const pathBits = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase()
      if (host && text.includes(host)) { score += 3; reasons.push(`host:${host}`) }
      if (pathBits && text.includes(pathBits)) { score += 12; reasons.push(`path:${pathBits}`) }
    } catch {}
  }
  for (const token of titleTokens) {
    if (text.includes(token)) { score += 3; reasons.push(`title:${token}`) }
  }
  for (const token of bodyTokens) {
    if (text.includes(token)) score += 1
  }
  return { score, reasons: unique(reasons).slice(0, 8), refRepos, head: compact(source.text).slice(0, 160) }
}

async function listNotes() {
  const out = []
  const sinceMs = SINCE ? Date.parse(SINCE) : 0
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && item.name.endsWith('.md')) {
        const stat = await fs.stat(file)
        if (sinceMs && stat.mtimeMs < sinceMs) continue
        const text = await fs.readFile(file, 'utf8').catch(() => '')
        if (!/^source_type:\s*"synthesis-atom"\s*$/m.test(text)) continue
        const refs = sourceRefList(text)
        if (refs.length > 1) out.push({ file, text, refs, title: text.match(/^#\s+(.+)$/m)?.[1] || path.basename(file, '.md') })
      }
    }
  }
  await walk(VAULT)
  return out
}

function replaceSourceRefs(text, refs) {
  const replacement = `Локальные source refs:\n${refs.map(ref => `- local-media:${ref}`).join('\n')}`
  return String(text).replace(/Локальные source refs:\n(?:- local-media:[a-f0-9]{16}\n?)+/m, `${replacement}\n`)
}

async function main() {
  await fs.mkdir(STATE, { recursive: true })
  const changes = []
  for (const note of await listNotes()) {
    const body = noteSupportText(note.text)
    const urls = publicUrls(note.text)
    const noteRepos = githubRepos(note.text)
    const details = []
    for (const ref of note.refs) {
      const source = await sourceText(ref)
      details.push({ ref, source_hash: source.source_hash, ...scoreRef({ title: note.title, body, urls, noteRepos }, source) })
    }
    const best = Math.max(...details.map(item => item.score), 0)
    const keep = details
      .filter(item => item.score >= MIN_SCORE && item.score >= Math.max(MIN_SCORE, Math.floor(best * 0.35)))
      .map(item => item.ref)
    const selected = keep.length ? unique(keep) : [details.sort((a, b) => b.score - a.score)[0]?.ref].filter(Boolean)
    const changed = selected.length !== note.refs.length || selected.some(ref => !note.refs.includes(ref))
    changes.push({
      file: note.file,
      rel: path.relative(VAULT, note.file),
      title: note.title,
      before: note.refs,
      after: selected,
      changed,
      best_score: best,
      details
    })
    if (APPLY && changed) await fs.writeFile(note.file, replaceSourceRefs(note.text, selected), 'utf8')
  }
  const result = {
    ok: true,
    apply: APPLY,
    changed_since: SINCE || null,
    checked: changes.length,
    changed: changes.filter(item => item.changed).length,
    changes
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const stateFile = path.join(STATE, `reattribute-source-refs-${stamp}.json`)
  await fs.writeFile(stateFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...result, changes: changes.map(item => ({ rel: item.rel, title: item.title, before: item.before.length, after: item.after.length, changed: item.changed, after_refs: item.after })), state_file: stateFile }, null, 2))
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
