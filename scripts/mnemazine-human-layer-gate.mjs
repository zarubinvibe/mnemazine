#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'
import { SPEC_TYPES } from './mnemazine-note-spec.mjs'

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
const REPORTS = path.resolve(arg('reports', process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')))
const STATE = path.resolve(arg('state', process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')))
const REPORT = arg('report', '')
const BRIEF = arg('brief', path.join(STATE, 'last-action-brief.md'))
const MAX_FAILURES = Number(arg('max-failures', '50'))
const NOTES_ONLY = flag('notes-only')
const REPORTS_ONLY = flag('reports-only')
const BRIEF_ONLY = flag('brief-only')
const SOURCE_REFS = new Set(arg('source-ref', '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean))

function lastRunStartedAt() {
  try {
    const state = JSON.parse(readFileSync(path.join(STATE, 'last-run.json'), 'utf8'))
    return state?.started_at || ''
  } catch {
    return ''
  }
}

function sinceMs(value) {
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const CHANGED_SINCE = arg('changed-since', lastRunStartedAt())
const CHANGED_SINCE_MS = sinceMs(CHANGED_SINCE)

async function walk(dir, include) {
  const out = []
  async function visit(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      const file = path.join(folder, item.name)
      if (item.isDirectory()) await visit(file)
      else if (item.isFile() && include(file)) out.push(file)
    }
  }
  await visit(dir)
  return out
}

async function textFile(file) {
  return await fs.readFile(file, 'utf8').catch(() => '')
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function section(text, title) {
  const re = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi')
  return text.match(re)?.[1]?.trim() || ''
}

function hasAnySection(text, titles) {
  return titles.some(title => section(text, title))
}

function cyrillicCount(text) {
  return (String(text || '').match(/[А-Яа-яЁё]/g) || []).length
}

function latinCount(text) {
  return (String(text || '').match(/[A-Za-z]/g) || []).length
}

function languageLayerText(text) {
  return String(text || '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(?:source_ref|source_hash|cluster_id|processor_model|verification_status|local-media|processed_notes):\S*/gi, ' ')
    .replace(/\b[a-f0-9]{16,}\b/gi, ' ')
}

const rawMarkers = [
  ['english-section', /^##\s+(What This Is|Why It Matters|How To Use It|Source|Verification|Related Notes|Reuse)\b/gm],
  ['github-metadata-en', /\bGitHub metadata:/g],
  ['repository-freshness-en', /\bRepository freshness:/g],
  ['readme-signal-en', /\bREADME signal:/g],
  ['raw-html-attribute', /\b(?:src|href|alt|title)=["'][^"']*["']/gi],
  ['raw-meta-tag', /<meta\b/gi],
  ['raw-img-tag', /<img\b/gi],
  ['raw-script-marker', /window\.gtag/gi],
  ['raw-ocr-en', /\braw\s+ocr\b/gi],
  ['raw-ocr-ru', /сырой\s+ocr(?!\s+исключ[ее]н)/gi],
  ['video-ocr-marker', /Video keyframe OCR|Video transcript from local Whisper/gi],
  ['empty-extract-marker', /No extractable text/gi],
  ['draft-marker', /\b(?:intake-draft|draft-local)\b/gi],
  ['media-filename', /\bIMG_\d+(?:\.(?:WEBP|PNG|JPE?G|HEIC|TIFF|MOV|MP4))?\b/gi],
  ['agent-jargon', /\b(?:candidate capability|workflow-fit|capability review queue)\b/gi],
  ['bad-russian-grammar', /реальным рабочий|конкретного сценария конкретный|Перед пробный|режим только чтение режим|доменов доменов|web-рабочий сценарий|черновик короткое видео/gi]
]

function markerFailures(text) {
  const failures = []
  for (const [name, re] of rawMarkers) {
    const matches = [...String(text || '').matchAll(re)].slice(0, 5).map(m => m[0])
    if (matches.length) failures.push({ rule: name, details: matches })
  }
  return failures
}

function noteFailures(text) {
  const failures = markerFailures(text)
  const type = text.match(/^type:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || ''
  // Состав типов знания — из единого модуля П05, а не литерала: переименование типа
  // в спеке не должно молча ослеплять этот гейт (план П16 шаг 2).
  const isDigest = type === 'knowledge-digest'
  const isKnowledge = SPEC_TYPES.has(type) || /^#\s+/.test(text)
  if (!isDigest && !isKnowledge) return failures

  const required = isDigest
    ? ['Что это', 'Как использовать', 'Проверка', 'Связанные заметки']
    : ['Что это', 'Источники', 'Проверка', 'Следующее действие']
  const missing = required.filter(title => !section(text, title))
  if (missing.length) failures.push({ rule: 'missing-russian-sections', details: missing })

  if (!isDigest && !hasAnySection(text, ['Как использовать', 'Что добавила Mnemazine', 'Зачем это нужно'])) {
    failures.push({ rule: 'missing-use-section', details: ['Как использовать / Что добавила Mnemazine / Зачем это нужно'] })
  }

  const languageText = languageLayerText(text)
  const cyrillic = cyrillicCount(languageText)
  const latin = latinCount(languageText)
  if (cyrillic < 120) failures.push({ rule: 'weak-russian-layer', details: `cyrillic_chars=${cyrillic}` })
  if (latin > cyrillic * 2.2) failures.push({ rule: 'english-dominant-layer', details: `latin=${latin}, cyrillic=${cyrillic}` })
  return failures
}

function briefFailures(text) {
  const failures = markerFailures(text)
  if (!/^#\s+Короткий отч[её]т Mnemazine\b/m.test(text)) failures.push({ rule: 'brief-title-not-russian', details: ['# Короткий отчет Mnemazine'] })
  if (!section(text, 'Статус')) failures.push({ rule: 'brief-status-missing', details: ['## Статус'] })
  if (!section(text, 'Следующие действия')) failures.push({ rule: 'brief-actions-missing', details: ['## Следующие действия'] })
  if (/^##\s+Next Actions\b/m.test(text) || /^-\s+(Quality gate|Graph refresh|Weekly report|Report quality):/m.test(text)) {
    failures.push({ rule: 'brief-english-shell', details: ['old English brief labels'] })
  }
  return failures
}

function reportFailures(text) {
  const failures = markerFailures(text)
  const required = [
    ['report-title', /Отч[ее]т Mnemazine|Mnemazine после прогона/i],
    ['new-knowledge-section', /Новые и обновленн?ые знания/i],
    ['next-action-section', /Следующ(?:ий ход|ее действие)/i],
    ['verification-signal', /Проверка|риск/i]
  ]
  for (const [name, re] of required) if (!re.test(text)) failures.push({ rule: `missing-${name}`, details: [String(re)] })
  if (cyrillicCount(text) < 200) failures.push({ rule: 'weak-russian-report', details: `cyrillic_chars=${cyrillicCount(text)}` })
  return failures
}

// Служебная секция vault — сервис, не знание: человеческий слой ее не судит (П22).
// «99 Система» — живой корпус владельца, «00 System» — публичный близнец, куда
// install.sh кладет «Mnemazine Protocol.md». Ровно то же исключение, что в
// vault-quality-gate.isServicePath.
function isVaultServiceNote(file) {
  const rel = path.relative(VAULT, file).replace(/\\/g, '/')
  return /^99 Система\//.test(rel) || /^00 System\//.test(rel)
}

async function listNotes() {
  if (!existsSync(VAULT)) return []
  const files = await walk(VAULT, file => file.endsWith('.md'))
  const out = []
  for (const file of files) {
    if (isVaultServiceNote(file)) continue
    const stat = await fs.stat(file)
    if (CHANGED_SINCE_MS && stat.mtimeMs >= CHANGED_SINCE_MS) {
      out.push(file)
      continue
    }
    if (SOURCE_REFS.size) {
      const text = await textFile(file)
      if ([...SOURCE_REFS].some(ref => text.includes(ref))) out.push(file)
    }
  }
  return [...new Set(out)]
}

async function latestReport() {
  const files = await walk(REPORTS, file => /\.(html|md)$/i.test(file))
  const reports = []
  for (const file of files) reports.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs })
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || ''
}

async function listReports() {
  if (REPORT) return [path.resolve(REPORT)]
  if (!existsSync(REPORTS)) return []
  if (CHANGED_SINCE_MS) {
    const files = await walk(REPORTS, file => /\.(html|md)$/i.test(file))
    const recent = []
    for (const file of files) if ((await fs.stat(file)).mtimeMs >= CHANGED_SINCE_MS) recent.push(file)
    if (recent.length) return recent
  }
  const latest = await latestReport()
  return latest ? [latest] : []
}

async function checkFile(file, kind) {
  const raw = await textFile(file)
  const text = kind === 'report' && file.endsWith('.html') ? stripHtml(raw) : raw
  const failures = kind === 'note' ? noteFailures(text) : kind === 'brief' ? briefFailures(text) : reportFailures(text)
  return failures.length ? { file: path.relative(ROOT, file), kind, failures } : null
}

const failures = []
if (!REPORTS_ONLY && !BRIEF_ONLY) {
  for (const file of await listNotes()) {
    const failure = await checkFile(file, 'note')
    if (failure) failures.push(failure)
    if (failures.length >= MAX_FAILURES) break
  }
}

if (!NOTES_ONLY && !BRIEF_ONLY && failures.length < MAX_FAILURES) {
  for (const file of await listReports()) {
    const failure = await checkFile(file, 'report')
    if (failure) failures.push(failure)
    if (failures.length >= MAX_FAILURES) break
  }
}

if (!NOTES_ONLY && !REPORTS_ONLY && failures.length < MAX_FAILURES && existsSync(BRIEF)) {
  const failure = await checkFile(path.resolve(BRIEF), 'brief')
  if (failure) failures.push(failure)
}

const result = {
  ok: failures.length === 0,
  checked_since: CHANGED_SINCE || null,
  source_refs: SOURCE_REFS.size,
  failures
}

console[result.ok ? 'log' : 'error'](JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
