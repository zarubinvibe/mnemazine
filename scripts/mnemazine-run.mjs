#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { llmAvailable, llmText } from './mnemazine-llm.mjs'
import { strictKnowledgeReady } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'
import { requireEngines } from './mnemazine-local-engines.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())

// Config contradiction, caught by code — not by a warning string. Strict protocol
// (REQUIRE_DEEP) and draft-only are mutually exclusive: draft-only writes nothing
// to the vault and never archives, so a run that must fail-before-archive cannot
// also be draft-only. Exit 2 (config error), distinct from a gate failure (1).
// This gate MUST stay the FIRST exit-2 path: it runs before resolveVault and before
// the vault-quality-gate, so an observed exit 2 provably means THIS contradiction
// and nothing else (empty-vault gate also exits 2 — that ambiguity is why order
// matters). Remove the exit below and the run falls through to a code that is not 2.
const REQUIRE_DEEP = process.argv.includes('--require-deep') || process.env.MNEMAZINE_REQUIRE_DEEP === '1'
const DRAFT_ONLY = process.env.MNEMAZINE_DRAFT_ONLY === '1'
if (REQUIRE_DEEP && DRAFT_ONLY) {
  console.error('strict protocol vs draft-only: MNEMAZINE_REQUIRE_DEEP=1 и MNEMAZINE_DRAFT_ONLY=1 несовместимы')
  process.exit(2)
}

const INBOX = process.env.MNEMAZINE_INBOX || path.join(ROOT, 'inbox')
const VAULT = resolveVault()
const REPORTS = process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const CACHE = process.env.MNEMAZINE_CACHE || path.join(ROOT, '.mnemazine/cache/processed-hashes.json')
const ARCHIVE = process.env.MNEMAZINE_ARCHIVE || path.join(ROOT, '.mnemazine/archive')
const TRANSCRIPTS = path.join(ROOT, '.mnemazine/cache/video-transcripts')
const VIDEO_AUDIO = path.join(ROOT, '.mnemazine/cache/video-audio')
const VIDEO_FRAMES = path.join(ROOT, '.mnemazine/cache/video-frames')
const VIDEO_QUEUE = path.join(ROOT, '.mnemazine/cache/video-queue.jsonl')
const EXTRACTS = process.env.MNEMAZINE_EXTRACTS || path.join(ROOT, '.mnemazine/cache/extracted')
const SYNTHESIZE = process.env.MNEMAZINE_SYNTHESIZE !== '0'
const FINISH = process.env.MNEMAZINE_FINISH !== '0'
const RUN_ID = process.env.MNEMAZINE_RUN_ID || `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
// Opt-in deep stage (atomization + web/LLM verification, README:230 pipeline).
// Default OFF for direct runs. Strict desktop protocol does not pass --deep;
// it lets tierOf(file) choose deep work only for tier>=1.
const DEEP = process.argv.includes('--deep') || process.env.MNEMAZINE_DEEP === '1'
const DEEP_ALLOWED = DEEP || REQUIRE_DEEP
const ENRICH_REQUIRED = DEEP_ALLOWED && process.env.MNEMAZINE_ENRICH !== '0' && !process.argv.includes('--no-enrich')
const STRICT_ARCHIVE_KNOWLEDGE = (REQUIRE_DEEP || (DEEP && ENRICH_REQUIRED)) && process.env.MNEMAZINE_STRICT_ARCHIVE !== '0' && !process.argv.includes('--allow-raw-archive')
// Local-first contract (П10): with require-local on, a run that meets a MISSING
// local engine STOPS (exit 3) rather than silently reaching for the cloud. The
// env name is shared with CI and the launchd job — it flips the switch without
// changing the command; --require-local is the equivalent CLI flag.
const REQUIRE_LOCAL = process.argv.includes('--require-local') || process.env.MNEMAZINE_REQUIRE_LOCAL_EXTRACTION === '1'
// Every local engine seen missing this run — cloud-substituted or not. Stamped
// onto last-run.json by writeRunState so a silent cloud fallback is never silent.
const localEnginesMissing = new Set()
const WHISPER_MODEL = process.env.MNEMAZINE_WHISPER_MODEL || ''
const WHISPER_LANGUAGE = process.env.MNEMAZINE_WHISPER_LANGUAGE || 'ru'
const VIDEO_FRAME_LIMIT = Number(process.env.MNEMAZINE_VIDEO_FRAME_LIMIT || '8')
const VIDEO_INLINE_MAX_SECONDS = Number(process.env.MNEMAZINE_VIDEO_INLINE_MAX_SECONDS || '180')
const COMMAND_TIMEOUT_MS = Number(process.env.MNEMAZINE_COMMAND_TIMEOUT_MS || '120000')
const PROGRESS_EVERY = Number(process.env.MNEMAZINE_PROGRESS_EVERY || '25')

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

function slugify(value) {
  return String(value || 'note')
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note'
}

function compact(value, limit = 1400) {
  return String(value || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function sourceRef(hash) {
  return `local-media:${String(hash).slice(0, 16)}`
}

function inferTitle(text, fallback = 'Local source') {
  const clean = compact(text, 500)
  const url = clean.match(/\bhttps?:\/\/[^\s)]+/)?.[0]
  if (url) return url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').slice(0, 90)
  const line = String(text || '')
    .split(/\n|[.!?]\s+/)
    .map(s => compact(s, 120))
    .find(s => s.length >= 18 && s.length <= 120 && !/^(IMG_|temp_image|screenshot|screen shot)/i.test(s))
  return line || fallback
}

function bullets(text, max = 7) {
  const out = []
  const seen = new Set()
  for (const part of String(text || '').split(/\n|[•*-]\s+/)) {
    const line = compact(part, 180)
    if (line.length < 24) continue
    if (/^(IMG_|temp_image|screenshot|screen shot|save this|follow)/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function hasUsableExtraction(text) {
  const clean = compact(text, 2000)
  if (clean.length < 80) return false
  if (/^(Video queued for local Whisper transcription|No extractable text)/i.test(clean)) return false
  const alpha = (clean.match(/[A-Za-zА-Яа-яЁё]/g) || []).length
  return alpha >= 50
}

function isVideo(file) {
  return ['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(path.extname(file).toLowerCase())
}

function isAudio(file) {
  return ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(path.extname(file).toLowerCase())
}

function isImage(file) {
  return ['.png', '.jpg', '.jpeg', '.heic', '.webp', '.tiff'].includes(path.extname(file).toLowerCase())
}

function isMarkitdownDocument(file) {
  return ['.pdf', '.docx', '.pptx', '.xlsx', '.html', '.htm'].includes(path.extname(file).toLowerCase())
}

export function tierOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (['.md', '.txt', '.json', '.csv'].includes(ext)) return 0
  if (['.pdf', '.docx', '.pptx', '.xlsx'].includes(ext)) return 1
  if (isImage(file)) return 2
  if (isVideo(file) || isAudio(file)) return 3
  return 1
}

function enginesFor(file) {
  if (tierOf(file) === 0) return ['text-read']
  if (isVideo(file) || isAudio(file)) return ['ffmpeg', 'whisper', 'vision-ocr']
  if (isImage(file)) return ['vision-ocr']
  if (isMarkitdownDocument(file)) return ['markitdown']
  return []
}

function videoDurationSeconds(file) {
  const probe = spawnSync('ffmpeg', ['-i', file], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  const match = `${probe.stderr}\n${probe.stdout}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function whisperModelFor(durationSeconds) {
  if (WHISPER_MODEL) return WHISPER_MODEL
  if (durationSeconds !== null && durationSeconds <= 90) return 'base'
  return 'tiny'
}

