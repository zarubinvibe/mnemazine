#!/usr/bin/env node
// П17 · прибор подъема _archive/2026-08 через починенный конвейер.
//
// Режимы:
//   --plan     собрать рабочий список из state-файла archive-covered и записать
//              журнал партий (манифест BagIt-стиля: хеши + что нашлось/что нет).
//   --stage    скопировать (НЕ переместить) партию во вложенный инбокс под
//              исходными именами из items[].name; копия проверяется по sha256.
//   --measure  строго замерить покрытие партии по единому strictKnowledgeReady
//              (подстрока хеша в не-строгой ноте покрытием не считается) и
//              записать результат в журнал (журнал событий источника, прием 8).
//   --record   дописать метаданные прогона (секунды, ok) в партию.
//   --set-floor  зафиксировать порог N (только вверх).
//   --rollback снять отметки партии в журнале (копии и git-реверт vault делает
//              исполнитель отдельно — см. план П17, «Откат»).
//   --status   сводка журнала.
//
// Инварианты: оригиналы в _archive не перемещаются и не удаляются; партия <= 20;
// пропавший рабочий список = exit 2, а не «поднимать нечего».
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { resolveVault } from './mnemazine-paths.mjs'
import { strictKnowledgeReady } from './mnemazine-note-spec.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const MODE = ['plan', 'stage', 'measure', 'record', 'set-floor', 'rollback', 'status']
  .find(m => argv.includes(`--${m}`)) || ''
const JOURNAL = path.resolve(arg('journal', path.join(ROOT, '.mnemazine/state', 'П17-batches.json')))
const DEFAULT_STATE = path.join(ROOT, '.mnemazine/state/archive-covered-20260820T105308Z.json')
const DEFAULT_ARCHIVE = path.join(os.homedir(), 'Desktop', 'Mnemazine Inbox', '_archive', '2026-08')
const BATCH_SIZE_DEFAULT = 20

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
}

function sourceRef(hash) {
  return `local-media:${String(hash).slice(0, 16)}`
}

async function readJournal() {
  if (!existsSync(JOURNAL)) fail(`журнал не найден: ${JOURNAL} (сначала --plan)`, 2)
  return JSON.parse(await fs.readFile(JOURNAL, 'utf8'))
}

async function writeJournal(journal) {
  journal.updated_at = new Date().toISOString()
  await fs.mkdir(path.dirname(JOURNAL), { recursive: true })
  await fs.writeFile(JOURNAL, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

function batchItems(journal, batchId, size) {
  const pending = journal.items.filter(item => item.matched)
  return pending.slice((batchId - 1) * size, batchId * size)
}

// --- --plan -----------------------------------------------------------------
async function doPlan() {
  const stateFile = path.resolve(arg('state', DEFAULT_STATE))
  const archiveDir = path.resolve(arg('archive', DEFAULT_ARCHIVE))
  const out = path.resolve(arg('out', JOURNAL))
  if (!existsSync(stateFile)) fail(`рабочий список не найден: ${stateFile}`, 2)
  if (!existsSync(archiveDir)) fail(`архив не найден: ${archiveDir}`, 2)
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  const archiveFiles = await fs.readdir(archiveDir)
  const pending = (state.items || []).filter(item => item.strict_final === false)
  const items = []
  let missing = 0
  for (const item of pending) {
    const hit = archiveFiles.find(name => name.startsWith(item.hash))
    if (!hit) missing += 1
    items.push({
      hash: item.hash,
      name: item.name,
      source_ref: item.source_ref || sourceRef(item.hash),
      matched: Boolean(hit),
      archive_file: hit ? path.join(archiveDir, hit) : null,
      status: 'pending',
      batch: null,
      staged_name: null,
      covered: null,
      events: [{ event: 'raised', at: new Date().toISOString(), from: path.basename(stateFile) }]
    })
  }
  const size = Number(arg('size', BATCH_SIZE_DEFAULT))
  const matched = items.filter(item => item.matched).length
  const journal = {
    version: 1,
    plan: 'П17',
    created_at: new Date().toISOString(),
    state_source: stateFile,
    archive_dir: archiveDir,
    batch_size: size,
    floor: null,
    totals: {
      pending: items.length,
      matched,
      missing,
      batches: Math.ceil(matched / size)
    },
    items,
    batches: []
  }
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ok: true,
    journal: out,
    pending: items.length,
    matched,
    missing,
    batches: journal.totals.batches,
    missing_hashes: items.filter(item => !item.matched).map(item => item.hash.slice(0, 16))
  }, null, 2))
  if (missing > 0) process.exitCode = 2
}

