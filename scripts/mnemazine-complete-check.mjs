#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const INBOX = process.env.MNEMAZINE_INBOX || path.join(ROOT, 'inbox')
const REPORTS = process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const NEEDS_UPDATE_MAX_DAYS = Number(arg('needs-update-max-days', process.env.MNEMAZINE_NEEDS_UPDATE_MAX_DAYS || '1'))
const STRICT_GRAPH = argv.includes('--strict-graph')
const REQUIRE_DEEP = argv.includes('--require-deep') || process.env.MNEMAZINE_REQUIRE_DEEP === '1'
// Удаление протухшего маркера графа — только по этому явному флагу.
// Без него маркер остается на месте и ложится в warnings/failures (план П08).
const PRUNE_GRAPH_MARKER = argv.includes('--prune-graph-marker')

if (argv.includes('--help')) {
  console.log(`mnemazine-complete-check.mjs — сводный гейт «конвейер завершен честно»:
инбокс пуст, coverage/качество/отчет/человеческий слой зеленые, маркер графа учтен.

Использование: node scripts/mnemazine-complete-check.mjs [флаги]
  --vault <путь>             корпус (иначе MNEMAZINE_VAULT, last-run.vault или repo-local vault)
  --require-deep             требовать deep-прогон в last-run (или MNEMAZINE_REQUIRE_DEEP=1)
  --strict-graph             маркер needs_update — failure, а не warning
  --needs-update-max-days N  возраст маркера до failure (по умолчанию 1)
  --prune-graph-marker       удалить протухший маркер graphify-out/needs_update
                             (по умолчанию НИЧЕГО не удаляется — только verdict)
  --help                     эта справка

Коды возврата: 0 — все проверки зеленые; 1 — есть failures или ошибка.`)
  process.exit(0)
}

function run(command, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ ok: code === 0, code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', error => resolve({ ok: false, code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() }))
  })
}

async function newestChangedFileMtime(dir, sinceMs, filter = () => true) {
  let newest = 0
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('graphify-out')) continue
      const file = path.join(folder, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && filter(file)) {
        const stat = await fs.stat(file)
        if (!sinceMs || stat.mtimeMs >= sinceMs) newest = Math.max(newest, stat.mtimeMs)
      }
    }
  }
  await walk(dir)
  return newest
}

async function latestReport() {
  const reports = []
  for (const item of await fs.readdir(REPORTS, { withFileTypes: true }).catch(() => [])) {
    if (!item.isFile() || !item.name.endsWith('.html')) continue
    const file = path.join(REPORTS, item.name)
    reports.push({ file, name: item.name, mtimeMs: (await fs.stat(file)).mtimeMs })
  }
  const visual = reports.filter(item => item.name.includes('visual-knowledge-report'))
  return (visual.length ? visual : reports).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || ''
}