async function appendVideoQueue(item) {
  await ensureDir(path.dirname(VIDEO_QUEUE))
  await fs.appendFile(VIDEO_QUEUE, `${JSON.stringify(item)}\n`, 'utf8')
}

async function extractVideo(file, hash) {
  await ensureDir(TRANSCRIPTS)
  await ensureDir(VIDEO_AUDIO)
  await ensureDir(VIDEO_FRAMES)
  const durationSeconds = videoDurationSeconds(file)
  const transcriptPath = path.join(TRANSCRIPTS, `${hash}.txt`)
  if (existsSync(transcriptPath)) {
    const transcript = await fs.readFile(transcriptPath, 'utf8')
    const frames = await extractVideoFrames(file, hash)
    return joinVideoParts(transcript, frames)
  }

  if (durationSeconds !== null && durationSeconds > VIDEO_INLINE_MAX_SECONDS) {
    const frames = await extractVideoFrames(file, hash)
    await appendVideoQueue({
      hash,
      source_ref: sourceRef(hash),
      file,
      duration_seconds: Math.round(durationSeconds),
      status: 'deferred_transcription',
      reason: `duration exceeds inline limit ${VIDEO_INLINE_MAX_SECONDS}s`,
      suggested_command: `MNEMAZINE_WHISPER_MODEL=small MNEMAZINE_VIDEO_INLINE_MAX_SECONDS=999999 node scripts/mnemazine-run.mjs`
    })
    return joinVideoParts('', frames) || `Video queued for local Whisper transcription.\n\nDuration: ${Math.round(durationSeconds)} seconds.\nInline limit: ${VIDEO_INLINE_MAX_SECONDS} seconds.\nSource: ${sourceRef(hash)}`
  }

  const audioPath = path.join(VIDEO_AUDIO, `${hash}.wav`)
  const ffmpeg = spawnSync('ffmpeg', [
    '-y',
    '-i', file,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    audioPath
  ], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  if (ffmpeg.status !== 0 || !existsSync(audioPath)) return ''

  const whisper = spawnSync('whisper', [
    audioPath,
    '--model', whisperModelFor(durationSeconds),
    '--language', WHISPER_LANGUAGE,
    '--output_dir', TRANSCRIPTS,
    '--output_format', 'txt',
    '--fp16', 'False',
    '--verbose', 'False'
  ], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  const whisperOut = path.join(TRANSCRIPTS, `${hash}.txt`)
  let transcript = ''
  if (whisper.status === 0 && existsSync(whisperOut)) {
    transcript = await fs.readFile(whisperOut, 'utf8')
  }
  const frames = await extractVideoFrames(file, hash)
  return joinVideoParts(transcript, frames)
}

async function extractAudio(file, hash) {
  await ensureDir(TRANSCRIPTS)
  await ensureDir(VIDEO_AUDIO)
  const transcriptPath = path.join(TRANSCRIPTS, `${hash}.txt`)
  if (existsSync(transcriptPath)) return await fs.readFile(transcriptPath, 'utf8')
  const audioPath = path.join(VIDEO_AUDIO, `${hash}.wav`)
  const ffmpeg = spawnSync('ffmpeg', [
    '-y',
    '-i', file,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    audioPath
  ], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  if (ffmpeg.status !== 0 || !existsSync(audioPath)) return ''
  const whisper = spawnSync('whisper', [
    audioPath,
    '--model', WHISPER_MODEL || 'tiny',
    '--language', WHISPER_LANGUAGE,
    '--output_dir', TRANSCRIPTS,
    '--output_format', 'txt',
    '--fp16', 'False',
    '--verbose', 'False'
  ], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  const whisperOut = path.join(TRANSCRIPTS, `${hash}.txt`)
  if (whisper.status === 0 && existsSync(whisperOut)) return await fs.readFile(whisperOut, 'utf8')
  return ''
}

async function extractVideoFrames(file, hash) {
  const ocr = path.join(ROOT, '.mnemazine/bin/vision-ocr')
  if (!existsSync(ocr)) return ''
  const frameDir = path.join(VIDEO_FRAMES, hash)
  await ensureDir(frameDir)
  const existing = (await fs.readdir(frameDir).catch(() => [])).filter(name => name.endsWith('.png'))
  if (!existing.length) {
    spawnSync('ffmpeg', [
      '-y',
      '-i', file,
      '-vf', 'fps=1/3',
      '-frames:v', String(VIDEO_FRAME_LIMIT),
      path.join(frameDir, 'frame-%03d.png')
    ], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  }
  const chunks = []
  const seen = new Set()
  const frames = (await fs.readdir(frameDir).catch(() => []))
    .filter(name => name.endsWith('.png'))
    .sort()
    .slice(0, VIDEO_FRAME_LIMIT)
  for (const frame of frames) {
    const out = spawnSync(ocr, [path.join(frameDir, frame)], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
    if (out.status !== 0) continue
    for (const line of out.stdout.split(/\r?\n/)) {
      const clean = compact(line, 220)
      if (clean.length < 12) continue
      const key = clean.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      chunks.push(clean)
    }
  }
  return chunks.join('\n')
}

function joinVideoParts(transcript, frameText) {
  const parts = []
  if (compact(transcript, 80)) parts.push(`Video transcript from local Whisper:\n\n${transcript.trim()}`)
  if (compact(frameText, 80)) parts.push(`Video keyframe OCR:\n\n${frameText.trim()}`)
  return parts.join('\n\n')
}

// Local-first extraction. Returns { text, engine_used, engines_missing }: a
// MISSING engine (binary absent) is reported in engines_missing so the caller can
// stop under require-local; a PRESENT engine that yields nothing leaves
// engines_missing empty — that is «движок не нашел», a different outcome that must
// not be confused with «движка нет». Engine presence is the ONE truth in
// mnemazine-local-engines.mjs (rule 8) — not re-encoded here.
//
// Text on the extraction/verification/citation path is passed through WHOLE — it
// is never compressed or summarised on the way (measured 32–60% dangling links
// after compressors). This is a rule, not a gate: keep it that way here and in
// llmExtract below.
async function extract(file) {
  const ext = path.extname(file).toLowerCase()
  if (['.md', '.txt', '.json', '.csv'].includes(ext)) {
    return { text: await fs.readFile(file, 'utf8'), engine_used: 'text-read', engines_tried: ['text-read'], engines_missing: [] }
  }
  if (isVideo(file)) {
    const engines_missing = requireEngines(['ffmpeg', 'whisper', 'vision-ocr'])
    const text = await extractVideo(file, await sha256(file))
    return { text, engine_used: text ? 'video' : '', engines_tried: ['ffmpeg', 'whisper', 'vision-ocr'], engines_missing }
  }
  if (isAudio(file)) {
    const engines_missing = requireEngines(['ffmpeg', 'whisper'])
    const text = await extractAudio(file, await sha256(file))
    return { text, engine_used: text ? 'audio' : '', engines_tried: ['ffmpeg', 'whisper'], engines_missing }
  }
  if (isImage(file)) {
    const engines_missing = requireEngines(['vision-ocr'])
    if (!engines_missing.length) {
      const ocr = path.join(ROOT, '.mnemazine/bin/vision-ocr')
      const out = spawnSync(ocr, [file], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
      if (out.status === 0) return { text: out.stdout, engine_used: 'vision-ocr', engines_tried: ['vision-ocr'], engines_missing: [] }
    }
    return { text: '', engine_used: '', engines_tried: ['vision-ocr'], engines_missing }
  }
  if (isMarkitdownDocument(file)) {
    const engines_missing = requireEngines(['markitdown'])
    if (!engines_missing.length) {
      const markitdown = spawnSync('markitdown', [file], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
      if (markitdown.status === 0 && markitdown.stdout.trim()) return { text: markitdown.stdout, engine_used: 'markitdown', engines_tried: ['markitdown'], engines_missing: [] }
    }
    return { text: '', engine_used: '', engines_tried: ['markitdown'], engines_missing }
  }
  return { text: '', engine_used: '', engines_tried: enginesFor(file), engines_missing: [] }
}

// LLM recognition fallback (deep only). Used ONLY when local engines (Apple
// Vision OCR / markitdown / whisper) produced nothing usable — keeps the default
// path at 0 tokens. A vision-capable agent reads the file and transcribes it.
// The transcription is returned WHOLE (no compression/summary on the way) — same
// rule as extract(): compressors drop 32–60% of citation links.
async function llmExtract(file) {
  const ext = path.extname(file).toLowerCase()
  const kind = isImage(file) ? 'image' : isVideo(file) ? 'video frame still' : 'document'
  const prompt = `Read the local ${kind} file and output ALL of its information as plain text: transcribe every readable word verbatim, then add a short factual description of any non-text content (diagrams, charts, UI). No commentary, no preamble.\n\nFILE: ${file}`
  // Claude reads via the Read tool; Codex reads files in its working dir.
  const text = await llmText(prompt, {
    tools: ['Read'],
    cwd: path.dirname(file),
    timeoutMs: COMMAND_TIMEOUT_MS
  })
  return text || ''
}

async function writeExtractCache(source, hash, text, status) {
  await ensureDir(EXTRACTS)
  const ext = path.extname(source).toLowerCase().replace('.', '') || 'file'
  const ref = sourceRef(hash)
  const record = {
    source_ref: ref,
    source_hash: hash,
    source_type: ext,
    status,
    extracted_at: new Date().toISOString(),
    text_path: compact(text, 80) ? `${hash}.txt` : null
  }
  if (record.text_path) await fs.writeFile(path.join(EXTRACTS, record.text_path), text, 'utf8')
  await fs.writeFile(path.join(EXTRACTS, `${hash}.json`), JSON.stringify(record, null, 2), 'utf8')
  return record
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

let vaultMarkdownFiles = null
async function listVaultMarkdownFiles() {
  if (vaultMarkdownFiles) return vaultMarkdownFiles
  const out = []
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, item.name)
      if (item.isDirectory()) {
        if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
        await walk(p)
      } else if (item.isFile() && p.endsWith('.md')) out.push(p)
    }
  }
  await walk(VAULT)
  vaultMarkdownFiles = out
  return out
}

async function hasFinalKnowledgeForHash(hash) {
  const ref = sourceRef(hash)
  for (const file of await listVaultMarkdownFiles()) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if ((text.includes(ref) || text.includes(hash)) && (!STRICT_ARCHIVE_KNOWLEDGE || strictKnowledgeReady(text))) return true
  }
  return false
}

async function cachedExtractionText(entry) {
  let textPath = entry?.text_path || ''
  if (!textPath && entry?.cache) {
    const record = await readJson(path.join(ROOT, entry.cache), {})
    textPath = record.text_path || ''
  }
  if (!textPath) return ''
  return await fs.readFile(path.join(EXTRACTS, textPath), 'utf8').catch(() => '')
}

export function runLocalNodeScript(script, args = []) {
  const file = path.join(ROOT, 'scripts', script)
  if (!existsSync(file)) {
    // Пропавший ОБЯЗАТЕЛЬНЫЙ скрипт — дыра, а не «пропущено»: throw (первый шаг
    // пошаговой аттестации, полная — П11). Все, чего нет в REQUIRED_FINISH_SCRIPTS
    // (в т.ч. .gitignore-нутый refresh-core-indexes, отсутствующий на чужом клоне
    // по замыслу), остается мягким пропуском — иначе П03 сломал бы чужую установку,
    // а это тот же провал, что дыра.
    if (REQUIRED_FINISH_SCRIPTS.has(script)) {
      throw new Error(`required pipeline script missing: ${script}`)
    }
    return { skipped: true, reason: `${script} missing` }
  }
  const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: process.env, timeout: COMMAND_TIMEOUT_MS * 5 })
  return {
    skipped: false,
    ok: result.status === 0,
    code: result.status,
    stdout: compact(result.stdout, 1200),
    stderr: compact(result.stderr, 1200)
  }
}

function parseJsonOutput(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end < start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

function failRunState(payload, code = 1) {
  return writeRunState({
    ok: false,
    inbox: payload.inbox,
    processed: payload.processed,
    cached_only: payload.cached_only,
    failed: payload.failed,
    deep: DEEP,
    deep_required: REQUIRE_DEEP,
    enrich_required: ENRICH_REQUIRED,
    strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE,
    synthesize: payload.synthesize,
    vault: VAULT,
    started_at: payload.started_at,
    finished_at: new Date().toISOString(),
    ...payload.extra
  }).then(() => process.exit(code))
}

async function writeRunState(state) {
  await ensureDir(STATE)
  // local_engine_missing is stamped on EVERY state write (single writer), so a
  // cloud fallback that stood in for an absent local engine is always on the record.
  const enriched = { ...state, local_engine_missing: [...localEnginesMissing] }
  await fs.writeFile(path.join(STATE, 'last-run.json'), `${JSON.stringify(enriched, null, 2)}\n`, 'utf8')
}

function sidecarPresentFor(file, hash) {
  if (!hash) return false
  if (existsSync(path.join(EXTRACTS, `${hash}.txt`))) return true
  if ((isVideo(file) || isAudio(file)) && existsSync(path.join(TRANSCRIPTS, `${hash}.txt`))) return true
  return false
}

function c2paManifestPresent(file) {
  if (!isImage(file) && !isVideo(file)) return undefined
  const dir = path.dirname(file)
  const name = path.basename(file)
  const stem = name.replace(/\.[^.]+$/, '')
  const candidates = [
    `${file}.c2pa`,
    `${file}.c2pa.json`,
    path.join(dir, `${stem}.c2pa`),
    path.join(dir, `${stem}.c2pa.json`),
    path.join(dir, `${stem}.manifest.json`)
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try { readFileSync(candidate) } catch {}
    return true
  }
  return false
}

async function appendRunObservation(row) {
  await ensureDir(STATE)
  await fs.appendFile(path.join(STATE, 'run-observability.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
}

function observationFor(file, hash, overrides = {}) {
  const ext = path.extname(file).toLowerCase()
  const tier = tierOf(file)
  const row = {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    file,
    ext,
    tier,
    sidecar_present: sidecarPresentFor(file, hash),
    engines_tried: enginesFor(file),
    engine_used: '',
    llm_extract_used: false,
    deep: DEEP_ALLOWED && tier >= 1,
    ...overrides
  }
  const c2pa = c2paManifestPresent(file)
  if (typeof c2pa === 'boolean') row.c2pa_manifest = c2pa
  return row
}

function validateDeepRun({ synthesize, processed, inboxCount, cachedOnly = 0, observations = [] }) {
  const failures = []
  const deepRows = observations.filter(row => row.tier >= 1)
  const missingDeep = deepRows.filter(row => row.deep !== true)
  if (missingDeep.length) failures.push(`deep stage missing for ${missingDeep.length} tier>=1 units`)
  if (processed <= 0) {
    // Zero processed with a non-empty inbox is a strict-run failure: something was
    // there to handle and nothing was. Zero-in / zero-out stays legal.
    if (inboxCount > 0 && cachedOnly <= 0) failures.push('нечего обработать при непустом инбоксе')
    return failures
  }
  if (deepRows.length === 0) return failures
  if (!synthesize || (synthesize.skipped && Number(synthesize.atomized || 0) <= 0 && Number(synthesize.written || 0) <= 0)) failures.push('deep synthesis did not run')
  if (synthesize?.degraded) failures.push('deep synthesis degraded to local template')
  if (processed > 0 && Number(synthesize?.atomized || 0) <= 0) failures.push('deep synthesis produced zero atoms')
  if (processed > 0 && ENRICH_REQUIRED && Number(synthesize?.enriched || 0) <= 0) failures.push('deep enrichment produced zero enriched clusters')
  return failures
}

async function recentNotes(limit = 8) {
  const notes = []
  function cleanAction(text) {
    return String(text || '')
      .split(/\n\s*\n/)[0]
      .replace(/^[-*]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  function section(text, names) {
    for (const name of names) {
      const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi')
      const hit = text.match(re)
      if (hit) return cleanAction(hit[1])
    }
    return ''
  }
  function present(text) {
    return String(text || '')
      .replace(/Security, review, and trust boundaries: source-backed operating pattern/g, 'Безопасность, ревью и границы доверия: проверенный рабочий паттерн')
      .replace(/Miscellaneous knowledge signals: source-backed operating pattern/g, 'Прочие сигналы знаний: проверенный рабочий паттерн')
      .replace(/Knowledge memory, vaults, and synthesis loops: source-backed operating pattern/g, 'Память знаний, vault и циклы синтеза: проверенный рабочий паттерн')
      .replace(/Design systems and frontend quality: source-backed operating pattern/g, 'Дизайн-системы и качество фронтенда: проверенный рабочий паттерн')
      .replace(/Mnemazine routing decision/g, 'решение для Mnemazine')
      .replace(/operational risk and maintenance check/g, 'риск эксплуатации и поддержки')
      .replace(/README-backed capability summary/g, 'что реально обещает README')
      .replace(/Add a unified publish gate: vault quality, report quality, secret scan, diff review\./g, 'Собрать единый publish gate: качество vault, качество отчета, поиск секретов и ревью изменений.')
      .replace(/Manually review miscellaneous signals and either promote or forget them\./g, 'Вручную разобрать misc-сигналы: повысить до знания или забыть.')
      .replace(/Automate nightly connection finding and weekly synthesis from final atoms\./g, 'Автоматизировать ночной поиск связей и weekly synthesis по финальным атомам.')
      .replace(/Create browser smoke for generated HTML reports\./g, 'Сделать browser-smoke для сгенерированных HTML-отчетов.')
      .replace(/Add ([^ ]+\/[^ ]+) to the capability review queue with one accept\/reject criterion\./g, 'Добавить $1 в очередь разбора возможностей с одним критерием: принять или отклонить.')
      .replace(/Run a small local trial for ([^ ]+) only if the workflow fit is concrete\./g, 'Запустить маленький локальный пробный запуск для $1 только если понятна пригодность к рабочему сценарию.')
      .replace(/Map ([^ ]+) README features to one concrete local workflow before installing\./g, 'Связать возможности README $1 с одним конкретным рабочим сценарием до установки.')
      .replace(/с одним реальным рабочий сценарий/gi, 'с одним реальным рабочим сценарием')
      .replace(/если пригодность для конкретного сценария конкретный/gi, 'если есть понятная пригодность для конкретного сценария')
      .replace(/с одним критерием принять\/отклонить/gi, 'с одним критерием: принять или отклонить')
      .trim()
  }
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('graphify-out')) continue
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && item.name.endsWith('.md')) {
        const stat = await fs.stat(file)
        const text = await fs.readFile(file, 'utf8').catch(() => '')
        const title = present(text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, '.md'))
        const action = present(section(text, ['Следующее действие', 'Next Action']) || text.match(/Next action:\s*(.+)$/mi)?.[1]?.trim() || text.match(/- Next action:\s*(.+)$/mi)?.[1]?.trim() || '')
        notes.push({ file: path.relative(VAULT, file), title, action, mtimeMs: stat.mtimeMs })
      }
    }
  }
  await walk(VAULT)
  return notes.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

async function writeActionBrief(finishResult) {
  const dir = STATE
  await ensureDir(dir)
  const notes = await recentNotes()
  const inboxEntries = await fs.readdir(INBOX, { withFileTypes: true }).catch(() => [])
  const activeInboxCount = inboxEntries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).length
  const lines = [
    `# Короткий отчет Mnemazine — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Статус',
    '',
    `- Inbox: ${activeInboxCount}`,
    `- Vault: ${VAULT}`,
    `- Гейт качества: ${finishResult.quality?.ok ? 'ok' : 'проверь вывод'}`,
    `- Обновление графа: ${finishResult.graph?.ok ? 'ok' : finishResult.graph?.code === 2 ? 'частично / semantic pending' : finishResult.graph?.skipped ? 'пропущено' : 'failed'}`,
    `- Недельный отчет: ${finishResult.weekly?.ok ? 'ok' : finishResult.weekly?.skipped ? 'пропущен' : 'failed'}`,
    `- Качество отчета: ${finishResult.report_quality?.ok ? 'ok' : finishResult.report_quality?.skipped ? 'пропущено' : 'failed'}`,
    '',
    '## Следующие действия',
    '',
    ...(notes.length
      ? notes.map(note => `- ${note.title}${note.action ? ` — ${note.action}` : ''} (${note.file})`)
      : ['- Свежие заметки не найдены.'])
  ]
  const out = path.join(dir, 'last-action-brief.md')
  await fs.writeFile(out, `${lines.join('\n')}\n`, 'utf8')
  return out
}

// Скрипты, которые finishRun обязан найти в scripts/. Все восемь git-tracked —
// значит на чистом клоне они присутствуют, и пропажа любого = реальная дыра, а не
// частичная копия. Это единственный источник правды об «обязательном»: то, чего
// здесь нет (напр. .gitignore:48 mnemazine-refresh-core-indexes.mjs, которого на
// чужом клоне нет по замыслу), runLocalNodeScript мягко пропускает.
const REQUIRED_FINISH_SCRIPTS = new Set([
  'mnemazine-tool-decision-queue.mjs',
  'mnemazine-vault-quality-gate.mjs',
  'mnemazine-refresh-graphify.mjs',
  'mnemazine-semantic-graph-task.mjs',
  'mnemazine-weekly-brief-html.mjs',
  'mnemazine-report-quality-gate.mjs',
  'mnemazine-postrun-knowledge-report.mjs',
  'mnemazine-human-layer-gate.mjs'
])

// Один элемент finish.* «в порядке», если: он был легально пропущен (стадия
// выключена env-ом или скрипт не обязателен), отработал зеленым, ИЛИ это граф с
// кодом 2 — задокументированный semantic-pending при --mark-semantic-pending.
function finishGateOk(key, entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.skipped === true) return true
  if (entry.ok === true) return true
  if (key === 'graph' && entry.code === 2) return true
  return false
}

// result.ok больше не литерал: прогон зеленый только если ноль файлов упало И
// каждый обязательный элемент finish.* в легальном состоянии. Коды гейтов,
// собранные finishRun, наконец читаются — до архива они решали, после архива
// теперь не «советуют», а считаются. finish === null (черновая ветка/FINISH=0):
// решает только failed.
function computeRunOk(failed, finish) {
  if (Number(failed || 0) !== 0) return false
  if (!finish || finish.skipped === true) return true
  for (const [key, entry] of Object.entries(finish)) {
    if (key === 'brief') continue // путь к файлу, не гейт
    if (!finishGateOk(key, entry)) return false
  }
  return true
}

async function finishRun(runStartedAt) {
  const result = {}
  result.tool_queue = runLocalNodeScript('mnemazine-tool-decision-queue.mjs', ['--changed-since', runStartedAt, '--session', new Date().toISOString().slice(0, 10)])
  result.quality = runLocalNodeScript('mnemazine-vault-quality-gate.mjs', ['--changed-since', runStartedAt, '--max-failures', '50'])
  result.graph = runLocalNodeScript('mnemazine-refresh-graphify.mjs', ['--vault', VAULT, '--mode', process.env.MNEMAZINE_FINISH_GRAPH_MODE || 'code', '--mark-semantic-pending', '--json'])
  result.semantic_graph_task = process.env.MNEMAZINE_FINISH_SEMANTIC_ASYNC === '0'
    ? { skipped: true, reason: 'disabled by MNEMAZINE_FINISH_SEMANTIC_ASYNC=0' }
    : runLocalNodeScript('mnemazine-semantic-graph-task.mjs', ['--start', '--vault', VAULT])
  result.weekly = runLocalNodeScript('mnemazine-weekly-brief-html.mjs')
  const weeklyReport = result.weekly?.stdout?.match(/\/[^\s]+\.html/)?.[0]
  result.report_quality = weeklyReport
    ? runLocalNodeScript('mnemazine-report-quality-gate.mjs', ['--report', weeklyReport])
    : { skipped: true, reason: 'weekly report path missing' }
  result.brief = await writeActionBrief(result)
  result.visual_report = runLocalNodeScript('mnemazine-postrun-knowledge-report.mjs', ['--run-id', `local-${new Date().toISOString().slice(0, 10)}`, '--changed-since', runStartedAt])
  const visualReport = result.visual_report?.stdout?.match(/"html":\s*"([^"]+)"/)?.[1] || ''
  result.human_layer = runLocalNodeScript('mnemazine-human-layer-gate.mjs', [
    '--changed-since',
    runStartedAt,
    ...(visualReport ? ['--report', visualReport] : [])
  ])
  return result
}

async function main() {
  const runStartedAt = new Date().toISOString()
  await ensureDir(INBOX)
  await ensureDir(VAULT)
  await ensureDir(REPORTS)
  await ensureDir(path.dirname(CACHE))
  await ensureDir(ARCHIVE)
  const cache = await readJson(CACHE, {})
  const entries = (await fs.readdir(INBOX, { withFileTypes: true }))
    .filter(d => d.isFile() && !d.name.startsWith('.'))
  let processed = 0
  let cachedOnly = 0
  const toArchive = []
  const synthSourceRefs = new Set()
  let failed = 0
  const observations = []
  const canLlmExtract = llmAvailable()
  for (const [index, entry] of entries.entries()) {
    const file = path.join(INBOX, entry.name)
    let observation = observationFor(file, '', { engines_tried: enginesFor(file) })
    // Per-file isolation: one file's recognition failure must NEVER break the
    // others. Any throw here is contained — the file stays in inbox for a retry.
    try {
      const hash = await sha256(file)
      observation = observationFor(file, hash)
      if (cache[hash]) {
        if (await hasFinalKnowledgeForHash(hash)) {
          toArchive.push({ file, hash })
          cachedOnly += 1
          observation.engine_used = 'cache'
          observations.push(observation)
          await appendRunObservation(observation)
          continue
        }
        if (DRAFT_ONLY && cache[hash].status === 'draft_complete') {
          cachedOnly += 1
          observation.engine_used = 'cache'
          observations.push(observation)
          await appendRunObservation(observation)
          continue
        }
        const cachedText = await cachedExtractionText(cache[hash])
        if (cache[hash].status === 'extracted_for_note' && hasUsableExtraction(cachedText)) {
          synthSourceRefs.add(cache[hash].source_ref || sourceRef(hash))
          toArchive.push({ file, hash })
          processed += 1
          observation.engine_used = 'cache'
          observations.push(observation)
          await appendRunObservation(observation)
          continue
        }
        delete cache[hash]
      }
      // Local-first recognition (0 tokens): Apple Vision OCR / markitdown / whisper.
      const extraction = await extract(file)
      observation.engines_tried = extraction.engines_tried || observation.engines_tried
      observation.engine_used = extraction.engine_used || ''
      let text = extraction.text
      // Two outcomes are now distinct. A MISSING engine is not «движок ничего не
      // нашел»: under require-local we STOP here (exit 3, before any state write)
      // instead of letting the cloud silently stand in. Otherwise the cloud may
      // take over — but the substitution is recorded on run state, not silent.
      if (extraction.engines_missing.length) {
        for (const name of extraction.engines_missing) localEnginesMissing.add(name)
        if (REQUIRE_LOCAL) {
          console.error(JSON.stringify({ require_local_stop: true, file: entry.name, local_engine_missing: extraction.engines_missing }))
          process.exit(3)
        }
      }
      // Only if local produced nothing usable AND deep is on: LLM recognition.
      if (!hasUsableExtraction(text) && observation.deep && canLlmExtract && (isImage(file) || isVideo(file) || isAudio(file) || isMarkitdownDocument(file))) {
        try {
          const llmText = await llmExtract(file)
          observation.llm_extract_used = true
          if (hasUsableExtraction(llmText)) text = llmText
        } catch (err) {
          console.error(JSON.stringify({ file: entry.name, llm_extract_error: String(err.message).slice(0, 200) }))
        }
      }
      if (!hasUsableExtraction(text)) {
        const record = await writeExtractCache(file, hash, text, 'needs_manual_context')
        cache[hash] = { status: record.status, source_ref: record.source_ref, cache: path.relative(ROOT, path.join(EXTRACTS, `${hash}.json`)) }
        failed += 1
      } else {
        const record = await writeExtractCache(file, hash, text, 'extracted_for_note')
        cache[hash] = { status: 'extracted_for_note', source_ref: sourceRef(hash), cache: path.relative(ROOT, path.join(EXTRACTS, `${hash}.json`)) }
        synthSourceRefs.add(record.source_ref)
        toArchive.push({ file, hash })
        processed += 1
      }
      observations.push(observation)
      await appendRunObservation(observation)
    } catch (err) {
      // Isolated failure: log, leave file in inbox, keep going.
      failed += 1
      observations.push(observation)
      await appendRunObservation(observation)
      console.error(JSON.stringify({ file: entry.name, extract_error: String(err.message).slice(0, 200) }))
    }
    if (PROGRESS_EVERY > 0 && (index + 1) % PROGRESS_EVERY === 0) {
      console.error(JSON.stringify({ progress: index + 1, total: entries.length, processed, cached_only: cachedOnly, failed }))
    }
  }
  await fs.writeFile(CACHE, JSON.stringify(cache, null, 2), 'utf8')
  const hasDeepUnits = observations.some(row => row.deep === true && row.engine_used)
  let synthesize = { skipped: true, reason: processed > 0 ? 'disabled' : 'no newly extracted sources' }
  if (SYNTHESIZE && processed > 0) {
    // Stages: extraction+understanding already done above; synthesize runs
    // research/verification/atomization (deep) and writes vault atoms.
    const synthArgs = [path.join(ROOT, 'scripts/mnemazine-synthesize.mjs')]
    if (hasDeepUnits) synthArgs.push('--deep')
    const synthEnv = { ...process.env }
    if (synthSourceRefs.size) synthEnv.MNEMAZINE_SYNTH_SOURCE_REFS = [...synthSourceRefs].join(',')
    const synth = spawnSync(process.execPath, synthArgs, { encoding: 'utf8', env: synthEnv })
    if (synth.stdout) process.stdout.write(synth.stdout)
    if (synth.stderr) process.stderr.write(synth.stderr)
    synthesize = parseJsonOutput(synth.stdout) || { ok: synth.status === 0, parse_error: true }
    if (synth.status !== 0) {
      await writeRunState({ ok: false, failure: 'synthesize failed', inbox: entries.length, processed, cached_only: cachedOnly, failed, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() })
      process.exit(synth.status || 1)
    }
    vaultMarkdownFiles = null
  }
  if (REQUIRE_DEEP) {
    const deepFailures = validateDeepRun({ synthesize, processed, cachedOnly, inboxCount: entries.length, observations })
    if (deepFailures.length) {
      await writeRunState({ ok: false, failures: deepFailures, inbox: entries.length, processed, cached_only: cachedOnly, failed, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() })
      console.error(JSON.stringify({ ok: false, failures: deepFailures, synthesize }, null, 2))
      process.exit(1)
    }
  }
  const qualityArgs = [path.join(ROOT, 'scripts/mnemazine-vault-quality-gate.mjs'), '--changed-since', runStartedAt, '--max-failures', '50']
  if (processed === 0 && cachedOnly > 0) qualityArgs.push('--allow-empty')
  const quality = spawnSync(process.execPath, qualityArgs, { stdio: 'inherit', env: process.env })
  if (quality.status !== 0) {
    await writeRunState({ ok: false, failure: 'run vault quality failed', inbox: entries.length, processed, cached_only: cachedOnly, failed, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() })
    process.exit(quality.status || 1)
  }
  if (DRAFT_ONLY) {
    for (const item of toArchive) if (cache[item.hash]) cache[item.hash].status = 'draft_complete'
    await fs.writeFile(CACHE, JSON.stringify(cache, null, 2), 'utf8')
    const result = { ok: computeRunOk(failed, null), draft_only: true, inbox: entries.length, processed, cached_only: cachedOnly, failed, archived: 0, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() }
    await writeRunState(result)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const missingFinalNotes = []
  vaultMarkdownFiles = null
  for (const item of toArchive) {
    if (!await hasFinalKnowledgeForHash(item.hash)) missingFinalNotes.push(path.basename(item.file))
  }
  if (missingFinalNotes.length) {
    const failure = STRICT_ARCHIVE_KNOWLEDGE ? 'final enriched verified note missing for archive candidates' : 'final note missing for archive candidates'
    await writeRunState({ ok: false, failure, missing_final_notes: missingFinalNotes, inbox: entries.length, processed, cached_only: cachedOnly, failed, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() })
    console.error(JSON.stringify({ ok: false, failure, missing_final_notes: missingFinalNotes }, null, 2))
    process.exit(1)
  }
  // Deep + final stage before archive: Russian humanizer digest + human-layer
  // gate. If this fails, sources stay in inbox for a safe retry.
  if (hasDeepUnits) {
    const digest = spawnSync(process.execPath, [path.join(ROOT, 'scripts/mnemazine-digest.mjs'), '--changed-since', runStartedAt], { stdio: 'inherit', env: process.env })
    if (digest.status !== 0) {
      await failRunState({
        inbox: entries.length,
        processed,
        cached_only: cachedOnly,
        failed,
        synthesize,
        started_at: runStartedAt,
        extra: { failure: 'digest failed before archive' }
      }, digest.status || 1)
    }
    // План П13 fixup: humanize-пас МЕЖДУ генерацией ноты и sweep. Конвейер (digest/
    // LLM) рождает слоп и падал бы о собственный sweep. Пас очеловечивает каждую
    // свежую ноту ДО сторожа: гейт → автоправка → повторный гейт; не чинится за 2
    // итерации → прогон честно падает 1 с именем ноты. Sweep ниже остается байтовым
    // бэкстопом на дочищенном тексте.
    const humanizePass = spawnSync(process.execPath, [path.join(ROOT, 'scripts/mnemazine-humanize-gate.mjs'), '--pass', '--vault', VAULT, '--changed-since', runStartedAt], { encoding: 'utf8', env: process.env })
    if (humanizePass.stdout) process.stdout.write(humanizePass.stdout)
    if (humanizePass.stderr) process.stderr.write(humanizePass.stderr)
    if (humanizePass.status !== 0) {
      await failRunState({
        inbox: entries.length,
        processed,
        cached_only: cachedOnly,
        failed,
        synthesize,
        started_at: runStartedAt,
        extra: { failure: 'humanize pass could not clear slop before archive' }
      }, humanizePass.status || 1)
    }
    // План П13 шаг 6: гейт сохранности/читаемости по нотам, измененным с runStartedAt.
    // Фатален настоящий слоп (hard bans кроме сквозного em-dash); em-dash и низкий score —
    // advisory, чтобы сторож не краснил живой прогон на дочищенном тексте.
    const preserve = spawnSync(process.execPath, [path.join(ROOT, 'scripts/mnemazine-humanize-gate.mjs'), '--sweep', '--vault', VAULT, '--changed-since', runStartedAt], { encoding: 'utf8', env: process.env })
    if (preserve.stdout) process.stdout.write(preserve.stdout)
    if (preserve.stderr) process.stderr.write(preserve.stderr)
    if (preserve.status !== 0) {
      await failRunState({
        inbox: entries.length,
        processed,
        cached_only: cachedOnly,
        failed,
        synthesize,
        started_at: runStartedAt,
        extra: { failure: 'humanize preservation gate failed before archive' }
      }, preserve.status || 1)
    }
    const refs = [...new Set(toArchive.map(item => sourceRef(item.hash)))]
    const humanArgs = [path.join(ROOT, 'scripts/mnemazine-human-layer-gate.mjs'), '--notes-only', '--changed-since', runStartedAt]
    if (refs.length) humanArgs.push('--source-ref', refs.join(','))
    const human = spawnSync(process.execPath, humanArgs, { encoding: 'utf8', env: process.env })
    if (human.stdout) process.stdout.write(human.stdout)
    if (human.stderr) process.stderr.write(human.stderr)
    if (human.status !== 0) {
      await failRunState({
        inbox: entries.length,
        processed,
        cached_only: cachedOnly,
        failed,
        synthesize,
        started_at: runStartedAt,
        extra: { failure: 'human layer gate failed before archive' }
      }, human.status || 1)
    }
  }
  const archived = []
  for (const item of toArchive) archived.push(await archiveFile(item.file, item.hash))
  const finish = FINISH ? await finishRun(runStartedAt) : { skipped: true }
  const result = { ok: computeRunOk(failed, finish), inbox: entries.length, processed, cached_only: cachedOnly, failed, archived: archived.length, deep: DEEP, deep_required: REQUIRE_DEEP, enrich_required: ENRICH_REQUIRED, strict_archive_knowledge: STRICT_ARCHIVE_KNOWLEDGE, synthesize, finish, vault: VAULT, started_at: runStartedAt, finished_at: new Date().toISOString() }
  await writeRunState(result)
  console.log(JSON.stringify(result, null, 2))
}

// Запуск main только когда файл исполняется напрямую (node .../mnemazine-run.mjs),
// а не импортируется. Импорт нужен пробе runLocalNodeScript (harness на две строки)
// и любому будущему потребителю экспортов — он не должен гонять пайплайн.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