// --- --stage ----------------------------------------------------------------
async function doStage() {
  const batchId = Number(arg('batch', 0))
  const journal = await readJournal()
  const size = Number(arg('size', journal.batch_size || BATCH_SIZE_DEFAULT))
  const target = path.resolve(arg('to', path.join(os.homedir(), 'Desktop', 'Mnemazine Inbox', 'mnemazine-inbox')))
  if (!batchId) fail('укажи --batch N', 2)
  const existing = (await fs.readdir(target, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
  if (existing.length) fail(`целевой инбокс не пуст (${existing.length} файлов): ${target} — не смешиваю партии`, 2)
  const items = batchItems(journal, batchId, size)
  if (!items.length) fail(`партия ${batchId} пуста`, 2)
  if (items.some(item => item.status !== 'pending')) fail(`партия ${batchId} уже поднималась — сначала --rollback --batch ${batchId}`, 2)
  await fs.mkdir(target, { recursive: true })
  const usedNames = new Set()
  const manifest = []
  for (const item of items) {
    let stagedName = item.name
    const ext = path.extname(stagedName)
    const stem = stagedName.slice(0, stagedName.length - ext.length)
    if (usedNames.has(stagedName) || existsSync(path.join(target, stagedName))) {
      stagedName = `${stem}-${item.hash.slice(0, 8)}${ext}`
    }
    usedNames.add(stagedName)
    const dest = path.join(target, stagedName)
    await fs.copyFile(item.archive_file, dest)
    const copyHash = await sha256(dest)
    if (copyHash !== item.hash) fail(`копия не совпала по sha256: ${stagedName}`, 1)
    item.status = 'staged'
    item.batch = batchId
    item.staged_name = stagedName
    item.events.push({ event: 'staged', at: new Date().toISOString(), batch: batchId, staged_as: stagedName })
    manifest.push({ hash: item.hash, name: item.name, staged_as: stagedName, source_ref: item.source_ref })
  }
  journal.batches.push({
    id: batchId,
    size: items.length,
    staged_at: new Date().toISOString(),
    status: 'staged',
    strict_covered: null,
    run_ok: null,
    seconds: null,
    manifest,
    missing: items.filter(item => !item.matched).map(item => item.hash.slice(0, 16))
  })
  await writeJournal(journal)
  console.log(JSON.stringify({ ok: true, batch: batchId, staged: items.length, to: target }, null, 2))
}

// --- --measure --------------------------------------------------------------
async function vaultMarkdownFiles(vault) {
  const out = []
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name)
      const rel = path.relative(vault, file).replace(/\\/g, '/')
      if (item.isDirectory()) {
        if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
        if (rel === '99 Система' || rel.startsWith('99 Система/')) continue
        await walk(file)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        out.push(file)
      }
    }
  }
  await walk(vault)
  return out
}

async function doMeasure() {
  const batchId = Number(arg('batch', 0))
  const vault = resolveVault({ cli: arg('vault', '') || undefined })
  if (!batchId) fail('укажи --batch N', 2)
  const journal = await readJournal()
  const batch = journal.batches.find(entry => entry.id === batchId)
  if (!batch) fail(`партия ${batchId} не найдена в журнале`, 2)
  const notes = []
  for (const file of await vaultMarkdownFiles(vault)) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (!text.includes('local-media:') && !text.includes('source_hash')) continue
    if (!strictKnowledgeReady(text)) continue
    // `synthesis-` used to mean a hollow cluster template, so the name was
    // excluded outright. Atomized notes now carry the deep verdict and are the
    // knowledge itself; cluster drafts stay out on their own merit (they are
    // `status: draft`, which strictKnowledgeReady already rejects).
    if (/^source_type:\s*"?synthesis-cluster"?\s*$/m.test(text)) continue
    notes.push({ file, text })
  }
  let covered = 0
  for (const item of journal.items.filter(row => row.batch === batchId)) {
    const ref = sourceRef(item.hash)
    const hit = notes.find(note => note.text.includes(ref) || note.text.includes(item.hash))
    item.covered = Boolean(hit)
    if (hit) covered += 1
    item.events.push({
      event: 'measured',
      at: new Date().toISOString(),
      batch: batchId,
      covered: item.covered,
      note: hit ? path.relative(vault, hit.file) : null
    })
  }
  batch.strict_covered = covered
  batch.status = 'measured'
  batch.measured_at = new Date().toISOString()
  batch.measured_vault = vault
  await writeJournal(journal)
  console.log(JSON.stringify({ ok: true, batch: batchId, size: batch.size, strict_covered: covered, floor: journal.floor }, null, 2))
}