// fail-closed: нечитаемый инбокс (EACCES и пр.) не должен быть неотличим от
// пустого. ENOENT — легитимно «нет папки = пусто»; любая другая ошибка readdir —
// это провал «inbox unreadable», а не «инбокс пуст».
async function activeInboxFiles() {
  let entries
  try {
    entries = await fs.readdir(INBOX, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { files: [], error: null }
    return { files: [], error: err.code || String(err.message) }
  }
  return {
    files: entries.filter(item => item.isFile() && !item.name.startsWith('.')).map(item => item.name),
    error: null
  }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function graphMtime(file) {
  const stat = await fs.stat(file).catch(() => null)
  return stat ? stat.mtimeMs : 0
}

function isGraphSemanticFile(file) {
  return ['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.gif', '.svg']
    .includes(path.extname(file).toLowerCase())
}

function deepFailures(lastRun) {
  const failures = []
  if (!lastRun) return ['last run state missing']
  if (!lastRun.ok) failures.push(`last run failed: ${(lastRun.failures || [lastRun.failure || 'unknown']).join('; ')}`)
  if (lastRun.draft_only) failures.push('last run was draft-only')
  if (!lastRun.deep) failures.push('last run was not deep')
  if (lastRun.strict_archive_knowledge !== true) failures.push('strict archive knowledge gate was not enabled')
  if (!lastRun.synthesize || lastRun.synthesize.skipped) {
    if (Number(lastRun.processed || 0) > 0) failures.push('deep synthesis did not run')
    return failures
  }
  if (lastRun.synthesize.degraded) failures.push('deep synthesis degraded to local template')
  if (Number(lastRun.processed || 0) > 0 && Number(lastRun.synthesize.atomized || 0) <= 0) failures.push('deep synthesis produced zero atoms')
  if (Number(lastRun.processed || 0) > 0 && lastRun.enrich_required && Number(lastRun.synthesize.enriched || 0) <= 0) failures.push('deep enrichment produced zero enriched clusters')
  return failures
}

async function main() {
  const failures = []
  const warnings = []
  const inbox = await activeInboxFiles()
  if (inbox.error) failures.push(`inbox unreadable: ${inbox.error}`)
  const inboxFiles = inbox.files
  if (inboxFiles.length) failures.push(`inbox not empty: ${inboxFiles.length}`)

  const lastRunFile = path.join(STATE, 'last-run.json')
  const lastRun = await readJson(lastRunFile)
  const VAULT = resolveVault({ cli: arg('vault'), env: process.env.MNEMAZINE_VAULT || lastRun?.vault })
  const gateEnv = { MNEMAZINE_VAULT: VAULT }
  const coverageArgs = ['scripts/mnemazine-coverage-check.mjs', '--vault', VAULT, '--inbox', INBOX, '--json']
  if (inboxFiles.length === 0) coverageArgs.push('--allow-empty')
  const coverage = spawnSync(process.execPath, coverageArgs, { cwd: ROOT, env: { ...process.env, ...gateEnv }, encoding: 'utf8' })
  const coverageCode = coverage.status ?? 1
  if (coverageCode === 1) failures.push(`coverage failed: ${(coverage.stderr || coverage.stdout || '').trim()}`)
  else if (coverageCode !== 0) failures.push(`coverage check error: ${(coverage.stderr || coverage.stdout || coverage.error?.message || '').trim()}`)
  const lastRunStartedMs = lastRun?.started_at ? Date.parse(lastRun.started_at) : 0
  const qualityArgs = ['scripts/mnemazine-vault-quality-gate.mjs', '--vault', VAULT, '--max-failures', '50']
  if (lastRunStartedMs) qualityArgs.push('--changed-since', lastRun.started_at)
  if (Number(lastRun?.processed || 0) === 0) qualityArgs.push('--allow-empty')
  const quality = await run(process.execPath, qualityArgs, gateEnv)
  if (!quality.ok) failures.push(`vault quality failed: ${quality.stderr || quality.stdout}`)

  // Потолок провалов спеки в продовом пути (план П06 шаг 6): гейт --spec виден
  // приемке, а не только вручную. Ненулевой код прибора потолка → в failures.
  const specCeilingFile = path.join(STATE, 'spec-ceiling.json')
  if (!existsSync(specCeilingFile)) {
    // Свежая установка: потолок спеки — per-machine runtime (план П16, .mnemazine/state
    // gitignored), на чистом клоне его нет и сравнивать не с чем. Это «нет данных», а не
    // провал: ratchet без базы — no-op. doctor распознает эту строку как no-data (degraded, не fatal).
    failures.push('spec ceiling has no baseline yet')
  } else {
    const specCeiling = await run(process.execPath, ['scripts/mnemazine-spec-ceiling.mjs', '--check', '--vault', VAULT, '--ceiling', specCeilingFile], gateEnv)
    if (!specCeiling.ok) failures.push(`spec ceiling failed: ${specCeiling.stderr || specCeiling.stdout}`)
  }

  const report = await latestReport()
  if (!report) failures.push('weekly report missing')
  else {
    const reportQuality = await run(process.execPath, ['scripts/mnemazine-report-quality-gate.mjs', '--report', report], gateEnv)
    if (!reportQuality.ok) failures.push(`report quality failed: ${reportQuality.stderr || reportQuality.stdout}`)
  }

  const newestNote = await newestChangedFileMtime(VAULT, lastRunStartedMs, file => file.endsWith('.md'))
  const reportMtime = report ? (await fs.stat(report)).mtimeMs : 0
  if (newestNote && reportMtime && reportMtime < newestNote) failures.push('weekly report older than newest vault note')

  const brief = path.join(STATE, 'last-action-brief.md')
  if (!existsSync(brief)) failures.push('action brief missing')
  else if ((await fs.stat(brief)).mtimeMs < newestNote) failures.push('action brief older than newest vault note')

  const humanLayerArgs = ['scripts/mnemazine-human-layer-gate.mjs', '--vault', VAULT]
  if (lastRun?.started_at) humanLayerArgs.push('--changed-since', lastRun.started_at)
  if (report) humanLayerArgs.push('--report', report)
  const humanLayer = await run(process.execPath, humanLayerArgs, gateEnv)
  if (!humanLayer.ok) failures.push(`human layer failed: ${humanLayer.stderr || humanLayer.stdout}`)

  const needsUpdate = path.join(VAULT, 'graphify-out', 'needs_update')
  if (existsSync(needsUpdate)) {
    const markerText = await fs.readFile(needsUpdate, 'utf8').catch(() => '')
    const deferredSemantic = /deferred:/i.test(markerText)
    const graphPath = path.join(VAULT, 'graphify-out', 'graph.json')
    const graphMs = await graphMtime(graphPath)
    const newestSemantic = await newestChangedFileMtime(VAULT, 0, isGraphSemanticFile)
    const staleMarker = graphMs && newestSemantic && graphMs >= newestSemantic
    if (staleMarker && !deferredSemantic) {
      if (PRUNE_GRAPH_MARKER) {
        await fs.rm(needsUpdate, { force: true }).catch(() => {})
      } else {
        const ageDays = (Date.now() - (await fs.stat(needsUpdate)).mtimeMs) / 86400000
        const msg = `semantic graph marker stale (${ageDays.toFixed(2)} days; graph.json covers the newest semantic file — marker kept, prune explicitly with --prune-graph-marker)`
        if (STRICT_GRAPH || ageDays > NEEDS_UPDATE_MAX_DAYS) failures.push(msg)
        else warnings.push(msg)
      }
    } else {
      const ageDays = (Date.now() - (await fs.stat(needsUpdate)).mtimeMs) / 86400000
      const msg = `semantic graph pending (${ageDays.toFixed(2)} days; run npm run graph:semantic:async)`
      if (STRICT_GRAPH || ageDays > NEEDS_UPDATE_MAX_DAYS) failures.push(msg)
      else warnings.push(msg)
    }
  }

  if (REQUIRE_DEEP) {
    for (const failure of deepFailures(lastRun)) failures.push(failure)
  }

  const result = {
    ok: failures.length === 0,
    failures,
    warnings,
    inbox: inboxFiles.length,
    deep_required: REQUIRE_DEEP,
    last_run: lastRun ? {
      ok: lastRun.ok,
      deep: lastRun.deep,
      processed: lastRun.processed,
      atomized: lastRun.synthesize?.atomized ?? null,
      enriched: lastRun.synthesize?.enriched ?? null,
      finished_at: lastRun.finished_at || null
    } : null,
    report: report ? path.relative(ROOT, report) : null,
    brief: existsSync(brief) ? path.relative(ROOT, brief) : null
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exit(1)
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