// --- --record ---------------------------------------------------------------
async function doRecord() {
  const batchId = Number(arg('batch', 0))
  if (!batchId) fail('укажи --batch N', 2)
  const journal = await readJournal()
  const batch = journal.batches.find(entry => entry.id === batchId)
  if (!batch) fail(`партия ${batchId} не найдена в журнале`, 2)
  const seconds = arg('seconds', '')
  if (seconds !== '') batch.seconds = Number(seconds)
  const runOk = arg('run-ok', '')
  if (runOk !== '') batch.run_ok = runOk === '1' || runOk === 'true'
  const note = arg('note', '')
  if (note) batch.note = note
  await writeJournal(journal)
  console.log(JSON.stringify({ ok: true, batch: batchId, seconds: batch.seconds, run_ok: batch.run_ok }, null, 2))
}

// --- --set-floor ------------------------------------------------------------
async function doSetFloor() {
  const journal = await readJournal()
  const value = Number(arg('batch', '') || argv[argv.indexOf('--set-floor') + 1])
  if (!Number.isFinite(value)) fail('укажи значение пола: --set-floor N', 2)
  if (journal.floor !== null && value < journal.floor) {
    fail(`пол переписывается только вверх: текущий ${journal.floor}, попытка ${value}`, 2)
  }
  journal.floor = value
  journal.floor_history = [...(journal.floor_history || []), { floor: value, at: new Date().toISOString() }]
  await writeJournal(journal)
  console.log(JSON.stringify({ ok: true, floor: value }, null, 2))
}

// --- --rollback -------------------------------------------------------------
async function doRollback() {
  const batchId = Number(arg('batch', 0))
  if (!batchId) fail('укажи --batch N', 2)
  const journal = await readJournal()
  const batch = journal.batches.find(entry => entry.id === batchId)
  if (!batch) fail(`партия ${batchId} не найдена в журнале`, 2)
  for (const item of journal.items.filter(row => row.batch === batchId)) {
    item.status = 'pending'
    item.batch = null
    item.staged_name = null
    item.covered = null
    item.events.push({ event: 'rollback', at: new Date().toISOString(), batch: batchId })
  }
  batch.status = 'rolled_back'
  batch.rolled_back_at = new Date().toISOString()
  // Drop the header too: leaving it made a re-stage push a second entry with the
  // same id, and --measure/--record then found() the stale one.
  journal.batches = journal.batches.filter(entry => entry.id !== batchId)
  journal.rolled_back = [...(journal.rolled_back || []), { ...batch }]
  await writeJournal(journal)
  console.log(JSON.stringify({ ok: true, batch: batchId, rolled_back: true }, null, 2))
}

// --- --status ---------------------------------------------------------------
async function doStatus() {
  const journal = await readJournal()
  console.log(JSON.stringify({
    ok: true,
    floor: journal.floor,
    totals: journal.totals,
    batches: journal.batches.map(batch => ({
      id: batch.id,
      size: batch.size,
      status: batch.status,
      strict_covered: batch.strict_covered,
      run_ok: batch.run_ok,
      seconds: batch.seconds
    }))
  }, null, 2))
}

const handlers = {
  plan: doPlan,
  stage: doStage,
  measure: doMeasure,
  record: doRecord,
  'set-floor': doSetFloor,
  rollback: doRollback,
  status: doStatus
}

if (!MODE || !handlers[MODE]) {
  fail('режим обязателен: --plan | --stage | --measure | --record | --set-floor | --rollback | --status', 2)
}

handlers[MODE]().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
